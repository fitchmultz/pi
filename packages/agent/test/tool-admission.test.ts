import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentTool } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "offline",
	name: "Offline",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://offline.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const call = { type: "toolCall" as const, id: "call", name: "guarded", arguments: {} };

describe.each(["sequential", "parallel"] as const)("%s tool admission", (toolExecution) => {
	it.each(["generation", "hook", "schema", "executor"] as const)(
		"refuses a tool changed during %s",
		async (boundary) => {
			let executions = 0;
			const tool: AgentTool = {
				name: "guarded",
				label: "Guarded",
				description: "Guarded",
				parameters: Type.Object({}),
				async execute() {
					executions++;
					return { content: [], details: {} };
				},
			};
			const agent = new Agent({
				initialState: { model, tools: [tool] },
				toolExecution,
				finishTurn: () => ({ action: "end" }),
				beforeToolCall: async () => {
					if (boundary === "hook") agent.state.tools = [];
					if (boundary === "schema")
						Object.assign(tool.parameters, {
							properties: { requiredValue: { type: "string" } },
							required: ["requiredValue"],
						});
					if (boundary === "executor")
						tool.execute = async () => {
							executions++;
							return { content: [], details: {} };
						};
					return undefined;
				},
				streamFn: () => {
					if (boundary === "generation") agent.state.tools = [];
					const stream = createAssistantMessageEventStream();
					stream.push({
						type: "done",
						reason: "toolUse",
						message: {
							...fauxAssistantMessage(""),
							stopReason: "toolUse",
							content: [call],
						},
					});
					return stream;
				},
			});
			await agent.prompt("use tool");
			expect(executions).toBe(0);
			expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
				isError: true,
				content: [{ type: "text", text: expect.stringMatching(/no longer available|changed before execution/) }],
			});
		},
	);
});

it("rechecks nested callable permissions after an awaited hook", async () => {
	let executions = 0;
	const tool: AgentTool = {
		name: "guarded",
		label: "Guarded",
		description: "Guarded",
		parameters: Type.Object({}),
		async execute() {
			executions++;
			return { content: [], details: {} };
		},
	};
	let tools = [tool];
	const result = await runToolCall(call, {
		tools,
		context: { messages: [], tools },
		assistantMessage: fauxAssistantMessage(""),
		getTools: () => tools,
		beforeToolCall: async () => {
			tools = [];
			return undefined;
		},
	});
	expect(executions).toBe(0);
	expect(result.isError).toBe(true);
	expect(result.result.content).toEqual([{ type: "text", text: "Tool guarded is no longer available" }]);
});

it.each(["schema", "execute", "prepareArguments", "executionMode"] as const)(
	"refuses a materially replaced tool with a changed %s",
	async (change) => {
		let executions = 0;
		const tool: AgentTool = {
			name: "guarded",
			label: "Guarded",
			description: "Guarded",
			parameters: Type.Object({}),
			prepareArguments: (args) => args as Record<string, never>,
			async execute() {
				executions++;
				return { content: [], details: {} };
			},
		};
		let tools = [tool];
		const outcome = await runToolCall(call, {
			tools,
			context: { messages: [], tools },
			assistantMessage: fauxAssistantMessage(""),
			getTools: () => tools,
			beforeToolCall: async () => {
				tools = [
					{
						...tool,
						description: "New display description",
						...(change === "schema" ? { parameters: Type.Object({ value: Type.String() }) } : {}),
						...(change === "execute" ? { execute: async () => ({ content: [], details: {} }) } : {}),
						...(change === "prepareArguments" ? { prepareArguments: () => ({}) } : {}),
						...(change === "executionMode" ? { executionMode: "sequential" as const } : {}),
					},
				];
			},
		});
		expect(executions).toBe(0);
		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: "Tool guarded changed before execution" }]);
	},
);
