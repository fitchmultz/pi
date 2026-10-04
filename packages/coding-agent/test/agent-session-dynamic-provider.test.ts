import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Provider } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function nativeAnthropicProvider(baseUrl: string): Provider {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, baseUrl };
	return {
		id: "anthropic",
		name: "Native Anthropic",
		baseUrl,
		auth: {
			apiKey: {
				name: "Test API key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFunction = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("registers native pi-ai providers during extension loading", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-top-level"));
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-top-level");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});

	it("registers native pi-ai providers at command time", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-native", {
					description: "Use native provider",
					handler: async () => {
						pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-command"));
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-native");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-command");

		session.dispose();
	});

	it.each(["sdk", "services"] as const)(
		"publishes factory fallback auth before %s selection despite late background config and disposes it on reload",
		async (mode) => {
			const credentials = AuthStorage.inMemory();
			const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
			const modelId = "gpt-5.3-codex-spark";
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "openai-codex",
				defaultModel: modelId,
			});
			const backgroundConfig = Promise.withResolvers<void>();
			const startupAuthEntered = Promise.withResolvers<void>();
			const startupAuth = Promise.withResolvers<void>();
			const backgroundAuth = Promise.withResolvers<void>();
			const load = ModelConfig.load;
			const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementationOnce(async (path) => {
				await backgroundConfig.promise;
				return load(path);
			});
			const refresh = modelRuntime.refresh.bind(modelRuntime);
			const refreshes: ReturnType<ModelRuntime["refresh"]>[] = [];
			const refreshSpy = vi.spyOn(modelRuntime, "refresh").mockImplementation((options) => {
				const pending = refresh(options);
				refreshes.push(pending);
				return pending;
			});
			let present = true;
			let checks = 0;
			let resolves = 0;
			const resourceLoaderOptions = {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					((pi) => {
						if (!present) return;
						pi.registerProviderAuthFallback("openai-codex", {
							check: async () => {
								if (++checks === 1) {
									startupAuthEntered.resolve();
									await startupAuth.promise;
								} else if (checks === 2) {
									await backgroundAuth.promise;
								}
								return { type: "oauth", source: "account" };
							},
							resolve: async () => ({ auth: { apiKey: `account-${++resolves}` }, source: "account" }),
						});
					}) satisfies ExtensionFactory,
				],
			};
			const sessionOptions = {
				cwd: tempDir,
				agentDir,
				modelRuntime,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
			};
			let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
			try {
				const start = async () => {
					if (mode === "services") {
						return createAgentSessionServices({ ...sessionOptions, resourceLoaderOptions });
					}
					const resourceLoader = new DefaultResourceLoader({ ...sessionOptions, ...resourceLoaderOptions });
					await resourceLoader.reload();
					return createAgentSession({ ...sessionOptions, resourceLoader });
				};
				const startup = start();
				await startupAuthEntered.promise;
				// The older registration config finishes while the awaited startup auth is still blocked.
				backgroundConfig.resolve();
				// Drain immediate offline work: obsolete work joins startup; broken work starts a newer auth pass.
				await setImmediate();
				startupAuth.resolve();
				const created = await startup;
				if ("session" in created) session = created.session;
				const initial = {
					configured: modelRuntime.hasConfiguredAuth("openai-codex"),
					oauth: modelRuntime.isUsingOAuth("openai-codex"),
					models: modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`),
					error: modelRuntime.getError(),
				};
				if (!("session" in created)) {
					expect(created.diagnostics).toEqual([]);
					expect(created.resourceLoader.getExtensions().errors).toEqual([]);
				}
				session = (
					"session" in created
						? created
						: await createAgentSessionFromServices({
								services: created,
								sessionManager: sessionOptions.sessionManager,
							})
				).session;
				expect({ ...initial, selected: `${session?.model?.provider}/${session?.model?.id}` }).toEqual({
					configured: true,
					oauth: true,
					models: expect.arrayContaining([`openai-codex/${modelId}`]),
					error: undefined,
					selected: `openai-codex/${modelId}`,
				});
				expect(resolves).toBe(0);
				backgroundAuth.resolve();
				await Promise.all(refreshes);
				expect((await modelRuntime.getAuth("openai-codex"))?.auth.apiKey).toBe("account-1");
				present = false;
				await session.reload();
				expect(session.model?.provider).toBe("openai-codex");
				expect(modelRuntime.hasConfiguredAuth("openai-codex")).toBe(false);
				expect(await modelRuntime.getAuth("openai-codex")).toBeUndefined();
				expect(resolves).toBe(1);
			} finally {
				backgroundConfig.resolve();
				startupAuth.resolve();
				backgroundAuth.resolve();
				await Promise.allSettled(refreshes);
				session?.dispose();
				await Promise.allSettled(refreshes);
				loadSpy.mockRestore();
				refreshSpy.mockRestore();
			}
		},
	);
});
