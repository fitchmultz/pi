import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
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

it("dispatches only the exact namespace and rejects a missing namespace with duplicate leaves", async () => {
	const executed: string[] = [];
	const tools: AgentTool[] = ["left", "right"].map((namespace) => ({
		namespace,
		name: "lookup",
		label: namespace,
		description: namespace,
		parameters: Type.Object({}),
		async execute() {
			executed.push(namespace);
			return { content: [{ type: "text", text: namespace }], details: {} };
		},
	}));
	let requests = 0;
	const calls: ToolCall[] = [
		{ type: "toolCall", id: "right-call", namespace: "right", name: "lookup", arguments: {} },
		{ type: "toolCall", id: "ambiguous-call", name: "lookup", arguments: {} },
	];
	const messages = await runAgentLoop(
		[{ role: "user", content: "Look up", timestamp: 0 }],
		{ messages: [], tools },
		{
			model,
			convertToLlm: (messages) =>
				messages.filter(
					(message): message is Message =>
						message.role === "system" ||
						message.role === "user" ||
						message.role === "assistant" ||
						message.role === "toolResult",
				),
		},
		() => {},
		undefined,
		() => {
			const stream = createAssistantMessageEventStream();
			const first = requests++ === 0;
			const message: AssistantMessage = {
				role: "assistant",
				content: first ? calls : [{ type: "text", text: "Done" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: first ? "toolUse" : "stop",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
			return stream;
		},
	);
	expect(executed).toEqual(["right"]);
	expect(messages.filter((message) => message.role === "toolResult")).toMatchObject([
		{ toolCallId: "right-call", namespace: "right", isError: false },
		{ toolCallId: "ambiguous-call", isError: true },
	]);
});
