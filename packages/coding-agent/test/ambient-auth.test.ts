import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AuthResult, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ProviderConfig } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const providers = ["anthropic", "openai-codex"] as const;
const lastModified = (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 60_000;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function sharedAuth(type: "oauth" | "api_key" = "oauth") {
	let sequence = 0;
	return {
		check: vi.fn<NonNullable<ProviderConfig["ambientAuth"]>["check"]>(async ({ credential, signal }) => {
			signal.throwIfAborted();
			expect(credential).toBeUndefined();
			return { type, source: "shared account" };
		}),
		resolve: vi.fn<NonNullable<ProviderConfig["ambientAuth"]>["resolve"]>(async ({ credential, signal }) => {
			signal.throwIfAborted();
			expect(credential).toBeUndefined();
			const version = String(++sequence);
			return {
				auth: {
					apiKey: `shared-${version}`,
					headers: { "X-Account": version },
					baseUrl: `https://provider.example.test/${version}`,
				},
				env: { ACCOUNT_VERSION: version },
				source: `shared account ${version}`,
			};
		}),
	};
}

describe("ambient auth composition", () => {
	let directory: string;
	let credentials: InMemoryCredentialStore;
	let modelsStore: InMemoryModelsStore;
	let runtime: ModelRuntime;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-ambient-auth-"));
		vi.stubEnv("HOME", directory);
		vi.stubEnv("USERPROFILE", directory);
		for (const name of Object.keys(process.env)) {
			if (/KEY|TOKEN|SECRET|^AWS_|^GOOGLE_|^AZURE_|^CLOUDFLARE_/.test(name)) vi.stubEnv(name, undefined);
		}
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
		credentials = new InMemoryCredentialStore();
		modelsStore = new InMemoryModelsStore();
		runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath: join(directory, "models.json") });
	});

	afterEach(async () => {
		await runtime.flushForCheckpoint();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it("retains native models/login and labels Anthropic and Codex subscriptions without storing shared grants", async () => {
		const registry = new ModelRegistry(runtime);
		for (const id of providers) {
			const native = runtime.getProvider(id)!;
			const models = native.getModels();
			const ambientAuth = sharedAuth();
			registry.registerProvider(id, { ambientAuth });
			await registry.refresh({ allowNetwork: false });
			expect(registry.getAvailable().filter((model) => model.provider === id)).toEqual(models);
			expect(runtime.isUsingSubscription(id)).toBe(true);
			expect(registry.isUsingOAuth(models[0])).toBe(true);
			expect(registry.getProvider(id)?.auth.oauth?.login).toBe(native.auth.oauth?.login);
			expect(registry.getProvider(id)?.auth.apiKey?.login).toBe(native.auth.apiKey?.login);
			expect(ambientAuth.resolve).not.toHaveBeenCalled();
			for (const version of ["1", "2"]) {
				expect(await registry.getProviderAuth(id)).toEqual({
					auth: {
						apiKey: `shared-${version}`,
						headers: { "X-Account": version },
						baseUrl: `https://provider.example.test/${version}`,
					},
					env: { ACCOUNT_VERSION: version },
					source: `shared account ${version}`,
				});
			}
		}
		expect(await credentials.list()).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("keeps configured keys/headers, local login, runtime and request keys above ambient auth", async () => {
		const model = runtime.getModels("anthropic")[0];
		writeFileSync(
			join(directory, "models.json"),
			JSON.stringify({
				providers: {
					anthropic: {
						apiKey: "configured-key",
						headers: { "X-Configured": "fixed" },
						modelOverrides: { [model.id]: { name: "User label", headers: { "X-Model": "fixed-model" } } },
					},
				},
			}),
		);
		const ambientAuth = sharedAuth("api_key");
		runtime.registerProvider("anthropic", { ambientAuth, authHeader: true });
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("anthropic", model.id)?.name).toBe("User label");
		expect((await runtime.getAuth(model))?.auth).toMatchObject({
			apiKey: "configured-key",
			headers: {
				"X-Configured": "fixed",
				"X-Model": "fixed-model",
				Authorization: "Bearer configured-key",
			},
		});
		await runtime.login("anthropic", "api_key", { prompt: async () => "local-key", notify: () => {} });
		expect((await runtime.getAuth(model))?.auth.apiKey).toBe("local-key");
		await runtime.setRuntimeApiKey("anthropic", "cli-key");
		expect((await runtime.getAuth(model))?.auth.apiKey).toBe("cli-key");
		expect((await runtime.getAuth(model, { apiKey: "request-key" }))?.auth.apiKey).toBe("request-key");
		await runtime.removeRuntimeApiKey("anthropic");
		await runtime.logout("anthropic");
		expect((await runtime.getAuth(model))?.auth.apiKey).toBe("configured-key");
		expect(ambientAuth.resolve).not.toHaveBeenCalled();
		expect(ambientAuth.check).not.toHaveBeenCalled();

		writeFileSync(
			join(directory, "models.json"),
			JSON.stringify({
				providers: {
					anthropic: {
						headers: { "X-Version": "$ACCOUNT_VERSION" },
						modelOverrides: { [model.id]: { headers: { "X-Model-Version": "$ACCOUNT_VERSION" } } },
					},
				},
			}),
		);
		await runtime.refresh({ allowNetwork: false });
		expect(await runtime.getAuth(model)).toMatchObject({
			auth: {
				apiKey: "shared-1",
				headers: {
					"X-Account": "1",
					"X-Version": "1",
					"X-Model-Version": "1",
					Authorization: "Bearer shared-1",
				},
				baseUrl: "https://provider.example.test/1",
			},
			env: { ACCOUNT_VERSION: "1" },
			source: "shared account 1",
		});
		expect(runtime.isUsingSubscription("anthropic")).toBe(false);
	});

	it("local OAuth owns auth, including failed native refresh; logout reveals shared auth", async () => {
		const ambientAuth = sharedAuth();
		await credentials.modify("anthropic", async () => ({
			type: "oauth",
			access: "local-oauth",
			refresh: "synthetic-refresh",
			expires: Date.now() + 3_600_000,
		}));
		runtime.registerProvider("anthropic", { ambientAuth });
		await runtime.refresh({ allowNetwork: false });
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("local-oauth");
		await credentials.modify("anthropic", async (current) => ({
			...current!,
			type: "oauth",
			access: "expired",
			refresh: "synthetic-refresh",
			expires: 0,
		}));
		// Only the HTTP boundary is mocked: native OAuth refresh and locked credential resolution run.
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Reconnect local account", { status: 400 }));
		await expect(runtime.getAuth("anthropic")).rejects.toThrow("OAuth refresh failed");
		expect(globalThis.fetch).toHaveBeenCalled();
		expect(ambientAuth.check).not.toHaveBeenCalled();
		expect(ambientAuth.resolve).not.toHaveBeenCalled();
		await runtime.logout("anthropic");
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("shared-1");
		expect(await credentials.list()).toEqual([]);

		// Codex has no key login, but an explicitly stored key still overrides ambient auth.
		runtime.registerProvider("openai-codex", { ambientAuth });
		await credentials.modify("openai-codex", async () => ({ type: "api_key", key: "local-codex-key" }));
		expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("local-codex-key");
		expect(ambientAuth.resolve).toHaveBeenCalledTimes(1);
	});

	it("does not fall through on missing, failed or cancelled shared auth; replacement and unregister restore policy", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "unrelated-payer");
		const ambientAuth = sharedAuth();
		ambientAuth.check.mockResolvedValue(undefined);
		ambientAuth.resolve.mockResolvedValue(undefined);
		runtime.registerProvider("anthropic", { ambientAuth });
		await runtime.refresh({ allowNetwork: false });
		expect(await runtime.getAvailable("anthropic")).toEqual([]);
		expect(await runtime.getAuth("anthropic")).toBeUndefined();
		ambientAuth.resolve.mockRejectedValue(new Error("Reconnect selected account"));
		await expect(runtime.getAuth("anthropic")).rejects.toThrow("Reconnect selected account");
		const started = deferred<AbortSignal>();
		ambientAuth.resolve.mockImplementation(({ signal }) => {
			started.resolve(signal);
			return new Promise<AuthResult | undefined>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const controller = new AbortController();
		const pending = runtime.getAuth("anthropic", { signal: controller.signal });
		const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		const signal = await started.promise;
		controller.abort();
		await rejection;
		expect(signal.aborted).toBe(true);
		const previousCalls = ambientAuth.resolve.mock.calls.length;
		const replacement = sharedAuth("api_key");
		runtime.registerProvider("anthropic", { ambientAuth: replacement });
		await runtime.refresh({ allowNetwork: false });
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("shared-1");
		expect(ambientAuth.resolve).toHaveBeenCalledTimes(previousCalls);
		runtime.unregisterProvider("anthropic");
		await runtime.refresh({ allowNetwork: false });
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("unrelated-payer");
	});

	it("retains coding-agent cached catalogs and native fetch/ETag publication under ambient-only registration", async () => {
		for (const id of providers) {
			const baseline = runtime.getModels(id)[0];
			const cached = { ...baseline, id: "ambient-cached-only" };
			await modelsStore.write(id, { models: [cached], lastModified, checkedAt: 0, etag: '"cached"' });
			runtime.registerProvider(id, { ambientAuth: sharedAuth() });
			await runtime.refresh({ allowNetwork: false });
			expect(await runtime.getAvailable(id)).toContainEqual(cached);
			expect(globalThis.fetch).not.toHaveBeenCalled();
			const fetched = { ...baseline, id: "ambient-fetched-only" };
			vi.mocked(globalThis.fetch)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ models: [fetched] }), {
						headers: { "last-modified": new Date(lastModified).toUTCString(), etag: '"fetched"' },
					}),
				)
				.mockResolvedValueOnce(new Response(null, { status: 304 }));
			const result = await runtime.refresh({ providers: [id], allowNetwork: true, force: true });
			expect(result.errors.size).toBe(0);
			expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toBe(`https://pi.dev/api/models/providers/${id}`);
			expect(runtime.getModel(id, fetched.id)).toEqual(fetched);
			expect(await modelsStore.read(id)).toMatchObject({ models: [fetched], etag: '"fetched"' });
			await runtime.refresh({ providers: [id], allowNetwork: true, force: true });
			expect(vi.mocked(globalThis.fetch).mock.calls[1][1]?.headers).toMatchObject({ "if-none-match": '"fetched"' });
			expect(runtime.getModel(id, fetched.id)).toEqual(fetched);
			expect(runtime.getModel(id, baseline.id)).toEqual(baseline);
			vi.mocked(globalThis.fetch).mockClear();
		}
		expect(await credentials.list()).toEqual([]);
	});

	it("joins a superseding availability pass instead of returning an empty startup snapshot", async () => {
		const ambientAuth = sharedAuth();
		runtime.registerProvider("openai-codex", { ambientAuth });
		await runtime.flushForCheckpoint();
		const olderStarted = deferred<void>();
		const newerStarted = deferred<void>();
		const olderRelease = deferred<void>();
		const newerRelease = deferred<void>();
		let calls = 0;
		ambientAuth.check.mockImplementation(async () => {
			const call = ++calls;
			if (call === 2) olderStarted.resolve();
			if (call === 4) newerStarted.resolve();
			await (call <= 2 ? olderRelease.promise : newerRelease.promise);
			return { type: "oauth", source: "shared account" };
		});
		let olderSettled = false;
		const older = runtime.getAvailable().then((models) => {
			olderSettled = true;
			return models;
		});
		await olderStarted.promise;
		const newer = runtime.getAvailable();
		await newerStarted.promise;
		olderRelease.resolve();
		await new Promise<void>((done) => setImmediate(done));
		expect(olderSettled).toBe(false);
		newerRelease.resolve();
		expect(await older).toEqual(await newer);
		expect(runtime.isUsingSubscription("openai-codex")).toBe(true);
	});

	// PR #60: joining a newer pass must not import that caller's cancellation.
	it("rechecks availability for an uncancelled caller when the superseding caller aborts", async () => {
		const ambientAuth = sharedAuth();
		ambientAuth.check.mockResolvedValue(undefined);
		runtime.registerProvider("openai-codex", { ambientAuth });
		await runtime.flushForCheckpoint();
		expect(runtime.hasConfiguredAuth("openai-codex")).toBe(false);
		const olderStarted = deferred<void>();
		const newerStarted = deferred<void>();
		const retryStarted = deferred<void>();
		const olderRelease = deferred<void>();
		const newerRelease = deferred<void>();
		const retryRelease = deferred<void>();
		let calls = 0;
		ambientAuth.check.mockImplementation(async ({ signal }) => {
			const call = ++calls;
			if (call === 2) olderStarted.resolve();
			if (call === 4) newerStarted.resolve();
			if (call === 6) retryStarted.resolve();
			await (call <= 2 ? olderRelease.promise : call <= 4 ? newerRelease.promise : retryRelease.promise);
			signal.throwIfAborted();
			return { type: "oauth", source: "shared account" };
		});
		const olderController = new AbortController();
		const newerController = new AbortController();
		const older = runtime.getAvailable(undefined, { signal: olderController.signal }).then(
			(models) => ({ models }),
			(error: unknown) => ({ error }),
		);
		await olderStarted.promise;
		const newer = runtime
			.getAvailable(undefined, { signal: newerController.signal })
			.catch((error: unknown) => error);
		try {
			await newerStarted.promise;
			olderRelease.resolve();
			await new Promise<void>((done) => setImmediate(done));
			const reason = new Error("newer caller cancelled");
			newerController.abort(reason);
			expect(await newer).toBe(reason);
			expect(olderController.signal.aborted).toBe(false);
			expect(await Promise.race([older, retryStarted.promise.then(() => "retry started")])).toBe("retry started");
			let flushed = false;
			const checkpoint = runtime.flushForCheckpoint().then(() => {
				flushed = true;
			});
			await new Promise<void>((done) => setImmediate(done));
			expect(flushed).toBe(false);
			retryRelease.resolve();
			const result = await older;
			expect(result).toEqual({ models: runtime.getAvailableSnapshot() });
			expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "openai-codex")).toEqual(
				runtime.getModels("openai-codex"),
			);
			expect(runtime.isUsingSubscription("openai-codex")).toBe(true);
			expect(runtime.getError()).toBeUndefined();
			await checkpoint;
			expect(flushed).toBe(true);
		} finally {
			olderRelease.resolve();
			newerRelease.resolve();
			retryRelease.resolve();
			await Promise.all([older, newer]);
		}
	});

	// PR #60: isolate waiter cancellation, but still propagate a real superseding failure.
	it.each(["older cancellation", "newer failure"])("preserves %s while joining availability", async (variant) => {
		const ambientAuth = sharedAuth();
		runtime.registerProvider("openai-codex", { ambientAuth });
		await runtime.flushForCheckpoint();
		const olderStarted = deferred<void>();
		const newerStarted = deferred<void>();
		const olderRelease = deferred<void>();
		const newerRelease = deferred<void>();
		const reason = new Error(variant);
		let calls = 0;
		ambientAuth.check.mockImplementation(async ({ signal }) => {
			const call = ++calls;
			if (call === 2) olderStarted.resolve();
			if (call === 4) newerStarted.resolve();
			await (call <= 2 ? olderRelease.promise : newerRelease.promise);
			signal.throwIfAborted();
			if (call > 2 && variant === "newer failure") throw reason;
			return { type: "oauth", source: "shared account" };
		});
		const olderController = new AbortController();
		const newerController = new AbortController();
		const older = runtime
			.getAvailable(undefined, { signal: olderController.signal })
			.catch((error: unknown) => error);
		await olderStarted.promise;
		const newer = runtime
			.getAvailable(undefined, { signal: newerController.signal })
			.catch((error: unknown) => error);
		try {
			await newerStarted.promise;
			olderRelease.resolve();
			await new Promise<void>((done) => setImmediate(done));
			if (variant === "older cancellation") {
				olderController.abort(reason);
				expect(await older).toBe(reason);
				expect(newerController.signal.aborted).toBe(false);
				newerRelease.resolve();
				expect(await newer).toEqual(runtime.getAvailableSnapshot());
				expect(runtime.isUsingSubscription("openai-codex")).toBe(true);
				expect(runtime.getError()).toBeUndefined();
			} else {
				newerRelease.resolve();
				const failure = await newer;
				expect(failure).toMatchObject({
					name: "ModelsError",
					message: `API key auth check failed for provider openai-codex: ${reason.message}`,
				});
				expect(await older).toBe(failure);
				expect(runtime.getError()).toContain(reason.message);
			}
			expect(calls).toBe(4);
		} finally {
			olderRelease.resolve();
			newerRelease.resolve();
			await Promise.all([older, newer]);
		}
	});

	it("awaits factory registration and auth checks before settings, scope and saved-model selection, without session_start", async () => {
		const cached = { ...runtime.getModels("openai-codex")[0], id: "ambient-startup-only" };
		await modelsStore.write("openai-codex", { models: [cached], lastModified });
		const started = deferred<void>();
		const release = deferred<void>();
		const sessionStart = vi.fn();
		let settled = false;
		const servicesPromise = createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: cached.id }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					async (pi) => {
						await Promise.resolve();
						for (const id of providers) {
							const ambientAuth = sharedAuth();
							ambientAuth.check.mockImplementation(async ({ signal }) => {
								started.resolve();
								await release.promise;
								signal.throwIfAborted();
								return { type: "oauth", source: "startup shared account" };
							});
							pi.registerProvider(id, { ambientAuth });
						}
						pi.on("session_start", sessionStart);
					},
				],
			},
		}).then((services) => {
			settled = true;
			return services;
		});
		await started.promise;
		expect(settled).toBe(false);
		release.resolve();
		const services = await servicesPromise;
		expect(services.diagnostics).toEqual([]);
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		for (const id of providers) expect(runtime.isUsingSubscription(id)).toBe(true);
		const scope = await resolveModelScopeWithDiagnostics([`openai-codex/${cached.id}:high`], runtime);
		expect(scope.scopedModels.map(({ model }) => model.id)).toEqual([cached.id]);
		for (const saved of [false, true]) {
			const manager = SessionManager.inMemory(directory);
			if (saved) {
				manager.appendModelChange("anthropic", runtime.getModels("anthropic")[0].id);
				manager.appendMessage({ role: "user", content: "saved", timestamp: Date.now() });
			}
			const { session, modelFallbackMessage } = await createAgentSessionFromServices({
				services,
				sessionManager: manager,
			});
			expect(session.model?.provider).toBe(saved ? "anthropic" : "openai-codex");
			if (!saved) expect(session.model?.id).toBe(cached.id);
			expect(modelFallbackMessage).toBeUndefined();
			expect(sessionStart).not.toHaveBeenCalled();
			session.dispose();
		}
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(await credentials.list()).toEqual([]);
	});

	it("actual CLI --list-models loads ambient auth and cached-only models before any session_start", () => {
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir);
		const cached = Object.fromEntries(
			providers.map((id) => [
				id,
				{
					models: [{ ...runtime.getModels(id)[0], id: `ambient-cli-${id}` }],
					lastModified,
				},
			]),
		);
		writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(cached));
		const extension = join(directory, "ambient.ts");
		const sentinel = join(directory, "session-started");
		writeFileSync(
			extension,
			`import { writeFileSync } from "node:fs";
export default async function(pi) {
  await Promise.resolve();
  for (const id of ["anthropic", "openai-codex"]) pi.registerProvider(id, {
    ambientAuth: {
      async check({ signal }) { signal.throwIfAborted(); return { type: "oauth", source: "CLI shared" }; },
      async resolve() { throw new Error("list-models must not resolve request auth"); }
    }
  });
  pi.on("session_start", () => writeFileSync(${JSON.stringify(sentinel)}, "unexpected"));
}`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolve(__dirname, "../src/experimental/source-resolver.ts"),
				resolve(__dirname, "../src/cli.ts"),
				"--offline",
				"--no-session",
				"--no-extensions",
				"-e",
				extension,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--list-models",
				"ambient-cli",
			],
			{
				cwd: directory,
				encoding: "utf8",
				timeout: 20_000,
				env: {
					PATH: process.env.PATH,
					HOME: directory,
					USERPROFILE: directory,
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					PI_TELEMETRY: "0",
					PI_SKIP_VERSION_CHECK: "1",
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		for (const id of providers) expect(result.stdout).toContain(`ambient-cli-${id}`);
		expect(existsSync(sentinel)).toBe(false);
		const authPath = join(agentDir, "auth.json");
		expect(existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : {}).toEqual({});
		console.log(result.stdout.trim());
	});
});
