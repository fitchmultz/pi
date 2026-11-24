import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("OpenAI Responses tool call replay status", () => {
	it("emits status: completed on replayed function_call and custom_tool_call items", () => {
		const model = getModel("openai-codex", "gpt-6.2-sol");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_fn_1|fc_item_1",
					name: "lookup",
					arguments: { key: "alpha" },
				},
				{
					type: "toolCall",
					id: "call_custom_1|ctc_item_1",
					name: "codemode",
					arguments: { code: "return 1;" },
				},
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6.2-sol",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		const fnResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_fn_1|fc_item_1",
			toolName: "lookup",
			content: [{ type: "text", text: "7919" }],
			isError: false,
			timestamp: 3,
		};
		const customResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_custom_1|ctc_item_1",
			toolName: "codemode",
			content: [{ type: "text", text: "1" }],
			isError: false,
			timestamp: 4,
		};
		const context = normalizeContext({
			systemPrompt: "You are a coding assistant.",
			messages: [{ role: "user", content: "Run both tools.", timestamp: 1 }, assistant, fnResult, customResult],
		});

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]), {
			grammarToolInputProperties: new Map([["codemode", "code"]]),
			toolSupport: "none",
		});

		const fnCall = input.find((item) => item.type === "function_call");
		const customCall = input.find((item) => item.type === "custom_tool_call");

		expect(fnCall).toMatchObject({
			type: "function_call",
			id: "fc_item_1",
			call_id: "call_fn_1",
			name: "lookup",
			status: "completed",
		});
		expect(customCall).toMatchObject({
			type: "custom_tool_call",
			id: "ctc_item_1",
			call_id: "call_custom_1",
			name: "codemode",
			input: "return 1;",
			status: "completed",
		});
	});
});
