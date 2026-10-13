import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { completeSummarization } from "../src/core/compaction/compaction.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel<T extends Api>(api: T): Model<T> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, promptTokens = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api, promptTokens = 0) {
		const stream = createAssistantMessageEventStream();
		stream.end(createDoneMessage(api, promptTokens));
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionFactory?: ExtensionFactory,
		providerEvent?: unknown,
		exercise?: (session: AgentSession, captured: () => SimpleStreamOptions | undefined) => Promise<void>,
		providerStream?: ProviderConfigInput["streamSimple"],
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extensionFactory ? [extensionFactory] : [],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (requestModel, context, providerOptions) => {
				capturedOptions = providerOptions;
				if (providerStream) return providerStream(requestModel, context, providerOptions);
				if (providerEvent === undefined) return createDoneStream(api);

				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					stream.end(createDoneMessage(api));
				})();
				return stream;
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			if (exercise) {
				await exercise(session, () => capturedOptions);
			} else if (providerEvent === undefined) {
				const stream = await session.agent.streamFunction(
					model,
					normalizeContext({ messages: [] }),
					requestOptions,
				);
				await stream.result();
			} else {
				await session.prompt("test");
			}
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	async function createCacheWarmingSession(populate?: (manager: SessionManager, model: Model<Api>) => void) {
		const model: Model<Api> = {
			...createModel("anthropic-messages"),
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			promptCache: { short: 300 },
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let providerCalls = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				providerCalls++;
				return createDoneStream(model.api, 100_000);
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		populate?.(sessionManager, model);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({ cacheWarming: "idle" }),
			sessionManager,
		});
		return {
			session,
			providerCalls: () => providerCalls,
			dispose: () => {
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	it("schedules cache warming after a completed session request", async () => {
		const fixture = await createCacheWarmingSession();
		try {
			await fixture.session.prompt("test");
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());

			// Equivalent shallow copies remain current, but removing the request prefix does not.
			fixture.session.agent.state.messages = [...fixture.session.agent.state.messages];
			fixture.session.agent.state.model = { ...fixture.session.agent.state.model };
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());
			fixture.session.agent.state.messages = fixture.session.agent.state.messages.slice(1);
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("conversation context changed");
		} finally {
			fixture.dispose();
		}
	});

	it("waits for the next request instead of restoring cache warming", async () => {
		const fixture = await createCacheWarmingSession((manager, model) => {
			manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange("off");
			manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() - 60_000 });
			const assistant = { ...createDoneMessage(model.api, 100_000), timestamp: Date.now() - 59_000 };
			manager.appendMessage(assistant);
			manager.appendUsage("cache_warm", model.provider, model.id, assistant.usage);
		});
		try {
			expect(fixture.providerCalls()).toBe(0);
			expect(fixture.session.cacheWarmingStatus).toEqual({
				state: "inactive",
				reason: "waiting for first request",
			});
		} finally {
			fixture.dispose();
		}
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		vi.stubEnv("PI_CACHE_TRACE_DIR", "");
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
		expect(options).not.toHaveProperty("cacheTraceContext");
	});

	it("attributes actual SDK calls across purpose, compaction window, reload and model redirection", async () => {
		vi.stubEnv("PI_CACHE_TRACE_DIR", join(tempDir, "trace"));
		vi.stubEnv("PI_SUBAGENT_CHILD", "");
		const schemaToJSON = vi.fn(() => ({ type: "object" }));
		const context = normalizeContext({
			messages: [],
			tools: [
				{
					name: "probe",
					description: "Caller-owned schema",
					parameters: Object.assign(Type.Object({}), { toJSON: schemaToJSON }),
				},
			],
		});
		const captured: NonNullable<SimpleStreamOptions["cacheTraceContext"]>[] = [];
		await captureStreamOptions("openai-completions", {}, {}, undefined, undefined, async (session, latest) => {
			const send = async (options: SimpleStreamOptions = {}) => {
				const stream = await session.agent.streamFunction(
					{ ...createModel("openai-completions"), id: "physical-redirect" },
					context,
					{ sessionId: session.sessionId, ...options },
				);
				await stream.result();
				expect(latest()?.cacheTraceContext).toBeDefined();
				captured.push(latest()!.cacheTraceContext!);
			};
			await send();
			await send({ sessionId: "unowned-routing" });
			await completeSummarization(
				createModel("openai-completions"),
				normalizeContext({ messages: [] }),
				{ sessionId: session.sessionId },
				session.agent.streamFunction,
			);
			captured.push(latest()!.cacheTraceContext!);
			const kept = session.sessionManager.appendMessage({ role: "user", content: "keep", timestamp: 0 });
			const window = session.sessionManager.appendCompaction("summary", kept, 20);
			await send();
			expect(captured.at(-1)?.windowId).toBe(window);
			await session.reload();
			await send();
			vi.stubEnv("PI_SUBAGENT_CHILD", "1");
			await send();
		});
		expect(captured.map(({ purpose }) => purpose)).toEqual([
			"parent",
			"unknown",
			"summary",
			"parent",
			"parent",
			"child",
		]);
		expect(captured[0]).toMatchObject({
			selectedModel: "capture-model",
			selectedProvider: "capture-provider",
			reloadGeneration: 0,
			windowId: "initial",
			catalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			extensionsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			coverageGaps: expect.arrayContaining(["loaded_module_graph_unverified", "auth_generation_unknown"]),
		});
		expect(new Set(captured.map(({ runtimeGeneration }) => runtimeGeneration)).size).toBe(1);
		expect(captured[4].reloadGeneration).toBe(1);
		expect(captured[4].sessionId).toBe(captured[0].sessionId);
		// Provenance must not serialize caller-owned schemas before the provider does.
		expect(schemaToJSON).not.toHaveBeenCalled();
	});

	it.each(["different", "invalid", "matching"] as const)(
		"admits SDK provenance before native tracing only for the owning session (%s)",
		async (scope) => {
			const directory = join(tempDir, "trace");
			mkdirSync(directory, { mode: 0o700 });
			const target = "11111111-1111-4111-8111-111111111111";
			vi.stubEnv("PI_CACHE_TRACE_DIR", directory);
			vi.stubEnv("PI_CACHE_TRACE_SESSION_ID", scope === "invalid" ? "invalid-session" : target);
			vi.stubEnv("PI_SUBAGENT_CHILD", "1");
			const events = [
				{ type: "message_start", message: { id: "msg_scope", usage: { input_tokens: 1, output_tokens: 0 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic-ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			];
			const fetch = vi.fn(
				async () =>
					new Response(
						events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{ headers: { "content-type": "text/event-stream" } },
					),
			);
			const options = await captureStreamOptions(
				"anthropic-messages",
				{ cacheWarming: "off", compaction: { enabled: false } },
				{},
				undefined,
				undefined,
				async (session) => {
					expect(session.sessionId).not.toBe(target);
					if (scope === "matching") vi.stubEnv("PI_CACHE_TRACE_SESSION_ID", session.sessionId);
					await session.prompt("synthetic scope probe");
					const message = session.messages.findLast((item) => item.role === "assistant");
					expect(message?.stopReason).toBe("stop");
					expect(message?.content).toEqual([{ type: "text", text: "synthetic-ok" }]);
				},
				(_model, context, providerOptions) =>
					streamAnthropic(createModel("anthropic-messages"), normalizeContext(context), {
						...providerOptions,
						fetch,
					}),
			);
			expect(fetch).toHaveBeenCalledTimes(1);
			if (scope !== "matching") {
				expect(options?.cacheTraceContext).toBeUndefined();
				expect(readdirSync(directory)).toEqual([]);
			} else {
				expect(options?.cacheTraceContext).toMatchObject({
					sessionId: process.env.PI_CACHE_TRACE_SESSION_ID,
					purpose: "child",
					catalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
				const files = readdirSync(directory);
				expect(files).toContain("investigation.key");
				const rows = files
					.filter((name) => name.endsWith(".jsonl"))
					.flatMap((name) =>
						readFileSync(join(directory, name), "utf8")
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line) as Record<string, unknown>),
					);
				expect(rows).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ kind: "request" }),
						expect.objectContaining({ phase: "decoder_eof" }),
						expect.objectContaining({ phase: "adapter_done" }),
					]),
				);
			}
		},
	);

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	// Regression test for #9784.
	it("forwards provider stream events to extensions", async () => {
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		const extensionEvents: unknown[] = [];

		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{},
			(pi) => {
				pi.on("provider_stream_event", (event) => {
					extensionEvents.push(event);
				});
			},
			providerEvent,
		);

		expect(options?.onProviderStreamEvent).toEqual(expect.any(Function));
		expect(extensionEvents).toEqual([
			{
				data: providerEvent,
				type: "provider_stream_event",
				provider: "capture-provider",
				api: "openai-completions",
				model: "capture-model",
			},
		]);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			(pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			},
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});
});
