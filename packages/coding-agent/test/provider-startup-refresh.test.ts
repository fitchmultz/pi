import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthCheck, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("provider startup refresh", () => {
	let directory: string;
	let runtime: ModelRuntime;
	let store: InMemoryModelsStore;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-provider-startup-"));
		vi.stubEnv("HOME", directory);
		vi.stubEnv("USERPROFILE", directory);
		for (const name of Object.keys(process.env)) {
			if (/KEY|TOKEN|SECRET|^AWS_|^GOOGLE_|^AZURE_|^CLOUDFLARE_/.test(name)) vi.stubEnv(name, undefined);
		}
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
		store = new InMemoryModelsStore();
		runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: store,
			modelsPath: null,
			refreshOnCreate: false,
		});
	});

	afterEach(async () => {
		await runtime.flushForCheckpoint();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	function services(factory: ExtensionFactory, signal?: AbortSignal) {
		return createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			modelRuntimeSignal: signal,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [factory],
			},
		});
	}

	it("refreshes forty factory compositions once, restoring native cached models before returning", async () => {
		const providers = runtime.getProviders();
		expect(providers).toHaveLength(40);
		const cached = { ...runtime.getModels("anthropic")[0], id: "startup-cached-only" };
		await store.write("anthropic", {
			models: [cached],
			lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 60_000,
		});
		const read = vi.spyOn(store, "read");
		const checks = new Map<string, number>();
		const resolve = vi.fn(async () => undefined);
		const started = deferred();
		const release = deferred();
		let settled = false;
		const startup = services((pi) => {
			for (const provider of providers) {
				pi.registerProvider(provider.id, {
					ambientAuth: {
						async check({ signal }) {
							checks.set(provider.id, (checks.get(provider.id) ?? 0) + 1);
							started.resolve();
							await release.promise;
							signal.throwIfAborted();
							return { type: "oauth", source: "synthetic account metadata" };
						},
						resolve,
					},
				});
			}
		}).then((result) => {
			settled = true;
			return result;
		});
		try {
			await started.promise;
			expect(settled).toBe(false);
			release.resolve();
			const result = await startup;
			expect(result.diagnostics).toEqual([]);
			expect(runtime.getError()).toBeUndefined();
			expect(runtime.getAvailableSnapshot()).toContainEqual(cached);
			expect(runtime.isUsingSubscription("anthropic")).toBe(true);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
			// Drain only after checking the public startup boundary; include any late work in counts.
			await runtime.flushForCheckpoint();
			expect(resolve).not.toHaveBeenCalled();
			console.log(
				"factory metadata checks",
				[...checks.values()].reduce((sum, count) => sum + count, 0),
			);
			// Native availability + auth classification each check once per provider, not once per registration.
			expect([...checks.values()]).toEqual(providers.map(() => 2));
			expect(read).toHaveBeenCalledTimes(providers.length);
			for (const provider of providers) {
				expect(runtime.getProvider(provider.id)?.auth.oauth?.login).toBe(provider.auth.oauth?.login);
			}
		} finally {
			release.resolve();
			await startup;
		}
	});

	it("keeps live composition immediate and coalesces native registration, replacement and removal", async () => {
		const native = runtime.getProvider("anthropic")!;
		const read = vi.spyOn(store, "read");
		const started = deferred();
		const release = deferred();
		let flushed = false;
		let invalidated = false;
		const unhold = runtime.holdForCheckpoint(() => {
			invalidated = true;
		});
		try {
			runtime.registerNativeProvider({ ...native, id: "temporary-provider" });
			expect(runtime.getProvider("temporary-provider")).toBeDefined();
			runtime.unregisterProvider("temporary-provider");
			expect(runtime.getProvider("temporary-provider")).toBeUndefined();
			runtime.registerProvider("anthropic", { name: "Replaced", apiKey: "synthetic" });
			expect(runtime.getProvider("anthropic")?.name).toBe("Replaced");
			runtime.unregisterProvider("anthropic");
			expect(runtime.getProvider("anthropic")).toBe(native);
			runtime.registerProvider("anthropic", {
				ambientAuth: {
					async check({ signal }) {
						started.resolve();
						await release.promise;
						signal.throwIfAborted();
						return { type: "oauth", source: "live" };
					},
					resolve: async () => undefined,
				},
			});
			expect(invalidated).toBe(true);
			const checkpoint = runtime.flushForCheckpoint().then(() => {
				flushed = true;
			});
			await started.promise;
			expect(flushed).toBe(false);
			release.resolve();
			await checkpoint;
			expect(runtime.isUsingSubscription("anthropic")).toBe(true);
			expect(read).toHaveBeenCalledTimes(runtime.getProviders().length);
		} finally {
			unhold();
			release.resolve();
		}
	});

	it("cancels the services catalog barrier without losing checkpoint ownership of the store tail", async () => {
		const cached = { ...runtime.getModels("anthropic")[0], id: "cancelled-cached-only" };
		await store.write("anthropic", {
			models: [cached],
			lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 60_000,
		});
		const read = store.read.bind(store);
		const started = deferred();
		const release = deferred();
		let storeSignal: AbortSignal | undefined;
		vi.spyOn(store, "read").mockImplementation(async (id, options) => {
			if (id === "anthropic") {
				storeSignal = options?.signal;
				started.resolve();
				await release.promise;
			}
			return read(id, options);
		});
		const controller = new AbortController();
		const startup = services((pi) => {
			pi.registerProvider("anthropic", {
				ambientAuth: {
					check: async () => ({ type: "oauth", source: "synthetic" }),
					resolve: async () => undefined,
				},
			});
		}, controller.signal);
		try {
			await started.promise;
			controller.abort(new Error("cancel startup"));
			// Race against a turn, not a time budget; cancellation settles without releasing the store.
			expect(await Promise.race([startup.then(() => "cancelled"), nextTurn().then(() => "still waiting")])).toBe(
				"cancelled",
			);
			expect(storeSignal?.aborted).toBe(true);
			let flushed = false;
			const checkpoint = runtime.flushForCheckpoint().then(() => {
				flushed = true;
			});
			await nextTurn();
			expect(flushed).toBe(false);
			release.resolve();
			await checkpoint;
			expect(runtime.getModel("anthropic", cached.id)).toBeUndefined();
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
			expect(runtime.getError()).toBeUndefined();
		} finally {
			release.resolve();
			await startup;
		}
	});

	it("awaited services follow the current pass even when the superseded pass fails", async () => {
		const olderStarted = deferred();
		const newerStarted = deferred();
		const olderRelease = deferred();
		const newerRelease = deferred();
		let phase: "older" | "newer" = "older";
		let settled = false;
		const startup = services((pi) => {
			for (const provider of runtime.getProviders()) {
				pi.registerProvider(provider.id, {
					ambientAuth: {
						async check(): Promise<AuthCheck | undefined> {
							if (provider.id !== "anthropic") return undefined;
							const current = phase;
							(current === "older" ? olderStarted : newerStarted).resolve();
							await (current === "older" ? olderRelease : newerRelease).promise;
							if (current === "older") throw new Error("superseded metadata request failed");
							return { type: "oauth", source: "current account" };
						},
						resolve: async () => undefined,
					},
				});
			}
		}).then((result) => {
			settled = true;
			return result;
		});
		await olderStarted.promise;
		// Let every catalog continuation reach its gated availability phase, including services' barrier.
		await nextTurn();
		phase = "newer";
		const current = runtime.getAvailable();
		try {
			await newerStarted.promise;
			olderRelease.resolve();
			await nextTurn();
			console.log("services after stale failure", { settled, configured: runtime.hasConfiguredAuth("anthropic") });
			expect(settled).toBe(false);
			newerRelease.resolve();
			await startup;
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
			expect(runtime.isUsingSubscription("anthropic")).toBe(true);
			expect(runtime.getAvailableSnapshot()).toEqual(await current);
			expect(runtime.getError()).toBeUndefined();
		} finally {
			olderRelease.resolve();
			newerRelease.resolve();
			await Promise.all([startup, current]);
		}
	});
});
