import type { AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createResponsesControl } from "../../ai/src/api/openai-responses-control.ts";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { Agent } from "../src/agent.ts";
import { getPendingToolCalls } from "../src/agent-loop.ts";
import type { AgentEvent, AgentTool, AgentToolResult, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-6-astra",
	name: "Astra",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
	compat: { supportsAsyncTools: true },
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function assistant(id: string, content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: id,
		content,
		stopReason: "pending",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function call(id = "call"): ToolCall {
	return {
		type: "toolCall",
		id: `${id}|fc_${id}`,
		name: "work",
		arguments: { path: "original" },
		async: true,
		responsesItem: {
			type: "function_call",
			id: `fc_${id}`,
			call_id: id,
			name: "work",
			arguments: '{"path":"original"}',
			async: true,
			status: "completed",
		},
	};
}
function finish(stream: AssistantMessageEventStream, message: AssistantMessage, error = false) {
	message.stopReason = error
		? "error"
		: message.content.some((block) => block.type === "toolCall")
			? "toolUse"
			: "stop";
	if (error) stream.push({ type: "error", reason: "error", error: message });
	else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
	stream.end();
}
const result: AgentToolResult = { content: [{ type: "text", text: "actual result" }], details: undefined };
function setup(execute: AgentTool["execute"], options: Partial<AgentTool> = {}) {
	const streams: AssistantMessageEventStream[] = [];
	const inputs: Message[][] = [];
	const streamFn: StreamFn = (_model, context) => {
		inputs.push(structuredClone(context.messages));
		const stream = new AssistantMessageEventStream();
		streams.push(stream);
		return stream;
	};
	const tool: AgentTool = {
		name: "work",
		label: "Work",
		description: "Work",
		parameters: Type.Object({ path: Type.String() }),
		async: true,
		execute,
		...options,
	};
	const agent = new Agent({ initialState: { model, tools: [tool] }, streamFn });
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(structuredClone(event));
	});
	return { agent, streams, inputs, events, tool };
}
async function emitCall(stream: AssistantMessageEventStream, message: AssistantMessage, toolCall: ToolCall) {
	message.content.push(toolCall);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
}
async function answer(streams: AssistantMessageEventStream[], index: number) {
	await vi.waitFor(() => expect(streams.length).toBeGreaterThan(index));
	const message = assistant(`answer-${index}`, [{ type: "text", text: "answer" }]);
	streams[index].push({ type: "start", partial: message });
	finish(streams[index], message);
}

describe("native async lifecycle", () => {
	it("clears rejected live-input preparation so a corrected run can steer again", async () => {
		const { agent, streams } = setup(async () => result);
		const provider = agent.streamFunction;
		agent.streamFunction = (model, context, options) => {
			options?.onResponseControl?.({
				waitingForSuccessor: false,
				deliveredToolCallIds: new Set(),
				retired: false,
				retire() {},
				steer: () => false,
				submitToolResults() {},
			});
			return provider(model, context, options);
		};
		agent.prepareSteering = vi.fn().mockRejectedValueOnce(new Error("invalid image")).mockResolvedValue(undefined);
		const firstRun = agent.prompt("first");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		agent.steer({ role: "user", content: "invalid", timestamp: 1 });
		await answer(streams, 0);
		await firstRun;
		expect(agent.state.errorMessage).toBe("invalid image");
		agent.clearAllQueues();
		const secondRun = agent.prompt("corrected");
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		agent.steer({ role: "user", content: "valid steering", timestamp: 2 });
		await answer(streams, 1);
		await answer(streams, 2);
		await secondRun;
		expect(agent.prepareSteering).toHaveBeenCalledTimes(2);
		expect(
			agent.state.messages.filter((message) => message.role === "user" && message.content === "valid steering"),
		).toHaveLength(1);
	});

	it("does not execute partial calls when a stream fails", async () => {
		const execute = vi.fn<AgentTool["execute"]>(async () => result);
		const { agent, streams } = setup(execute);
		const run = agent.prompt("go");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const message = assistant("partial", [
			{ type: "toolCall", id: "partial", name: "work", arguments: { path: "partial" } },
		]);
		streams[0].push({ type: "start", partial: message });
		streams[0].push({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"partial', partial: message });
		finish(streams[0], message, true);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.some((entry) => entry.role === "toolResult")).toBe(false);
	});

	it("blocks native calls before the started checkpoint and does not assign executor time", async () => {
		const execute = vi.fn<AgentTool["execute"]>(async () => result);
		const { agent, streams, events } = setup(execute);
		agent.beforeToolCall = async () => ({ block: true, reason: "denied" });
		const run = agent.prompt("go");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const message = assistant("blocked");
		await emitCall(streams[0], message, call());
		await vi.waitFor(() => expect(events.some((event) => event.type === "tool_execution_end")).toBe(true));
		finish(streams[0], message);
		await answer(streams, 1);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.find((entry) => entry.role === "toolResult")).not.toHaveProperty("elapsedMs");
		expect(
			events.some(
				(event) =>
					event.type === "message_checkpoint" &&
					event.message.content.some((block) => block.type === "toolCall" && block.executionStarted),
			),
		).toBe(false);
	});

	it("retains a late new-window request until all native work drains", async () => {
		const work = deferred<AgentToolResult>();
		const { agent, streams } = setup(async () => work.promise);
		const prepared: unknown[] = [];
		agent.prepareNextTurnWithContext = async (turn) => {
			prepared.push(turn.newContext);
			return undefined;
		};
		const run = agent.prompt("go");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const first = assistant("first");
		await emitCall(streams[0], first, call());
		finish(streams[0], first);
		await vi.waitFor(() => expect(agent.state.pendingToolCalls.size).toBe(1));
		work.resolve({ ...result, newContext: { handoff: "carry" }, terminate: true });
		await answer(streams, 1);
		await run;
		expect(prepared).toEqual([{ handoff: "carry" }]);
	});

	it.each(
		(["stream end", "response end", "async item"] as const).flatMap((boundary) =>
			[false, true].map((fails) => ({ boundary, fails })),
		),
	)(
		"requires the full native batch to succeed before resetting ($boundary, fails=$fails)",
		async ({ boundary, fails }) => {
			const work = deferred<void>();
			const reset = deferred<void>();
			const resetExecuted = deferred<void>();
			const { agent, streams, inputs, events } = setup(async (_id, args) => {
				if ((args as { path: string }).path === "reset") {
					if (boundary === "async item") await reset.promise;
					resetExecuted.resolve();
					return { ...result, newContext: { handoff: "fresh handoff" } };
				}
				await work.promise;
				if (fails) throw new Error("FAILED_SIBLING_MARKER");
				return result;
			});
			const prepared: unknown[] = [];
			agent.prepareNextTurnWithContext = async ({ newContext, context }) => {
				prepared.push(newContext);
				return newContext
					? {
							context: {
								...context,
								messages: [{ role: "user", content: newContext.handoff ?? "", timestamp: 3 }],
							},
						}
					: undefined;
			};
			const run = agent.prompt("go");
			await vi.waitFor(() => expect(streams).toHaveLength(1));
			const first = assistant("first");
			await emitCall(streams[0], first, call());
			const resetCall: ToolCall =
				boundary === "async item"
					? { ...call("reset"), arguments: { path: "reset" } }
					: { type: "toolCall", id: "reset", name: "work", arguments: { path: "reset" } };
			first.content.push(resetCall);
			streams[0].push({ type: "toolcall_end", contentIndex: 1, toolCall: resetCall, partial: first });
			if (boundary === "response end") {
				first.stopReason = "toolUse";
				streams[0].push({ type: "response_end", message: first });
			} else {
				finish(streams[0], first);
			}
			if (boundary === "async item") {
				await vi.waitFor(() => expect(events.some((event) => event.type === "turn_end")).toBe(true));
				reset.resolve();
			}
			await resetExecuted.promise;
			expect(prepared).toEqual([]);
			if (boundary === "response end") {
				const successor = assistant("successor");
				streams[0].push({ type: "start", partial: successor });
				finish(streams[0], successor);
			}
			work.resolve();
			await answer(streams, 1);
			await run;
			expect(prepared).toEqual([fails ? undefined : { handoff: "fresh handoff" }]);
			expect(JSON.stringify(inputs[1])).toContain(fails ? "FAILED_SIBLING_MARKER" : "fresh handoff");
			expect(inputs[1].filter((message) => message.role === "toolResult")).toHaveLength(fails ? 2 : 0);
			expect(getPendingToolCalls(agent.state.messages)).toEqual([]);
		},
	);

	it.each([true, false])(
		"checks late reset errors in their original response (sameResponse=%s)",
		async (sameResponse) => {
			const reset = deferred<AgentToolResult>();
			const resetExecuted = deferred<void>();
			const { agent, streams, inputs, events } = setup(async (_id, args) => {
				if ((args as { path: string }).path === "reset") {
					const value = await reset.promise;
					resetExecuted.resolve();
					return value;
				}
				throw new Error("FAILED_SIBLING_MARKER");
			});
			const retire = vi.fn();
			const provider = agent.streamFunction;
			agent.streamFunction = (requestModel, context, options) => {
				const { control } = createResponsesControl(model, { model: model.id }, vi.fn(), vi.fn(), retire);
				options?.onResponseControl?.(control);
				return provider(requestModel, context, options);
			};
			const prepared: unknown[] = [];
			agent.prepareNextTurnWithContext = async ({ newContext, context }) => {
				prepared.push(newContext);
				return newContext ? { context: { ...context, messages: [] } } : undefined;
			};
			const run = agent.prompt("go");
			await vi.waitFor(() => expect(streams).toHaveLength(1));
			const first = assistant("first");
			await emitCall(streams[0], first, call());
			const resetCall = { ...call("reset"), arguments: { path: "reset" } };
			if (sameResponse) {
				first.content.push(resetCall);
				streams[0].push({ type: "toolcall_end", contentIndex: 1, toolCall: resetCall, partial: first });
			}
			finish(streams[0], first);
			await vi.waitFor(() => expect(streams).toHaveLength(2));
			expect(JSON.stringify(inputs[1])).toContain("FAILED_SIBLING_MARKER");
			const second = assistant("second");
			if (!sameResponse) await emitCall(streams[1], second, resetCall);
			else streams[1].push({ type: "start", partial: second });
			reset.resolve({ ...result, newContext: { handoff: "late" } });
			await resetExecuted.promise;
			await vi.waitFor(() =>
				expect(
					events.some(
						(event) =>
							event.type === "message_end" &&
							event.message.role === "toolResult" &&
							event.message.toolCallId === resetCall.id,
					),
				).toBe(true),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(retire).toHaveBeenCalledTimes(sameResponse ? 0 : 1);
			finish(streams[1], second);
			await answer(streams, 2);
			await run;
			expect(prepared).toEqual([undefined, sameResponse ? undefined : { handoff: "late" }]);
			expect(JSON.stringify(inputs[2]).includes("FAILED_SIBLING_MARKER")).toBe(sameResponse);
		},
	);

	it.each([false, true])("checks persisted sibling results before a restored reset (fails=%s)", async (fails) => {
		const reset = deferred<AgentToolResult>();
		const execute = vi.fn(async () => result);
		const resume = vi.fn(async () => reset.promise);
		const { agent, streams, inputs, events } = setup(execute, { resume });
		const savedCall = call("saved");
		const resetCall = { ...call("reset"), executionStarted: true };
		agent.state.messages = [
			assistant("saved", [resetCall, savedCall]),
			{
				role: "toolResult",
				toolCallId: savedCall.id,
				toolName: "work",
				content: [{ type: "text", text: fails ? "FAILED_SIBLING_MARKER" : "saved success" }],
				isError: fails,
				timestamp: 2,
			},
		];
		const prepared: unknown[] = [];
		agent.prepareNextTurnWithContext = async ({ newContext, context }) => {
			prepared.push(newContext);
			return newContext ? { context: { ...context, messages: [] } } : undefined;
		};
		const run = agent.continue();
		await answer(streams, 0);
		await vi.waitFor(() => expect(events.some((event) => event.type === "turn_end")).toBe(true));
		reset.resolve({ ...result, newContext: { handoff: "restored" } });
		await answer(streams, 1);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(resume).toHaveBeenCalledOnce();
		expect(prepared).toEqual([fails ? undefined : { handoff: "restored" }]);
		expect(JSON.stringify(inputs[1]).includes("FAILED_SIBLING_MARKER")).toBe(fails);
		expect(inputs[1].filter((message) => message.role === "toolResult")).toHaveLength(fails ? 2 : 0);
	});

	it.each([false, true])("only a successful late reset overrides finishTurn end (fails=%s)", async (fails) => {
		const reset = deferred<AgentToolResult>();
		const atEnd = deferred<void>();
		const { agent, streams } = setup(async (id) => {
			if (id === "reset|fc_reset") return reset.promise;
			if (fails) throw new Error("FAILED_SIBLING_MARKER");
			return result;
		});
		const provider = agent.streamFunction;
		agent.streamFunction = async (...args) => {
			const response = await provider(...args);
			if (streams.length > 1) finish(response, assistant("answer"));
			return response;
		};
		const prepared: unknown[] = [];
		agent.prepareNextTurnWithContext = async ({ newContext }) => {
			prepared.push(newContext);
			return undefined;
		};
		agent.finishTurn = () => {
			atEnd.resolve();
			return { action: "end" };
		};
		const run = agent.prompt("go");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const first = assistant("first");
		await emitCall(streams[0], first, call("reset"));
		first.content.push({ type: "toolCall", id: "sibling", name: "work", arguments: { path: "original" } });
		finish(streams[0], first);
		await atEnd.promise;
		expect(prepared).toEqual([]);
		reset.resolve({ ...result, newContext: { handoff: "late" } });
		await run;
		expect(streams).toHaveLength(fails ? 1 : 2);
		expect(prepared).toEqual(fails ? [] : [{ handoff: "late" }]);
		expect(getPendingToolCalls(agent.state.messages)).toEqual([]);
	});

	it("executes only a completed item after preflight and the durable started barrier, while the response remains open", async () => {
		const invoked = vi.fn<AgentTool["execute"]>(async () => result);
		const { agent, streams, events } = setup(invoked);
		const barrier = deferred<void>();
		agent.beforeToolCall = async ({ args }) => {
			(args as { path: string }).path = "admitted";
			return undefined;
		};
		agent.subscribe(async (event) => {
			if (
				event.type === "message_checkpoint" &&
				event.message.content.some((block) => block.type === "toolCall" && block.executionStarted)
			)
				await barrier.promise;
		});
		const run = agent.prompt("go");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const message = assistant("first");
		const toolCall = call();
		message.content.push(toolCall);
		streams[0].push({ type: "start", partial: message });
		streams[0].push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(invoked).not.toHaveBeenCalled();
		streams[0].push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
		await vi.waitFor(() => expect(events.some((event) => event.type === "tool_execution_prepared")).toBe(true));
		expect(invoked).not.toHaveBeenCalled();
		barrier.resolve();
		await vi.waitFor(() => expect(invoked).toHaveBeenCalledOnce());
		expect(invoked.mock.calls[0]?.[1]).toEqual({ path: "admitted" });
		expect(toolCall.responsesItem?.type === "function_call" && toolCall.responsesItem.arguments).toBe(
			'{"path":"original"}',
		);
		finish(streams[0], message);
		await answer(streams, 1);
		await run;
		expect(
			agent.state.messages.filter((entry) => entry.role === "assistant" && entry.responseId === "first"),
		).toHaveLength(1);
		expect(agent.state.messages.find((entry) => entry.role === "toolResult")).toMatchObject({
			toolCallId: toolCall.id,
			elapsedMs: expect.any(Number),
			content: result.content,
		});
	});

	it("keeps independent steering running and delivers a late original result after a later assistant", async () => {
		const work = deferred<AgentToolResult>();
		const { agent, streams, inputs } = setup(async () => work.promise);
		const run = agent.prompt("go");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const first = assistant("first");
		await emitCall(streams[0], first, call());
		await vi.waitFor(() => expect(agent.state.pendingToolCalls.size).toBe(1));
		finish(streams[0], first);
		agent.steer({ role: "user", content: "independent question", timestamp: 2 });
		await answer(streams, 1);
		expect(inputs[1].some((entry) => entry.role === "toolResult")).toBe(false);
		work.resolve(result);
		await answer(streams, 2);
		await run;
		expect(inputs[2].filter((entry) => entry.role === "toolResult")).toHaveLength(1);
		expect(getPendingToolCalls(agent.state.messages)).toEqual([]);
	});

	it.each(["sequential", "parallel"] as const)(
		"keeps local %s ordering separate from native async",
		async (executionMode) => {
			const work = deferred<AgentToolResult>();
			const invoked = vi.fn(async () => work.promise);
			const { agent, streams } = setup(invoked, { executionMode });
			const run = agent.prompt("go");
			await vi.waitFor(() => expect(streams).toHaveLength(1));
			const first = assistant("first");
			await emitCall(streams[0], first, call());
			await vi.waitFor(() => expect(invoked).toHaveBeenCalledOnce());
			const second = call("second");
			first.content.push(second);
			streams[0].push({ type: "toolcall_end", contentIndex: 1, toolCall: second, partial: first });
			if (executionMode === "parallel") await vi.waitFor(() => expect(invoked).toHaveBeenCalledTimes(2));
			else expect(invoked).toHaveBeenCalledOnce();
			work.resolve(result);
			await vi.waitFor(() => expect(invoked).toHaveBeenCalledTimes(2));
			finish(streams[0], first);
			await answer(streams, 1);
			await run;
		},
	);

	it.each([
		{ boundary: "async item", earlier: "parallel", global: false },
		{ boundary: "async item", earlier: "sequential", global: false },
		{ boundary: "stream end", earlier: "sequential", global: false },
		{ boundary: "response end", earlier: "parallel", global: false },
		{ boundary: "async item", earlier: "parallel", global: true },
		{ boundary: "stream end", earlier: "parallel", global: true },
	] as const)(
		"scopes sequential ordering across responses ($boundary, earlier=$earlier, global=$global)",
		async ({ boundary, earlier, global }) => {
			const work = deferred<AgentToolResult>();
			const invoked = vi.fn(async () => work.promise);
			const changed = vi.fn(async () => result);
			const { agent, streams, events, tool } = setup(invoked, { executionMode: earlier });
			if (global) agent.toolExecution = "sequential";
			agent.state.tools = [tool, { ...tool, name: "change_dir", executionMode: "sequential", execute: changed }];
			const provider = agent.streamFunction;
			agent.streamFunction = async (...args) => {
				const response = await provider(...args);
				if (streams.length > 2) {
					finish(response, assistant(`answer-${streams.length}`, [{ type: "text", text: "done" }]));
				}
				return response;
			};
			const second = assistant("directory");
			const run = agent.prompt("delegate work");
			try {
				await vi.waitFor(() => expect(streams).toHaveLength(1));
				const first = assistant("delegate");
				await emitCall(streams[0], first, call());
				await vi.waitFor(() => expect(invoked).toHaveBeenCalledOnce());
				finish(streams[0], first);
				agent.steer({ role: "user", content: "change directory while work continues", timestamp: 2 });
				await vi.waitFor(() => expect(streams).toHaveLength(2));
				const change = { ...call("directory"), name: "change_dir", async: boundary === "async item" };
				if (change.responsesItem?.type === "function_call") {
					change.responsesItem.name = "change_dir";
					change.responsesItem.async = change.async;
				}
				await emitCall(streams[1], second, change);
				if (boundary === "response end") {
					second.stopReason = "toolUse";
					streams[1].push({ type: "response_end", message: second });
					const successor = assistant("successor", [{ type: "text", text: "done" }]);
					streams[1].push({ type: "start", partial: successor });
					finish(streams[1], successor);
				} else if (boundary === "stream end") {
					finish(streams[1], second);
				}
				await vi.waitFor(() =>
					expect(
						events.some(
							(event) =>
								(event.type === "message_checkpoint" || event.type === "message_end") &&
								event.message.role === "assistant" &&
								event.message.responseId === second.responseId,
						),
					).toBe(true),
				);
				if (global) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(changed).not.toHaveBeenCalled();
				} else {
					await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce(), { timeout: 200 });
				}
			} finally {
				work.resolve(result);
				if (boundary === "async item") {
					await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
					finish(streams[1], second);
				}
				await run;
			}
			expect(invoked).toHaveBeenCalledOnce();
			expect(changed).toHaveBeenCalledOnce();
			expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
			expect(getPendingToolCalls(agent.state.messages)).toEqual([]);
		},
	);

	it.each(
		(["stream end", "response end"] as const).flatMap((boundary) =>
			(
				[
					{ global: "parallel", before: "sequential", native: "parallel", incomplete: false },
					{ global: "parallel", before: "parallel", native: "sequential", incomplete: false },
					{ global: "sequential", before: "parallel", native: "parallel", incomplete: false },
					{ global: "parallel", before: "sequential", native: "parallel", incomplete: true },
					{ global: "sequential", before: "parallel", native: "parallel", incomplete: true },
				] as const
			).map((modes) => ({ boundary, ...modes })),
		),
	)(
		"orders synchronous and native async siblings ($boundary, global=$global, before=$before, native=$native, incomplete=$incomplete)",
		async ({ boundary, global, before, native, incomplete }) => {
			const work = deferred<AgentToolResult>();
			const order: string[] = [];
			let cwd = "original";
			const { agent, streams, events, tool } = setup(
				async () => {
					order.push(`write:${cwd}`);
					return work.promise;
				},
				{ executionMode: native },
			);
			agent.toolExecution = global;
			agent.state.tools = [
				tool,
				{
					...tool,
					name: "change_dir",
					async: false,
					executionMode: before,
					execute: async () => {
						cwd = "requested";
						order.push("change_dir");
						return result;
					},
				},
			];
			const provider = agent.streamFunction;
			agent.streamFunction = async (...args) => {
				const response = await provider(...args);
				if (streams.length > 1) finish(response, assistant(`answer-${streams.length}`));
				return response;
			};
			const run = agent.prompt("change directory, then write");
			await vi.waitFor(() => expect(streams).toHaveLength(1));
			const first = assistant("mixed");
			const change: ToolCall = {
				type: "toolCall",
				id: "change",
				name: "change_dir",
				arguments: { path: "requested" },
			};
			if (incomplete) {
				first.content.push(change);
				streams[0].push({ type: "start", partial: first });
				streams[0].push({ type: "toolcall_start", contentIndex: 0, partial: first });
			} else await emitCall(streams[0], first, change);
			const write = call("write");
			first.content.push(write);
			streams[0].push({ type: "toolcall_end", contentIndex: 1, toolCall: write, partial: first });
			try {
				await vi.waitFor(() => expect(events.filter((event) => event.type === "message_update")).toHaveLength(2));
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect.soft(order).toEqual([]);
				if (incomplete)
					streams[0].push({ type: "toolcall_end", contentIndex: 0, toolCall: change, partial: first });
				if (boundary === "response end") {
					first.stopReason = "toolUse";
					streams[0].push({ type: "response_end", message: first });
					const successor = assistant("successor", [{ type: "text", text: "while write runs" }]);
					streams[0].push({ type: "start", partial: successor });
					finish(streams[0], successor);
					await vi.waitFor(() =>
						expect(
							events.some(
								(event) =>
									event.type === "message_end" &&
									event.message.role === "assistant" &&
									event.message.responseId === "successor",
							),
						).toBe(true),
					);
				} else {
					finish(streams[0], first);
					agent.steer({ role: "user", content: "independent question", timestamp: 2 });
					await vi.waitFor(() => expect(streams.length).toBeGreaterThan(1));
				}
				expect(order).toEqual(["change_dir", "write:requested"]);
			} finally {
				work.resolve(result);
				await run;
			}
			expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		},
	);

	it.each(["blocked", "error", "length"] as const)(
		"preserves mixed-call failure behavior when the synchronous predecessor is %s",
		async (outcome) => {
			const execute = vi.fn(async () => result);
			const { agent, streams, events, tool } = setup(execute);
			agent.state.tools = [
				tool,
				{
					...tool,
					name: "change_dir",
					async: false,
					executionMode: "sequential",
					execute: async () => {
						throw new Error("directory unavailable");
					},
				},
			];
			agent.beforeToolCall = async ({ toolCall }) =>
				outcome === "blocked" && toolCall.name === "change_dir" ? { block: true } : undefined;
			const provider = agent.streamFunction;
			agent.streamFunction = async (...args) => {
				const response = await provider(...args);
				if (streams.length > 1) finish(response, assistant(`answer-${streams.length}`));
				return response;
			};
			const run = agent.prompt("change directory, then write");
			await vi.waitFor(() => expect(streams).toHaveLength(1));
			const first = assistant("mixed");
			await emitCall(streams[0], first, {
				type: "toolCall",
				id: "change",
				name: "change_dir",
				arguments: { path: "requested" },
			});
			const write = call("write");
			first.content.push(write);
			streams[0].push({ type: "toolcall_end", contentIndex: 1, toolCall: write, partial: first });
			if (outcome === "length") {
				first.stopReason = "length";
				streams[0].push({ type: "done", reason: "length", message: first });
				streams[0].end();
			} else finish(streams[0], first);
			await run;
			expect(execute).toHaveBeenCalledTimes(outcome === "length" ? 0 : 1);
			expect(events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolCallId)).toEqual(
				["change", write.id],
			);
			expect(agent.state.messages.filter((message) => message.role === "toolResult")).toMatchObject([
				{ toolCallId: "change", isError: true },
				{ toolCallId: write.id, isError: outcome === "length" },
			]);
		},
	);

	it("detaches only after abort, preserves the anchor, then resumes once with admitted args", async () => {
		const execute = vi.fn(async (_id, _args, signal?: AbortSignal) => {
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { ...result, pending: true };
		});
		const resume = vi.fn<NonNullable<AgentTool["resume"]>>(async () => result);
		const { agent, streams, inputs, events } = setup(execute, { resume });
		const before = vi.fn(async ({ args }: { args: unknown }) => {
			(args as { path: string }).path = "admitted";
			return undefined;
		});
		agent.beforeToolCall = before;
		const run = agent.prompt("go");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const first = assistant("first");
		await emitCall(streams[0], first, call());
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		finish(streams[0], first);
		agent.abort();
		await run;
		expect(events.filter((event) => event.type === "tool_execution_detached")).toHaveLength(1);
		expect(agent.state.messages.some((entry) => entry.role === "toolResult")).toBe(false);
		expect(getPendingToolCalls(agent.state.messages)).toMatchObject([{ state: "detached" }]);
		const continuation = agent.continue();
		await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
		expect(resume.mock.calls[0]?.[1]).toEqual({ path: "admitted" });
		await answer(streams, 1);
		if (!inputs[1].some((message) => message.role === "toolResult")) await answer(streams, 2);
		await continuation;
		expect(execute).toHaveBeenCalledOnce();
		expect(before).toHaveBeenCalledOnce();
		expect(agent.state.messages.filter((entry) => entry.role === "toolResult")).toHaveLength(1);
	});

	it("joins earlier restored work when a later admission checkpoint fails", async () => {
		const started = deferred<void>();
		const released = deferred<AgentToolResult>();
		const failed = deferred<void>();
		const resume = vi.fn<NonNullable<AgentTool["resume"]>>(async () => {
			started.resolve();
			return released.promise;
		});
		const { agent, events, tool } = setup(
			async () => {
				throw new Error("Must never execute again");
			},
			{ namespace: "records", resume },
		);
		agent.state.tools = [
			{
				...tool,
				namespace: "other",
				resume: async () => {
					throw new Error("Wrong namespace");
				},
			},
			tool,
		];
		const first = { ...call("first"), namespace: "records", executionStarted: true };
		const second = { ...call("second"), namespace: "records", executionStarted: true };
		agent.state.messages = [assistant("saved", [first, second])];
		agent.subscribe(async (event) => {
			if (
				event.type === "message_checkpoint" &&
				event.message.content.some(
					(block) => block.type === "toolCall" && block.id === second.id && block.executionStarted,
				)
			) {
				await started.promise;
				failed.resolve();
				throw new Error("checkpoint persistence failed");
			}
		});
		let settled = false;
		const run = agent.continue().then(() => {
			settled = true;
		});
		await failed.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(agent.state.isStreaming).toBe(true);
		expect(events.some((event) => event.type === "agent_end")).toBe(false);
		released.resolve(result);
		await run;
		expect(resume).toHaveBeenCalledOnce();
		expect(agent.state.errorMessage).toBe("checkpoint persistence failed");
		expect(agent.state.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ toolCallId: first.id, namespace: "records", content: result.content },
		]);
		for (const type of ["tool_execution_start", "tool_execution_prepared", "tool_execution_end"] as const)
			expect(events.find((event) => event.type === type)).toMatchObject({
				namespace: "records",
				toolCallId: first.id,
			});
	});

	it("never executes a journaled started call without resume", async () => {
		const execute = vi.fn(async () => result);
		const { agent, streams, inputs } = setup(execute);
		const toolCall = { ...call(), executionStarted: true };
		agent.state.messages = [assistant("saved", [toolCall])];
		const run = agent.continue();
		await answer(streams, 0);
		if (!inputs[0].some((message) => message.role === "toolResult")) await answer(streams, 1);
		await run;
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.find((entry) => entry.role === "toolResult")).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("outcome is unknown") }],
		});
	});
});
