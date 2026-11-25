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
	getCacheWarmingMaxIdleAgeMs,
	getCacheWarmingRequestOptions,
	getEffectiveCacheRetention,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Models,
	shouldStopAfterColdCacheWarm,
	usesGoogleImplicitCache,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ModelRequest } from "@p2/app/v1/worker";

/** The `cacheWarming` setting: "idle" also warms after a run settled, "streaming" only while it runs. */
export type CacheWarmingMode = "off" | "streaming" | "idle";

/** What the warmers read and do outside themselves; the worker facet binds it to the Harness and the settings. */
export type WarmerHost = {
	mode(): CacheWarmingMode;
	/**
	 * "streaming" while the conversation's run is under way, "idle" after it, or `undefined` when warming the
	 * conversation is pointless: its next request will not start with `request`, or nobody is expected to continue it.
	 */
	phase(conversationId: ConversationId, request: ModelRequest): Promise<CacheWarmingPhase | undefined>;
	/** Adds a refresh's spend to the conversation's usage. */
	record(conversationId: ConversationId, message: AssistantMessage): Promise<void>;
	/** Counts the conversations being warmed; a count keeps the worker process alive. */
	keepAlive(delta: number): void;
};

type Run = {
	readonly request: ModelRequest;
	readonly models: Models;
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
	 * the refreshes.
	 */
	start(conversationId: ConversationId, message: AssistantMessage, request: ModelRequest, models: Models): void {
		this.stop(conversationId);
		// A failed or aborted response ended its run.
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		// Mode "off" uninstalls the hook; a run already armed stops at its next refresh.
		if (!isCacheWarmingReplayable(request.model, request.options)) return;
		const startedAt = Date.now();
		const timing = cacheTiming(
			request.cache,
			undefined,
			usesGoogleImplicitCache(request.model.api) ? startedAt : undefined,
		);
		if (timing === undefined || startedAt >= timing.anchorAt + timing.ttlMs) return;
		const { input, cacheRead, cacheWrite } = message.usage;
		const run: Run = {
			request,
			models,
			promptTokens: input + cacheRead + cacheWrite,
			timing,
			startedAt,
			controller: new AbortController(),
		};
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

	#arm(conversationId: ConversationId, run: Run, dueAt: number, warmUntil = Infinity): void {
		if (dueAt >= Math.min(run.timing.anchorAt + run.timing.ttlMs, warmUntil)) {
			this.stop(conversationId);
			return;
		}
		run.timer = setTimeout(() => void this.#refresh(conversationId, run), Math.max(0, dueAt - Date.now()));
	}

	async #refresh(conversationId: ConversationId, run: Run): Promise<void> {
		let refreshed: { timing: CacheTiming | undefined; cold: boolean } | undefined;
		let warmUntil = Infinity;
		try {
			const limit = await this.#warmUntil(conversationId, run);
			const expiresAt = Math.min(run.timing.anchorAt + run.timing.ttlMs, limit ?? Infinity);
			if (limit === undefined || Date.now() >= expiresAt) {
				if (this.#runs.get(conversationId) === run) this.stop(conversationId);
				return;
			}
			warmUntil = limit;
			const { model, messages, options } = run.request;
			let timing: CacheTiming | undefined;
			const message = await run.models
				.streamSimple(
					model,
					{ messages: [...messages] },
					getCacheWarmingRequestOptions(options, run.controller.signal),
					(preparedModel, preparedOptions) => {
						if (this.#runs.get(conversationId) !== run) return;
						// Auth preparation can outlast the entry or Google's idle window.
						if (Date.now() >= expiresAt) {
							this.stop(conversationId);
							return;
						}
						timing = cacheTiming(
							{
								retention: getEffectiveCacheRetention(preparedModel, preparedOptions),
								ttlMs: getPromptCacheTtlMs(preparedModel, preparedOptions),
								dispatchedAt: Date.now(),
							},
							run.timing.ttlMs,
						);
					},
				)
				.result();
			if (this.#runs.get(conversationId) !== run) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				refreshed = {
					timing: timing && usesGoogleImplicitCache(model.api) ? { ...timing, anchorAt: Date.now() } : timing,
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
			this.#arm(conversationId, run, run.timing.anchorAt + run.timing.delayMs, warmUntil);
		} else this.#arm(conversationId, run, Date.now() + run.timing.delayMs, warmUntil);
	}

	/** Dispatch cutoff for an eligible replay, or undefined if warming should stop now. */
	async #warmUntil(conversationId: ConversationId, run: Run): Promise<number | undefined> {
		const mode = this.#host.mode();
		if (mode === "off") return undefined;
		const phase = await this.#host.phase(conversationId, run.request);
		if (phase === undefined || (phase === "idle" && mode === "streaming")) return undefined;
		const { model } = run.request;
		const maxAge = phase === "idle" ? getCacheWarmingMaxIdleAgeMs(model) : CACHE_WARMING_MAX_AGE_MS;
		const deadline = run.startedAt + maxAge;
		if (Date.now() > deadline || this.#runs.get(conversationId) !== run) return undefined;
		if (evaluateCacheWarming(model, run.promptTokens, phase, run.timing.retention).action === "stop")
			return undefined;
		return phase === "idle" && usesGoogleImplicitCache(model.api) ? deadline : Infinity;
	}
}

/** Timing for the entry a request refreshed; a cache hit cannot be assumed to upgrade its existing lifetime. */
function cacheTiming(
	cache: ModelRequest["cache"],
	previousTtlMs?: number,
	completedAt?: number,
): CacheTiming | undefined {
	if (cache?.ttlMs === undefined) return undefined;
	const ttlMs = Math.min(cache.ttlMs, previousTtlMs ?? cache.ttlMs);
	const delayMs = getCacheWarmingDelayMs(ttlMs);
	return delayMs === undefined
		? undefined
		: { retention: cache.retention, anchorAt: completedAt ?? cache.dispatchedAt, ttlMs, delayMs };
}
