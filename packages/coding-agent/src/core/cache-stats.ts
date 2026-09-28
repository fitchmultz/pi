import type { AssistantMessage, JsonObject, ModelPromptCache } from "@earendil-works/pi-ai";
import { getPromptCacheTtlMs } from "./cache-warmer.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

/** Fallback when the provider's cache lifetime is unknown. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const NOISE_FLOOR_TOKENS = 1024;

export interface CacheMiss {
	/** Warning deficit: min(previous prompt, current prompt) - current cache reads. */
	missedTokens: number;
	/** Estimated extra cost versus cached reads; zero when pricing is unknown. */
	missedCost: number;
	/** Actual decrease in cached reads, independently of the warning deficit. */
	cacheReadDecline: number;
	idleMs: number;
	modelChanged: boolean;
	observedChanges: string[];
	providerReasons: string[];
}

export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	missCount: number;
	/** Counts overlap when a request has multiple observations. */
	observedChanges: Map<string, number>;
	providerReasons: Map<string, number>;
}

export interface ModelPriceSource {
	getModel(
		provider: string,
		modelId: string,
	): { cost: { cacheRead: number }; promptCache?: ModelPromptCache } | undefined;
}

interface PreviousRequest {
	promptTokens: number;
	cacheRead: number;
	modelKey: string;
	endedAt: number;
	ttlMs: number;
	reportedCache: boolean;
	requestIndex: number;
	responseId?: string;
	consumed: Set<string>;
	details: JsonObject;
}

function object(value: unknown): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function requestDetails(message: AssistantMessage): JsonObject {
	return message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_request")?.details ?? {};
}

function requestStart(message: AssistantMessage): number {
	return (
		message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_request")?.timestamp ?? message.timestamp
	);
}

function formatProviderCode(code: string): string {
	return [
		"model_changed",
		"prompt_cache_key_changed",
		"service_tier_changed",
		"tools_changed",
		"text_format_changed",
		"reasoning_effort_changed",
		"verbosity_changed",
		"context_compacted",
		"input_changed",
		"cache_hit",
		"cache_miss",
		"comparison_response_not_found",
		"model_binding_mismatch",
		"prefix_binding_mismatch",
		"organization_binding_mismatch",
		"end_user_binding_mismatch",
	].includes(code)
		? code.replaceAll("_", " ")
		: code;
}

function providerReasons(message: AssistantMessage): string[] {
	const reasons: string[] = [];
	const groups = new Map<string, { type: string; reason: string; count: number }>();
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type === "anthropic_input_transformations") {
			const transformations = diagnostic.details?.transformations;
			if (!Array.isArray(transformations)) continue;
			for (const value of transformations) {
				const transformation = object(value);
				if (typeof transformation.type !== "string") continue;
				const type = transformation.type;
				const reason = typeof transformation.reason === "string" ? transformation.reason : "";
				const key = JSON.stringify([type, reason]);
				const group = groups.get(key);
				if (group) group.count++;
				else groups.set(key, { type, reason, count: 1 });
			}
		}
		const diagnostics =
			diagnostic.type === "prompt_cache_diagnostics"
				? diagnostic.details
				: diagnostic.details?.prompt_cache_diagnostics;
		const result = object(diagnostics);
		if (result.type === "unavailable") continue;
		const code = typeof result.reason === "string" ? result.reason : result.type;
		if (typeof code === "string" && code) reasons.push(formatProviderCode(code));
	}
	for (const { type, reason, count } of groups.values()) {
		const summary =
			type === "thinking_dropped"
				? `dropped ${count} thinking ${count === 1 ? "block" : "blocks"}`
				: `${type} (${count})`;
		reasons.push(summary + (reason ? ` (${formatProviderCode(reason)})` : ""));
	}
	// Provider text is untrusted terminal input; display control characters rather than executing them.
	return [
		...new Set(
			reasons.map((reason) =>
				reason.replace(
					/[\p{Cc}\p{Cf}]/gu,
					(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
				),
			),
		),
	];
}

function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
	olderAsyncAdmitted: boolean,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache))
		return undefined;
	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
	const details = requestDetails(message);
	const before = object(prev.details.requestShape);
	const after = object(details.requestShape);
	const observedChanges: string[] = [];
	const modelChanged = `${message.provider}/${message.model}` !== prev.modelKey;
	if (modelChanged) observedChanges.push("model changed");
	if (olderAsyncAdmitted) observedChanges.push("older async result admitted");
	if (
		["requestedServiceTier", "returnedServiceTier"].some(
			(key) =>
				typeof prev.details[key] === "string" &&
				typeof details[key] === "string" &&
				prev.details[key] !== "unknown" &&
				details[key] !== "unknown" &&
				prev.details[key] !== details[key],
		)
	)
		observedChanges.push("service tier changed");
	// ponytail: byte sizes cannot detect equal-length edits; use content hashes if providers expose them.
	if (
		(typeof before.toolsBytes === "number" &&
			typeof after.toolsBytes === "number" &&
			before.toolsBytes !== after.toolsBytes) ||
		(Array.isArray(before.toolDefinitionBytes) &&
			Array.isArray(after.toolDefinitionBytes) &&
			JSON.stringify(before.toolDefinitionBytes) !== JSON.stringify(after.toolDefinitionBytes))
	) {
		observedChanges.push("tool definitions changed");
	}
	if (
		typeof before.instructionsBytes === "number" &&
		typeof after.instructionsBytes === "number" &&
		before.instructionsBytes !== after.instructionsBytes
	)
		observedChanges.push("instructions changed");
	if (details.socketReused === false) observedChanges.push("new connection");
	if (details.websocketRequestMode === "full" && prev.details.websocketRequestMode === "delta")
		observedChanges.push("full resend");
	const idleMs = Math.max(0, requestStart(message) - prev.endedAt);
	if (idleMs > prev.ttlMs) {
		const duration = idleMs < 60_000 ? `${Math.floor(idleMs / 1000)}s` : `${Math.floor(idleMs / 60_000)}m`;
		observedChanges.push(`idle ${duration}`);
	}
	if (observedChanges.length === 0) observedChanges.push("unclassified");
	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		cacheReadDecline: Math.max(0, prev.cacheRead - usage.cacheRead),
		idleMs,
		modelChanged,
		observedChanges,
		providerReasons: providerReasons(message),
	};
}

class CacheMissTracker {
	private prev: PreviousRequest | undefined;
	private requestIndex = 0;
	private window = 0;
	private calls = new Map<string, { requestIndex: number; window: number; responseId?: string }>();
	private results = new Map<string, string>();

	detect(
		message: AssistantMessage,
		models: ModelPriceSource,
		consumedToolResultIds: string[] = [],
	): CacheMiss | undefined {
		const olderAsyncAdmitted = consumedToolResultIds.some((id) => {
			const call = this.calls.get(this.results.get(id) ?? "");
			return (
				call &&
				this.prev &&
				!this.prev.consumed.has(id) &&
				(call.window < this.window ||
					(call.requestIndex < this.prev.requestIndex &&
						(!call.responseId || call.responseId !== this.prev.responseId)))
			);
		});
		return detectMiss(this.prev, message, models, olderAsyncAdmitted);
	}

	observe(entry: SessionEntry, models: ModelPriceSource): CacheMiss | undefined {
		if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "context_window") {
			this.prev = undefined;
			this.window++;
			return;
		}
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0) {
				this.prev = {
					promptTokens,
					cacheRead: entry.usage.cacheRead,
					modelKey: `${entry.provider}/${entry.model}`,
					endedAt: Date.parse(entry.timestamp),
					ttlMs: this.prev?.ttlMs ?? CACHE_TTL_MS,
					reportedCache: true,
					requestIndex: this.prev?.requestIndex ?? this.requestIndex,
					responseId: this.prev?.responseId,
					consumed: this.prev?.consumed ?? new Set(),
					details: this.prev?.details ?? {},
				};
			}
		}
		if (entry.type !== "message") return;
		if (entry.message.role === "toolResult") this.results.set(entry.id, entry.message.toolCallId);
		if (entry.message.role !== "assistant") return;
		const message = entry.message;
		// Checkpoints can be the only surviving record of a carried native call.
		for (const block of message.content) {
			if (block.type === "toolCall" && block.async && !this.calls.has(block.id))
				this.calls.set(block.id, {
					requestIndex: this.requestIndex,
					window: this.window,
					responseId: message.responseId,
				});
		}
		if (entry.checkpoint) {
			this.requestIndex++;
			return;
		}
		const miss = this.detect(message, models, entry.consumedToolResultIds);
		const usage = message.usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens > 0) {
			const details = requestDetails(message);
			const endedAt =
				typeof details.terminalEventMs === "number"
					? requestStart(message) + details.terminalEventMs
					: Date.parse(entry.timestamp);
			const model = models.getModel(message.provider, message.model);
			this.prev = {
				promptTokens,
				cacheRead: usage.cacheRead,
				modelKey: `${message.provider}/${message.model}`,
				endedAt: Number.isFinite(endedAt) ? endedAt : message.timestamp,
				// ponytail: journals omit retention overrides; use the configured lifetime until requests record their TTL.
				ttlMs: (model && getPromptCacheTtlMs(model, undefined)) ?? CACHE_TTL_MS,
				reportedCache: (this.prev?.reportedCache ?? false) || usage.cacheRead + usage.cacheWrite > 0,
				requestIndex: this.requestIndex,
				responseId: message.responseId,
				consumed: new Set(entry.consumedToolResultIds ?? []),
				details,
			};
		}
		this.requestIndex++;
		return miss;
	}
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	const tracker = new CacheMissTracker();
	const totals: CacheWasteTotals = {
		missedTokens: 0,
		missedCost: 0,
		missCount: 0,
		observedChanges: new Map(),
		providerReasons: new Map(),
	};
	const misses = new Map<AssistantMessage, CacheMiss>();
	for (const entry of entries) {
		const miss = tracker.observe(entry, models);
		if (!miss || entry.type !== "message" || entry.message.role !== "assistant") continue;
		totals.missedTokens += miss.missedTokens;
		totals.missedCost += miss.missedCost;
		totals.missCount++;
		for (const label of miss.observedChanges)
			totals.observedChanges.set(label, (totals.observedChanges.get(label) ?? 0) + 1);
		for (const reason of miss.providerReasons)
			totals.providerReasons.set(reason, (totals.providerReasons.get(reason) ?? 0) + 1);
		misses.set(entry.message, miss);
	}
	return { totals, misses };
}

export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

interface LiveCacheState {
	tracker: CacheMissTracker;
	sessionId: string;
	revision: number;
	lastEntry: SessionEntry | undefined;
}
const liveCacheStates = new WeakMap<SessionManager, LiveCacheState>();

/** Compare before persistence; the next call ingests the completed response exactly once. */
export function detectCacheMiss(
	manager: SessionManager,
	message: AssistantMessage,
	models: ModelPriceSource,
	consumedToolResultIds?: string[],
): CacheMiss | undefined {
	let state = liveCacheStates.get(manager);
	const revision = manager.getEntriesRevision();
	const sessionId = manager.getSessionId();
	if (
		!state ||
		state.sessionId !== sessionId ||
		(state.lastEntry && manager.getEntry(state.lastEntry.id) !== state.lastEntry)
	) {
		state = { tracker: new CacheMissTracker(), sessionId, revision: -1, lastEntry: undefined };
		liveCacheStates.set(manager, state);
	}
	if (state.revision !== revision) {
		const pending: SessionEntry[] = [];
		let id = manager.getLeafId();
		while (id && id !== state.lastEntry?.id) {
			const entry = manager.getEntry(id);
			if (!entry) break;
			pending.push(entry);
			id = entry.parentId;
		}
		// Initial hydration or a branch/reload needs replay; normal appends only visit the new suffix.
		if (
			state.revision === -1 ||
			id !== (state.lastEntry?.id ?? null) ||
			pending.length !== revision - state.revision
		) {
			state.tracker = new CacheMissTracker();
			const entries = manager.getEntries();
			for (const entry of entries) state.tracker.observe(entry, models);
			state.lastEntry = entries.at(-1);
		} else {
			for (const entry of pending.reverse()) state.tracker.observe(entry, models);
			state.lastEntry = pending.at(-1) ?? state.lastEntry;
		}
		state.revision = revision;
	}
	return state.tracker.detect(message, models, consumedToolResultIds);
}
