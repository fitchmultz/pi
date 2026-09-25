import { expect, it } from "vitest";
import { getModels } from "../src/compat.ts";
import { flattenModelCatalog } from "../src/model-catalog.ts";
import type { Api, Model } from "../src/types.ts";

const astra: Model<"openai-responses"> = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 272000,
	maxTokens: 128000,
	compat: { supportsStrictMode: true },
};

it.each([
	["openai", "openai-responses"],
	["openai-codex", "openai-codex-responses"],
	["cloudflare-ai-gateway", "openai-responses"],
] as const)("restores Astra lifecycle capabilities from older %s catalog data", (provider, api) => {
	const source = { ...astra, provider, api };
	const catalog = flattenModelCatalog(provider, { [api]: { [source.id]: source } });

	expect(catalog[source.id].compat).toEqual({
		supportsStrictMode: true,
		supportsAsyncTools: true,
		supportsSteering: true,
		supportsReasoningEffortUpdates: true,
	});
	expect(source.compat).toEqual({ supportsStrictMode: true });
});

it.each([
	{ supportsSteering: false },
	{ supportsAsyncTools: false, supportsSteering: false, supportsReasoningEffortUpdates: false },
])("preserves explicit Astra capabilities and fills only omitted defaults: %j", (compat) => {
	const source = { ...astra, compat };
	const catalog = flattenModelCatalog("openai", { "openai-responses": { [source.id]: source } });
	expect(catalog[source.id].compat).toEqual(
		Object.assign(
			{
				supportsAsyncTools: true,
				supportsSteering: true,
				supportsReasoningEffortUpdates: true,
			},
			compat,
		),
	);
});

it.each([
	{ ...astra, id: "gpt-6-sol" },
	{ ...astra, provider: "custom-openai" },
	{ ...astra, api: "openai-completions" },
] satisfies Model<Api>[])("does not add Astra capabilities to $provider/$id using $api", (source) => {
	const catalog = flattenModelCatalog(source.provider, { [source.api]: { [source.id]: source } });
	expect(catalog[source.id]).toBe(source);
});

it("generates Anthropic IDs for Cloudflare AI Gateway Claude models", () => {
	const ids = getModels("cloudflare-ai-gateway")
		.filter((model) => model.api === "anthropic-messages")
		.map((model) => model.id);
	expect(ids).toContain("claude-opus-5-5");
	expect(ids.filter((id) => id.includes("."))).toEqual([]);
});
