// Prompt cache warming for the session's conversations, as pi-coding-agent does it for its one session: before the
// cache entry a conversation's last request wrote expires, send that request again with a one-token output cap, for as
// long as that is expected to pay off. The policy is pi-ai's; this file schedules it per conversation.
import {
	type AssistantMessage,
	CACHE_WARMING_MAX_AGE_MS,
	type CacheRetention,
	type CacheWarmingPhase,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getCacheWarmingDispatchWindow,
	getCacheWarmingMaxIdleAgeMs,
	getCacheWarmingRequestOptions,
	getEffectiveCacheRetention,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Models,
	shouldStopAfterColdCacheWarm,
	usesGoogleImplicitCache,
} from "@earendil-works/pi-ai";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { ModelRequest } from "@p2/app/v1/worker";

/** The `cacheWarming` setting: "idle" also warms after a run settled, "streaming" only while it runs. */
export type CacheWarmingMode = "off" | "streaming" | "idle";

/** The Durable generation that produced a Google response. */
export type ReplayGeneration = { taskId: TaskId; next: "tool-round" | "answer" };

/** What the warmers read and do outside themselves; the worker facet binds it to the Harness and the settings. */
export type WarmerHost = {
	mode(): CacheWarmingMode;
	/**
	 * "streaming" while the conversation's run is under way, "idle" after it, or `undefined` when warming the
	 * conversation is pointless: its next request will not start with `request`, or nobody is expected to continue it.
	 */
	phase(
		conversationId: ConversationId,
		request: ModelRequest,
		generation?: ReplayGeneration,
	): Promise<CacheWarmingPhase | undefined>;
	/** Adds a refresh's spend to the conversation's usage. */
	record(conversationId: ConversationId, message: AssistantMessage): Promise<void>;
	/** Counts the conversations being warmed; a count keeps the worker process alive. */
	keepAlive(delta: number): void;
};

type Run = {
	readonly request: ModelRequest;
	readonly models: Models;
	readonly generation?: ReplayGeneration;
	/** Prompt size of the request, as the provider reported it. */
	readonly promptTokens: number;
	timing: CacheTiming;
	readonly startedAt: number;
	readonly controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
};

type CacheTiming = {
	readonly retention: CacheRetention;
	readonly anchorAt: number;
	readonly ttlMs: number;
	readonly delayMs: number;
};

/**
 * One warming run per conversation, started by each response and replaced by the next one. Each refresh asks the host
 * for the conversation's phase and follows pi-ai's age limits and cost estimate.
 */
export class ConversationWarmers {
	readonly #host: WarmerHost;
	readonly #runs = new Map<ConversationId, Run>();

	constructor(host: WarmerHost) {
		this.#host = host;
	}

	/**
	 * Warm the cache entry `request` wrote, replacing the conversation's run: `message` is its response, `models` sends
	 * the refreshes. For Google, `generation` ties the replay to the active run that produced the response.
	 */
	start(
		conversationId: ConversationId,
		message: AssistantMessage,
		request: ModelRequest,
		models: Models,
		generation?: ReplayGeneration,
	): void {
		this.stop(conversationId);
		// A failed or aborted response ended its run.
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		// Mode "off" uninstalls the hook; a run already armed stops at its next refresh.
		if (!isCacheWarmingReplayable(request.model, request.options)) return;
		const startedAt = Date.now();
		const timing = cacheTiming(request.cache);
		if (timing === undefined) return;
		const { input, cacheRead, cacheWrite } = message.usage;
		const run: Run = {
			request,
			models,
			generation,
			promptTokens: input + cacheRead + cacheWrite,
			timing,
			startedAt,
			controller: new AbortController(),
		};
		if (dispatchWindowClosed(run, startedAt)) return;
		this.#runs.set(conversationId, run);
		this.#host.keepAlive(1);
		this.#arm(conversationId, run, timing.anchorAt + timing.delayMs);
	}

	/** Stop warming the conversation; a refresh in flight is aborted. */
	stop(conversationId: ConversationId): void {
		const run = this.#runs.get(conversationId);
		if (run === undefined) return;
		this.#runs.delete(conversationId);
		clearTimeout(run.timer);
		run.controller.abort();
		this.#host.keepAlive(-1);
	}

	/** Stop every run (a reload or the worker's stop). */
	close(): void {
		for (const conversationId of [...this.#runs.keys()]) this.stop(conversationId);
	}

	#arm(conversationId: ConversationId, run: Run, dueAt: number): void {
		const now = Date.now();
		const nextWarmAt = Math.max(now, dueAt);
		if (dispatchWindowClosed(run, nextWarmAt)) {
			this.stop(conversationId);
			return;
		}
		run.timer = setTimeout(() => void this.#refresh(conversationId, run), nextWarmAt - now);
	}

	async #refresh(conversationId: ConversationId, run: Run): Promise<void> {
		let refreshed: { timing: CacheTiming | undefined; cold: boolean } | undefined;
		const { model, messages, options } = run.request;
		const google = usesGoogleImplicitCache(model.api);
		try {
			if (!(await this.#canWarm(conversationId, run)) || dispatchWindowClosed(run, Date.now())) {
				if (this.#runs.get(conversationId) === run) this.stop(conversationId);
				return;
			}
			const signal = run.controller.signal;
			const replayOptions = getCacheWarmingRequestOptions(options, signal);
			let timing: CacheTiming | undefined;
			if (google) {
				// Recheck phase at the provider's last async hook, after auth and payload preparation.
				replayOptions.onPayload = async (payload, preparedModel) => {
					const replacement = await options.onPayload?.(payload, preparedModel);
					const canWarm = await this.#canWarm(conversationId, run);
					const dispatchedAt = Date.now();
					signal.throwIfAborted();
					if (!canWarm || dispatchWindowClosed(run, dispatchedAt)) {
						this.stop(conversationId);
						signal.throwIfAborted();
					}
					if (timing) timing = { ...timing, anchorAt: dispatchedAt };
					return replacement;
				};
			}
			const message = await run.models
				.streamSimple(model, { messages: [...messages] }, replayOptions, (preparedModel, preparedOptions) => {
					signal.throwIfAborted();
					const dispatchedAt = Date.now();
					if (dispatchWindowClosed(run, dispatchedAt) || (google && this.#host.mode() === "off")) {
						this.stop(conversationId);
						signal.throwIfAborted();
					}
					timing = cacheTiming(
						{
							retention: getEffectiveCacheRetention(preparedModel, preparedOptions),
							ttlMs: getPromptCacheTtlMs(preparedModel, preparedOptions),
							dispatchedAt,
						},
						run.timing.ttlMs,
					);
				})
				.result();
			if (this.#runs.get(conversationId) !== run) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				refreshed = {
					timing,
					cold: shouldStopAfterColdCacheWarm(model, run.promptTokens, message.usage),
				};
				await this.#host.record(conversationId, message);
			}
		} catch (error) {
			// Warming is best effort: a failed refresh never touches the conversation, the next one may succeed.
			if (!run.controller.signal.aborted) console.error("p2 cache-warming: refreshing failed:", error);
		}
		if (this.#runs.get(conversationId) !== run) return;
		if (refreshed !== undefined) {
			if (refreshed.cold || refreshed.timing === undefined) {
				this.stop(conversationId);
				return;
			}
			run.timing = refreshed.timing;
			this.#arm(conversationId, run, run.timing.anchorAt + run.timing.delayMs);
		} else if (google) {
			// A failed Google replay did not reset the cache clock.
			this.stop(conversationId);
		} else {
			this.#arm(conversationId, run, Date.now() + run.timing.delayMs);
		}
	}

	async #canWarm(conversationId: ConversationId, run: Run): Promise<boolean> {
		if (this.#host.mode() === "off") return false;
		const phase = await this.#host.phase(conversationId, run.request, run.generation);
		const mode = this.#host.mode();
		if (phase === undefined || mode === "off" || (phase === "idle" && mode === "streaming")) return false;
		const { model } = run.request;
		const maxAge = phase === "idle" ? getCacheWarmingMaxIdleAgeMs(model) : CACHE_WARMING_MAX_AGE_MS;
		if (maxAge <= 0 || Date.now() > run.startedAt + maxAge || this.#runs.get(conversationId) !== run) return false;
		return evaluateCacheWarming(model, run.promptTokens, phase, run.timing.retention).action === "warm";
	}
}

function dispatchWindowClosed(run: Run, at: number): boolean {
	const { anchorAt, ttlMs, delayMs } = run.timing;
	return (
		at >= anchorAt + ttlMs ||
		(usesGoogleImplicitCache(run.request.model.api) &&
			at > getCacheWarmingDispatchWindow(anchorAt, ttlMs, delayMs).deadlineAt)
	);
}

/** Timing for the entry a request refreshed; a cache hit cannot be assumed to upgrade its existing lifetime. */
function cacheTiming(cache: ModelRequest["cache"], previousTtlMs?: number): CacheTiming | undefined {
	if (cache?.ttlMs === undefined) return undefined;
	const ttlMs = Math.min(cache.ttlMs, previousTtlMs ?? cache.ttlMs);
	const delayMs = getCacheWarmingDelayMs(ttlMs);
	return delayMs === undefined
		? undefined
		: { retention: cache.retention, anchorAt: cache.dispatchedAt, ttlMs, delayMs };
}
