import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-model-config-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

const capabilities = {
	supportsMidConvoSystemMessages: true,
	supportsAdditionalTools: true,
	supportsToolSearch: true,
	supportsExplicitPromptCacheMode: true,
	supportsAsyncTools: true,
	supportsSteering: true,
	supportsReasoningEffortUpdates: true,
};

describe("Responses model configuration", () => {
	it("retains GPT-6 capabilities at provider, model, and override levels", async () => {
		const provider = {
			compat: capabilities,
			models: [{ id: "gpt-6-sol", compat: capabilities }],
			modelOverrides: { "gpt-6-luna": { compat: { ...capabilities, supportsSteering: false } } },
		};
		const path = join(directory, "models.json");
		await writeFile(path, JSON.stringify({ providers: { openai: provider } }));
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("openai")).toEqual(provider);
	});

	it.each(Object.keys(capabilities))(
		"rejects non-boolean %s rather than accepting another API schema",
		async (key) => {
			const path = join(directory, "models.json");
			await writeFile(path, JSON.stringify({ providers: { openai: { compat: { [key]: "false" } } } }));
			const config = await ModelConfig.load(path);
			expect(config.getError()).toContain(key);
			expect(config.getProviderIds()).toEqual([]);
		},
	);
});
