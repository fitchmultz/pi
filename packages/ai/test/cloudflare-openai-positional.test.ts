import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	normalizeCloudflareModel,
} from "../src/api/cloudflare.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { AnthropicMessagesCompat, OpenAIResponsesCompat } from "../src/types.ts";

function positional(model: { compat?: unknown }) {
	const compat = model.compat as OpenAIResponsesCompat | undefined;
	return {
		systemMessages: compat?.supportsMidConvoSystemMessages === true,
		additionalTools: compat?.supportsAdditionalTools === true,
		toolSearch: compat?.supportsToolSearch === true,
		explicitPromptCacheMode: compat?.supportsExplicitPromptCacheMode === true,
		effort: compat?.supportsMidConvoEffort === true,
		temperature: compat?.supportsTemperature ?? true,
	};
}

const routed = getBuiltinModels("cloudflare-ai-gateway").filter(
	(model) => model.api === "openai-responses" && model.baseUrl === CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
);

describe("Cloudflare OpenAI positional defaults", () => {
	// The published catalog lists only OpenCode and Copilot as Responses proxies, so Cloudflare's
	// /openai passthrough re-sent the whole prompt after every system update or tool load.
	it("match direct OpenAI for every Cloudflare /openai Responses model", () => {
		const direct = new Map(getBuiltinModels("openai").map((model) => [model.id, positional(model)]));
		const actual = routed.map((model) => ({
			id: model.id,
			...positional(normalizeCloudflareModel({ ...model, compat: undefined })),
		}));
		expect(actual).toEqual(routed.map((model) => ({ id: model.id, ...(direct.get(model.id) ?? positional({})) })));
		expect(actual.some((model) => model.additionalTools)).toBe(true);
		expect(actual.some((model) => model.effort)).toBe(true);
		const imageModels = routed.filter((model) => model.input.includes("image"));
		expect(imageModels.length).toBeGreaterThan(0);
		for (const model of imageModels) {
			expect(model.inputLimits).toMatchObject({
				maxRequestBytes: CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES,
				images: { maxPerRequest: 1500 },
			});
		}
		const gpt62Sol = routed.find((model) => model.id === "gpt-6.2-sol");
		expect(gpt62Sol?.promptCache).toEqual({ short: 1800, long: 43200 });
		for (const codexModel of getBuiltinModels("openai-codex")) {
			expect(codexModel.inputLimits).toMatchObject({
				maxRequestBytes: 512 * 1024 * 1024,
				images: { maxPerRequest: 1500 },
			});
		}
	});

	it("keeps explicit values and leaves custom endpoints alone", () => {
		const astra = routed.find((model) => model.id === "gpt-6-astra");
		if (!astra) throw new Error("Missing Cloudflare gpt-6-astra");
		const optOut = normalizeCloudflareModel({ ...astra, compat: { supportsMidConvoSystemMessages: false } });
		expect(optOut.compat).toEqual({
			supportsMidConvoSystemMessages: false,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
			supportsExplicitPromptCacheMode: true,
			supportsMidConvoEffort: true,
			supportsTemperature: false,
		});
		const concrete = normalizeCloudflareModel({
			...astra,
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acc123/workos/openai",
			compat: undefined,
		});
		expect(concrete.compat).toEqual({
			supportsMidConvoSystemMessages: true,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
			supportsExplicitPromptCacheMode: true,
			supportsMidConvoEffort: true,
			supportsTemperature: false,
		});
		const custom = { ...astra, baseUrl: "https://proxy.invalid/openai", compat: { supportsStrictMode: true } };
		expect(normalizeCloudflareModel(custom)).toBe(custom);

		const stale512 = normalizeCloudflareModel({
			...astra,
			inputLimits: { maxRequestBytes: 512 * 1024 * 1024, images: { maxPerRequest: 1500 } },
		});
		expect(stale512.inputLimits).toEqual({
			maxRequestBytes: CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES,
			images: { maxPerRequest: 1500 },
		});

		const smaller16 = normalizeCloudflareModel({
			...astra,
			inputLimits: { maxRequestBytes: 16 * 1024 * 1024, images: { maxPerRequest: 1500 } },
		});
		expect(smaller16.inputLimits).toEqual({
			maxRequestBytes: 16 * 1024 * 1024,
			images: { maxPerRequest: 1500 },
		});
	});
});

describe("Cloudflare Anthropic passthrough positional defaults", () => {
	function claudePositional(model: { compat?: unknown }) {
		const compat = model.compat as AnthropicMessagesCompat | undefined;
		return {
			systemMessages: compat?.supportsMidConvoSystemMessages === true,
			toolChanges: compat?.supportsMidConvoToolChanges === true,
			effort: compat?.supportsMidConvoEffort === true,
		};
	}

	const routedAnthropic = getBuiltinModels("cloudflare-ai-gateway").filter(
		(model) => model.api === "anthropic-messages" && model.baseUrl === CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	);

	it("match direct Anthropic for every Cloudflare /anthropic passthrough model", () => {
		const direct = new Map(getBuiltinModels("anthropic").map((model) => [model.id, claudePositional(model)]));
		const actual = routedAnthropic.map((model) => ({
			id: model.id,
			...claudePositional(normalizeCloudflareModel(model)),
		}));
		expect(actual).toEqual(
			routedAnthropic.map((model) => ({ id: model.id, ...(direct.get(model.id) ?? claudePositional({})) })),
		);
		for (const model of routedAnthropic.filter((entry) => entry.input.includes("image"))) {
			expect(model.inputLimits?.maxRequestBytes).toBe(CLOUDFLARE_AI_GATEWAY_MAX_REQUEST_BYTES);
			expect(model.inputLimits?.images?.maxPerRequest).toBe(model.contextWindow === 200000 ? 100 : 600);
		}
		for (const model of routedAnthropic) {
			expect((model.compat as AnthropicMessagesCompat | undefined)?.supportsStrictTools).toBe(true);
		}
		const fable52 = routedAnthropic.find((entry) => entry.id === "claude-fable-5-2");
		const opus5 = routedAnthropic.find((entry) => entry.id === "claude-opus-5");
		if (!opus5) throw new Error("Missing Cloudflare claude-opus-5");
		expect((fable52?.compat as AnthropicMessagesCompat | undefined)?.allowedFallbackModels).toEqual([
			{
				provider: "cloudflare-ai-gateway",
				model: "claude-opus-5",
				cost: opus5.cost,
			},
		]);
		expect(actual.find((entry) => entry.id === "claude-sonnet-5-5")).toEqual({
			id: "claude-sonnet-5-5",
			systemMessages: true,
			toolChanges: true,
			effort: true,
		});
		expect(actual.find((entry) => entry.id === "claude-haiku-5-5")).toEqual({
			id: "claude-haiku-5-5",
			systemMessages: true,
			toolChanges: true,
			effort: true,
		});
	});
});
