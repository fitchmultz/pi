import { setImmediate } from "node:timers/promises";
import type { ApiKeyCredential, Credential, CredentialStore, Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

function model(provider: string): Model<"openai-completions"> {
	return {
		id: "dynamic",
		name: "Dynamic",
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function provider(
	id: string,
	options: {
		login?: () => Promise<ApiKeyCredential>;
		refreshModels?: Provider["refreshModels"];
	} = {},
): Provider<"openai-completions"> {
	const providerModel = model(id);
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				login: async () => options.login?.() ?? { type: "api_key", key: `${id}-key` },
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [providerModel],
		refreshModels: options.refreshModels,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

async function runtimeWithProvider(
	registered: Provider,
	credentials: AuthStorage = AuthStorage.inMemory(),
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(registered);
	await runtime.refresh({ allowNetwork: false, providers: [registered.id] });
	return runtime;
}

describe("ModelRuntime credential synchronization", () => {
	it.each(["login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"] as const)(
		"does not let earlier config I/O overtake %s catalog synchronization",
		async (operation) => {
			const id = "admission";
			const credentials = AuthStorage.inMemory({ [id]: { type: "api_key", key: "stored-key" } });
			const cacheEntered = Promise.withResolvers<void>();
			const cacheGate = Promise.withResolvers<void>();
			const obsoleteGate = Promise.withResolvers<void>();
			let active = false;
			let reads = 0;
			let models: readonly Model<"openai-completions">[] = [{ ...model(id), id: "fallback" }];
			const registered = provider(id, {
				refreshModels: async ({ credential, publish }) => {
					if (!active) return;
					if (++reads === 1) {
						cacheEntered.resolve();
						await cacheGate.promise;
					} else {
						await obsoleteGate.promise;
					}
					await publish({
						update: () => {
							models = [
								{ ...model(id), id: credential?.type === "api_key" ? credential.key! : "no-credential" },
							];
						},
					});
				},
			});
			registered.getModels = () => models;
			const runtime = await runtimeWithProvider(registered, credentials);
			if (operation === "removeRuntimeApiKey") await runtime.setRuntimeApiKey(id, "previous-runtime-key");
			const configEntered = Promise.withResolvers<void>();
			const configGate = Promise.withResolvers<void>();
			const load = ModelConfig.load;
			const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementationOnce(async (path) => {
				const config = await load(path);
				configEntered.resolve();
				await configGate.promise;
				return config;
			});
			active = true;
			const older = runtime.refresh({ allowNetwork: false });
			let synchronized: Promise<unknown> | undefined;
			try {
				await configEntered.promise;
				if (operation === "login") {
					synchronized = runtime.login(id, "api_key", { prompt: async () => "unused", notify() {} });
				} else if (operation === "logout") {
					synchronized = runtime.logout(id);
				} else if (operation === "setRuntimeApiKey") {
					synchronized = runtime.setRuntimeApiKey(id, "runtime-key");
				} else {
					synchronized = runtime.removeRuntimeApiKey(id);
				}
				await cacheEntered.promise;
				configGate.resolve();
				await setImmediate();
				cacheGate.resolve();
				await synchronized;
				const expected = {
					login: `${id}-key`,
					logout: "no-credential",
					setRuntimeApiKey: "runtime-key",
					removeRuntimeApiKey: "stored-key",
				}[operation];
				expect(runtime.getModels(id).map((entry) => entry.id)).toEqual([expected]);
				expect(runtime.hasConfiguredAuth(id)).toBe(operation !== "logout");
			} finally {
				configGate.resolve();
				cacheGate.resolve();
				obsoleteGate.resolve();
				await Promise.allSettled([older, synchronized]);
				loadSpy.mockRestore();
			}
		},
	);

	it("publishes locally consistent availability before login and logout resolve", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(provider("dynamic"), credentials);

		await runtime.login("dynamic", "api_key", { prompt: async () => "unused", notify: () => {} });
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);
		expect(runtime.getAvailableSnapshot().map((entry) => entry.id)).toContain("dynamic");
		expect(await credentials.read("dynamic")).toEqual({ type: "api_key", key: "dynamic-key" });

		await runtime.logout("dynamic");
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === "dynamic")).toBe(false);
		expect(await credentials.read("dynamic")).toBeUndefined();
	});

	it("orders same-provider credential operations through local synchronization", async () => {
		let markLoginStarted: (() => void) | undefined;
		let finishLogin: (() => void) | undefined;
		const loginStarted = new Promise<void>((resolve) => {
			markLoginStarted = resolve;
		});
		const blockedLogin = new Promise<void>((resolve) => {
			finishLogin = resolve;
		});
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("ordered", {
				login: async () => {
					markLoginStarted?.();
					await blockedLogin;
					return { type: "api_key", key: "ordered-key" };
				},
			}),
			credentials,
		);

		const login = runtime.login("ordered", "api_key", { prompt: async () => "unused", notify: () => {} });
		await loginStarted;
		const logout = runtime.logout("ordered");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await credentials.read("ordered")).toBeUndefined();

		finishLogin?.();
		await Promise.all([login, logout]);
		expect(await credentials.read("ordered")).toBeUndefined();
		expect(runtime.hasConfiguredAuth("ordered")).toBe(false);
	});

	it("allows different providers to run credential flows concurrently", async () => {
		let firstStarted: (() => void) | undefined;
		let secondStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const second = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			provider("one", {
				login: async () => {
					firstStarted?.();
					await blocked;
					return { type: "api_key", key: "one" };
				},
			}),
		);
		runtime.registerNativeProvider(
			provider("two", {
				login: async () => {
					secondStarted?.();
					await blocked;
					return { type: "api_key", key: "two" };
				},
			}),
		);
		await runtime.refresh({ allowNetwork: false, providers: ["one", "two"] });

		const one = runtime.login("one", "api_key", { prompt: async () => "unused", notify: () => {} });
		const two = runtime.login("two", "api_key", { prompt: async () => "unused", notify: () => {} });
		await Promise.all([first, second]);
		finish?.();
		await Promise.all([one, two]);
	});

	it("does not wait for unrelated provider availability during local synchronization", async () => {
		let stallUnrelated = false;
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(provider("target"));
		const unrelated = provider("unrelated");
		if (unrelated.auth.apiKey) {
			unrelated.auth.apiKey.check = async () => {
				if (stallUnrelated) await new Promise<void>(() => {});
				return undefined;
			};
		}
		runtime.registerNativeProvider(unrelated);
		await runtime.refresh({ allowNetwork: false, providers: ["target", "unrelated"] });
		stallUnrelated = true;

		await runtime.login("target", "api_key", { prompt: async () => "unused", notify: () => {} });
		expect(runtime.hasConfiguredAuth("target")).toBe(true);
		await expect(runtime.refresh({ allowNetwork: false, providers: ["target"] })).resolves.toMatchObject({
			aborted: false,
		});
	});

	it.each(["login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"] as const)(
		"finishes %s local synchronization before an overlapping full successor's unrelated catalog",
		async (operation) => {
			const id = "local-target";
			const credentials = AuthStorage.inMemory({ [id]: { type: "api_key", key: "stored-key" } });
			const firstEntered = Promise.withResolvers<void>();
			const firstGate = Promise.withResolvers<void>();
			const firstPublished = Promise.withResolvers<void>();
			const targetPublished = Promise.withResolvers<void>();
			const unrelatedEntered = Promise.withResolvers<void>();
			const unrelatedGate = Promise.withResolvers<void>();
			let active = false;
			let targetCalls = 0;
			let models: readonly Model<"openai-completions">[] = [model(id)];
			const target = provider(id, {
				refreshModels: async ({ credential, publish }) => {
					if (!active) return;
					const first = ++targetCalls === 1;
					if (first) {
						firstEntered.resolve();
						await firstGate.promise;
					}
					try {
						await publish({
							update: () => {
								models = [{ ...model(id), id: credential?.type === "api_key" ? credential.key! : "no-key" }];
							},
						});
						if (!first) targetPublished.resolve();
					} finally {
						if (first) firstPublished.resolve();
					}
				},
			});
			target.getModels = () => models;

			const runtime = await runtimeWithProvider(target, credentials);
			runtime.registerNativeProvider(
				provider("local-unrelated", {
					refreshModels: async () => {
						if (!active) return;
						unrelatedEntered.resolve();
						await unrelatedGate.promise;
					},
				}),
			);
			await runtime.refresh({ allowNetwork: false });
			if (operation === "removeRuntimeApiKey") await runtime.setRuntimeApiKey(id, "previous-key");
			active = true;
			const completionOrder: string[] = [];
			const local = (
				operation === "login"
					? runtime.login(id, "api_key", { prompt: async () => "unused", notify() {} })
					: operation === "logout"
						? runtime.logout(id)
						: operation === "setRuntimeApiKey"
							? runtime.setRuntimeApiKey(id, "runtime-key")
							: runtime.removeRuntimeApiKey(id)
			).then(() => {
				completionOrder.push("local");
			});
			await firstEntered.promise;
			const full = runtime.refresh({ allowNetwork: false }).then((result) => {
				completionOrder.push("full");
				return result;
			});
			try {
				await Promise.all([unrelatedEntered.promise, targetPublished.promise]);
				firstGate.resolve();
				await firstPublished.promise;
				unrelatedGate.resolve();
				await Promise.all([local, full]);
				expect(completionOrder).toEqual(["local", "full"]);
				const expected = {
					login: `${id}-key`,
					logout: "no-key",
					setRuntimeApiKey: "runtime-key",
					removeRuntimeApiKey: "stored-key",
				}[operation];
				expect(runtime.getModels(id).map((entry) => entry.id)).toEqual([expected]);
				expect(runtime.hasConfiguredAuth(id)).toBe(operation !== "logout");
			} finally {
				firstGate.resolve();
				unrelatedGate.resolve();
				await Promise.allSettled([local, full]);
			}
		},
	);

	it.each(["login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"] as const)(
		"publishes %s auth and credential-filtered models despite a later held global availability read",
		async (operation) => {
			const id = "global-overlap-target";
			const stored = operation === "logout" || operation === "removeRuntimeApiKey";
			const base = AuthStorage.inMemory(stored ? { [id]: { type: "api_key", key: "stored-key" } } : {});
			const listEntered = Promise.withResolvers<void>();
			const listGate = Promise.withResolvers<void>();
			const unrelatedEntered = Promise.withResolvers<void>();
			const unrelatedGate = Promise.withResolvers<void>();
			const targetEntered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const targetGates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			let active = false;
			let checks = 0;
			const credentials: CredentialStore = {
				read: (providerId, options) => base.read(providerId, options),
				modify: (providerId, update, options) => base.modify(providerId, update, options),
				delete: (providerId, options) => base.delete(providerId, options),
				list: async (options) => {
					if (active) {
						listEntered.resolve();
						await listGate.promise;
					}
					return base.list(options);
				},
			};
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
			const target = provider(id);
			target.getModels = () =>
				["stored-key", `${id}-key`, "runtime-key", "previous-key"].map((key) => ({ ...model(id), id: key }));
			target.filterModels = (models, credential) =>
				models.filter((entry) => credential?.type === "api_key" && entry.id === credential.key);
			target.auth.apiKey!.check = async ({ credential }) => {
				if (active) {
					const index = checks++;
					targetEntered[index]!.resolve();
					await targetGates[index]!.promise;
				}
				return credential ? { type: "api_key", source: "fixture" } : undefined;
			};
			const unrelated = provider("global-overlap-unrelated");
			unrelated.auth.apiKey!.check = async () => {
				if (active) {
					unrelatedEntered.resolve();
					await unrelatedGate.promise;
				}
				return undefined;
			};
			runtime.registerNativeProvider(target);
			runtime.registerNativeProvider(unrelated);
			await runtime.refresh({ allowNetwork: false });
			if (operation === "removeRuntimeApiKey") await runtime.setRuntimeApiKey(id, "previous-key");
			active = true;
			let globalSettled = false;
			const local =
				operation === "login"
					? runtime.login(id, "api_key", { prompt: async () => "unused", notify() {} })
					: operation === "logout"
						? runtime.logout(id)
						: operation === "setRuntimeApiKey"
							? runtime.setRuntimeApiKey(id, "runtime-key")
							: runtime.removeRuntimeApiKey(id);
			let global: ReturnType<ModelRuntime["getAvailable"]> | undefined;
			try {
				await targetEntered[0]!.promise;
				global = runtime.getAvailable().then((models) => {
					globalSettled = true;
					return models;
				});
				await Promise.all([targetEntered[1]!.promise, unrelatedEntered.promise, listEntered.promise]);
				targetGates[0]!.resolve();
				await local;
				expect(globalSettled).toBe(false);
				expect(runtime.hasConfiguredAuth(id)).toBe(operation !== "logout");
				const expected = {
					login: [`${id}-key`],
					logout: [],
					setRuntimeApiKey: ["runtime-key"],
					removeRuntimeApiKey: ["stored-key"],
				}[operation];
				expect(
					runtime
						.getAvailableSnapshot()
						.filter((entry) => entry.provider === id)
						.map((entry) => entry.id),
				).toEqual(expected);
				expect(runtime.getError()).toBeUndefined();
				targetGates[1]!.resolve();
				unrelatedGate.resolve();
				listGate.resolve();
				expect((await global).filter((entry) => entry.provider === id).map((entry) => entry.id)).toEqual(expected);
			} finally {
				for (const gate of targetGates) gate.resolve();
				unrelatedGate.resolve();
				listGate.resolve();
				await Promise.allSettled([local, global]);
			}
		},
	);

	it.each(["abort", "store failure"] as const)(
		"does not discard credential synchronization when a later global availability read ends in %s",
		async (failure) => {
			const id = "failed-global-target";
			const base = AuthStorage.inMemory();
			const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			let active = false;
			let checks = 0;
			const credentials: CredentialStore = {
				read: (providerId, options) => base.read(providerId, options),
				modify: (providerId, update, options) => base.modify(providerId, update, options),
				delete: (providerId, options) => base.delete(providerId, options),
				list: async (options) => {
					if (active && failure === "store failure") throw new Error("global list failed");
					return base.list(options);
				},
			};
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
			const target = provider(id);
			target.auth.apiKey!.check = async ({ credential }) => {
				if (active) {
					const index = checks++;
					entered[index]!.resolve();
					await gates[index]!.promise;
				}
				return credential ? { type: "api_key", source: "fixture" } : undefined;
			};
			runtime.registerNativeProvider(target);
			await runtime.refresh({ allowNetwork: false });
			active = true;
			const local = runtime.setRuntimeApiKey(id, "runtime-key");
			const controller = new AbortController();
			const reason = new Error("global read cancelled");
			let outcome: Promise<unknown> | undefined;
			try {
				await entered[0]!.promise;
				outcome = runtime.getAvailable(undefined, { signal: controller.signal }).catch((error: unknown) => error);
				await entered[1]!.promise;
				if (failure === "abort") controller.abort(reason);
				if (failure === "abort") expect(await outcome).toBe(reason);
				else expect(await outcome).toMatchObject({ message: "global list failed" });
				gates[0]!.resolve();
				await local;
				expect(runtime.hasConfiguredAuth(id)).toBe(true);
				expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === id)).toBe(true);
			} finally {
				for (const gate of gates) gate.resolve();
				await Promise.allSettled([local, outcome]);
			}
		},
	);

	it.each(["credential synchronization", "global availability read"] as const)(
		"retains the newer snapshot after %s overtakes an older global availability read",
		async (successor) => {
			const id = "older-global-target";
			const credentials = AuthStorage.inMemory();
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			let active = false;
			const target = provider(id);
			target.auth.apiKey!.check = async ({ credential }) => {
				if (active && !credential) {
					entered.resolve();
					await gate.promise;
				}
				return credential ? { type: "api_key", source: "fixture" } : undefined;
			};
			const runtime = await runtimeWithProvider(target, credentials);
			active = true;
			const global = runtime.getAvailable();
			try {
				await entered.promise;
				if (successor === "credential synchronization") await runtime.setRuntimeApiKey(id, "runtime-key");
				else {
					await credentials.modify(id, async () => ({ type: "api_key", key: "stored-key" }));
					await runtime.getAvailable();
				}
				gate.resolve();
				expect((await global).some((entry) => entry.provider === id)).toBe(true);
				expect(runtime.hasConfiguredAuth(id)).toBe(true);
				expect(runtime.getError()).toBeUndefined();
			} finally {
				gate.resolve();
				await global;
			}
		},
	);

	it("reports cancellation that occurs during provider-scoped availability", async () => {
		let blockAvailability = false;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const registered = provider("cancelled-availability");
		if (registered.auth.apiKey) {
			registered.auth.apiKey.check = async ({ credential }) => {
				if (blockAvailability) {
					markStarted?.();
					await new Promise<void>(() => {});
				}
				return credential ? { type: "api_key", source: "stored" } : undefined;
			};
		}
		const runtime = await runtimeWithProvider(registered);
		await runtime.setRuntimeApiKey(registered.id, "key");
		blockAvailability = true;
		const controller = new AbortController();
		const refresh = runtime.refresh({
			allowNetwork: false,
			providers: [registered.id],
			signal: controller.signal,
		});
		await started;
		controller.abort();

		await expect(refresh).resolves.toMatchObject({ aborted: true });
	});

	it("does not run network refresh inside the credential operation chain", async () => {
		const networkRefresh = vi.fn(async () => new Promise<void>(() => {}));
		const runtime = await runtimeWithProvider(
			provider("local-only", {
				refreshModels: async (context) => {
					if (context.allowNetwork) await networkRefresh();
				},
			}),
		);

		await runtime.login("local-only", "api_key", { prompt: async () => "unused", notify: () => {} });
		expect(networkRefresh).not.toHaveBeenCalled();
		expect(runtime.hasConfiguredAuth("local-only")).toBe(true);
	});

	it("keeps provider-scoped refreshes from superseding unrelated providers", async () => {
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		let firstSignal: AbortSignal | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			provider("one", {
				refreshModels: async (context) => {
					if (!context.allowNetwork) return;
					firstSignal = context.signal;
					markStarted?.();
					await blocked;
				},
			}),
		);
		runtime.registerNativeProvider(provider("two"));
		await runtime.refresh({ allowNetwork: false, providers: ["one", "two"] });
		await runtime.setRuntimeApiKey("one", "one-key");
		await runtime.setRuntimeApiKey("two", "two-key");

		const first = runtime.refresh({ allowNetwork: true, providers: ["one"] });
		await started;
		await runtime.refresh({ allowNetwork: true, providers: ["two"] });
		expect(firstSignal?.aborted).toBe(false);

		finish?.();
		await first;
	});

	it("waits for a committed credential mutation to settle before reporting cancellation", async () => {
		let stored: Credential | undefined;
		let markCommitted: (() => void) | undefined;
		let finishMutation: (() => void) | undefined;
		const committed = new Promise<void>((resolve) => {
			markCommitted = resolve;
		});
		const mutationFinished = new Promise<void>((resolve) => {
			finishMutation = resolve;
		});
		const credentials: CredentialStore = {
			read: async () => stored,
			list: async () => (stored ? [{ providerId: "delayed-commit", type: stored.type }] : []),
			modify: async (_providerId, update) => {
				const next = await update(stored);
				if (next) stored = next;
				markCommitted?.();
				await mutationFinished;
				return stored;
			},
			delete: async () => {
				stored = undefined;
			},
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerNativeProvider(provider("delayed-commit"));
		await runtime.refresh({ allowNetwork: false, providers: ["delayed-commit"] });
		const controller = new AbortController();
		let settled = false;
		const login = runtime.login("delayed-commit", "api_key", {
			signal: controller.signal,
			prompt: async () => "unused",
			notify: () => {},
		});
		const outcome = login.then(
			() => {
				settled = true;
				return undefined;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		await committed;
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		finishMutation?.();
		await expect(outcome).resolves.toMatchObject({
			name: "CredentialSynchronizationError",
			credential: { type: "api_key", key: "delayed-commit-key" },
		});
		expect(stored).toEqual({ type: "api_key", key: "delayed-commit-key" });
	});

	it("reports a typed error when cancellation interrupts post-commit synchronization", async () => {
		let blockCacheRefresh = false;
		let markCacheRefreshStarted: (() => void) | undefined;
		const cacheRefreshStarted = new Promise<void>((resolve) => {
			markCacheRefreshStarted = resolve;
		});
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("cancelled-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && blockCacheRefresh) {
						markCacheRefreshStarted?.();
						await new Promise<void>(() => {});
					}
				},
			}),
			credentials,
		);
		blockCacheRefresh = true;
		const controller = new AbortController();
		const login = runtime.login("cancelled-sync", "api_key", {
			signal: controller.signal,
			prompt: async () => "unused",
			notify: () => {},
		});
		await cacheRefreshStarted;
		controller.abort();

		await expect(login).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "cancelled-sync",
			operation: "login",
			credential: { type: "api_key", key: "cancelled-sync-key" },
		});
		expect(await credentials.read("cancelled-sync")).toEqual({
			type: "api_key",
			key: "cancelled-sync-key",
		});
	});

	it("reports committed credentials when local synchronization fails", async () => {
		let failCacheRefresh = false;
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("broken-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && failCacheRefresh) throw new Error("cache restore failed");
				},
			}),
			credentials,
		);
		failCacheRefresh = true;

		const login = runtime.login("broken-sync", "api_key", { prompt: async () => "unused", notify: () => {} });
		await expect(login).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "broken-sync",
			operation: "login",
			credential: { type: "api_key", key: "broken-sync-key" },
		});
		await expect(login).rejects.toBeInstanceOf(CredentialSynchronizationError);
		expect(await credentials.read("broken-sync")).toEqual({ type: "api_key", key: "broken-sync-key" });
	});
});
