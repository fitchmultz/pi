import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
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
		const actual = routed.map((model) => ({ id: model.id, ...positional(normalizeCloudflareModel(model)) }));
		expect(actual).toEqual(routed.map((model) => ({ id: model.id, ...(direct.get(model.id) ?? positional({})) })));
		expect(actual.some((model) => model.additionalTools)).toBe(true);
	});

	it("keeps explicit values and leaves custom endpoints alone", () => {
		const astra = routed.find((model) => model.id === "gpt-6-astra");
		if (!astra) throw new Error("Missing Cloudflare gpt-6-astra");
		const optOut = normalizeCloudflareModel({ ...astra, compat: { supportsMidConvoSystemMessages: false } });
		expect(optOut.compat).toEqual({ supportsMidConvoSystemMessages: false, supportsAdditionalTools: true });
		const custom = { ...astra, baseUrl: "https://proxy.invalid/openai", compat: { supportsStrictMode: true } };
		expect(normalizeCloudflareModel(custom)).toBe(custom);
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
