import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
	type Api,
	type AuthType,
	type CredentialStore,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviders()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime auth options", () => {
	// Regression from https://github.com/fitchmultz/pi/pull/179#discussion_r4175398566.
	it("loads deeply nested sampling parameters as immutable model configuration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-model-config-depth-"));
		const path = join(dir, "models.json");
		const depth = 10_000;
		try {
			writeFileSync(
				path,
				'{"providers":{"nested":{"api":"anthropic-messages","baseUrl":"https://nested.test","apiKey":"fixture","models":[{"id":"model","samplingParams":{"nested":' +
					'{"x":'.repeat(depth) +
					"123" +
					"}".repeat(depth) +
					"}}]}}}",
			);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: path,
				modelsStore: new InMemoryModelsStore(),
			});
			expect(runtime.getError()).toBeUndefined();
			expect(runtime.hasConfiguredAuth("nested")).toBe(true);
			const params = runtime.getModel("nested", "model")?.samplingParams;
			expect(params).toBeDefined();
			let value: unknown = params!.nested;
			for (let i = 0; i < depth; i++) {
				expect(Object.isFrozen(value)).toBe(true);
				value = (value as { x: unknown }).x;
			}
			expect(value).toBe(123);
			expect(Reflect.set(params!, "nested", null)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

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

	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("composes fresh fallback envelopes with the effective provider and never crosses a local auth failure", async () => {
		const credentials = new InMemoryCredentialStore();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		const base = runtime.getProvider("openai-codex")!;
		let resolved = 0;
		let checked = 0;
		const fallback = {
			check: async () => {
				checked++;
				return { type: "api_key" as const, source: "selected account" };
			},
			resolve: async () => ({
				auth: { headers: { "x-account": String(++resolved) }, baseUrl: "https://account.test" },
				env: { ACCOUNT_ENV: "private" },
				source: "selected account",
			}),
		};
		const oldDispose = runtime.registerProviderAuthFallback(base.id, fallback);
		const dispose = runtime.registerProviderAuthFallback(base.id, fallback);
		oldDispose();
		await runtime.refresh({ allowNetwork: false });
		expect(resolved).toBe(0);
		expect(runtime.hasConfiguredAuth(base.id)).toBe(true);
		expect(runtime.getProvider(base.id)?.auth.oauth?.login).toBe(base.auth.oauth?.login);
		expect(runtime.getProvider(base.id)?.auth.apiKey?.login).toBeUndefined();
		expect(await runtime.getAuth(base.id)).toEqual({
			auth: { headers: { "x-account": "1" }, baseUrl: "https://account.test" },
			env: { ACCOUNT_ENV: "private" },
			source: "selected account",
		});
		expect((await runtime.getAuth(base.id))?.auth.headers).toEqual({ "x-account": "2" });
		expect(await credentials.list()).toEqual([]);

		runtime.registerNativeProvider({
			...base,
			getModels: () => [{ ...base.getModels()[0]!, id: "effective-only" }],
			getAllModels: () => [{ ...base.getModels()[0]!, id: "effective-only" }],
			auth: {
				...base.auth,
				apiKey: {
					name: "Local",
					check: async ({ credential, ctx }) => {
						if (credential) throw new Error("local failed");
						return (await ctx.env("LOCAL_ACCOUNT_KEY")) ? { type: "api_key", source: "local" } : undefined;
					},
					resolve: async ({ credential, ctx }) => {
						if (credential) throw new Error("local failed");
						const key = await ctx.env("LOCAL_ACCOUNT_KEY");
						return key ? { auth: { apiKey: key }, source: "local" } : undefined;
					},
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel(base.id, "effective-only")).toBeDefined();
		expect((await runtime.getAuth(base.id, { env: { LOCAL_ACCOUNT_KEY: "local-key" } }))?.auth.apiKey).toBe(
			"local-key",
		);
		expect(resolved).toBe(2);
		await credentials.modify(base.id, async () => ({ type: "api_key", key: "broken" }));
		checked = 0;
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getAuthCheckError(base.id)?.message).toContain("API key auth check failed");
		expect(runtime.hasConfiguredAuth(base.id)).toBe(false);
		expect(checked).toBe(0);
		await expect(runtime.getAuth(base.id)).rejects.toThrow("API key auth failed");
		expect(resolved).toBe(2);
		expect(checked).toBe(0);
		await credentials.delete(base.id);
		runtime.registerProvider(base.id, { apiKey: "$ABSENT_SELECTED_KEY" });
		await expect(runtime.getAuth(base.id)).rejects.toThrow("API key auth failed");
		expect(resolved).toBe(2);
		runtime.unregisterProvider(base.id);
		expect((await runtime.getAuth(base.id))?.auth.headers).toEqual({ "x-account": "3" });
		dispose();
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.hasConfiguredAuth(base.id)).toBe(false);
		expect(runtime.getProvider(base.id)?.auth.apiKey).toBeUndefined();
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("publishes healthy availability and provider-local auth diagnostics", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "key" } }),
			modelsPath: null,
		});
		runtime.registerNativeProvider({
			...runtime.getProvider("anthropic")!,
			id: "broken",
			getModels: () => [],
			auth: {
				apiKey: {
					name: "broken",
					check: async () => {
						throw new Error("broken auth");
					},
					resolve: async () => undefined,
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
		expect((await runtime.getAvailable()).some((model) => model.provider === "anthropic")).toBe(true);
		expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
		expect(runtime.getAuthCheckError("broken")?.message).toContain("broken");
		expect(runtime.getError()).toContain('Provider "broken"');
	});

	it("resumes a saved session on a provider whose auth check failed", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const anthropic = runtime.getProvider("anthropic")!;
		const model = { ...anthropic.getModels()[0]!, provider: "broken" };
		runtime.registerNativeProvider({
			...anthropic,
			id: "broken",
			getModels: () => [model],
			auth: {
				apiKey: {
					name: "broken",
					check: async () => {
						throw new Error("broken auth");
					},
					resolve: async () => undefined,
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
		const dir = mkdtempSync(join(tmpdir(), "pi-auth-resume-"));
		try {
			const sessionManager = SessionManager.inMemory(dir);
			sessionManager.appendModelChange("broken", model.id);
			sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime: runtime,
				sessionManager,
				settingsManager: SettingsManager.inMemory(),
			});
			expect(session.model?.provider).toBe("broken");
			expect(modelFallbackMessage).toBeUndefined();
			session.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("projects provider-owned methods, names, and status", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "amazon-bedrock", name: "Amazon Bedrock" }),
					method: expect.objectContaining({ name: "AWS credentials or bearer token" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "google-vertex", name: "Google Vertex AI" }),
					method: expect.objectContaining({ name: "Google Cloud credentials" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI" }),
				}),
			]),
		);
		expect(authOptions(runtime, "api_key").every((option) => option.type === "api_key")).toBe(true);
		expect(authOptions(runtime, "oauth").every((option) => option.type === "oauth")).toBe(true);
		expect(options.some((option) => option.provider.id === "openai-codex" && option.type === "api_key")).toBe(false);
	});

	it("attaches the provider's active auth status to every method option", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsPath: null,
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "anthropic");
		expect(options).toHaveLength(2);
		expect(await runtime.checkAuth("anthropic")).toMatchObject({ type: "oauth" });
	});

	it("distinguishes subscription OAuth from generic OAuth sign-in", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "anthropic-access",
					refresh: "anthropic-refresh",
					expires: Date.now() + 60 * 60_000,
				},
				openrouter: {
					type: "oauth",
					access: "openrouter-key",
					refresh: "",
					expires: Number.MAX_SAFE_INTEGER,
				},
				radius: {
					type: "oauth",
					access: "radius-access",
					refresh: "radius-refresh",
					expires: Date.now() + 60 * 60_000,
				},
			}),
			modelsPath: null,
		});

		expect(runtime.isUsingOAuth("anthropic")).toBe(true);
		expect(runtime.isUsingSubscription("anthropic")).toBe(true);
		expect(runtime.isUsingOAuth("openrouter")).toBe(true);
		expect(runtime.isUsingSubscription("openrouter")).toBe(false);
		expect(runtime.isUsingOAuth("radius")).toBe(true);
		expect(runtime.isUsingSubscription("radius")).toBe(false);
	});

	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("keeps API-key login for a configured key alongside OAuth", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerProvider("key-and-oauth", {
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
			apiKey: "configured-key",
			oauth: {
				name: "Account",
				login: async () => ({ access: "oauth", refresh: "refresh", expires: 60000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			models: [testModel("both")],
		});
		const prompt = async (request: { message: string }) => {
			expect(request.message).toBe("Enter API key");
			return "entered-key";
		};
		expect(
			await runtime.login("key-and-oauth", "api_key", {
				prompt,
				notify() {},
			}),
		).toEqual({ type: "api_key", key: "entered-key" });
		expect((await runtime.getAuth("key-and-oauth"))?.auth.apiKey).toBe("entered-key");
		expect((await runtime.getAuth("key-and-oauth", { apiKey: "explicit-key" }))?.auth.apiKey).toBe("explicit-key");
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("forwards cancellation to extension OAuth refresh", async () => {
		const credentials = AuthStorage.inMemory({
			"extension-oauth": {
				type: "oauth",
				access: "expired",
				refresh: "refresh",
				expires: 0,
			},
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		let refreshSignal: AbortSignal | undefined;
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential, signal) => {
					refreshSignal = signal;
					return { ...credential, expires: Date.now() + 60_000 };
				},
				getApiKey: (credential) => credential.access,
			},
			models: [testModel("extension-model")],
		});
		const controller = new AbortController();

		await runtime.getAuth("extension-oauth", { signal: controller.signal });
		expect(refreshSignal).toBeInstanceOf(AbortSignal);
		const reason = new Error("cancelled");
		controller.abort(reason);
		expect(refreshSignal?.aborted).toBe(true);
		expect(refreshSignal?.reason).toBe(reason);
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				isSubscription: true,
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription", isSubscription: true },
		});
	});
});
