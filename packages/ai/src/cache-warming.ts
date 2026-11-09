// Prompt cache warming policy shared by pi's hosts: when a refresh is due, whether a request can be replayed, and
// whether a refresh pays for itself. Hosts own the scheduling; this module owns the numbers.
import { calculateCost, hasApi } from "./models.ts";
import type { Api, CacheRetention, Model, SimpleStreamOptions, Usage } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

/** Whether a refresh is sent ("warm") or warming ends until the next real request ("stop"). */
export type CacheWarmingAction = "warm" | "stop";

/** "streaming" while the agent run that sent the request is still active; "idle" after it settled. */
export type CacheWarmingPhase = "streaming" | "idle";

/**
 * Inputs and outcome of one warm-or-stop decision. Prices use the selected model's catalog; provider wrappers or
 * service tiers can change actual request rates. This is not a cost or savings guarantee.
 */
export interface CacheWarmingDecision {
	phase: CacheWarmingPhase;
	/** Price of this refresh: a cache read of the prompt plus one output token. */
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost. */
	missCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	continuationProbability: number;
	/** `continuationProbability * missCost - warmCost`. */
	expectedSavings: number;
	/** False when the prompt size or the model's prices are unknown. */
	economicsAvailable: boolean;
	/** "warm" when `expectedSavings` is at least `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS`. */
	action: CacheWarmingAction;
}

/** Streaming warming never continues past this long after the real request that started it. */
export const CACHE_WARMING_MAX_AGE_MS = 60 * 60_000;

/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
export const CACHE_WARMING_MAX_IDLE_AGE_MS = 30 * 60_000;

/** A refresh is sent only when it is expected to save at least this many dollars. */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;

/**
 * Chance that a real request arrives before the cache entry expires while the agent sits idle. Measured from our own
 * usage; per-session estimates were not better than this constant.
 */
export const CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY = 0.15;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Retention used by the native adapter, including models that do not support one-hour writes. */
export function getEffectiveCacheRetention(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): CacheRetention {
	const retention =
		options?.cacheRetention ??
		(getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
	return retention === "long" &&
		hasApi(model, "anthropic-messages") &&
		model.compat?.supportsLongCacheRetention === false
		? "short"
		: retention;
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's `promptCache` tier for the retention the
 * request used. Undefined when the model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention = getEffectiveCacheRetention(model, options);
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache entry untouched. Anthropic's budget-based
 * thinking (Claude models without adaptive thinking) derives `budget_tokens` from `max_tokens`; the replay would get a
 * different budget, which Anthropic keys the message cache on, and the model could still think for thousands of tokens.
 */
export function isCacheWarmingReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning || model.api !== "anthropic-messages") return true;
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

/**
 * The options of a refresh: the request's own, capped at one output token, without retries, and without replacing the
 * conversation's provider thread state (the refresh repeats the last request).
 */
export function getCacheWarmingRequestOptions<T extends SimpleStreamOptions>(options: T, signal: AbortSignal): T {
	return {
		...options,
		...(options.cacheTraceContext
			? { cacheTraceContext: { ...options.cacheTraceContext, purpose: "warming" as const } }
			: {}),
		maxTokens: 1,
		disableContinuation: true,
		maxRetries: 0,
		signal,
	};
}

/** Decide whether refreshing the cache entry of a `promptTokens`-token request pays for itself in `phase`. */
export function evaluateCacheWarming(
	model: Model<Api>,
	promptTokens: number,
	phase: CacheWarmingPhase,
	retention: CacheRetention = "short",
): CacheWarmingDecision {
	const cacheHitCost = price(model, { cacheRead: promptTokens });
	const longWrite =
		(model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") && retention === "long";
	const hasWritePrice = model.cost.cacheWrite > 0 || model.cost.tiers?.some((tier) => tier.cacheWrite > 0);
	const cacheMissCost = price(
		model,
		longWrite || hasWritePrice
			? { cacheWrite: promptTokens, cacheWrite1h: longWrite ? promptTokens : 0 }
			: { input: promptTokens },
	);
	const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
	const missCost = Math.max(0, cacheMissCost - cacheHitCost);
	const continuationProbability = phase === "idle" ? CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY : 1;
	const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
	const expectedSavings = continuationProbability * missCost - warmCost;
	return {
		phase,
		warmCost,
		missCost,
		continuationProbability,
		expectedSavings,
		economicsAvailable,
		action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
	};
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}
