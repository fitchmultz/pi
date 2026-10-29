import { describe, expect, it } from "vitest";
import { CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL, normalizeCloudflareModel } from "../src/api/cloudflare.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { OpenAIResponsesCompat } from "../src/types.ts";

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
