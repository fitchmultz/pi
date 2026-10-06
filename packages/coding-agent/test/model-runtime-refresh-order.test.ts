import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { type Api, InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("ModelRuntime refresh ownership", () => {
	it.each(["config", "catalog"] as const)(
		"waits for superseding %s publication before awaited registry reads",
		async (phase) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-refresh-overlap-"));
			const path = join(dir, "models.json");
			const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: path });
			const registry = new ModelRegistry(runtime);
			const firstEntered = Promise.withResolvers<void>();
			const firstGate = Promise.withResolvers<void>();
			const secondEntered = Promise.withResolvers<void>();
			const secondGate = Promise.withResolvers<void>();
			const oldPublication = Promise.withResolvers<void>();
			const model = { ...runtime.getModels("anthropic")[0]!, provider: "refresh-probe", id: "ready" };
			let models: readonly Model<Api>[] = [];
			let active = false;
			let catalogs = 0;
			const provider: Provider = {
				...runtime.getProvider("anthropic")!,
				id: "refresh-probe",
				getModels: () => models,
				getAllModels: () => models,
				auth: {
					apiKey: {
						name: "fixture",
						check: async () => (active ? { type: "api_key", source: "fixture" } : undefined),
						resolve: async () => undefined,
					},
				},
				refreshModels: async ({ publish }) => {
					if (!active) return;
					const call = ++catalogs;
					if (phase === "catalog" && call <= 2) {
						(call === 1 ? firstEntered : secondEntered).resolve();
						await (call === 1 ? firstGate : secondGate).promise;
					}
					try {
						await publish({
							update: () => {
								models = [{ ...model, id: phase === "catalog" && call === 1 ? "obsolete" : "ready" }];
							},
						});
					} finally {
						if (phase === "catalog" && call === 1) oldPublication.resolve();
					}
				},
			};
			runtime.registerNativeProvider(provider);
			await runtime.refresh({ allowNetwork: false });
			writeFileSync(path, JSON.stringify({ providers: { "refresh-probe": { baseUrl: "https://fresh.test" } } }));
			active = true;
			const load = ModelConfig.load;
			const loadSpy = vi.spyOn(ModelConfig, "load");
			if (phase === "config") {
				for (const [entered, gate] of [
					[firstEntered, firstGate],
					[secondEntered, secondGate],
				]) {
					loadSpy.mockImplementationOnce(async (file) => {
						const config = await load(file);
						entered.resolve();
						await gate.promise;
						return config;
					});
				}
			}
			const pending: ReturnType<ModelRuntime["refresh"]>[] = [];
			try {
				const first = registry.refresh({ allowNetwork: false }).then((result) => ({
					result,
					model: registry.find("refresh-probe", "ready"),
					available: registry.getAvailable().map((entry) => `${entry.provider}/${entry.id}`),
					configured: runtime.hasConfiguredAuth("refresh-probe"),
				}));
				await firstEntered.promise;
				const second = registry.refresh({ allowNetwork: false });
				pending.push(second);
				await secondEntered.promise;
				if (phase === "config") firstGate.resolve();
				// Drain immediate work while the successor's actual I/O remains held.
				await setImmediate();
				secondGate.resolve();
				const read = await first;
				await second;
				expect(read).toMatchObject({
					result: { aborted: false, errors: new Map() },
					model: { id: "ready", baseUrl: "https://fresh.test" },
					available: expect.arrayContaining(["refresh-probe/ready"]),
					configured: true,
				});
				if (phase === "catalog") {
					firstGate.resolve();
					await oldPublication.promise;
					expect(registry.find("refresh-probe", "obsolete")).toBeUndefined();
				}
			} finally {
				firstGate.resolve();
				secondGate.resolve();
				await Promise.allSettled(pending);
				loadSpy.mockRestore();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it.each([
		["config", "registration"],
		["catalog", "registration"],
		["config", "disposal"],
		["catalog", "disposal"],
	] as const)("publishes uncancelled fallback %s work for %s after a successor aborts", async (phase, action) => {
		const store = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore: store,
		});
		let resolves = 0;
		const fallback = {
			check: async () => ({ type: "oauth" as const, source: "account" }),
			resolve: async () => {
				resolves++;
				return { auth: { apiKey: "request-only" }, source: "account" };
			},
		};
		let dispose: (() => void) | undefined;
		if (action === "disposal") {
			dispose = runtime.registerProviderAuthFallback("openai-codex", fallback);
			await runtime.refresh({ allowNetwork: false });
			expect(runtime.hasConfiguredAuth("openai-codex")).toBe(true);
		}
		const firstEntered = Promise.withResolvers<void>();
		const firstGate = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const load = ModelConfig.load;
		const loadSpy = vi.spyOn(ModelConfig, "load");
		const read = store.read.bind(store);
		let reads = 0;
		const readSpy = vi.spyOn(store, "read").mockImplementation(async (id, options) => {
			if (phase === "catalog" && id === "openai-codex" && ++reads <= 2) {
				(reads === 1 ? firstEntered : secondEntered).resolve();
				await (reads === 1 ? firstGate : secondGate).promise;
			}
			return read(id, options);
		});
		if (phase === "config") {
			for (const [entered, gate] of [
				[firstEntered, firstGate],
				[secondEntered, secondGate],
			]) {
				loadSpy.mockImplementationOnce(async (path) => {
					entered.resolve();
					await gate.promise;
					return load(path);
				});
			}
		}
		const refresh = runtime.refresh.bind(runtime);
		const pending: ReturnType<ModelRuntime["refresh"]>[] = [];
		const refreshSpy = vi.spyOn(runtime, "refresh").mockImplementation((options) => {
			const operation = refresh(options);
			pending.push(operation);
			return operation;
		});
		try {
			if (action === "registration") dispose = runtime.registerProviderAuthFallback("openai-codex", fallback);
			else dispose!();
			await firstEntered.promise;
			const controller = new AbortController();
			const later = runtime.refresh({ allowNetwork: false, signal: controller.signal });
			await secondEntered.promise;
			controller.abort();
			firstGate.resolve();
			secondGate.resolve();
			expect((await later).aborted).toBe(true);
			expect((await pending[0]!).aborted).toBe(false);
			const configured = action === "registration";
			expect({
				configured: runtime.hasConfiguredAuth("openai-codex"),
				oauth: runtime.isUsingOAuth("openai-codex"),
				available: runtime.getAvailableSnapshot().some((model) => model.provider === "openai-codex"),
				resolves,
			}).toEqual({ configured, oauth: configured, available: configured, resolves: 0 });
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			await Promise.allSettled(pending);
			refreshSpy.mockRestore();
			readSpy.mockRestore();
			loadSpy.mockRestore();
		}
	});

	it("rechecks every requested provider after a cancelled sibling successor resumes", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const registry = new ModelRegistry(runtime);
		const base = runtime.getProvider("anthropic")!;
		const bEntered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const bGates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const latestAEntered = Promise.withResolvers<void>();
		const latestAGate = Promise.withResolvers<void>();
		const resumedBPublished = Promise.withResolvers<void>();
		let active = false;
		for (const id of ["round-a", "round-b"]) {
			let calls = 0;
			let models: readonly Model<Api>[] = [{ ...base.getModels()[0]!, provider: id, id: "initial" }];
			runtime.registerNativeProvider({
				...base,
				id,
				getModels: () => models,
				getAllModels: () => models,
				auth: {
					apiKey: {
						name: "fixture",
						check: async () => ({ type: "api_key", source: "fixture" }),
						resolve: async () => undefined,
					},
				},
				refreshModels: async ({ publish }) => {
					if (!active) return;
					const call = ++calls;
					if (id === "round-b" && call <= 2) {
						bEntered[call - 1]!.resolve();
						await bGates[call - 1]!.promise;
					} else if (id === "round-a" && call === 2) {
						latestAEntered.resolve();
						await latestAGate.promise;
					}
					await publish({
						update: () => {
							models = [{ ...models[0]!, id: `${id}-${call}` }];
						},
					});
					if (id === "round-b" && call === 2) resumedBPublished.resolve();
					if (id === "round-a" && call === 2) throw new Error("latest catalog failed");
				},
			});
		}
		await runtime.refresh({ allowNetwork: false });
		const configEntered = Promise.withResolvers<void>();
		const configGate = Promise.withResolvers<void>();
		const load = ModelConfig.load;
		const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementationOnce(async (path) => {
			const config = await load(path);
			configEntered.resolve();
			await configGate.promise;
			return config;
		});
		const pending: ReturnType<ModelRuntime["refresh"]>[] = [];
		active = true;
		const first = registry.refresh({ allowNetwork: false, providers: ["round-a", "round-b"] }).then((result) => ({
			result,
			models: registry
				.getAvailable()
				.filter((model) => model.provider.startsWith("round-"))
				.map((model) => model.id),
		}));
		try {
			await configEntered.promise;
			await registry.refresh({ allowNetwork: false, providers: ["round-a"] });
			const controller = new AbortController();
			const cancelled = registry.refresh({ allowNetwork: false, providers: ["round-b"], signal: controller.signal });
			await bEntered[0]!.promise;
			controller.abort();
			expect((await cancelled).aborted).toBe(true);
			configGate.resolve();
			await bEntered[1]!.promise;
			const latestA = registry.refresh({ allowNetwork: false, providers: ["round-a"] });
			pending.push(latestA);
			await latestAEntered.promise;
			bGates[1]!.resolve();
			await resumedBPublished.promise;
			latestAGate.resolve();
			const read = await first;
			expect(read.result.aborted).toBe(false);
			expect(read.result.errors.get("round-a")?.message).toBe("latest catalog failed");
			expect(read.models).toEqual(["round-a-2", "round-b-2"]);
			await latestA;
		} finally {
			configGate.resolve();
			for (const gate of bGates) gate.resolve();
			latestAGate.resolve();
			await Promise.allSettled([first, ...pending]);
			loadSpy.mockRestore();
		}
	});

	it("cancels a superseded caller without waiting for its successor or blocking scoped credential work", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const firstGate = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const load = ModelConfig.load;
		const loadSpy = vi
			.spyOn(ModelConfig, "load")
			.mockImplementationOnce(async (path) => {
				await firstGate.promise;
				return load(path);
			})
			.mockImplementationOnce(async (path) => {
				secondEntered.resolve();
				await secondGate.promise;
				return load(path);
			});
		const controller = new AbortController();
		const first = runtime.refresh({ allowNetwork: false, signal: controller.signal });
		const second = runtime.refresh({ allowNetwork: false });
		try {
			await secondEntered.promise;
			firstGate.resolve();
			await setImmediate();
			controller.abort();
			expect((await first).aborted).toBe(true);
			await runtime.setRuntimeApiKey("anthropic", "scoped-key");
			expect((await runtime.refresh({ providers: ["anthropic"], allowNetwork: false })).aborted).toBe(false);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			await Promise.allSettled([first, second]);
			loadSpy.mockRestore();
		}
	});

	it.each(["full", "disjoint"] as const)(
		"keeps %s sibling refresh work and ignores older config snapshots",
		async (scope) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-scoped-refresh-"));
			const path = join(dir, "models.json");
			const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: path });
			const base = runtime.getProvider("anthropic")!;
			const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
			const entered = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
			let active = false;
			for (const id of ["catalog-a", "catalog-b"]) {
				let models: readonly Model<Api>[] = [];
				gates.set(id, Promise.withResolvers<void>());
				entered.set(id, Promise.withResolvers<void>());
				runtime.registerNativeProvider({
					...base,
					id,
					auth: {
						apiKey: {
							name: "fixture",
							check: async () => ({ type: "api_key", source: "fixture" }),
							resolve: async () => undefined,
						},
					},
					getModels: () => models,
					getAllModels: () => models,
					refreshModels: async ({ publish }) => {
						if (!active) return;
						entered.get(id)!.resolve();
						await gates.get(id)!.promise;
						await publish({
							update: () => {
								models = [{ ...base.getModels()[0]!, provider: id, id: "ready" }];
							},
						});
					},
				});
			}
			await runtime.refresh({ allowNetwork: false });
			const writeConfig = (host: string) =>
				writeFileSync(
					path,
					JSON.stringify({
						providers: {
							"catalog-a": { baseUrl: `https://${host}.test/a` },
							"catalog-b": { baseUrl: `https://${host}.test/b` },
						},
					}),
				);
			writeConfig("old");
			const load = ModelConfig.load;
			const oldEntered = Promise.withResolvers<void>();
			const oldGate = Promise.withResolvers<void>();
			const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementationOnce(async (file) => {
				const config = await load(file);
				oldEntered.resolve();
				await oldGate.promise;
				return config;
			});
			active = true;
			const older = runtime.refresh({
				allowNetwork: false,
				...(scope === "disjoint" ? { providers: ["catalog-b"] } : {}),
			});
			let newer: ReturnType<ModelRuntime["refresh"]> | undefined;
			try {
				await oldEntered.promise;
				writeConfig("fresh");
				newer = runtime.refresh({ allowNetwork: false, providers: ["catalog-a"] });
				await entered.get("catalog-a")!.promise;
				oldGate.resolve();
				await entered.get("catalog-b")!.promise;
				gates.get("catalog-a")!.resolve();
				expect(await newer).toEqual({ aborted: false, errors: new Map() });
				expect(runtime.getModel("catalog-a", "ready")?.baseUrl).toBe("https://fresh.test/a");
				expect(runtime.hasConfiguredAuth("catalog-a")).toBe(true);
				gates.get("catalog-b")!.resolve();
				expect(await older).toEqual({ aborted: false, errors: new Map() });
				expect(runtime.getModel("catalog-b", "ready")?.baseUrl).toBe("https://fresh.test/b");
				expect(
					runtime.getAvailableSnapshot().filter((model) => model.provider.startsWith("catalog-")),
				).toHaveLength(2);
			} finally {
				oldGate.resolve();
				for (const gate of gates.values()) gate.resolve();
				await Promise.allSettled([older, newer]);
				loadSpy.mockRestore();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it.each(["auth", "catalog"] as const)(
		"keeps sibling availability and credential filters when scoped work overtakes full %s publication",
		async (phase) => {
			const filtered = "filtered-auth";
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ [filtered]: { type: "api_key", key: "allowed" } }),
				modelsPath: null,
			});
			const base = runtime.getProvider("anthropic")!;
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			let active = false;
			const models = ["allowed", "excluded"].map((id) => ({ ...base.getModels()[0]!, provider: filtered, id }));
			runtime.registerNativeProvider({
				...base,
				id: filtered,
				getModels: () => models,
				getAllModels: () => models,
				filterModels: (entries, credential) =>
					entries.filter((model) => credential?.type === "api_key" && model.id === credential.key),
				auth: {
					apiKey: {
						name: "fixture",
						check: async () => ({ type: "api_key", source: "fixture" }),
						resolve: async () => undefined,
					},
				},
			});
			runtime.registerNativeProvider({
				...base,
				id: "slow-auth",
				getModels: () => [{ ...base.getModels()[0]!, provider: "slow-auth" }],
				getAllModels: () => [{ ...base.getModels()[0]!, provider: "slow-auth" }],
				refreshModels: async () => {
					if (active && phase === "catalog") {
						entered.resolve();
						await gate.promise;
					}
				},
				auth: {
					apiKey: {
						name: "fixture",
						resolve: async () => undefined,
						check: async () => {
							if (!active) return undefined;
							if (phase === "auth") {
								entered.resolve();
								await gate.promise;
							}
							return { type: "api_key", source: "fixture" };
						},
					},
				},
			});
			await runtime.refresh({ allowNetwork: false });
			active = true;
			const full = runtime.refresh({ allowNetwork: false });
			try {
				await entered.promise;
				await runtime.refresh({ allowNetwork: false, providers: [filtered] });
				gate.resolve();
				await full;
				expect(runtime.hasConfiguredAuth("slow-auth")).toBe(true);
				expect(runtime.getAvailableSnapshot().some((model) => model.provider === "slow-auth")).toBe(true);
				expect(
					runtime
						.getAvailableSnapshot()
						.filter((model) => model.provider === filtered)
						.map((model) => model.id),
				).toEqual(["allowed"]);
			} finally {
				gate.resolve();
				await full;
			}
		},
	);

	it("clears a failed sibling's auth and availability when a full refresh is partially superseded", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const base = runtime.getProvider("anthropic")!;
		let fail = false;
		for (const id of ["healthy-scope", "failed-sibling"]) {
			const models = [{ ...base.getModels()[0]!, provider: id }];
			runtime.registerNativeProvider({
				...base,
				id,
				getModels: () => models,
				getAllModels: () => models,
				auth: {
					apiKey: {
						name: "fixture",
						resolve: async () => undefined,
						check: async () => {
							if (fail && id === "failed-sibling") throw new Error("sibling auth failed");
							return { type: "api_key", source: "fixture" };
						},
					},
				},
			});
		}
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.hasConfiguredAuth("failed-sibling")).toBe(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "failed-sibling")).toBe(true);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const load = ModelConfig.load;
		const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementationOnce(async (path) => {
			const config = await load(path);
			entered.resolve();
			await gate.promise;
			return config;
		});
		fail = true;
		const full = runtime.refresh({ allowNetwork: false });
		try {
			await entered.promise;
			await runtime.refresh({ allowNetwork: false, providers: ["healthy-scope"] });
			gate.resolve();
			const result = await full;
			expect(result.aborted).toBe(false);
			expect(result.errors.get("failed-sibling")?.message).toContain("sibling auth failed");
			expect(runtime.hasConfiguredAuth("failed-sibling")).toBe(false);
			expect(runtime.getAvailableSnapshot().some((model) => model.provider === "failed-sibling")).toBe(false);
			expect(runtime.getAuthCheckError("failed-sibling")?.message).toContain("sibling auth failed");
			expect(runtime.hasConfiguredAuth("healthy-scope")).toBe(true);
			await expect(runtime.getAvailable("failed-sibling")).rejects.toThrow("sibling auth failed");
		} finally {
			gate.resolve();
			await full;
			loadSpy.mockRestore();
		}
	});
});
