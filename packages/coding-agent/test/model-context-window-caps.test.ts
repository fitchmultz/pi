import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("models.json context window ceilings", () => {
	const dirs: string[] = [];
	function modelsFile(config: unknown): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-ceilings-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		writeFileSync(path, JSON.stringify(config));
		return path;
	}
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("caps current and future chat models without raising source or explicit limits", async () => {
		const path = modelsFile({
			contextWindowCaps: {
				default: 335000,
				providers: { ds4: 262144, "local-abliterated": 262144, higher: 400000 },
			},
			providers: {
				fixture: {
					models: [{ id: "replaced", contextWindow: 500000 }],
					modelOverrides: {
						small: { contextWindow: 335000 },
						limited: { contextWindow: 180000 },
						opaque: { contextWindow: 335000 },
					},
				},
			},
		});
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), path));
		const fixture = fauxProvider({
			provider: "fixture",
			models: [
				{ id: "large", contextWindow: 1000000, cost: { input: 3, output: 5, cacheRead: 1, cacheWrite: 2 } },
				{ id: "small", contextWindow: 128000 },
				{ id: "limited", contextWindow: 1000000 },
				{ id: "replaced", contextWindow: 128000 },
				{ id: "opaque", contextWindow: 0 },
			],
		});
		runtime.registerNativeProvider(fixture.provider);
		const local = fauxProvider({ provider: "ds4", models: [{ id: "discovered", contextWindow: 1000000 }] });
		runtime.registerNativeProvider(local.provider);
		const otherLocal = fauxProvider({
			provider: "local-abliterated",
			models: [{ id: "different-model", contextWindow: 1000000 }],
		});
		runtime.registerNativeProvider(otherLocal.provider);
		const higher = fauxProvider({ provider: "higher", models: [{ id: "large", contextWindow: 1000000 }] });
		runtime.registerNativeProvider(higher.provider);
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getModel("anthropic", "claude-haiku-5-5")?.contextWindow).toBe(335000);
		expect(runtime.getModel("fixture", "large")?.contextWindow).toBe(335000);
		expect(runtime.getModel("fixture", "small")?.contextWindow).toBe(128000);
		expect(runtime.getModel("fixture", "limited")?.contextWindow).toBe(180000);
		expect(runtime.getModel("fixture", "replaced")?.contextWindow).toBe(128000);
		expect(runtime.getModel("fixture", "opaque")?.contextWindow).toBe(0);
		expect(runtime.getModel("ds4", "discovered")?.contextWindow).toBe(262144);
		expect(runtime.getModel("local-abliterated", "different-model")?.contextWindow).toBe(262144);
		expect(runtime.getModel("higher", "large")?.contextWindow).toBe(400000);
		expect(runtime.getModel("fixture", "large")?.cost).toEqual(fixture.models[0].cost);
	});

	it("preserves provider filtering and dispatches a retained model with current limits", async () => {
		const path = modelsFile({ providers: {} });
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), path));
		const fixture = fauxProvider({
			provider: "filtered",
			models: [
				{ id: "eligible", contextWindow: 1000000 },
				{ id: "ineligible", contextWindow: 128000 },
			],
		});
		runtime.registerNativeProvider({
			...fixture.provider,
			filterModels: (models) => models.filter((model) => model.contextWindow > 500000),
		});
		await runtime.refresh({ allowNetwork: false });
		const retained = runtime.getModel("filtered", "eligible")!;
		writeFileSync(path, JSON.stringify({ contextWindowCaps: { default: 335000 } }));
		await runtime.refresh({ allowNetwork: false });

		const available = await runtime.getAvailable("filtered");
		expect(available.map((model) => [model.id, model.contextWindow])).toEqual([["eligible", 335000]]);
		const provider = runtime.getProvider("filtered")!;
		expect(provider.filterModels?.(provider.getModels(), undefined).map((model) => model.id)).toEqual(["eligible"]);
		let dispatched: typeof retained | undefined;
		fixture.setResponses([
			(_context, _options, _state, model) => {
				dispatched = model;
				return fauxAssistantMessage("ok");
			},
		]);
		const response = await runtime.completeSimple(retained, { messages: [] });
		expect(response.stopReason).toBe("stop");
		expect(dispatched).toMatchObject({
			id: retained.id,
			api: retained.api,
			baseUrl: retained.baseUrl,
			cost: retained.cost,
			contextWindow: 335000,
		});
	});

	it("preserves a native provider's accessor metadata and optional methods", async () => {
		const runtime = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory(), modelsFile({ contextWindowCaps: { default: 335000 } })),
		);
		const fixture = fauxProvider({ provider: "native", models: [{ id: "large", contextWindow: 1000000 }] });
		class NativeProvider {
			get id() {
				return fixture.provider.id;
			}
			get name() {
				return fixture.provider.name;
			}
			get auth() {
				return fixture.provider.auth;
			}
			getModels() {
				return fixture.provider.getModels();
			}
			stream = fixture.provider.stream;
			streamSimple = fixture.provider.streamSimple;
		}
		runtime.registerNativeProvider(new NativeProvider());
		const provider = runtime.getProvider("native")!;
		expect(provider.id).toBe("native");
		expect(provider.name).toBe(fixture.provider.name);
		expect(provider.auth).toBe(fixture.provider.auth);
		expect(provider.getAllModels).toBeUndefined();
		expect(provider.getModels()[0].contextWindow).toBe(335000);
	});

	it("caps dynamically refreshed extension models and preserves their pre-override limits", async () => {
		const path = modelsFile({
			contextWindowCaps: { default: 335000 },
			providers: {
				dynamic: {
					baseUrl: "http://localhost:0",
					api: "openai-completions",
					models: [{ id: "configured", contextWindow: 100000 }],
					modelOverrides: { small: { contextWindow: 335000 } },
				},
			},
		});
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), path));
		const model = (id: string, contextWindow: number) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: 1000,
		});
		let next = [model("small", 128000), model("configured", 1000000)];
		runtime.registerProvider("dynamic", {
			baseUrl: "http://localhost:0",
			api: "openai-completions",
			apiKey: "fixture",
			refreshModels: async () => next,
		});
		await runtime.refresh({ providers: ["dynamic"], allowNetwork: false });
		expect(runtime.getModel("dynamic", "small")?.contextWindow).toBe(128000);
		expect(runtime.getModel("dynamic", "configured")?.contextWindow).toBe(100000);
		next = [model("new-model", 1000000), model("small", 128000)];
		await runtime.refresh({ providers: ["dynamic"], allowNetwork: false });
		expect(runtime.getModel("dynamic", "new-model")?.contextWindow).toBe(335000);
		expect(
			runtime.getAvailableSnapshot().find((entry) => entry.id === "small" && entry.provider === "dynamic")
				?.contextWindow,
		).toBe(128000);
	});

	it("supports a provider-only policy without imposing a default", async () => {
		const runtime = getModelRuntime(
			await createModelRegistry(
				AuthStorage.inMemory(),
				modelsFile({ contextWindowCaps: { providers: { local: 262144 } } }),
			),
		);
		const local = fauxProvider({ provider: "local", models: [{ id: "one", contextWindow: 1000000 }] });
		const other = fauxProvider({ provider: "other", models: [{ id: "two", contextWindow: 1000000 }] });
		runtime.registerNativeProvider(local.provider);
		runtime.registerNativeProvider(other.provider);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("local", "one")?.contextWindow).toBe(262144);
		expect(runtime.getModel("other", "two")?.contextWindow).toBe(1000000);
	});

	it("leaves image and classifier catalogs unchanged", async () => {
		const without = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), modelsFile({ providers: {} })));
		const withCaps = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory(), modelsFile({ contextWindowCaps: { default: 335000 } })),
		);
		const classifiers = without.getModelsOfType("classifier");
		const images = without.getModelsOfType("image");
		expect(classifiers.length).toBeGreaterThan(0);
		expect(images.length).toBeGreaterThan(0);
		expect(withCaps.getModelsOfType("classifier")).toEqual(classifiers);
		expect(withCaps.getModelsOfType("image")).toEqual(images);
	});

	it("does not invent a limit for a virtual model with an unknown backend", async () => {
		const path = modelsFile({
			contextWindowCaps: { default: 335000 },
			providers: {
				router: { modelOverrides: { auto: { contextWindow: 120000 }, known: { contextWindow: 120000 } } },
			},
		});
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), path));
		const target = fauxProvider({ provider: "target", models: [{ id: "physical", contextWindow: 1000000 }] });
		runtime.registerNativeProvider(target.provider);
		runtime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			route: () => ({ model: target.getModel(), thinkingLevel: "off" }),
		});
		runtime.registerVirtualModel({
			provider: "router",
			id: "known",
			name: "Known",
			contextWindow: 1000000,
			route: () => ({ model: target.getModel(), thinkingLevel: "off" }),
		});
		await runtime.refresh({ allowNetwork: false });
		const virtual = runtime.getModel("router", "auto")!;
		expect(virtual.contextWindow).toBe(0);
		expect(runtime.getModel("router", "known")?.contextWindow).toBe(120000);
		const route = await runtime.resolveModel(virtual, [], { reason: "user", thinkingLevel: "off" });
		expect(route.model.contextWindow).toBe(335000);
		writeFileSync(
			path,
			JSON.stringify({ providers: { router: { modelOverrides: { known: { contextWindow: 120000 } } } } }),
		);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("router", "known")?.contextWindow).toBe(1000000);
	});

	it("keeps existing override behavior when the policy is absent", async () => {
		const path = modelsFile({ providers: { fixture: { modelOverrides: { small: { contextWindow: 335000 } } } } });
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), path));
		const fixture = fauxProvider({ provider: "fixture", models: [{ id: "small", contextWindow: 128000 }] });
		runtime.registerNativeProvider(fixture.provider);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("fixture", "small")?.contextWindow).toBe(335000);
	});

	it("still rejects a missing providers key when no policy is present", async () => {
		const invalid = await ModelConfig.load(modelsFile({ provdiers: {} }));
		expect(invalid.getError()).toContain("providers");
		const policyOnly = await ModelConfig.load(modelsFile({ contextWindowCaps: { default: 335000 } }));
		expect(policyOnly.getError()).toBeUndefined();
	});

	it("updates all providers when a scoped refresh reloads the global policy", async () => {
		const path = modelsFile({ providers: {} });
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), path));
		for (const id of ["first", "second"]) {
			const fixture = fauxProvider({ provider: id, models: [{ id: "large", contextWindow: 1000000 }] });
			runtime.registerNativeProvider(fixture.provider);
		}
		await runtime.refresh({ allowNetwork: false });
		writeFileSync(path, JSON.stringify({ providers: {}, contextWindowCaps: { default: 335000 } }));
		await runtime.refresh({ allowNetwork: false, providers: ["first"] });
		expect(runtime.getModel("second", "large")?.contextWindow).toBe(335000);
		expect(runtime.getAvailableSnapshot().find((model) => model.provider === "second")?.contextWindow).toBe(335000);
		writeFileSync(path, JSON.stringify({ providers: {} }));
		await runtime.refresh({ allowNetwork: false, providers: ["first"] });
		expect(runtime.getModel("second", "large")?.contextWindow).toBe(1000000);
		expect(runtime.getAvailableSnapshot().find((model) => model.provider === "second")?.contextWindow).toBe(1000000);
	});

	it.each([0, -1, 1.5, "335000", null, 9007199254740992])("rejects invalid ceiling %s", async (value) => {
		const path = modelsFile({ providers: {}, contextWindowCaps: { default: value } });
		expect((await ModelConfig.load(path)).getError()).toContain("contextWindowCaps.default");
	});

	it("rejects malformed provider ceilings and misspelled policy fields", async () => {
		for (const caps of [
			{ providers: { ds4: 0 } },
			{ providers: { "": 1000 } },
			{ providers: [] },
			{ defaut: 335000 },
		]) {
			expect((await ModelConfig.load(modelsFile({ contextWindowCaps: caps }))).getError()).toContain(
				"contextWindowCaps",
			);
		}
	});
});
