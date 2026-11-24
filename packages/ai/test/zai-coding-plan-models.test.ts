import { expect, it } from "vitest";
import { isZaiMidConvoSystemModel } from "../src/api/zai-catalog.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

it("exposes GLM-4.6V on the China Coding Plan catalog", () => {
	const model = getBuiltinModel("zai-coding-cn", "glm-4.6v");

	expect(model).toMatchObject({
		id: "glm-4.6v",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0.05, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			zaiToolStream: true,
		},
	});
});

it("uses API-equivalent reference costs for Coding Plan models", () => {
	expect(getBuiltinModel("zai", "glm-5.2").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3").cost).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
		});
	}
});

it("exposes GLM-5.3+ on Z.AI via OpenAI Responses with verified compat defaults", () => {
	for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed", "glm-5.4"] as const) {
		expect(getBuiltinModel("zai", id), `zai/${id}`).toMatchObject({
			id,
			provider: "zai",
			api: "openai-responses",
			baseUrl: "https://api.z.ai/api/v1",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 131072,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
			compat: {
				supportsDeveloperRole: true,
				supportsMidConvoSystemMessages: true,
				supportsStrictMode: true,
				supportsOpenAIGrammarTools: true,
				supportsLongCacheRetention: false,
			},
		});
	}
	expect(getBuiltinModel("zai", "glm-5.4").input).toEqual(["text", "image"]);
	expect(getBuiltinModel("zai-coding-cn", "glm-5.4")).toMatchObject({
		id: "glm-5.4",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		input: ["text", "image"],
		compat: {
			thinkingFormat: "zai",
			zaiToolStream: true,
			supportsMidConvoSystemMessages: true,
		},
	});
	expect(isZaiMidConvoSystemModel("glm-5.3")).toBe(true);
	expect(isZaiMidConvoSystemModel("glm-5.4")).toBe(true);
	expect(isZaiMidConvoSystemModel("glm-5.5")).toBe(true);
	expect(isZaiMidConvoSystemModel("glm-6")).toBe(true);
	expect(isZaiMidConvoSystemModel("glm-6.1-flash")).toBe(true);
	expect(isZaiMidConvoSystemModel("glm-5.2")).toBe(false);
	expect(isZaiMidConvoSystemModel("glm-5-turbo")).toBe(false);
	expect(isZaiMidConvoSystemModel("glm-4.7")).toBe(false);
});

it("keeps zero costs for Coding Plan models without a matching API price", () => {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	expect(getBuiltinModel("zai", "glm-5.2-highspeed").cost).toEqual(zeroCost);

	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3-highspeed").cost).toEqual(zeroCost);
	}
});
