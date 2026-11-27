// Cache warming (plugins/cache-warming): a conversation's last request is sent again with one output token before its
// prompt cache entry expires, while pi's policy says it pays off. The warmers use native Models with an offline provider;
// a worker runs them end to end with the fake provider given a short cache lifetime.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type CacheWarmingPhase,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	type Model,
	type ModelsSimpleStreamOptions,
	type SimpleStreamOptions,
	type StopReason,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	type ConversationId,
	type ConversationView,
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	LiveDoc,
	type LiveState,
	type UsageState,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, followNative, whenLive } from "@p2/app/v1";
import type { ModelRequest } from "@p2/app/v1/worker";
import { type CacheWarmingMode, ConversationWarmers, type WarmerHost } from "../../plugins/cache-warming/warmer.ts";
import cacheWarmingWorker from "../../plugins/cache-warming/worker.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { WorkerModels } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { createHost, defineFacet, Session } from "../../src/runtime/chord.ts";
import { openHostStore, sessionDirectory } from "../../src/runtime/host-dirs.ts";
import { HOST } from "../../src/runtime/principals.ts";
import {
	Extensions,
	HarnessConfig,
	HarnessHost,
	HarnessNative,
	Liveness,
	SessionLocation,
	type WorkerInit,
	workerCore,
} from "../../src/runtime/worker.ts";
import { APP, holdIn, NO_IMAGES, startFixture, until } from "./helpers.ts";

const MODEL: Model<"pi-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "https://radius.example/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	promptCache: { short: 300, long: 3600 },
};
const GEMINI = getBuiltinModel("google", "gemini-4-neon");
const CONVERSATION = 1 as ConversationId;
const REQUEST = {
	model: MODEL,
	messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
	options: { sessionId: "provider-session", reasoning: "high" as const },
	cache: { retention: "short", ttlMs: 300_000, dispatchedAt: 0 },
} satisfies ModelRequest;

/** Warmers on mocked timers; `phase` is what the host reports, `sent` the refreshes the offline provider received. */
function setup(t: { after(fn: () => void): void }, mode: CacheWarmingMode = "idle", model: Model<Api> = MODEL) {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const state = {
		mode,
		phase: "streaming" as CacheWarmingPhase | undefined,
		alive: 0,
		sent: [] as ModelsSimpleStreamOptions[],
		recorded: 0,
		cacheRead: 0,
		input: 0,
		retention: "short" as CacheRetention,
		authReady: Promise.resolve(),
		replyReady: Promise.resolve(),
		failed: false,
	};
	const respond = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
		assert.deepEqual(context.messages, REQUEST.messages);
		assert.ok(options);
		const answer = fauxAssistantMessage([]);
		const message = {
			...answer,
			usage: { ...answer.usage, input: state.input, cacheRead: state.cacheRead },
			stopReason: state.failed ? ("error" as const) : ("length" as const),
		};
		const stream = createAssistantMessageEventStream();
		void (async () => {
			try {
				await options.onPayload?.({}, model);
				options.signal?.throwIfAborted();
				state.sent.push(options);
				await state.replyReady;
				if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
				else {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "length", message });
				}
			} catch {
				stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
			}
			stream.end();
		})();
		return stream;
	};
	const models = createModels();
	models.setProvider(
		createProvider({
			id: model.provider,
			models: [model],
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => {
						await state.authReady;
						return { auth: {}, env: { PI_CACHE_RETENTION: state.retention } };
					},
				},
			},
			api: { stream: respond, streamSimple: respond },
		}),
	);
	const host: WarmerHost = {
		mode: () => state.mode,
		phase: async () => state.phase,
		record: async () => {
			state.recorded++;
		},
		keepAlive: (delta) => {
			state.alive += delta;
		},
	};
	const warmers = new ConversationWarmers(host);
	t.after(() => {
		warmers.close();
		mock.timers.reset();
	});
	/** Starts warming after a response to a `promptTokens`-token prompt. */
	const start = (
		promptTokens: number,
		stopReason: StopReason = "toolUse",
		options: SimpleStreamOptions = REQUEST.options,
		dispatchedAt = Date.now(),
	) => {
		const message = fauxAssistantMessage([]);
		const usage = { ...message.usage, input: 2, cacheRead: promptTokens - 1002, cacheWrite: 1000 };
		const retention = options.cacheRetention ?? state.retention;
		const seconds = retention === "none" ? undefined : model.promptCache?.[retention];
		warmers.start(
			CONVERSATION,
			{ ...message, stopReason, usage },
			{
				...REQUEST,
				model,
				options,
				cache: { retention, ttlMs: seconds === undefined ? undefined : seconds * 1000, dispatchedAt },
			},
			models,
		);
	};
	/** Advances the clock by `ms` and lets the refreshes it fired finish (they arm the next timer when done). */
	const advance = async (ms: number) => {
		mock.timers.tick(ms);
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
	};
	/** Advances refresh by refresh until warming stops; returns how many refreshes were sent. */
	const runOut = async () => {
		for (let refresh = 0; refresh < 100 && state.alive > 0; refresh++) await advance(270_000);
		return state.sent.length;
	};
	return { state, host, warmers, start, advance, runOut };
}

test("refreshes every 270 s with the request's options and one output token, and counts the spend", async (t) => {
	const { state, start, advance } = setup(t);
	start(600_000);
	assert.equal(state.alive, 1);
	await advance(269_000);
	assert.equal(state.sent.length, 0);
	await advance(1_000);
	assert.equal(state.sent.length, 1);
	const [options] = state.sent;
	assert.equal(options!.sessionId, "provider-session");
	assert.equal(options!.reasoning, "high");
	assert.equal(options!.maxTokens, 1);
	assert.equal(options!.maxRetries, 0);
	assert.equal(options!.disableContinuation, true);
	assert.equal(state.recorded, 1);
	await advance(270_000);
	assert.equal(state.sent.length, 2);
});

test("does not refresh an expired entry when a timer arrives late", async (t) => {
	const { state, start, advance } = setup(t);
	start(600_000);
	await advance(600_000);
	assert.equal(state.sent.length, 0);
	assert.equal(state.alive, 0);
});

test("schedules from the prepared dispatch rather than the response or replay options", async (t) => {
	const previous = process.env.PI_CACHE_RETENTION;
	process.env.PI_CACHE_RETENTION = "long";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = previous;
	});
	const { state, start, advance } = setup(t);
	await advance(200_000);
	start(600_000, "toolUse", REQUEST.options, 0);
	await advance(69_000);
	assert.equal(state.sent.length, 0);
	await advance(1_000);
	assert.equal(state.sent.length, 1);
});

test("anchors Gemini replays to dispatch, including time spent preparing a payload", async (t) => {
	const { state, start, advance } = setup(t, "idle", GEMINI);
	state.cacheRead = 57_950;
	state.input = 2_050;
	const payload = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	state.replyReady = reply.promise;
	await advance(35_000);
	start(60_000, "toolUse", { ...REQUEST.options, onPayload: () => payload.promise }, 0);
	await advance(29_999);
	assert.equal(state.sent.length, 0);
	await advance(1);
	await advance(2_000);
	assert.equal(state.sent.length, 0);
	payload.resolve();
	await advance(0);
	assert.equal(state.sent.length, 1);
	await advance(40_000);
	reply.resolve();
	await advance(0);
	assert.equal(state.recorded, 1);
	await advance(24_999);
	assert.equal(state.sent.length, 1);
	await advance(1);
	assert.equal(state.sent.length, 2);
});

test("does not arm a Gemini replay when the response took 72 s", async (t) => {
	const { state, start, advance } = setup(t, "idle", GEMINI);
	await advance(72_000);
	start(60_000, "toolUse", REQUEST.options, 0);
	assert.equal(state.alive, 0);
	await advance(65_000);
	assert.equal(state.sent.length, 0);
});

test("stops Gemini replays on idle transition even under idle mode", async (t) => {
	const { state, start, advance } = setup(t, "idle", GEMINI);
	state.cacheRead = 57_950;
	state.input = 2_050;
	start(60_000);
	await advance(65_000);
	assert.equal(state.sent.length, 1);
	state.phase = "idle";
	await advance(65_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.alive, 0);
});

test("records a partial Gemini miss and cancels the next replay", async (t) => {
	const { state, start, advance } = setup(t, "idle", GEMINI);
	state.cacheRead = 17_823;
	state.input = 311_859;
	start(329_682);
	await advance(65_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.recorded, 1);
	assert.equal(state.alive, 0);
	await advance(65_000);
	assert.equal(state.sent.length, 1);
});

test("stops a failed Gemini replay without resetting the cache clock", async (t) => {
	const { state, start, advance } = setup(t, "idle", GEMINI);
	state.failed = true;
	start(60_000);
	await advance(65_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.alive, 0);
	await advance(65_000);
	assert.equal(state.sent.length, 1);
});

for (const interruption of ["idle transition", "refresh deadline"] as const) {
	test(`cancels Gemini after auth prep on ${interruption}`, async (t) => {
		const { state, start, advance } = setup(t, "idle", GEMINI);
		const auth = Promise.withResolvers<void>();
		state.authReady = auth.promise;
		start(60_000);
		await advance(65_000);
		assert.equal(state.alive, 1);
		if (interruption === "idle transition") state.phase = "idle";
		else await advance(5_001);
		auth.resolve();
		await advance(0);
		assert.equal(state.sent.length, 0);
		assert.equal(state.alive, 0);
	});
}

test("rechecks expiry after the host's phase decision", async (t) => {
	const { state, host, start, advance } = setup(t);
	const decision = Promise.withResolvers<CacheWarmingPhase | undefined>();
	t.mock.method(host, "phase", () => decision.promise);
	start(600_000);
	await advance(270_000);
	await advance(30_001);
	decision.resolve("idle");
	await advance(0);
	assert.equal(state.sent.length, 0);
	assert.equal(state.alive, 0);
});

test("cancels a refresh whose native auth preparation outlasts the entry", async (t) => {
	const { state, start, advance } = setup(t);
	const auth = Promise.withResolvers<void>();
	state.authReady = auth.promise;
	start(600_000);
	await advance(270_000);
	await advance(30_001);
	auth.resolve();
	await advance(0);
	assert.equal(state.sent.length, 0);
	assert.equal(state.alive, 0);
});

test("does not assume asking for long retention upgrades an existing five-minute entry", async (t) => {
	const { state, start, advance } = setup(t);
	start(600_000);
	state.retention = "long";
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	await advance(270_000);
	assert.equal(state.sent.length, 2);
	assert.equal(state.recorded, 2);
});

test("stops after a failed refresh when the next retry would miss expiry", async (t) => {
	const { state, start, advance } = setup(t);
	state.failed = true;
	start(600_000);
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.recorded, 0);
	assert.equal(state.alive, 0);
});

test("keeps retrying a failed refresh while the original entry is still valid", async (t) => {
	const { state, start, advance } = setup(t, "idle", { ...MODEL, promptCache: { short: 11 } });
	state.failed = true;
	start(600_000);
	await advance(1_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.recorded, 0);
	state.failed = false;
	await advance(1_000);
	assert.equal(state.sent.length, 2);
	assert.equal(state.recorded, 1);
});

test("warms up to an hour while streaming and 30 minutes while idle; mode streaming stops when idle", async (t) => {
	const streaming = setup(t);
	streaming.start(600_000);
	assert.equal(await streaming.runOut(), 13);
	mock.timers.reset();

	const idle = setup(t);
	idle.state.phase = "idle";
	idle.start(600_000);
	assert.equal(await idle.runOut(), 6);
	mock.timers.reset();

	const streamingOnly = setup(t, "streaming");
	streamingOnly.state.phase = "idle";
	streamingOnly.start(600_000);
	assert.equal(await streamingOnly.runOut(), 0);
});

test("does not warm what is not worth it or cannot be repeated", async (t) => {
	const { state, warmers, start, advance } = setup(t);
	// A failed or aborted response, a model without a cache lifetime for the retention: nothing starts.
	start(600_000, "error");
	start(600_000, "aborted");
	start(600_000, "toolUse", { cacheRetention: "none" });
	assert.equal(state.alive, 0);
	// Mode off (which also uninstalls the hook) stops a run at its next refresh.
	start(600_000);
	state.mode = "off";
	await advance(270_000);
	assert.equal(state.alive, 0);
	state.mode = "idle";

	// 10k tokens: a refresh costs more than it is expected to save.
	start(10_000);
	await advance(270_000);
	// 80k tokens: worth it while the run streams, not once only a 15% chance remains that it continues.
	start(80_000);
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	state.phase = "idle";
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.alive, 0);

	// The host says the conversation changed (reset, compaction, model) or ended (a settled subagent): it stops.
	state.phase = undefined;
	start(600_000);
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.alive, 0);
	warmers.close();
});

test("the next response replaces the run; close stops it", async (t) => {
	const { state, warmers, start, advance } = setup(t);
	start(600_000);
	await advance(200_000);
	start(600_000);
	assert.equal(state.alive, 1);
	// The first run's timer is gone: the refresh comes 270 s after the second response.
	await advance(200_000);
	assert.equal(state.sent.length, 0);
	await advance(70_000);
	assert.equal(state.sent.length, 1);
	warmers.close();
	assert.equal(state.alive, 0);
	await advance(600_000);
	assert.equal(state.sent.length, 1);
});

for (const race of ["tool handoff", "settlement during phase read"] as const) {
	test(`handles a real Durable Google ${race}`, { timeout: 8_000 }, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
		const context = BACKGROUND_CONTEXT;
		const scratch = mkdtempSync(join(tmpdir(), "p2-warm-race-"));
		const store = await openHostStore(sessionDirectory(scratch, "s1"), { outbox: false }, context);
		const host = createHost({ address: Session({ id: "s1" }), principal: HOST, store, onError: console.error });
		const finishHandoff = Promise.withResolvers<void>();
		const finishTool = Promise.withResolvers<void>();
		const finishPhase = Promise.withResolvers<void>();
		const reachedHandoff = Promise.withResolvers<void>();
		const reachedPhase = Promise.withResolvers<void>();
		const replay = Promise.withResolvers<"sent" | "stopped">();
		const stopped = Promise.withResolvers<void>();
		const liveness = new Liveness();
		const counts = await liveness.watch();
		let armed = false;
		counts.start(async (change) => {
			if (change.kind !== "value") return;
			if (change.value.cacheWarming === 1) armed = true;
			else if (armed && change.value.cacheWarming === 0) {
				replay.resolve("stopped");
				stopped.resolve();
			}
		});
		const call = { type: "toolCall", id: "finish-1", name: "finish", arguments: {} } as const;
		const models = createModels();
		const respond = (model: Model<Api>, _context: TranscriptContext, options?: SimpleStreamOptions) => {
			const warming = options?.cacheWarm === true;
			const base = fauxAssistantMessage(warming ? [] : [call]);
			const message: AssistantMessage = {
				...base,
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: warming ? "length" : "toolUse",
				usage: {
					...base.usage,
					input: warming ? 60_000 : 2_050,
					cacheRead: warming ? 0 : 57_950,
					totalTokens: 60_001,
				},
			};
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					await options?.onPayload?.({}, model);
					options?.signal?.throwIfAborted();
					if (warming) replay.resolve("sent");
					else t.mock.timers.tick(race === "tool handoff" ? 66_000 : 64_000);
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "length", message });
				} catch {
					stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
				}
				stream.end();
			})();
			return stream;
		};
		models.setProvider(
			createProvider({
				id: GEMINI.provider,
				models: [GEMINI],
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				api: { stream: respond, streamSimple: respond },
			}),
		);
		const probe = defineExtension({
			name: "warm-race",
			hooks: [
				hook(GenerationTask, {
					afterResponse: async () => {
						reachedHandoff.resolve();
						await finishHandoff.promise;
					},
				}),
			],
			tools: [
				defineTool({
					name: "finish",
					description: "End the run",
					parameters: obj({}),
					execute: async () => {
						await finishTool.promise;
						return { output: [], control: { terminate: true } };
					},
				}),
			],
		});
		const init: WorkerInit = {
			app: APP,
			dataDir: scratch,
			fake: true,
			telemetry: false,
			generation: 1,
			values: {
				session: {
					id: "s1",
					cwd: scratch,
					env: null,
					model: { provider: GEMINI.provider, modelId: GEMINI.id },
					thinkingLevel: "off",
				},
			},
		};
		const core = workerCore(
			init,
			liveness,
			new SessionLocation({ cwd: scratch, env: null }),
			store,
			(fn) => host.root(fn, context),
			NO_IMAGES,
			undefined,
		);
		const config = defineFacet((facet, self) => {
			facet.serve(WorkerModels, (_params, bindings) => ({
				settings: followNative(
					bindings,
					() => () => undefined,
					() => ({ cacheWarming: "idle" as const }),
				),
			}));
			self.contribute(HarnessConfig, { default: { models: () => models, settings: () => ({}) } });
			self.contribute(Extensions, { [probe.name]: probe });
		});
		try {
			await host.load(
				[
					{ name: "@p2/core", facet: core },
					{ name: "config", facet: config },
					{ name: "cache-warming", facet: cacheWarmingWorker },
				],
				context,
			);
			const holder = host.hold(HarnessHost, {}, context);
			t.after(() => holder.release());
			await whenLive(holder);
			const parts = (await host.registry(HarnessNative, context)).value;
			assert.ok(parts);
			const { durable } = parts;
			const root = await durable.root(context);
			const warming = (await host.registry(Extensions, context)).value.get("cache-warming");
			assert.ok(warming);
			await root.configure({ tools: probe.tools, extensions: [warming, probe] }, context);
			if (race === "settlement during phase read") {
				const conversation = durable.conversation.bind(durable);
				let phaseReads = 0;
				t.mock.method(durable, "conversation", async (...args: Parameters<typeof conversation>) => {
					const current = await conversation(...args);
					if (current && ++phaseReads === 2) {
						const read = current.context.bind(current);
						t.mock.method(current, "context", async (...input: Parameters<typeof read>) => {
							const view = await read(...input);
							reachedPhase.resolve();
							await finishPhase.promise;
							return view;
						});
					}
					return current;
				});
			}
			durable.resume();
			const submission = await root.submit({ type: "input", content: "hello" }, context);
			await reachedHandoff.promise;
			if (race === "tool handoff") {
				assert.ok((await durable.snapshot(LiveDoc, root.id, context))?.generation);
				assert.equal(await replay.promise, "sent", "the response's own generation must not block its warm");
				await stopped.promise;
			} else {
				finishHandoff.resolve();
				await reachedPhase.promise;
				assert.ok((await durable.snapshot(LiveDoc, root.id, context))?.run);
				finishTool.resolve();
				await submission.wait(context);
				assert.equal((await durable.snapshot(LiveDoc, root.id, context))?.run, undefined);
				finishPhase.resolve();
				assert.equal(await replay.promise, "stopped", "settlement during the last phase read must block dispatch");
			}
		} finally {
			finishHandoff.resolve();
			finishTool.resolve();
			finishPhase.resolve();
			await counts.stop();
			await host.close(context);
			await store.close(context);
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}

test(
	"a worker keeps the main conversation's cache warm after its run and counts the refreshes' spend",
	{ timeout: 90_000 },
	async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "p2-cache-warming-"));
		const requestLog = join(scratch, "requests.jsonl");
		writeFileSync(requestLog, "");
		const fixture = await startFixture({ workerEnv: { P2_FAKE_REQUESTS: requestLog } });
		t.after(async () => {
			await fixture.close();
			rmSync(scratch, { recursive: true, force: true });
		});
		// The fake model as a cached, expensive one, before the session's worker reads models.json: an 11-second
		// lifetime refreshes after one second, and every refresh pays off even for its small prompts.
		writeFileSync(
			join(fixture.dataDir, "models.json"),
			JSON.stringify({
				providers: {
					faux: {
						modelOverrides: {
							"faux-1": {
								cost: { input: 4000, output: 20000, cacheRead: 200, cacheWrite: 5000 },
								promptCache: { short: 11 },
							},
						},
					},
				},
			}),
		);
		const owner = fixture.browser();
		const session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send({ text: "hello", requestId: "m1" }, BACKGROUND_CONTEXT);
		const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
		const tokens = (view: ConversationView | null | undefined) =>
			Object.values((view?.docs["pi.usage"] as unknown as UsageState | undefined)?.models ?? {}).reduce(
				(total, model) => total + model.totalTokens,
				0,
			);
		const answered = await until(chat.view, (view) => (view?.entries.length ?? 0) > 1 && !live(view)?.run, 30_000);
		const requests = () => readFileSync(requestLog, "utf8").split("\n").filter(Boolean);
		// Idle now: the refreshes repeat the request exactly, and their spend is the conversation's.
		await until(chat.view, (view) => tokens(view) > tokens(answered) && requests().length >= 3, 20_000);
		const [sent, ...refreshes] = requests();
		for (const refresh of refreshes) assert.equal(refresh, sent);
	},
);
