import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];
const modelIds = ["gpt-6-sol", "gpt-6-luna"];
const efforts = { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

function generateModels(stale: boolean): Record<string, Record<string, Model<Api>>> {
	const root = mkdtempSync(join(tmpdir(), "pi-gpt6-generation-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	const sourceModels = Object.fromEntries(
		modelIds.map((id) => [
			id,
			{
				id,
				name: "Stale name",
				tool_call: true,
				reasoning: false,
				reasoning_options: [{ type: "effort", values: ["minimal", "high"] }],
				modalities: { input: ["text"] },
				limit: { context: 400000, output: 4096 },
				cost: { input: 9, output: 8, cache_read: 7, cache_write: 0 },
				provider: { npm: "@ai-sdk/openai" },
			},
		]),
	);
	const catalog = stale
		? {
				openai: { models: sourceModels },
				"github-copilot": { models: sourceModels },
				opencode: { models: sourceModels },
				"opencode-go": { models: sourceModels },
				"cloudflare-ai-gateway": {
					models: Object.fromEntries(Object.entries(sourceModels).map(([id, model]) => [`openai/${id}`, model])),
				},
			}
		: {};
	const openrouter = stale
		? modelIds.map((id) => ({
				id: `openai/${id}`,
				name: id,
				supported_parameters: ["tools", "reasoning"],
				reasoning: { mandatory: true, supported_efforts: ["high"] },
			}))
		: [];
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
			`  if (url === "https://openrouter.ai/api/v1/models") return Response.json({ data: ${JSON.stringify(openrouter)} });\n` +
			`  if (url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });\n` +
			`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });\n` +
			`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
			`};\n`,
	);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	expect(result.stderr).toBe("");
	return JSON.parse(readFileSync(join(outputPath, "models.json"), "utf8")) as Record<
		string,
		Record<string, Model<Api>>
	>;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("GPT-6 model generation", () => {
	it.each([false, true])("corrects direct metadata with stale catalog = %s", (stale) => {
		const models = generateModels(stale);
		for (const id of modelIds) {
			const model = models.openai[id];
			expect(model).toMatchObject({
				id,
				name: id === "gpt-6-sol" ? "GPT-6 Sol" : "GPT-6 Luna",
				api: "openai-responses",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272000,
				maxTokens: 128000,
				thinkingLevelMap: efforts,
				compat: {
					supportsStrictMode: true,
					supportsOpenAIGrammarTools: true,
					supportsToolSearch: true,
					supportsAdditionalTools: true,
					supportsMidConvoSystemMessages: true,
					supportsExplicitPromptCacheMode: true,
					supportsAsyncTools: true,
					supportsSteering: true,
					supportsReasoningEffortUpdates: true,
				},
			});
			expect(model.thinkingLevelMap).toEqual(efforts);
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
			expect(model.cost).toEqual(
				id === "gpt-6-sol"
					? {
							input: 2,
							output: 10,
							cacheRead: 0.2,
							cacheWrite: 2.5,
							tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
						}
					: {
							input: 0.1,
							output: 0.5,
							cacheRead: 0.01,
							cacheWrite: 0.125,
							tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
						},
			);
			const codex = models["openai-codex"][id];
			expect(codex).toMatchObject({
				id,
				name: model.name,
				provider: "openai-codex",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272000,
				maxTokens: 128000,
			});
			expect(codex.cost).toEqual(model.cost);
			expect(codex.thinkingLevelMap).toEqual(efforts);
			expect(getSupportedThinkingLevels(codex)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
			expect(codex.compat).toEqual({
				supportsOpenAIGrammarTools: true,
				supportsToolSearch: true,
				supportsAdditionalTools: true,
				supportsMidConvoSystemMessages: true,
				supportsAsyncTools: true,
				supportsSteering: true,
				supportsReasoningEffortUpdates: true,
			});
			const azure = models["azure-openai-responses"][id];
			expect(azure.cost.tiers).toBeUndefined();
			expect(azure.thinkingLevelMap).toEqual(efforts);
			for (const flag of [
				"supportsAsyncTools",
				"supportsSteering",
				"supportsReasoningEffortUpdates",
				"supportsExplicitPromptCacheMode",
				"supportsToolSearch",
				"supportsAdditionalTools",
			]) {
				expect(azure.compat).not.toHaveProperty(flag);
				if (stale) {
					for (const provider of ["cloudflare-ai-gateway", "github-copilot", "opencode", "opencode-go"]) {
						expect(models[provider][id].compat).not.toHaveProperty(flag);
					}
				}
			}
			if (stale) {
				for (const provider of ["cloudflare-ai-gateway", "github-copilot", "opencode", "opencode-go"]) {
					expect(models[provider][id].contextWindow).toBe(400000);
					expect(models[provider][id].cost).toEqual({ input: 9, output: 8, cacheRead: 7, cacheWrite: 0 });
					expect(models[provider][id].thinkingLevelMap).toEqual({
						off: null,
						minimal: "minimal",
						low: null,
						medium: null,
						high: "high",
						xhigh: null,
						max: null,
					});
					expect(models[provider][id].compat).not.toHaveProperty("supportsMidConvoSystemMessages");
				}
				expect(getSupportedThinkingLevels(models.openrouter[`openai/${id}`])).toEqual(["high"]);
			} else {
				expect(models["cloudflare-ai-gateway"]).toBeUndefined();
				expect(models.openrouter[`openai/${id}`]).toBeUndefined();
			}
		}
		for (const provider of ["openai", "openai-codex"]) {
			expect(getSupportedThinkingLevels(models[provider]["gpt-6-astra"])).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		}
	});
});
