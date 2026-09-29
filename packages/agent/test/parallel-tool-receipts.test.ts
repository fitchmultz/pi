import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentTool } from "../src/types.ts";

it.each(["message_start", "message_end", "tool_execution_end", "none"] as const)(
	"retains completed parallel receipts without replay after %s callback failure",
	async (fault) => {
		const effects = [0, 0];
		const tools: AgentTool[] = effects.map((_, index) => ({
			name: `effect${index}`,
			label: `Effect ${index}`,
			description: "Record an irreversible effect",
			parameters: Type.Object({}),
			execute: async () => {
				effects[index]++;
				return { content: [{ type: "text", text: `receipt${index}` }], details: { index } };
			},
		}));
		const response: AssistantMessage = {
			role: "assistant",
			content: tools.map((tool, index) => ({
				type: "toolCall",
				id: `call${index}`,
				name: tool.name,
				arguments: {},
			})),
			api: "openai-responses",
			provider: "openai",
			model: "offline",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
		let requests = 0;
		const agent = new Agent({
			initialState: { tools },
			streamFn: () => {
				requests++;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message: response });
				return stream;
			},
			finishTurn: () => ({ action: "end" }),
		});
		const receiptEvents: string[] = [];
		const failure = new Error(`original ${fault} failure`);
		agent.subscribe(async (event) => {
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
				receiptEvents.push(`${event.type}:${event.message.toolCallId}`);
				if (event.type === fault) throw event.message.toolCallId === "call0" ? failure : new Error("later failure");
			}
			if (event.type === "tool_execution_end" && fault === event.type) {
				throw event.toolCallId === "call0" ? failure : new Error("later failure");
			}
		});
		await agent.prompt("Perform both effects");
		await agent.waitForIdle();
		expect(effects).toEqual([1, 1]);
		expect(requests).toBe(1);
		expect(agent.state.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ toolCallId: "call0", content: [{ type: "text", text: "receipt0" }], isError: false },
			{ toolCallId: "call1", content: [{ type: "text", text: "receipt1" }], isError: false },
		]);
		expect(receiptEvents).toEqual([
			"message_start:call0",
			"message_end:call0",
			"message_start:call1",
			"message_end:call1",
		]);
		expect(agent.state.errorMessage).toBe(fault === "none" ? undefined : failure.message);
		expect(agent.state.isStreaming).toBe(false);
	},
);

it.each(["sequential", "parallel", "parallel-running"] as const)(
	"closes every accepted %s tool call after abort without running canceled effects",
	async (mode) => {
		const hooks: string[] = [];
		const tools: AgentTool[] = ["a", "b", "c"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			prepareArguments(args) {
				hooks.push(`prepare:${name}`);
				return args as Record<string, never>;
			},
			async execute() {
				hooks.push(`execute:${name}`);
				if (mode === "sequential" || (mode === "parallel-running" && name === "b")) agent.abort();
				return { content: [{ type: "text", text: `receipt:${name}` }], details: {} };
			},
		}));
		const response: AssistantMessage = {
			role: "assistant",
			content: tools.map((tool) => ({ type: "toolCall", id: tool.name, name: tool.name, arguments: {} })),
			api: "openai-responses",
			provider: "openai",
			model: "offline",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
		let requests = 0;
		const agent = new Agent({
			initialState: { tools },
			toolExecution: mode === "sequential" ? "sequential" : "parallel",
			streamFn: () => {
				requests++;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message: response });
				return stream;
			},
			beforeToolCall: async ({ toolCall }) => {
				hooks.push(`before:${toolCall.id}`);
				if (mode === "parallel" && toolCall.id === "b") agent.abort();
				return undefined;
			},
			afterToolCall: async ({ toolCall }) => {
				hooks.push(`after:${toolCall.id}`);
				return undefined;
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end") events.push(`end:${event.toolCallId}`);
			if (event.type === "message_end" && event.message.role === "toolResult") {
				events.push(`message:${event.message.toolCallId}`);
			}
		});
		await agent.prompt("Run tools");
		await agent.waitForIdle();
		const receipts = agent.state.messages.filter((message) => message.role === "toolResult");
		expect(receipts.map((message) => message.toolCallId)).toEqual(["a", "b", "c"]);
		expect(receipts.map((message) => [message.isError, message.content])).toEqual(
			mode === "sequential"
				? [
						[false, [{ type: "text", text: "receipt:a" }]],
						[true, [{ type: "text", text: "Operation aborted" }]],
						[true, [{ type: "text", text: "Operation aborted" }]],
					]
				: mode === "parallel-running"
					? [
							[false, [{ type: "text", text: "receipt:a" }]],
							[false, [{ type: "text", text: "receipt:b" }]],
							[true, [{ type: "text", text: "Operation aborted" }]],
						]
					: ["a", "b", "c"].map(() => [true, [{ type: "text", text: "Operation aborted" }]]),
		);
		expect(events.filter((event) => event.startsWith("end:")).sort()).toEqual(["end:a", "end:b", "end:c"]);
		expect(events.filter((event) => event.startsWith("message:"))).toEqual(["message:a", "message:b", "message:c"]);
		expect(hooks).toEqual(
			mode === "sequential"
				? ["prepare:a", "before:a", "execute:a", "after:a"]
				: mode === "parallel-running"
					? [
							"prepare:a",
							"before:a",
							"prepare:b",
							"before:b",
							"prepare:c",
							"before:c",
							"execute:a",
							"execute:b",
							"after:a",
							"after:b",
						]
					: ["prepare:a", "before:a", "prepare:b", "before:b"],
		);
		expect(requests).toBe(1);
	},
);
