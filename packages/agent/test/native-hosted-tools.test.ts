import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { BetaResponsesClientEvent } from "openai/resources/beta/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream } from "../../ai/src/api/openai-responses.ts";
import { convertResponsesMessages } from "../../ai/src/api/openai-responses-shared.ts";
import { normalizeContext, snapshotResponsesContent } from "../../ai/src/utils/transcript.ts";
import { createResponsesServer, replyWithOutput, textOutput } from "../../ai/test/responses-websocket-server.ts";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentTool } from "../src/types.ts";

const caller = { type: "program", caller_id: "program" };
const program = {
	type: "program",
	id: "prog",
	call_id: "program",
	code: "text(await tools.read({}));",
	fingerprint: "opaque",
};
const call = (id: string, agent = "/root") => ({
	type: "function_call",
	id: `fc_${id}`,
	call_id: id,
	name: "read",
	arguments: "{}",
	status: "completed",
	caller,
	agent: { agent_name: agent },
});
const result = { content: [{ type: "text" as const, text: '{"value":3}' }], details: undefined };
function tool(execute = vi.fn(async () => result)): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Read",
		parameters: Type.Object({}),
		allowedCallers: ["direct", "programmatic"],
		execute,
	};
}
function setup(
	server: Awaited<ReturnType<typeof createResponsesServer>>,
	tools: AgentTool[],
	hosted: "program" | "multi",
	transport: "sse" | "websocket" = "sse",
) {
	const events: AgentEvent[] = [];
	const agent = new Agent({
		initialState: { model: server.model, tools },
		streamFn: (_model, context, options) =>
			stream(server.model, context, {
				...options,
				apiKey: "local-fixture",
				transport,
				maxRetries: 0,
				timeoutMs: 1500,
				onPayload: (payload) => {
					const body = payload as { tools: unknown[]; multi_agent?: { enabled: true } };
					if (hosted === "program") body.tools.push({ type: "programmatic_tool_calling" });
					else body.multi_agent = { enabled: true };
				},
			}),
	});
	agent.subscribe((event) => {
		events.push(structuredClone(event));
	});
	return { agent, events };
}

describe("hosted tool execution", () => {
	it("admits and injects child native search while the hosted response waits, preserving replay and loaded namespaces", async () => {
		const searchItem = {
			type: "tool_search_call",
			id: "ts",
			call_id: "search",
			execution: "client",
			status: "completed",
			arguments: {},
			agent: { agent_name: "/root/child" },
		};
		const output: Record<string, unknown>[] = [searchItem];
		const injections: Extract<BetaResponsesClientEvent, { type: "response.inject" }>[] = [];
		const server = await createResponsesServer((request) => {
			const event = request.body as BetaResponsesClientEvent;
			if (event.type !== "response.inject") {
				request.send({ type: "response.created", response: { id: "active", status: "in_progress" } });
				request.send({ type: "response.output_item.done", output_index: 0, item: searchItem });
				return;
			}
			injections.push(event);
			expect(event.response_id).toBe("active");
			request.send({ type: "response.inject.created", response_id: "active", sequence_number: injections.length });
			if (injections.length === 1) {
				const searchOutput = event.input.find((item) => item.type === "tool_search_output");
				expect(searchOutput).toMatchObject({ call_id: "search", execution: "client", status: "completed" });
				const namespace = searchOutput!.tools[0];
				if (namespace.type !== "namespace") throw new Error("Expected search-loaded wire namespace");
				expect(namespace.tools[0]).toMatchObject({
					name: "read",
					allowed_callers: ["direct", "programmatic"],
					output_schema: { type: "object" },
				});
				output.push(program, { ...call("loaded", "/root/child"), namespace: namespace.name });
				for (const index of [1, 2])
					request.send({ type: "response.output_item.done", output_index: index, item: output[index] });
			} else {
				expect(event.input).toEqual([
					{ type: "function_call_output", call_id: "loaded", caller, output: '{"value":3}' },
				]);
				output.push(textOutput("final"));
				request.send({ type: "response.completed", response: { id: "active", status: "completed", output } });
			}
		});
		try {
			server.model.compat = { supportsToolSearch: true };
			const read = { ...tool(), outputSchema: { type: "object" } };
			const searchExecute = vi.fn(async () => {
				agent.state.tools = [search, read];
				expect(
					events.some(
						(event) =>
							event.type === "message_checkpoint" &&
							event.message.content.some(
								(part) => part.type === "toolCall" && part.kind === "toolSearch" && part.executionStarted,
							),
					),
				).toBe(true);
				return {
					content: [{ type: "text" as const, text: "loaded read" }],
					details: undefined,
					tools: [{ name: "read" }],
				};
			});
			const search: AgentTool = {
				name: "search",
				label: "Search",
				description: "Search",
				parameters: Type.Object({}),
				toolSearch: true,
				execute: searchExecute,
			};
			const { agent, events } = setup(server, [search], "multi", "websocket");
			const before = vi.fn(async () => undefined);
			agent.beforeToolCall = before;
			await agent.prompt("go");
			expect(server.errors).toEqual([]);
			expect(agent.state.errorMessage).toBeUndefined();
			expect(searchExecute).toHaveBeenCalledOnce();
			expect(read.execute).toHaveBeenCalledOnce();
			expect(before).toHaveBeenCalledTimes(2);
			expect(injections).toHaveLength(2);
			expect(server.requests).toHaveLength(3);
			const answer = agent.state.messages.find(
				(message): message is AssistantMessage => message.role === "assistant" && message.responseId === "active",
			)!;
			const results = agent.state.messages.filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			const replay = convertResponsesMessages(
				server.model,
				normalizeContext({ messages: [JSON.parse(JSON.stringify(answer)), ...results] }),
				new Set(["openai"]),
				{ supportsToolSearch: true },
			);
			expect(replay.filter((item) => item.type === "tool_search_call")).toEqual([searchItem]);
			expect(replay.filter((item) => item.type === "tool_search_output")).toHaveLength(1);
			expect(replay.filter((item) => item.type === "function_call_output")).toHaveLength(1);
			expect(JSON.stringify(replay).match(/loaded read/g)).toHaveLength(1);
		} finally {
			await server.close();
		}
	});

	it("loads an eligible tool through native search and calls it from a later program using its wire namespace", async () => {
		let turn = 0;
		const server = await createResponsesServer((request) => {
			if (turn++ === 0) {
				replyWithOutput(request, "search", [
					{
						type: "tool_search_call",
						id: "ts",
						call_id: "search",
						execution: "client",
						status: "completed",
						arguments: {},
					},
				]);
			} else if (turn === 2) {
				const input = request.body.input as {
					type: string;
					tools?: { type: string; name: string; tools: unknown[] }[];
				}[];
				const namespace = input.find((item) => item.type === "tool_search_output")!.tools![0];
				expect(namespace.tools[0]).toMatchObject({
					name: "read",
					allowed_callers: ["direct", "programmatic"],
					output_schema: { type: "object" },
				});
				replyWithOutput(request, "program", [program, { ...call("loaded"), namespace: namespace.name }]);
			} else replyWithOutput(request, "final", [textOutput("final")]);
		});
		try {
			server.model.compat = { supportsToolSearch: true };
			const read = { ...tool(), outputSchema: { type: "object" } };
			const search: AgentTool = {
				name: "search",
				label: "Search",
				description: "Search",
				parameters: Type.Object({}),
				toolSearch: true,
				execute: async () => {
					agent.state.tools = [search, read];
					return { content: [], details: undefined, tools: [{ name: "read" }] };
				},
			};
			const { agent } = setup(server, [search], "program");
			await agent.prompt("go");
			expect(agent.state.errorMessage).toBeUndefined();
			expect(read.execute).toHaveBeenCalledOnce();
			expect(turn).toBe(3);
			const input = server.requests[2].body.input as { type: string; call_id?: string; caller?: unknown }[];
			expect(
				input.find((item) => item.type === "function_call_output" && item.call_id === "loaded")?.caller,
			).toEqual(caller);
		} finally {
			await server.close();
		}
	});

	it("continues multiple program pauses and program-only responses through existing hooks", async () => {
		let turn = 0;
		const server = await createResponsesServer((request) => {
			const outputs = [
				[program, call("one"), call("two")],
				[{ type: "program_output", id: "po", call_id: "program", result: "3", status: "completed" }],
				[{ ...textOutput("comment", "checking"), phase: "commentary" }, program, call("three")],
				[textOutput("final", "answer")],
			];
			replyWithOutput(request, `resp_${turn}`, outputs[turn++]);
		});
		try {
			const read = tool();
			const { agent, events } = setup(server, [read], "program");
			const before = vi.fn(async () => undefined);
			agent.beforeToolCall = before;
			await agent.prompt("go");
			expect(agent.state.errorMessage).toBeUndefined();
			expect(turn).toBe(4);
			expect(read.execute).toHaveBeenCalledTimes(3);
			expect(before).toHaveBeenCalledTimes(3);
			const outputs = (server.requests[3].body.input as { type: string; caller?: unknown }[]).filter(
				(item) => item.type === "function_call_output",
			);
			expect(outputs).toHaveLength(3);
			expect(outputs.every((item) => JSON.stringify(item.caller) === JSON.stringify(caller))).toBe(true);
			expect(
				events.filter(
					(event) =>
						event.type === "message_checkpoint" &&
						event.message.content.some((part) => part.type === "toolCall" && part.executionStarted),
				),
			).toHaveLength(3);
		} finally {
			await server.close();
		}
	});

	it("blocks program access to direct-only tools locally", async () => {
		let turn = 0;
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, `resp_${turn}`, turn++ === 0 ? [program, call("blocked")] : [textOutput("final")]),
		);
		try {
			const read = { ...tool(), allowedCallers: undefined };
			const { agent } = setup(server, [read], "program");
			await agent.prompt("go");
			expect(read.execute).not.toHaveBeenCalled();
			expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
				isError: true,
				content: [{ type: "text", text: expect.stringContaining("does not permit programmatic") }],
			});
		} finally {
			await server.close();
		}
	});

	it("executes child/root HTTP calls and carries collaboration state into continuation", async () => {
		let turn = 0;
		const child = { ...textOutput("child", "child private answer"), agent: { agent_name: "/root/child" } };
		const server = await createResponsesServer((request) =>
			replyWithOutput(
				request,
				`resp_${turn}`,
				turn++ === 0
					? [program, call("child", "/root/child"), call("root"), child]
					: [textOutput("final", "root answer")],
			),
		);
		try {
			const read = tool();
			const { agent } = setup(server, [read], "multi");
			await agent.prompt("go");
			expect(read.execute).toHaveBeenCalledTimes(2);
			expect(
				agent.state.messages
					.filter((message) => message.role === "assistant")
					.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text)),
			).toEqual(["root answer"]);
			expect(server.requests[1].body.input).toContainEqual(child);
		} finally {
			await server.close();
		}
	});

	it.each(["ack", "late", "disconnect"] as const)(
		"handles %s injection without repeating execution",
		async (outcome) => {
			const callItem = call("work", "/root/child");
			let creates = 0;
			let injections = 0;
			const server = await createResponsesServer((request) => {
				const event = request.body as BetaResponsesClientEvent;
				if (event.type === "response.inject") {
					injections++;
					expect(event.response_id).toBe("active");
					expect(event.input).toEqual([
						{ type: "function_call_output", call_id: "work", caller, output: '{"value":3}' },
					]);
					if (outcome === "disconnect") {
						request.socket!.terminate();
						return;
					}
					const final = textOutput("root", "root answer");
					const output = outcome === "late" ? [program, callItem] : [program, callItem, final];
					request.send({ type: "response.completed", response: { id: "active", status: "completed", output } });
					// Acknowledgement intentionally arrives after completion and final output.
					request.send(
						outcome === "ack"
							? { type: "response.inject.created", response_id: "active", sequence_number: 9 }
							: {
									type: "response.inject.failed",
									response_id: "active",
									sequence_number: 9,
									input: event.input,
									error: { code: "response_already_completed", message: "late" },
								},
					);
					return;
				}
				if (creates++ > 0) {
					replyWithOutput(request, "continued", [textOutput("final")]);
					return;
				}
				request.send({ type: "response.created", response: { id: "active", status: "in_progress" } });
				for (const [output_index, item] of [program, callItem].entries())
					request.send({ type: "response.output_item.done", output_index, item });
			});
			try {
				const read = tool();
				const { agent } = setup(server, [read], "multi", "websocket");
				await agent.prompt("go");
				if (outcome === "disconnect") {
					expect(agent.state.errorMessage).toBeDefined();
					// Durable transcript reload; the side effect already has a saved result.
					agent.state.messages = JSON.parse(JSON.stringify(agent.state.messages));
					await agent.prompt("continue");
				}
				expect(agent.state.errorMessage).toBeUndefined();
				expect(read.execute).toHaveBeenCalledOnce();
				expect(injections).toBe(1);
				expect(creates).toBe(outcome === "ack" ? 1 : 2);
				const first = agent.state.messages.find(
					(message): message is AssistantMessage =>
						message.role === "assistant" && message.responseId === "active",
				)!;
				const results = agent.state.messages.filter(
					(message): message is ToolResultMessage => message.role === "toolResult",
				);
				const replay = convertResponsesMessages(
					server.model,
					normalizeContext({ messages: [first, ...results] }),
					new Set(["openai"]),
				);
				expect(replay.filter((item) => item.type === "function_call_output")).toHaveLength(1);
				if (outcome === "ack")
					expect(replay.map((item) => item.type)).toEqual([
						"program",
						"function_call",
						"function_call_output",
						"message",
					]);
				expect(server.requests[0].headers["openai-beta"]).toContain("responses_multi_agent=v1");
			} finally {
				await server.close();
			}
		},
	);

	it("tracks two outstanding injection acknowledgements and continues only the rejected result", async () => {
		let creates = 0;
		const injections: Extract<BetaResponsesClientEvent, { type: "response.inject" }>[] = [];
		const firstCall = call("one", "/root/child");
		const secondCall = call("two");
		const server = await createResponsesServer((request) => {
			const event = request.body as BetaResponsesClientEvent;
			if (event.type === "response.inject") {
				injections.push(event);
				if (injections.length < 2) return;
				request.send({
					type: "response.completed",
					response: { id: "active", status: "completed", output: [program, firstCall, secondCall] },
				});
				// Fail the second batch first; failures identify their input, successes are FIFO.
				request.send({
					type: "response.inject.failed",
					response_id: "active",
					sequence_number: 9,
					input: injections[1].input,
					error: { code: "response_already_completed", message: "late" },
				});
				request.send({ type: "response.inject.created", response_id: "active", sequence_number: 10 });
				return;
			}
			if (creates++ > 0) {
				replyWithOutput(request, "final", [textOutput("final")]);
				return;
			}
			request.send({ type: "response.created", response: { id: "active", status: "in_progress" } });
			for (const [output_index, item] of [program, firstCall, secondCall].entries())
				request.send({ type: "response.output_item.done", output_index, item });
		});
		try {
			const read = tool();
			const { agent } = setup(server, [read], "multi", "websocket");
			await agent.prompt("go");
			expect(agent.state.errorMessage).toBeUndefined();
			expect(read.execute).toHaveBeenCalledTimes(2);
			expect(creates).toBe(2);
			expect(injections).toHaveLength(2);
			const input = server.requests.at(-1)!.body.input as { type: string; call_id?: string }[];
			expect(
				input
					.filter((item) => item.type === "function_call_output")
					.map((item) => item.call_id)
					.sort(),
			).toEqual(["one", "two"]);
		} finally {
			await server.close();
		}
	});

	it("resumes a persisted program-only tail and never repeats an admitted call with unknown outcome", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, "final", [textOutput("answer")]),
		);
		try {
			const read = tool();
			const { agent } = setup(server, [read], "program");
			const saved = await stream(
				server.model,
				normalizeContext({ messages: [{ role: "user", content: "seed", timestamp: 1 }] }),
				{ apiKey: "fixture", transport: "sse" },
			).result();
			saved.content = [];
			saved.responsesContent = [];
			saved.responsesOutput = [program as NonNullable<AssistantMessage["responsesOutput"]>[number]];
			saved.needsContinuation = true;
			agent.state.messages = [saved];
			await agent.continue();
			expect(agent.state.errorMessage).toBeUndefined();
			const item = call("lost");
			const pending: ToolCall = {
				type: "toolCall",
				id: "lost|fc_lost",
				name: "read",
				arguments: {},
				streaming: true,
				executionStarted: true,
				responsesItem: item as ToolCall["responsesItem"],
			};
			agent.state.messages = [
				{
					...saved,
					content: [pending],
					responsesContent: snapshotResponsesContent([pending]),
					stopReason: "error",
					responsesOutput: [program, item] as AssistantMessage["responsesOutput"],
				},
			];
			await agent.continue();
			expect(read.execute).not.toHaveBeenCalled();
			expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
				isError: true,
				content: [{ type: "text", text: expect.stringContaining("outcome is unknown") }],
			});
			// A complete saved candidate still goes through admission once, and synchronous results precede any request.
			server.model.compat = { supportsAsyncTools: true };
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const execute = vi.fn<AgentTool["execute"]>(async () => {
				await gate;
				return result;
			});
			agent.state.tools = [{ ...read, execute }];
			agent.state.messages = [
				{
					...saved,
					stopReason: "pending",
					content: [{ ...pending, executionStarted: undefined }],
					responsesContent: snapshotResponsesContent([pending]),
					responsesOutput: [program, item] as AssistantMessage["responsesOutput"],
				},
			];
			const before = server.requests.length;
			const resumed = agent.continue();
			try {
				await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
				expect(server.requests).toHaveLength(before);
			} finally {
				release();
				await resumed;
			}
			expect(agent.state.errorMessage).toBeUndefined();
			expect(JSON.stringify(server.requests.at(-1)!.body.input)).not.toContain("No result provided");
		} finally {
			await server.close();
		}
	});
});
