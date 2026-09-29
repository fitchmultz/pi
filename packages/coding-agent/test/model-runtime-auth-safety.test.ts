import { type AuthCheck, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findInitialModel,
	resolveModelScopeWithDiagnostics,
	restoreModelFromSession,
} from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("model runtime auth safety", () => {
	let runtime: ModelRuntime;
	let credentials: InMemoryCredentialStore;
	let store: InMemoryModelsStore;
	let check: NonNullable<ProviderConfigInput["ambientAuth"]>["check"];
	const resolveAuth = vi.fn(async () => ({ auth: { apiKey: "shared-account" }, source: "shared" }));

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
		credentials = new InMemoryCredentialStore();
		store = new InMemoryModelsStore();
		runtime = await ModelRuntime.create({
			credentials,
			modelsStore: store,
			modelsPath: null,
			refreshOnCreate: false,
		});
		check = async () => ({ type: "oauth", source: "shared subscription" });
		for (const provider of runtime.getProviders()) {
			runtime.registerProvider(provider.id, {
				ambientAuth: {
					check: (input) =>
						provider.id === "anthropic"
							? check(input)
							: Promise.resolve(
									provider.id === "openai" ? { type: "api_key", source: "other payer" } : undefined,
								),
					resolve: resolveAuth,
				},
			});
		}
		await runtime.flushForCheckpoint();
	});

	afterEach(async () => {
		await runtime.flushForCheckpoint();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		resolveAuth.mockClear();
	});

	it("observes auth once per provider, reports subscription metadata, and resolves ambient auth only for a request", async () => {
		const observed = vi.fn();
		const checker = vi.fn(async (): Promise<AuthCheck> => ({ type: "oauth", source: "shared subscription" }));
		check = checker;
		await runtime.getAvailable(undefined, { onAuthResult: observed });
		expect(checker).toHaveBeenCalledTimes(1);
		expect(observed.mock.calls.filter(([id]) => id === "anthropic")).toEqual([
			["anthropic", { stored: false, auth: { type: "oauth", source: "shared subscription" }, error: undefined }],
		]);
		expect(runtime.isUsingSubscription("anthropic")).toBe(true);
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({
			configured: true,
			source: "environment",
			label: "shared subscription",
		});
		expect(resolveAuth).not.toHaveBeenCalled();
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("shared-account");
		expect(await credentials.list()).toEqual([]);
	});

	it("keeps healthy providers visible without changing a failed saved, default, or scoped payer", async () => {
		check = async () => {
			throw new Error("Reconnect selected subscription");
		};
		const available = await runtime.getAvailable();
		const selected = runtime.getModels("anthropic")[0];
		expect(available.some((model) => model.provider === "openai")).toBe(true);
		expect(available.some((model) => model.provider === "anthropic")).toBe(false);
		expect(runtime.isUsingSubscription("anthropic")).toBe(false);
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({ configured: false });
		expect(runtime.getError()).toContain("Reconnect selected subscription");
		expect(
			(
				await findInitialModel({
					scopedModels: [],
					isContinuing: false,
					defaultProvider: "anthropic",
					defaultModelId: selected.id,
					modelRuntime: runtime,
				})
			).model,
		).toEqual(selected);
		expect(await restoreModelFromSession("anthropic", selected.id, available[0], false, runtime)).toEqual({
			model: selected,
			fallbackMessage: undefined,
		});
		expect(
			(await resolveModelScopeWithDiagnostics([`anthropic/${selected.id}`, "openai/*"], runtime)).scopedModels[0]
				.model,
		).toEqual(selected);
		expect(resolveAuth).not.toHaveBeenCalled();
	});

	it("shares failure diagnostics across all model types without colliding chat and image identities", async () => {
		const native = runtime.getProvider("anthropic")!;
		const chat = runtime.getModels("anthropic")[0];
		const image = {
			type: "image" as const,
			id: chat.id,
			name: "Same-id image",
			provider: "anthropic",
			api: "test-images",
			baseUrl: "https://images.example.test",
			input: ["text" as const],
			output: ["image" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		runtime.registerNativeProvider({ ...native, getModels: () => [chat], getAllModels: () => [chat, image] });
		await runtime.flushForCheckpoint();
		expect(await runtime.getAllAvailable("anthropic")).toEqual([chat, image]);
		expect(await runtime.getAvailableOfType("image", "anthropic")).toEqual([image]);
		expect(await runtime.getAvailable("anthropic")).toEqual([chat]);
		check = async () => {
			throw new Error("Image subscription unavailable");
		};
		expect((await runtime.getAllAvailable()).some((model) => model.provider === "openai")).toBe(true);
		expect(runtime.getAuthCheckError("anthropic")?.message).toContain("Image subscription unavailable");
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(false);
		await expect(runtime.getAvailableOfType("image", "anthropic")).rejects.toThrow("Image subscription unavailable");
	});

	it("coalesces registration refreshes and waits for auth before publishing a startup snapshot", async () => {
		const started = deferred();
		const release = deferred();
		const checker = vi.fn(async (): Promise<AuthCheck> => {
			started.resolve();
			await release.promise;
			return { type: "oauth", source: "startup" };
		});
		check = checker;
		runtime.registerProvider("anthropic", { name: "Startup account" });
		runtime.registerProvider("openai", { name: "Other account" });
		let settled = false;
		const startup = runtime.refresh({ allowNetwork: false }).then(() => {
			settled = true;
		});
		try {
			await started.promise;
			expect(settled).toBe(false);
			release.resolve();
			await startup;
			await runtime.flushForCheckpoint();
			expect(checker).toHaveBeenCalledTimes(1);
			expect(runtime.getAvailableSnapshot()).toContainEqual(runtime.getModels("anthropic")[0]);
		} finally {
			release.resolve();
			await startup;
		}
	});

	it("retains checkpoint ownership of a cancelled catalog store tail and never publishes it", async () => {
		const started = deferred();
		const release = deferred();
		const read = store.read.bind(store);
		vi.spyOn(store, "read").mockImplementation(async (id, options) => {
			if (id === "anthropic") {
				started.resolve();
				await release.promise;
			}
			return read(id, options);
		});
		const controller = new AbortController();
		const refresh = runtime.refresh({ providers: ["anthropic"], allowNetwork: false, signal: controller.signal });
		await started.promise;
		controller.abort(new Error("startup deadline"));
		let flushed = false;
		const checkpoint = runtime.flushForCheckpoint().then(() => {
			flushed = true;
		});
		try {
			expect(await refresh).toMatchObject({ aborted: true });
			await new Promise<void>((done) => setImmediate(done));
			expect(flushed).toBe(false);
		} finally {
			release.resolve();
			await checkpoint;
		}
	});

	it("refuses durable checkpoints after storage failure but accepts them after a successful retry", async () => {
		const write = vi.spyOn(store, "write").mockRejectedValueOnce(new Error("disk full"));
		const native = runtime.getProvider("anthropic")!;
		runtime.registerNativeProvider({
			...native,
			refreshModels: async (context) => {
				await context.publish({ persist: { models: [] } });
			},
		});
		await runtime.flushForCheckpoint();
		await expect(runtime.flushForCheckpoint({ requireSuccessfulPersistence: true })).rejects.toThrow("disk full");
		expect(write).toHaveBeenCalled();
		await runtime.refresh({ providers: ["anthropic"], allowNetwork: false });
		await expect(runtime.flushForCheckpoint({ requireSuccessfulPersistence: true })).resolves.toBeUndefined();
	});
});
