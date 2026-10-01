import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, Usage } from "../src/types.ts";
import { assertContextFits, estimateContextTokens } from "../src/utils/estimate.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it("counts opaque reasoning signatures, tool-call signatures and schemas in fallback and output limits", () => {
		const assistant = createAssistant(1, 0);
		assistant.content = [
			{ type: "thinking", thinking: "", thinkingSignature: "x".repeat(16_000) },
			{ type: "toolCall", id: "call", name: "run", arguments: {}, thoughtSignature: "y".repeat(4000) },
		];
		const context = normalizeContext({ messages: [assistant] });
		expect(estimateContextTokens(context).tokens).toBe(5002);
		expect(buildBaseOptions(model, context).maxTokens).toBe(902);
		const withSchema = normalizeContext({
			messages: [assistant],
			tools: [{ name: "run", description: "Lookup", parameters: { type: "object", description: "z".repeat(4000) } }],
		});
		expect(estimateContextTokens(withSchema).tokens).toBeGreaterThanOrEqual(6002);
		expect(() => assertContextFits({ contextWindow: 6000 }, withSchema)).toThrow("exceeds the context window");
	});

	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_899);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});
});
