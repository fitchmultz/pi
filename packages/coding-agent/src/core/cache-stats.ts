import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/** Per-turn overlap estimates at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

type ReadPriceSource = "usage" | "ancestor" | "catalog" | "unknown";

// ponytail: token counts do not establish prefix identity; use native cache traces to diagnose causes.
/** A token-count overlap estimate, not proof of a changed cache key or avoidable billing. */
export interface CacheMiss {
	/** min(previous prompt, current prompt) - current cache reads; prefixes are not compared. */
	missedTokens: number;
	/** Estimated cost above a full cache hit; 0 when the read price is unknown. */
	missedCost: number;
	readPriceSource: ReadPriceSource;
	/** Request-start to request-start gap in milliseconds, not observed idle time. */
	idleMs: number;
	/** Expected transition to a different provider/model on the same ancestry. */
	modelChanged: boolean;
}

export interface CacheWasteTotals {
	missedTokens: number;
	/** Sum of priced estimates only; never part of real session usage/cost accounting. */
	missedCost: number;
	missCount: number;
	modelSwitchCount: number;
	ancestorPriceCount: number;
	catalogPriceCount: number;
	unpricedMissCount: number;
}

/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/** Last observed read rate on this uninterrupted provider/model ancestry. */
	readPerToken?: number;
	/** Some earlier request on this ancestry reported cache activity. */
	reportedCache: boolean;
}

function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// Cache-read-only providers do not report writes. A normalized zero alone
	// cannot distinguish a total miss from a provider that never reports caching.
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	const modelChanged = `${message.provider}/${message.responseModel ?? message.model}` !== prev.modelKey;
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	let readPerToken = usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : undefined;
	let readPriceSource: ReadPriceSource = "usage";
	if (readPerToken === undefined && !modelChanged && prev.readPerToken !== undefined) {
		readPerToken = prev.readPerToken;
		readPriceSource = "ancestor";
	}
	if (readPerToken === undefined) {
		// Today's catalog is not a historical tariff. Keep the fallback explicitly
		// identifiable, and never substitute a zero read price for missing metadata.
		const catalogRate = models.getModel(message.provider, message.responseModel ?? message.model)?.cost.cacheRead;
		if (catalogRate !== undefined && Number.isFinite(catalogRate) && catalogRate >= 0) {
			readPerToken = catalogRate / 1_000_000;
			readPriceSource = "catalog";
		} else {
			readPriceSource = "unknown";
		}
	}

	return {
		missedTokens,
		missedCost: readPerToken === undefined ? 0 : missedTokens * Math.max(0, paidPerToken - readPerToken),
		readPriceSource,
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged,
	};
}

function asPreviousRequest(message: AssistantMessage, prev: PreviousRequest | undefined): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	const modelKey = `${message.provider}/${message.responseModel ?? message.model}`;
	return {
		promptTokens,
		modelKey,
		timestamp: message.timestamp,
		readPerToken:
			usage.cacheRead > 0
				? usage.cost.cacheRead / usage.cacheRead
				: modelKey === prev?.modelKey
					? prev.readPerToken
					: undefined,
		reportedCache: (prev?.reportedCache ?? false) || usage.cacheRead + usage.cacheWrite > 0,
	};
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const requestsByEntry = new Map<string, PreviousRequest | undefined>();
	const totals: CacheWasteTotals = {
		missedTokens: 0,
		missedCost: 0,
		missCount: 0,
		modelSwitchCount: 0,
		ancestorPriceCount: 0,
		catalogPriceCount: 0,
		unpricedMissCount: 0,
	};
	const misses = new Map<AssistantMessage, CacheMiss>();

	// Native entries are append-only (parents precede children). Inherit the
	// request from each entry's own parent, never from an abandoned sibling.
	for (const entry of entries) {
		prev = entry.parentId === null ? undefined : requestsByEntry.get(entry.parentId);
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			prev = undefined;
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0) {
				const modelKey = `${entry.provider}/${entry.model}`;
				prev = {
					promptTokens,
					modelKey,
					timestamp: Date.parse(entry.timestamp),
					readPerToken:
						entry.usage.cacheRead > 0
							? entry.usage.cost.cacheRead / entry.usage.cacheRead
							: modelKey === prev?.modelKey
								? prev.readPerToken
								: undefined,
					reportedCache: true,
				};
			}
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				if (miss.modelChanged) totals.modelSwitchCount += 1;
				if (miss.readPriceSource === "ancestor") totals.ancestorPriceCount += 1;
				if (miss.readPriceSource === "catalog") totals.catalogPriceCount += 1;
				if (miss.readPriceSource === "unknown") totals.unpricedMissCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev) ?? prev;
		}
		requestsByEntry.set(entry.id, prev);
	}
	return { prev, totals, misses };
}

/**
 * Sum overlap/cost estimates across the supplied native entries, comparing each
 * request only with its own ancestry. All branches may be supplied for session
 * history; this never changes persisted usage or the real session cost total.
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/** Re-derive historical notices by assistant reference using native parent ancestry. */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * Estimate overlap for a just-completed assistant message. Supply getBranch(),
 * not global chronology: message_end fires before the message is persisted, and
 * only the session's current leaf identifies its ancestry.
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(scan(entries, models).prev, message, models);
}
