import { expect, it } from "vitest";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { stream as responsesStream } from "../src/api/openai-responses.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

it.each(["openai-responses", "openai-codex-responses"] as const)(
	"%s keeps initial effort stable and appends between-request changes only in standard mode",
	async (api) => {
		const model: Model<typeof api> = {
			id: "gpt-6-astra",
			name: "Astra",
			api,
			provider: api === "openai-responses" ? "openai" : "openai-codex",
			baseUrl: api === "openai-responses" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 1000,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		};
		const context = normalizeContext({
			messages: [
				{ role: "system", content: "Base", timestamp: 0 },
				{ role: "user", content: "hello", timestamp: 1 },
				...["medium", "high"].map((effort) => ({
					...fauxAssistantMessage(effort),
					api,
					provider: model.provider,
					model: model.id,
					providerThinkingLevel: effort,
				})),
				{ role: "user", content: "next", timestamp: Date.now() },
			],
		});
		const stream = (options: StreamOptions & { reasoningEffort: "max" }) =>
			api === "openai-responses"
				? responsesStream({ ...model, api }, context, options)
				: codexStream({ ...model, api }, context, options);
		for (const samplingParams of [
			undefined,
			{ truncation: "auto" },
			{ context_management: [{ type: "compaction" }] },
			{ reasoning: { mode: "pro", effort: "max" } },
			{ multi_agent: true },
		]) {
			let payload:
				| { reasoning?: { effort: string }; input: { type?: string; reasoning?: { effort: string } }[] }
				| undefined;
			const result = await stream({
				apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`,
				transport: "sse",
				reasoningEffort: "max",
				samplingParams,
				onPayload(value) {
					payload = value as typeof payload;
					throw new Error("offline capture");
				},
			}).result();
			expect(result.errorMessage).toContain("offline capture");
			const updates = payload!.input.filter((item) => item.type === "configuration_update");
			if (samplingParams) expect(updates).toEqual([]);
			else {
				expect(payload?.reasoning?.effort).toBe("medium");
				expect(updates).toEqual([
					{ type: "configuration_update", reasoning: { effort: "high" } },
					{ type: "configuration_update", reasoning: { effort: "max" } },
				]);
			}
		}
	},
);
