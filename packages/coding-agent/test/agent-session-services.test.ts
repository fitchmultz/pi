import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("createAgentSessionServices", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	function makeTempDir(prefix: string): string {
		const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
		return dir;
	}

	it("refreshes a caller-supplied ModelRuntime created with refreshOnCreate: false even with no provider extensions", async () => {
		const tempDir = makeTempDir("pi-services-refresh");
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
			refreshOnCreate: false,
		});

		expect(modelRuntime.getAvailableSnapshot()).toEqual([]);
		const refreshSpy = vi.spyOn(modelRuntime, "refresh");

		await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledWith({ allowNetwork: false });
		expect(modelRuntime.getAvailableSnapshot().some((m) => m.provider === "anthropic")).toBe(true);
	});

	it("does not add a duplicate refresh when an extension registers a provider", async () => {
		const tempDir = makeTempDir("pi-services-single-refresh");
		const extensionPath = join(tempDir, "provider-ext.ts");
		writeFileSync(
			extensionPath,
			`export default function (pi) {
				pi.registerProvider("ext-local", {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "test-key",
					models: [{ id: "ext-model", name: "Ext Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
				});
			}\n`,
		);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: join(tempDir, "models.json"),
			refreshOnCreate: false,
		});
		const refreshSpy = vi.spyOn(modelRuntime, "refresh");

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				additionalExtensionPaths: [extensionPath],
			},
		});

		expect(services.diagnostics).toEqual([]);
		// One internal refresh triggered by registerProvider() plus one awaited refresh in applyProviderRegistrations().
		expect(refreshSpy).toHaveBeenCalledTimes(2);
		expect(refreshSpy).toHaveBeenCalledWith({ allowNetwork: false });
		expect(modelRuntime.getAvailableSnapshot().some((m) => m.provider === "ext-local" && m.id === "ext-model")).toBe(
			true,
		);
	});
});
