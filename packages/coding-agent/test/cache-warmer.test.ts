import { tmpdir } from "node:os";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type CacheWarmingDecisionEvent,
	type CacheWarmRequest,
	formatCacheWarmingStatus,
	formatCacheWarmingUsage,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
} from "../src/core/cache-warmer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import { type CacheWarmingMode, SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const adaptiveModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...getBuiltinModel("openai", "gpt-5"),
	promptCache: { short: 300, long: 86_400 },
};
const unknownModel: Model<Api> = { ...adaptiveModel, promptCache: undefined };

const warmUsage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: warmUsage,
		stopReason,
		timestamp: 0,
	};
}

function branchWithPrompt(promptTokens: number): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				...response(adaptiveModel),
				usage: { ...warmUsage, output: 10, cacheRead: promptTokens, totalTokens: promptTokens + 10 },
			},
		},
	];
}

function fakeRuntime(
	options: {
		result?: (model: Model<Api>) => Promise<AssistantMessage>;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction | Promise<CacheWarmingAction>;
		mode?: CacheWarmingMode;
		branch?: SessionEntry[];
	} = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const warmedEntries: UsageEntry[] = [];
	const usageManager = SessionManager.inMemory();
	const appendUsage = vi.fn(usageManager.appendUsage.bind(usageManager));
	const state = { mode: options.mode ?? "idle", branch: options.branch ?? branchWithPrompt(100_000) };
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				return {
					result: () => (options.result ?? (async (m: Model<Api>) => response(m)))(model),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => state.branch },
		() => state.mode,
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
	);
	warmer.onWarmed = (entry) => warmedEntries.push(entry);
	return { warmer, calls, events, warmedEntries, appendUsage, state };
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("cache warming", () => {
	it.each<{
		retention: string;
		provider?: "anthropic";
		ambientRetention?: "short";
		supportsLongCacheRetention?: boolean;
		authRetention?: "short" | "long";
		requestOptions?: ModelsSimpleStreamOptions;
		expectedRetention: "short" | "long";
		refreshRetention?: "short" | "long";
		delayRefreshHeaders?: boolean;
		nonCurrent?: "virtual" | "redirected";
		abortPreparation?: boolean;
	}>([
		{ retention: "native default", expectedRetention: "long" },
		{ retention: "explicit long support", supportsLongCacheRetention: true, expectedRetention: "long" },
		{ retention: "explicit short-only support", supportsLongCacheRetention: false, expectedRetention: "short" },
		{
			retention: "auth short overriding ambient long",
			provider: "anthropic",
			authRetention: "short",
			expectedRetention: "short",
		},
		{
			retention: "auth long overriding ambient short",
			provider: "anthropic",
			authRetention: "long",
			ambientRetention: "short",
			expectedRetention: "long",
		},
		{
			retention: "explicit long overriding auth short",
			provider: "anthropic",
			authRetention: "short",
			requestOptions: { cacheRetention: "long" },
			expectedRetention: "long",
		},
		{
			retention: "request env short overriding auth and ambient long",
			provider: "anthropic",
			authRetention: "long",
			requestOptions: { env: { PI_CACHE_RETENTION: "short" } },
			expectedRetention: "short",
		},
		{
			retention: "refresh auth short changing to long",
			provider: "anthropic",
			authRetention: "short",
			expectedRetention: "short",
			refreshRetention: "long",
		},
		{
			retention: "refresh auth long changing to short",
			provider: "anthropic",
			authRetention: "long",
			ambientRetention: "short",
			expectedRetention: "long",
			refreshRetention: "short",
		},
		{
			retention: "refresh headers delayed past original deadline",
			provider: "anthropic",
			authRetention: "short",
			expectedRetention: "short",
			delayRefreshHeaders: true,
		},
		{
			retention: "virtual selection excludes physical warming",
			provider: "anthropic",
			authRetention: "short",
			expectedRetention: "short",
			nonCurrent: "virtual",
		},
		{
			retention: "redirected request excludes warming",
			provider: "anthropic",
			authRetention: "short",
			expectedRetention: "short",
			nonCurrent: "redirected",
		},
		{
			retention: "abort during real header preparation",
			provider: "anthropic",
			authRetention: "short",
			expectedRetention: "short",
			abortPreparation: true,
		},
	])("composes SDK replay, usage-only history, and cancellation with $retention", async (fixture) => {
		const expectations = {
			long: {
				delayMs: 3_240_000,
				cacheControl: { type: "ephemeral", ttl: "1h" },
				write1h: 7,
				warmUsageCost: 0.02521825,
				missCost: 1.975,
				expectedSavings: 1.94995,
				afterWarm: { state: "inactive", reason: "one-hour safety limit reached" },
			},
			short: {
				delayMs: 270_000,
				cacheControl: { type: "ephemeral" },
				write1h: 0,
				warmUsageCost: 0.02516575,
				missCost: 1.225,
				expectedSavings: 1.19995,
				afterWarm: { state: "scheduled" },
			},
		};
		const expected = expectations[fixture.expectedRetention];
		const refreshed = expectations[fixture.refreshRetention ?? fixture.expectedRetention];
		// Offline, non-server fixture: route acceptance and TTL durability need separate live evidence.
		// An explicit qualification run can load the real Fitch factory without copying its behavior.
		const fitchPath = process.env.PI_TEST_FITCH_FAST_MODE_EXTENSION;
		const model: Model<"anthropic-messages"> = {
			id: "claude-opus-5-offline-warmer",
			name: "Offline warmer fixture",
			api: "anthropic-messages",
			provider: fixture.provider ?? "cloudflare-ai-gateway",
			baseUrl:
				fixture.provider === "anthropic"
					? "https://offline.invalid/anthropic"
					: "https://offline.invalid/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic",
			reasoning: true,
			thinkingLevelMap: { high: "high", max: "max" },
			input: ["text"],
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			contextWindow: 200_000,
			maxTokens: 64,
			promptCache: { short: 300, long: 3600 },
			compat: {
				forceAdaptiveThinking: true,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
				supportsMidConvoEffort: true,
				supportsLongCacheRetention: fixture.supportsLongCacheRetention,
			},
		};
		const credentialEnv = {
			CLOUDFLARE_ACCOUNT_ID: "offline-account",
			CLOUDFLARE_GATEWAY_ID: "offline-gateway",
			...(fixture.authRetention ? { PI_CACHE_RETENTION: fixture.authRetention } : {}),
		};
		const credentials = AuthStorage.inMemory();
		await credentials.modify(model.provider, async () => ({
			type: "api_key",
			key: "offline-key",
			env: credentialEnv,
		}));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		let selectedModel: Model<Api> = model;
		if (fixture.nonCurrent === "virtual") {
			modelRuntime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, models: [model] });
			modelRuntime.registerVirtualModel({
				provider: "offline-router",
				id: "auto",
				name: "Offline router",
				route: () => ({ model, thinkingLevel: "max" }),
			});
			await modelRuntime.refresh({ allowNetwork: false });
			selectedModel = modelRuntime.getModel("offline-router", "auto")!;
		}
		const auth = vi.spyOn(modelRuntime, "getAuth");
		const settingsManager = SettingsManager.inMemory({
			cacheWarming: fixture.nonCurrent ? "idle" : "streaming",
			httpIdleTimeoutMs: 0,
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		let headerGeneration = "initial";
		let headerGate: Promise<void> | undefined;
		let releaseHeaders = () => {};
		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: tmpdir(),
			settingsManager,
			noExtensions: true,
			additionalExtensionPaths: fitchPath ? [fitchPath] : [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Offline cache-warmer qualification.",
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_headers", async (event) => {
						await headerGate;
						event.headers["x-offline-generation"] = headerGeneration;
					});
				},
			],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory();

		// Only HTTP is mocked. These frames contain no projected history, receipts, or lifecycle events.
		const replies = [
			{ held: false, warm: false },
			{ held: true, warm: false },
			{ held: false, warm: true },
			{ held: false, warm: false },
			{ held: true, warm: true },
			{ held: true, warm: false },
			{ held: true, warm: true },
		];
		let transportAttempts = 0;
		const calls: Array<{ request: Request; body: Record<string, unknown>; finish: () => void }> = [];
		const encode = new TextEncoder();
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			transportAttempts++;
			const index = calls.length;
			const reply = replies[index];
			const body = JSON.parse(await request.text()) as Record<string, unknown>;
			const frame = (event: Record<string, unknown>) =>
				encode.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const abort = () => controller.error(new DOMException("Offline request aborted", "AbortError"));
					const finish = () => {
						request.signal.removeEventListener("abort", abort);
						for (const event of [
							{
								type: "content_block_start",
								index: 0,
								content_block: {
									type: "thinking",
									thinking: `offline thinking ${index}`,
									signature: `offline-signature-${index}`,
								},
							},
							{ type: "content_block_stop", index: 0 },
							{
								type: "content_block_start",
								index: 1,
								content_block: { type: "text", text: `offline answer ${index}` },
							},
							{ type: "content_block_stop", index: 1 },
							{
								type: "message_delta",
								delta: { stop_reason: reply?.warm ? "max_tokens" : "end_turn" },
								usage: { output_tokens: reply?.warm ? 1 : 2 },
							},
							{ type: "message_stop" },
						]) {
							controller.enqueue(frame(event));
						}
						controller.close();
					};
					calls.push({ request, body, finish });
					if (
						!reply ||
						request.url !==
							(fixture.provider === "anthropic"
								? "https://offline.invalid/anthropic/v1/messages?beta=true"
								: "https://offline.invalid/offline-account/offline-gateway/anthropic/v1/messages?beta=true")
					) {
						throw new Error(`Unplanned offline transport: ${request.url} (request ${index})`);
					}
					controller.enqueue(
						frame({
							type: "message_start",
							message: {
								id: `offline-response-${index}`,
								model: model.id,
								usage: {
									input_tokens: reply.warm ? 3 : 0,
									output_tokens: 0,
									cache_read_input_tokens: reply.warm ? 99_993 : 80_000,
									cache_creation_input_tokens: reply.warm ? 7 : 20_000,
									cache_creation: {
										ephemeral_1h_input_tokens:
											index === 2 ? refreshed.write1h : index < 2 && expected.write1h > 0 ? 20_000 : 0,
									},
								},
							},
						}),
					);
					request.signal.addEventListener("abort", abort, { once: true });
					if (!reply.held) finish();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		};
		vi.stubGlobal("fetch", fetchMock);
		vi.stubEnv("PI_CACHE_RETENTION", fixture.ambientRetention ?? "long");
		vi.useFakeTimers();
		const { session, extensionsResult } = await createAgentSession({
			model: selectedModel,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			thinkingLevel: "max",
			tools: ["read", "bash"],
		});
		// Caller-supplied options still traverse the real SDK/native preparation path.
		let requestOptions = fixture.requestOptions ?? {};
		const nativeStream = session.agent.streamFunction;
		session.agent.streamFunction = (model, context, options) =>
			nativeStream(
				fixture.nonCurrent === "redirected" ? { ...model, id: "claude-opus-5-offline-redirected" } : model,
				context,
				{ ...options, ...requestOptions },
			);
		const warmed: UsageEntry[] = [];
		session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "usage") warmed.push(event.entry);
		});
		try {
			expect(extensionsResult.errors).toEqual([]);
			await session.bindExtensions({});
			session.setActiveToolsByName(["read"]);
			await session.prompt("Prime the offline prefix.");
			if (fixture.nonCurrent) {
				expect(calls).toHaveLength(1);
				expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
				expect(session.cacheWarmingStatus).toEqual({ state: "inactive", reason: "conversation context changed" });
				expect(formatCacheWarmingStatus(session.cacheWarmingStatus!)).toBe(
					"Inactive (conversation context changed)",
				);
				await vi.advanceTimersByTimeAsync(600_000);
				expect(calls).toHaveLength(1);
				expect(warmed).toEqual([]);
				return;
			}
			expect(session.cacheWarmingStatus).toMatchObject({ state: "inactive", reason: "agent run settled" });
			expect(settingsManager.getCacheWarmingMode()).toBe("streaming");

			session.setActiveToolsByName(["read", "bash"]);
			if (fixture.abortPreparation) {
				session.setCacheWarmingMode("idle");
				headerGate = new Promise<void>((resolve) => {
					releaseHeaders = resolve;
				});
			}
			const authBeforeReal = auth.mock.calls.length;
			const active = session.prompt("Continue with the current tool declaration.");
			await vi.advanceTimersByTimeAsync(0);
			if (fixture.abortPreparation) {
				expect(calls).toHaveLength(1);
				const abort = session.abort();
				releaseHeaders();
				headerGate = undefined;
				await abort;
				await active;
				await vi.advanceTimersByTimeAsync(600_000);
				expect(calls.filter((call) => call.body.max_tokens === 1)).toEqual([]);
				expect(warmed).toEqual([]);
				expect(session.cacheWarmingStatus).toEqual({ state: "inactive", reason: "inactive" });
				return;
			}
			expect(calls).toHaveLength(2);
			expect(auth.mock.calls.length - authBeforeReal).toBe(1);
			const system = calls[1].body.system as Array<{ cache_control: unknown }>;
			expect(system[0].cache_control).toEqual(expected.cacheControl);
			expect.soft(session.cacheWarmingStatus?.nextWarmAt).toBe(Date.now() + expected.delayMs);
			expect(session.cacheWarmingStatus?.decision).toMatchObject({
				phase: "streaming",
				continuationProbability: 1,
				action: "warm",
			});
			expect(session.cacheWarmingStatus?.decision?.warmCost).toBeCloseTo(0.02505);
			expect(session.cacheWarmingStatus?.decision?.missCost).toBeCloseTo(expected.missCost, 10);
			expect(session.cacheWarmingStatus?.decision?.expectedSavings).toBeCloseTo(expected.expectedSavings);
			expect(formatCacheWarmingStatus(session.cacheWarmingStatus!)).toContain("catalog estimate");
			const history = sessionManager.buildSessionContext().messages;
			headerGeneration = "current";
			await credentials.modify(model.provider, async () => ({
				type: "api_key",
				key: "offline-key-current",
				env: {
					...credentialEnv,
					...(fixture.refreshRetention ? { PI_CACHE_RETENTION: fixture.refreshRetention } : {}),
				},
			}));
			if (fixture.delayRefreshHeaders) {
				headerGate = new Promise<void>((resolve) => {
					releaseHeaders = resolve;
				});
			}
			const authBeforeWarm = auth.mock.calls.length;
			await vi.advanceTimersByTimeAsync(expected.delayMs);
			if (fixture.delayRefreshHeaders) {
				expect(session.cacheWarmingStatus?.state).toBe("refreshing");
				expect(calls).toHaveLength(2);
				await vi.advanceTimersByTimeAsync(15_001);
				releaseHeaders();
				headerGate = undefined;
				await vi.advanceTimersByTimeAsync(0);
				expect(auth.mock.calls.length - authBeforeWarm).toBe(1);
				expect(calls).toHaveLength(2);
				expect(transportAttempts).toBe(2);
				expect(warmed).toEqual([]);
				expect(sessionManager.getEntries().filter((entry) => entry.type === "usage")).toEqual([]);
				expect(sessionManager.buildSessionContext().messages).toEqual(history);
				expect(session.cacheWarmingStatus).toEqual({
					state: "inactive",
					reason: "cache refresh deadline missed",
				});
				expect(calls[1].request.signal.aborted).toBe(false);
				await session.abort();
				await active;
				return;
			}
			expect(calls).toHaveLength(3);
			expect(auth.mock.calls.length - authBeforeWarm).toBe(1);
			if (fixture.refreshRetention) {
				expect(JSON.stringify(calls[2].body)).not.toContain(JSON.stringify(expected.cacheControl));
			}
			// Only the deliberately changed retention markers differ from the original one-token replay.
			const replayedBody = JSON.parse(
				JSON.stringify(calls[2].body).replaceAll(
					JSON.stringify(refreshed.cacheControl),
					JSON.stringify(expected.cacheControl),
				),
			) as Record<string, unknown>;
			expect(replayedBody).toEqual({ ...calls[1].body, max_tokens: 1 });
			expect(replayedBody.tools).toEqual(calls[0].body.tools);
			expect(replayedBody.system).toEqual(calls[0].body.system);
			expect(JSON.stringify(calls[2].body.messages)).toContain('"type":"tool_addition"');
			expect(JSON.stringify(calls[2].body.messages)).toContain("offline-signature-0");
			expect(calls[2].body).toMatchObject({
				thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
				output_config: { effort: "high" },
				messages: expect.arrayContaining([{ role: "system", content: [], output_config: { effort: "max" } }]),
			});
			expect((calls[2].body.system as Array<{ cache_control: unknown }>)[0].cache_control).toEqual(
				refreshed.cacheControl,
			);
			const authHeader = fixture.provider === "anthropic" ? "x-api-key" : "cf-aig-authorization";
			expect(calls[1].request.headers.get(authHeader)).toBe(
				fixture.provider === "anthropic" ? "offline-key" : "Bearer offline-key",
			);
			expect(calls[2].request.headers.get(authHeader)).toBe(
				fixture.provider === "anthropic" ? "offline-key-current" : "Bearer offline-key-current",
			);
			expect(calls[1].request.headers.get("x-offline-generation")).toBe("initial");
			expect(calls[2].request.headers.get("x-offline-generation")).toBe("current");
			if (fitchPath) {
				expect(calls[2].body.speed).toBe("fast");
				expect(calls[2].request.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
			}
			expect(warmed).toHaveLength(1);
			expect(warmed[0]).toMatchObject({
				kind: "cache_warm",
				provider: model.provider,
				model: model.id,
				usage: {
					input: 3,
					output: 1,
					cacheRead: 99_993,
					cacheWrite: 7,
					cacheWrite1h: refreshed.write1h,
					totalTokens: 100_004,
				},
			});
			expect(warmed[0].usage.cost.total).toBeCloseTo(refreshed.warmUsageCost * (fitchPath ? 2 : 1), 10);
			expect(sessionManager.buildSessionContext().messages).toEqual(history);
			expect(session.messages).toEqual(history);
			if (fixture.refreshRetention) {
				expect.soft(session.cacheWarmingStatus?.state).toBe("scheduled");
				expect.soft(session.cacheWarmingStatus?.nextWarmAt).toBe(Date.now() + refreshed.delayMs);
				expect.soft(session.cacheWarmingStatus?.decision?.missCost).toBeCloseTo(refreshed.missCost, 10);
				expect(session.cacheWarmingStatus?.decision?.expectedSavings).toBeCloseTo(refreshed.expectedSavings);
			} else {
				expect(session.cacheWarmingStatus).toMatchObject(expected.afterWarm);
			}
			expect(calls[1].request.signal.aborted).toBe(false);
			await session.abort();
			await active;

			vi.stubEnv("PI_CACHE_RETENTION", "short");
			requestOptions = { cacheRetention: "short" };
			session.setCacheWarmingMode("idle");
			await session.prompt("Idle continuation excludes the warm assistant.");
			expect(JSON.stringify(calls[3].body)).not.toContain("offline-signature-2");
			expect(session.cacheWarmingStatus?.state).toBe("scheduled");
			expect(session.cacheWarmingStatus?.nextWarmAt).toBe(Date.now() + 270_000);
			expect(session.cacheWarmingStatus?.decision).toMatchObject({
				phase: "idle",
				continuationProbability: 0.15,
				action: "warm",
			});
			expect(session.cacheWarmingStatus?.decision?.expectedSavings).toBeCloseTo(0.1587);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(calls).toHaveLength(5);
			const user = sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!user) throw new Error("Expected a native user entry");
			sessionManager.appendContextEdit(user.id, null);
			session.refreshContext();
			calls[4].finish();
			await vi.advanceTimersByTimeAsync(0);
			expect(session.cacheWarmingStatus?.reason).toBe("conversation context changed");
			expect(warmed).toHaveLength(1);

			session.setCacheWarmingMode("streaming");
			const aborted = session.prompt("Abort during a refresh.");
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(calls).toHaveLength(7);
			expect(calls[6].request.signal.aborted).toBe(false);
			await session.abort();
			await aborted;
			expect(calls[5].request.signal.aborted).toBe(true);
			expect(calls[6].request.signal.aborted).toBe(true);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(calls).toHaveLength(7);
			expect(transportAttempts).toBe(7);
			expect(session.cacheWarmingStatus?.reason).toBe("agent run settled");
			expect(sessionManager.getEntries().filter((entry) => entry.type === "usage")).toEqual(warmed);
			expect(JSON.stringify(session.messages)).not.toMatch(/offline-(signature|response)-(2|4|6)/);
		} finally {
			session.dispose();
		}
	});

	it("derives eligibility and timing from retention and provider behavior", () => {
		expect([
			getPromptCacheTtlMs(adaptiveModel, undefined),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" }),
			getPromptCacheTtlMs(adaptiveModel, { env: { PI_CACHE_RETENTION: "long" } }),
			getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(unknownModel, undefined),
		]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000, undefined]);
		expect([getCacheWarmingDelayMs(300_000), getCacheWarmingDelayMs(60_000), getCacheWarmingDelayMs(10_000)]).toEqual(
			[270_000, 50_000, undefined],
		);
		expect([
			isReplayable(budgetModel, { reasoning: "medium" }),
			isReplayable(budgetModel, undefined),
			isReplayable(adaptiveModel, { reasoning: "medium" }),
			isReplayable(openaiModel, { reasoning: "medium" }),
		]).toEqual([false, true, true, true]);
	});

	it("replays profitable requests and preserves options across repeated refreshes", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, appendUsage, warmedEntries } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		const originalRequest = request(adaptiveModel, {
			reasoning: "high",
			signal,
			sessionId: "s",
			transformHeaders,
			cacheTraceContext: { purpose: "parent", sessionId: "s", windowId: "w", runtimeGeneration: "r" },
		});
		warmer.start(originalRequest, current, originalRequest);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(calls[0]).toMatchObject({
			model: adaptiveModel,
			options: { reasoning: "high", sessionId: "s", transformHeaders, maxTokens: 1, maxRetries: 0 },
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(calls[0].options?.cacheTraceContext).toEqual({
			purpose: "warming",
			sessionId: "s",
			windowId: "w",
			runtimeGeneration: "r",
		});
		expect(events[0]).toMatchObject({
			type: "cache_warming_decision",
			continuationProbability: 1,
			action: "warm",
		});
		expect(events[0].missCost).toBeCloseTo(0.575);
		expect(events[0].warmCost).toBeCloseTo(0.050025);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			warmUsage,
			undefined,
		);
		expect(warmedEntries).toEqual([appendUsage.mock.results[0]?.value]);

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
		expect(calls[1].options?.cacheTraceContext).toEqual(calls[0].options?.cacheTraceContext);
		warmer.cancel();
	});

	it("does not issue refreshes after their safe deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(), current, request());

		// A five-minute cache is scheduled for 4m30s and retains 15 seconds of
		// the 30-second expiry margin. Simulate a timer delayed by sleep.
		vi.setSystemTime(285_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("rechecks the deadline after an extension decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({
			decide: async () => {
				await Promise.resolve();
				vi.setSystemTime(285_001);
				return "warm" as const;
			},
		});
		warmer.start(request(), current, request());
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("applies economic decisions and extension overrides", async () => {
		vi.useFakeTimers();
		const unprofitable = fakeRuntime({ branch: branchWithPrompt(5_000) });
		unprofitable.warmer.start(request(), current, request());
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unprofitable.calls).toHaveLength(0);
		expect(unprofitable.warmer.status).toMatchObject({
			state: "inactive",
			decision: { action: "stop", economicsAvailable: true },
			extensionOverride: false,
		});

		const forced = fakeRuntime({ branch: branchWithPrompt(5_000), decide: () => "warm" });
		forced.warmer.start(request(), current, request());
		await vi.advanceTimersByTimeAsync(270_000);
		expect(forced.calls).toHaveLength(1);
		expect(forced.warmedEntries[0]?.note).toBe("extension override");
		forced.warmer.cancel();

		const vetoed = fakeRuntime({ decide: () => "stop" });
		vetoed.warmer.start(request(), current, request());
		await vi.advanceTimersByTimeAsync(270_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", extensionOverride: true });

		const unavailable = fakeRuntime({ branch: branchWithPrompt(0) });
		unavailable.warmer.start(request(), current, request());
		expect(unavailable.warmer.status).toMatchObject({
			state: "inactive",
			reason: "cache economics unavailable",
		});
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unavailable.calls).toHaveLength(0);
	});

	it.each([
		{ api: "anthropic-messages", retention: "short", baseWrite: 0, tierWrite: 25, missCost: 2.45, action: "warm" },
		{ api: "anthropic-messages", retention: "short", baseWrite: 12.5, tierWrite: 0, missCost: 0, action: "stop" },
		{
			api: "bedrock-converse-stream",
			retention: "long",
			baseWrite: 0,
			tierWrite: 25,
			missCost: 3.95,
			action: "warm",
		},
		{ api: "openai-responses", retention: "long", baseWrite: 0, tierWrite: 25, missCost: 2.45, action: "warm" },
	] as const)("honors $api $retention cache-write tiers ($baseWrite base, $tierWrite tier)", (fixture) => {
		vi.useFakeTimers();
		const { warmer } = fakeRuntime();
		const tierRequest = request(
			{
				...adaptiveModel,
				api: fixture.api,
				cost: {
					input: 10,
					output: 50,
					cacheRead: 0.25,
					cacheWrite: fixture.baseWrite,
					tiers: [
						{
							inputTokensAbove: 50_000,
							input: 20,
							output: 100,
							cacheRead: 0.5,
							cacheWrite: fixture.tierWrite,
						},
					],
				},
			},
			{ cacheRetention: fixture.retention },
		);
		warmer.start(tierRequest, current, tierRequest);
		expect(warmer.status.decision).toMatchObject({ action: fixture.action, economicsAvailable: true });
		expect(warmer.status.decision?.warmCost).toBeCloseTo(0.0501);
		expect(warmer.status.decision?.missCost).toBeCloseTo(fixture.missCost);
		warmer.cancel();
	});

	it("stops for unsupported requests, context changes, and mode changes", async () => {
		vi.useFakeTimers();
		const unsupported = fakeRuntime();
		unsupported.state.mode = "off";
		unsupported.warmer.start(request(), current, request());
		expect(unsupported.warmer.status.reason).toBe("cache warming disabled");
		unsupported.state.mode = "idle";
		const unknownRequest = request(unknownModel);
		unsupported.warmer.start(unknownRequest, current, unknownRequest);
		expect(unsupported.warmer.status.reason).toBe("cache lifetime unavailable");
		const budgetRequest = request(budgetModel, { reasoning: "high" });
		unsupported.warmer.start(budgetRequest, current, budgetRequest);
		expect(unsupported.warmer.status.reason).toBe("request cannot be replayed safely");

		let stillCurrent = true;
		unsupported.warmer.start(request(), () => stillCurrent, request());
		stillCurrent = false;
		expect(unsupported.warmer.status.reason).toBe("conversation context changed");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		unsupported.warmer.start(request(), current, request());
		unsupported.state.mode = "off";
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		const streaming = fakeRuntime({ mode: "streaming", branch: branchWithPrompt(400_000) });
		streaming.warmer.start(request(), current, request());
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status.reason).toBe("agent run settled");
	});

	it("aborts replaced requests and does not record failed refreshes", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const pending = fakeRuntime({
			result: (model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		});
		pending.warmer.start(request(), current, request());
		await vi.advanceTimersByTimeAsync(270_000);
		pending.warmer.start(request(), current, request());
		expect(pending.calls[0].options?.signal?.aborted).toBe(true);
		release();
		pending.warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(pending.calls).toHaveLength(1);

		const failed = fakeRuntime({ result: async (model) => response(model, "error") });
		failed.warmer.start(request(), current, request());
		await vi.advanceTimersByTimeAsync(270_000);
		expect(failed.appendUsage).not.toHaveBeenCalled();
		failed.warmer.cancel();
	});

	it("formats status and usage entries", () => {
		const decision: CacheWarmingDecision = {
			phase: "idle",
			warmCost: 0.013,
			missCost: 0.621,
			continuationProbability: 0.6,
			expectedSavings: 0.36,
			economicsAvailable: true,
			action: "warm",
		};
		expect(formatCacheWarmingStatus({ state: "scheduled", nextWarmAt: 222_000, decision }, 0)).toBe(
			"Decision in 3m 42s (catalog estimate, 60% continuation probability, expected savings $0.360 >= $0.050 -> warm)",
		);
		const usage = {
			...warmUsage,
			cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
		};
		const entry = SessionManager.inMemory().appendUsage(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			usage,
			"extension override",
		);
		expect(formatCacheWarmingUsage(entry)).toBe("Cache warmed (extension override): $0.029497");
	});
});

describe("ExtensionRunner.emitCacheWarmingDecision", () => {
	it("uses the last extension override", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const factories: ExtensionFactory[] = [
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
			},
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "stop" }));
			},
		];
		const extensions = [];
		for (const factory of factories) {
			extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		const event: CacheWarmingDecisionEvent = {
			type: "cache_warming_decision",
			warmCost: 0.05,
			missCost: 0.5,
			continuationProbability: 0.15,
			action: "warm",
		};

		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
	});
});
