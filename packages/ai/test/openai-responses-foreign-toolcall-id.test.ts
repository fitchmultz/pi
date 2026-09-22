import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, ToolResultMessage, Usage } from "../src/types.ts";
import { shortHash } from "../src/utils/hash.ts";
import { toolKey } from "../src/utils/tool-identity.ts";

const COPILOT_RAW_TOOL_CALL_ID =
	"call_4VnzVawQXPB9MgYib7CiQFEY|I9b95oN1wD/cHXKTw3PpRkL6KkCtzTJhUxMouMWYwHeTo2j3htzfSk7YPx2vifiIM4g3A8XXyOj8q4Bt6SLUG7gqY1E3ELkrkVQNHglRfUmWj84lqxJY+Puieb3VKyX0FB+83TUzn91cDMF/4gzt990IzqVrc+nIb9RRscRD070Du16q1glydVjWR0SBJsE6TbY/esOjFpqplogQqrajm1eI++f3eLi73R6q7hVusY0QbeFySVxABCjhN0lXB04caBe1rzHjYzul6MAXj7uq+0r17VLq+yrtyYhN12wkmFqHeqTyEei6EFPbMy24Nc+IbJlkP0OCg02W+gOnyBFcbi2ctvJFSOhSjt1CqBdqCnnhwUqXjbWiT0wh3DmLScRgTHmGkaI+oAcQQjfic65nxj+TnEkReA==";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("OpenAI Responses foreign tool call ID normalization", () => {
	it.each(["openai", "openai-codex"] as const)(
		"omits incompatible custom item IDs when switching to %s without changing calls or results",
		(provider) => {
			const model = getModel(provider, "gpt-6-astra");
			const id = "call_patch|ctc_foreign";
			const assistant: AssistantMessage = {
				role: "assistant",
				api: provider === "openai" ? "openai-codex-responses" : "openai-responses",
				provider: provider === "openai" ? "openai-codex" : "openai",
				model: model.id,
				content: [
					{
						type: "toolCall",
						id,
						name: "apply_patch",
						arguments: { input: "saved patch" },
						responsesItem: {
							type: "custom_tool_call",
							id: "ctc_foreign",
							call_id: "call_patch",
							name: "apply_patch",
							input: "saved patch",
						},
					},
				],
				usage,
				stopReason: "toolUse",
				timestamp: 1,
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: "apply_patch",
				content: [{ type: "text", text: "saved result" }],
				isError: false,
				timestamp: 2,
			};
			const context = normalizeContext({ messages: [assistant, result] });
			const original = structuredClone(context);
			const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex"]), {
				grammarToolInputProperties: new Map([[toolKey("apply_patch"), "input"]]),
			});
			expect(input).toEqual([
				{
					type: "custom_tool_call",
					id: undefined,
					call_id: "call_patch",
					name: "apply_patch",
					input: "saved patch",
				},
				{ type: "custom_tool_call_output", call_id: "call_patch", output: "saved result" },
			]);
			expect(context).toEqual(original);
		},
	);

	it("hashes foreign Copilot tool item IDs into a bounded Codex-safe fc_<hash> shape", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: COPILOT_RAW_TOOL_CALL_ID,
					name: "edit",
					arguments: { path: "src/styles/app.css" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.5",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 2000,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: COPILOT_RAW_TOOL_CALL_ID,
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};
		const context = normalizeContext({
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Use the tool.", timestamp: Date.now() - 3000 }, assistant, toolResult],
		});

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));
		const functionCall = input.find((item) => item.type === "function_call");

		expect(functionCall).toBeDefined();
		expect(functionCall?.type).toBe("function_call");
		if (!functionCall || functionCall.type !== "function_call") {
			throw new Error("Expected function_call item");
		}

		const expectedItemId = `fc_${shortHash(COPILOT_RAW_TOOL_CALL_ID.split("|")[1]!)}`;
		expect(functionCall.id).toBe(expectedItemId);
		expect(functionCall.id?.length ?? 0).toBeLessThanOrEqual(64);
		expect(functionCall.id).toMatch(/^fc_[A-Za-z0-9]+$/);
	});
});
