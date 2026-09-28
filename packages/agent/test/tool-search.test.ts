import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentTools,
	type Model,
	type ToolCall,
	type ToolReference,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentTool } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function response(content: AssistantMessage["content"]) {
	const stream = createAssistantMessageEventStream();
	const reason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
	stream.push({
		type: "done",
		reason,
		message: {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: reason,
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	});
	return stream;
}

describe.each(["sequential", "parallel"] as const)("%s tool revocation", (toolExecution) => {
	it.each(["schema", "executor", "both"] as const)(
		"rejects in-place %s mutation during preparation",
		async (mutation) => {
			let executions = 0;
			const tool: AgentTool = {
				name: "mutable",
				label: "Mutable",
				description: "Original",
				parameters: Type.Object({}),
				async execute() {
					executions++;
					return { content: [], details: {} };
				},
			};
			let requests = 0;
			const agent = new Agent({
				initialState: { model, tools: [tool] },
				toolExecution,
				beforeToolCall: async () => {
					if (mutation !== "executor") {
						Object.assign(tool.parameters, {
							properties: { requiredValue: { type: "string" } },
							required: ["requiredValue"],
						});
					}
					if (mutation !== "schema")
						tool.execute = async () => {
							executions++;
							return { content: [], details: {} };
						};
					return undefined;
				},
				streamFn: () =>
					response(
						requests++ === 0 ? [{ type: "toolCall", id: "mutable-call", name: tool.name, arguments: {} }] : [],
					),
			});
			await agent.prompt("Use the tool");
			expect(executions).toBe(0);
			expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
				isError: true,
				content: [{ type: "text", text: expect.stringContaining("changed before execution") }],
			});
		},
	);

	it.each(["generation", "beforeToolCall", "prepared-event"] as const)(
		"rejects a formerly advertised tool revoked during %s",
		async (boundary) => {
			let executions = 0;
			const tool: AgentTool = {
				name: "revoked",
				label: "Revoked",
				description: "Initially permitted",
				parameters: Type.Object({}),
				async execute() {
					executions++;
					return { content: [], details: {} };
				},
			};
			let requests = 0;
			const agent = new Agent({
				initialState: { model, tools: [tool] },
				toolExecution,
				beforeToolCall: async () => {
					if (boundary === "beforeToolCall") agent.state.tools = [];
					return undefined;
				},
				streamFn: (_model, context) => {
					if (requests++ > 0) {
						expect(getCurrentTools(context.messages)).toEqual([]);
						return response([]);
					}
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["revoked"]);
					if (boundary === "generation") agent.state.tools = [];
					return response([{ type: "toolCall", id: "revoked-call", name: tool.name, arguments: {} }]);
				},
			});
			agent.subscribe((event) => {
				if (boundary === "prepared-event" && event.type === "tool_execution_prepared") agent.state.tools = [];
			});
			await agent.prompt("Use the tool");
			expect(executions).toBe(0);
			expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
				toolCallId: "revoked-call",
				isError: true,
				content: [{ type: "text", text: expect.stringMatching(/not found|no longer available/) }],
			});
		},
	);
});

for (const kind of [undefined, "toolSearch"] as const) {
	it(`continues from ${kind ?? "ordinary"} discovery with only core-resolved declarations`, async () => {
		let called = 0;
		const target: AgentTool = {
			namespace: "records",
			name: "lookup",
			label: "Lookup",
			description: "Find record",
			parameters: Type.Object({ id: Type.String() }),
			async execute() {
				called++;
				return { content: [{ type: "text", text: "Found" }], details: {} };
			},
		};
		const reference: ToolReference = { namespace: "records", name: "lookup" };
		const search: AgentTool = {
			name: "discover",
			label: "Discover",
			toolSearch: true,
			description: "Find tools",
			parameters: Type.Object({ query: Type.String() }),
			async execute() {
				agent.state.tools = [search, target];
				return {
					content: [{ type: "text", text: "Loaded" }],
					details: {},
					tools: [reference, { ...reference, parameters: { forged: true } } as ToolReference],
				};
			},
		};
		let requests = 0;
		const agent = new Agent({
			initialState: { model, tools: [search] },
			streamFn: (_model, context) => {
				requests++;
				if (requests === 1)
					return response([
						{ type: "toolCall", kind, id: "search-call", name: "discover", arguments: { query: "records" } },
					]);
				if (requests === 2) {
					expect(getCurrentTools(context.messages).map(({ name, namespace }) => ({ name, namespace }))).toEqual([
						{ name: "discover", namespace: undefined },
						reference,
					]);
					expect(context.messages.filter((message) => message.role === "system")).toHaveLength(1);
					return response([{ type: "toolCall", id: "lookup-call", ...reference, arguments: { id: "1" } }]);
				}
				return response([{ type: "text", text: "Done" }]);
			},
		});
		await agent.prompt("Look up record 1");
		expect(called).toBe(1);
		const result = agent.state.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "search-call",
		);
		expect(result).toMatchObject({
			role: "toolResult",
			isError: false,
			...(kind ? { toolCallKind: kind } : {}),
			toolsAdded: [{ ...reference, description: target.description, parameters: target.parameters }],
		});
		expect(result && "toolsAdded" in result && result.toolsAdded).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("forged");
		expect(JSON.stringify(result)).not.toContain("execute");
	});
}

describe("search reference validation", () => {
	for (const reference of [{ name: "missing" }, { name: "lookup", namespace: "wrong" }, { name: "lookup" }]) {
		it(`rejects unavailable identity ${JSON.stringify(reference)}`, async () => {
			const search: AgentTool = {
				name: "discover",
				label: "Discover",
				toolSearch: true,
				description: "Find tools",
				parameters: Type.Object({}),
				async execute() {
					return { content: [], details: {}, tools: [reference] };
				},
			};
			let requests = 0;
			const agent = new Agent({
				initialState: { model, tools: [search] },
				streamFn: () =>
					requests++ === 0
						? response([
								{ type: "toolCall", kind: "toolSearch", id: "search-call", name: "discover", arguments: {} },
							])
						: response([{ type: "text", text: "Done" }]),
			});
			await agent.prompt("Find");
			expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
				toolCallId: "search-call",
				toolCallKind: "toolSearch",
				isError: true,
				toolsAdded: [],
				content: [{ type: "text", text: expect.stringContaining("not active or permitted") }],
			});
		});
	}
	it("does not dispatch native search to an ordinary same-name function", async () => {
		let executed = false;
		const tool: AgentTool = {
			name: "discover",
			label: "Discover",
			description: "Ordinary",
			parameters: Type.Object({}),
			async execute() {
				executed = true;
				return { content: [], details: {} };
			},
		};
		let requests = 0;
		const call: ToolCall = {
			type: "toolCall",
			kind: "toolSearch",
			id: "search-call",
			name: "discover",
			arguments: {},
		};
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			streamFn: () => (requests++ === 0 ? response([call]) : response([])),
		});
		await agent.prompt("Find");
		expect(executed).toBe(false);
		expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			toolsAdded: [],
		});
	});
});
