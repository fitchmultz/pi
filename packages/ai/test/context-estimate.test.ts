import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, Usage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";
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

function completionResponse(modelId: string, reasoning: string, outputTokens: number): Response {
	const chunk = {
		id: "chatcmpl-context-estimate",
		object: "chat.completion.chunk",
		created: 0,
		model: modelId,
	};
	const events = [
		{
			...chunk,
			choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning, content: "Done." } }],
		},
		{
			...chunk,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: outputTokens, total_tokens: 5 + outputTokens },
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe.each([
	{ name: "without a target", target: undefined },
	{ name: "with the same target", target: model },
])("context token estimation $name", ({ target }) => {
	it("counts encrypted thinking and tool replay signatures without reported usage", () => {
		const assistant = createAssistant(1, 0);
		assistant.content = [
			{ type: "thinking", thinking: "", thinkingSignature: "x".repeat(40_000) },
			{ type: "toolCall", id: "call", name: "test", arguments: {}, thoughtSignature: "x".repeat(4_000) },
		];
		expect(
			estimateContextTokens(
				[
					assistant,
					{
						role: "toolResult",
						toolCallId: "call",
						toolName: "test",
						content: [],
						isError: false,
						timestamp: 2,
					},
				],
				target,
			).tokens,
		).toBe(12_574);
	});

	// Regression for #10497: large new inputs need more room than chars/4 allows.
	it("reserves 3.5 characters per token for new text when limiting output", () => {
		const context = normalizeContext({
			messages: [createAssistant(100, 2_000), { role: "user", content: "x".repeat(3_500), timestamp: 200 }],
		});

		expect(estimateContextTokens(context, target)).toEqual({
			tokens: 3_000,
			usageTokens: 2_000,
			trailingTokens: 1_000,
			lastUsageIndex: 0,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(2_904);
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

		expect(estimateContextTokens(context, target)).toEqual({
			tokens: 1_149,
			usageTokens: 0,
			trailingTokens: 1_149,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_755);
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

		expect(estimateContextTokens(context, target)).toEqual({
			tokens: 2_002,
			usageTokens: 2_000,
			trailingTokens: 2,
			lastUsageIndex: 3,
		});
	});

	it.each(["error", "aborted", "stop"] as const)(
		"does not replace valid usage with a failed or zero-usage %s",
		(reason) => {
			const retry = createAssistant(200, reason === "stop" ? 0 : 9_500);
			retry.stopReason = reason;
			retry.content = [];
			expect(
				estimateContextTokens(
					[createAssistant(100, 2_000), retry, { role: "user", content: "tail", timestamp: 300 }],
					target,
				),
			).toEqual({ tokens: 2_002, usageTokens: 2_000, trailingTokens: 2, lastUsageIndex: 0 });
		},
	);
});

describe("cross-model context estimation", () => {
	it.each([
		{ name: "provider", origin: { provider: "other" } },
		{ name: "API", origin: { api: "anthropic-messages" as const } },
		{ name: "model", origin: { model: "other" } },
	])("does not use foreign $name usage or thinking for the target", ({ origin }) => {
		const assistant: AssistantMessage = {
			...createAssistant(100, 9_500),
			...origin,
			content: [
				{ type: "thinking", thinking: "private".repeat(10_000), thinkingSignature: "opaque" },
				{ type: "text", text: "kept" },
			],
		};
		expect(estimateContextTokens([assistant], model)).toEqual({
			tokens: 2,
			usageTokens: 0,
			trailingTokens: 2,
			lastUsageIndex: null,
		});
		expect(estimateContextTokens([assistant]).usageTokens).toBe(9_500);
	});

	it("keeps an earlier matching anchor's original index when switching back", () => {
		const omitted = { ...createAssistant(50, 9_500), stopReason: "aborted" as const };
		const foreign: AssistantMessage = {
			...createAssistant(300, 20_000),
			model: "other",
			content: [
				{ type: "thinking", thinking: "private".repeat(10_000) },
				{ type: "text", text: "kept" },
			],
		};
		const messages = [
			omitted,
			createAssistant(100, 2_000),
			{ role: "user" as const, content: "next", timestamp: 200 },
			foreign,
			{ role: "user" as const, content: "tail", timestamp: 400 },
		];
		expect(estimateContextTokens(messages, model)).toEqual({
			tokens: 2_006,
			usageTokens: 2_000,
			trailingTokens: 6,
			lastUsageIndex: 1,
		});
		expect(estimateContextTokens(messages)).toEqual({
			tokens: 20_002,
			usageTokens: 20_000,
			trailingTokens: 2,
			lastUsageIndex: 3,
		});
	});

	// Model switching drops foreign thinking (#10995); its old usage must not consume the new answer budget.
	it("preserves native output allowance when foreign reasoning is stripped from replay", async () => {
		const source: Model<"openai-completions"> = {
			...model,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "reasoning-source",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		};
		const target: Model<"openai-completions"> = {
			...source,
			id: "plain-target",
			reasoning: false,
			contextWindow: 16_385,
			maxTokens: 4_096,
		};
		const user = { role: "user" as const, content: "Say done after thinking.", timestamp: 1 };
		const payloads: ChatCompletionCreateParamsStreaming[] = [];

		for (const outputTokens of [20_000, 2]) {
			const reasoning = outputTokens === 20_000 ? "private ".repeat(10_000) : "";
			const assistant = await streamSimple(source, normalizeContext({ messages: [user] }), {
				apiKey: "offline-test-key",
				fetch: async () => completionResponse(source.id, reasoning, outputTokens),
			}).result();
			expect(assistant.stopReason).toBe("stop");
			expect(assistant.usage).toMatchObject({ input: 5, output: outputTokens, totalTokens: 5 + outputTokens });
			expect(assistant.content.some((block) => block.type === "thinking")).toBe(reasoning.length > 0);

			const result = await streamSimple(
				target,
				normalizeContext({
					messages: [user, assistant, { role: "user", content: "Continue.", timestamp: Date.now() + 1 }],
				}),
				{
					apiKey: "offline-test-key",
					fetch: async (_input, init) => {
						payloads.push(JSON.parse(String(init?.body)) as ChatCompletionCreateParamsStreaming);
						return completionResponse(target.id, "", 2);
					},
				},
			).result();
			expect(result.stopReason).toBe("stop");
		}

		expect(payloads).toHaveLength(2);
		for (const payload of payloads) {
			expect(payload.messages).toEqual([
				{ role: "user", content: "Say done after thinking." },
				{ role: "assistant", content: "Done." },
				{ role: "user", content: "Continue." },
			]);
			expect(payload.max_completion_tokens ?? payload.max_tokens).toBe(4_096);
		}
	});
});
