import {
	type Api,
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	type CacheRetention,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type Context,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getCacheWarmingDispatchWindow,
	getCacheWarmingMaxIdleAgeMs,
	getCacheWarmingRequestOptions,
	getEffectiveCacheRetention,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Model,
	type ModelsSimpleStreamOptions,
	type SimpleStreamOptions,
	shouldStopAfterColdCacheWarm,
	usesGoogleImplicitCache,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

export type { CacheWarmingAction, CacheWarmingDecision };

function getCacheWarmingTiming(model: Model<Api>, options: SimpleStreamOptions | undefined, previousTtlMs?: number) {
	const requestedTtlMs = getPromptCacheTtlMs(model, options);
	if (requestedTtlMs === undefined) return undefined;
	const ttlMs = Math.min(requestedTtlMs, previousTtlMs ?? requestedTtlMs);
	const delayMs = getCacheWarmingDelayMs(ttlMs);
	if (delayMs === undefined) return undefined;
	return { ttlMs, delayMs, retention: getEffectiveCacheRetention(model, options) };
}

/** Prompt size of the most recent real request on the branch, as reported by the provider. */
function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

/**
 * Fired before each refresh with pi's decision filled in. Everything else an
 * extension might want (model, idle state, context size) is on the context.
 */
export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "action"> {
	type: "cache_warming_decision";
}

export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	action?: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled": a refresh timer is armed; "refreshing": a due refresh is being decided or sent. */
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	reason?: string;
	nextWarmAt?: number;
	/** The pending decision, or the decision that stopped warming. */
	decision?: CacheWarmingDecision;
	/** True when an extension changed `decision.action`. */
	extensionOverride?: boolean;
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

/** When a run's next refresh is due and how late it may still be sent; fixed when it is scheduled. */
interface ScheduledRefresh {
	kind: "scheduled";
	timer: ReturnType<typeof setTimeout>;
	nextWarmAt: number;
	/** Latest safe time to send this refresh, leaving half the original expiry margin. */
	refreshDeadlineAt: number;
}

type RefreshCycle =
	| { kind: "awaiting-response" }
	| ScheduledRefresh
	| { kind: "deciding"; nextWarmAt: number }
	| { kind: "refreshing"; nextWarmAt: number; extensionOverride: boolean };

interface ActiveRun extends CacheWarmRequest {
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
	/** Effective retention observed at native request preparation, separate from replay options. */
	retention: CacheRetention;
	ttlMs: number;
	delayMs: number;
	startedAt: number;
	/** Dispatch time of the last request that wrote or refreshed Google's cache. */
	anchorAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	cycle: RefreshCycle;
}

function getSafetyLimit(run: Pick<ActiveRun, "model" | "phase" | "startedAt">) {
	if (run.phase === "streaming") {
		return { deadline: run.startedAt + CACHE_WARMING_MAX_AGE_MS, reason: "one-hour safety limit reached" };
	}
	const maxIdleAgeMs = getCacheWarmingMaxIdleAgeMs(run.model);
	return {
		deadline: run.startedAt + maxIdleAgeMs,
		reason: maxIdleAgeMs <= 0 ? "agent run settled" : `${maxIdleAgeMs / 60_000}-minute idle safety limit reached`,
	};
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactive: CacheWarmingStatus;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	/** Lets extensions override `event.action`; failures fall back to pi's decision. */
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** Called with the persisted usage entry after each completed refresh. */
	onWarmed?: (entry: UsageEntry) => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		if (this.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.run;
		if (!run) return this.inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const { cycle } = run;
		if (cycle.kind === "awaiting-response") return { state: "inactive", reason: "waiting for response" };
		const decision = this.evaluate(run);
		if (!decision.economicsAvailable && cycle.kind === "scheduled") {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return {
			state: cycle.kind === "scheduled" ? "scheduled" : "refreshing",
			nextWarmAt: cycle.nextWarmAt,
			decision,
			extensionOverride: cycle.kind === "refreshing" && cycle.extensionOverride,
		};
	}

	/** Keep raw replay options, but schedule and price the prepared request's native retention. */
	start(
		request: CacheWarmRequest,
		isCurrent: () => boolean,
		prepared: Pick<CacheWarmRequest, "model" | "options">,
	): void {
		this.clearRun();
		const mode = this.getMode();
		if (mode === "off") {
			this.stop("cache warming disabled");
			return;
		}
		if (!isCurrent()) {
			this.stop("conversation context changed");
			return;
		}
		if (!isCacheWarmingReplayable(prepared.model, prepared.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const timing = getCacheWarmingTiming(prepared.model, prepared.options);
		if (!timing) {
			this.stop(
				prepared.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const startedAt = Date.now();
		const run: Omit<ActiveRun, "cycle"> = {
			...request,
			isCurrent,
			...timing,
			startedAt,
			anchorAt: startedAt,
			controller: new AbortController(),
			phase: "streaming",
		};
		// The latest Google request's cache usage is not known until its response finishes.
		const cycle: RefreshCycle | undefined = usesGoogleImplicitCache(prepared.model.api)
			? { kind: "awaiting-response" }
			: this.schedule(run);
		if (cycle) this.run = { ...run, cycle };
	}

	/** Arm Google's refresh once the response's usage is in the journal. */
	onResponseCompleted(): void {
		const run = this.run;
		if (!run || run.cycle.kind !== "awaiting-response" || !this.validateRun(run)) return;
		const next = this.schedule(run);
		if (next) run.cycle = next;
	}

	onAgentSettled(): void {
		const run = this.run;
		if (!run) return;
		if (this.getMode() === "streaming") {
			this.stop("agent run settled");
			return;
		}
		if (run.cycle.kind === "awaiting-response") {
			this.stop("request did not complete");
			return;
		}
		run.phase = "idle";
		const modeStopReason = this.getModeStopReason(run);
		if (modeStopReason) {
			this.stop(modeStopReason);
			return;
		}
		const { deadline, reason } = getSafetyLimit(run);
		if (run.cycle.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(reason);
		}
	}

	/** Reconcile an active run after the persisted warming mode changes. */
	onModeChanged(): void {
		const run = this.run;
		if (!run) return;
		const reason = this.getModeStopReason(run);
		if (reason) this.stop(reason);
	}

	cancel(): void {
		this.stop("inactive");
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.cycle.kind === "scheduled") clearTimeout(run.cycle.timer);
		run.controller.abort();
	}

	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...stopped };
	}

	private schedule(run: Omit<ActiveRun, "cycle">): ScheduledRefresh | undefined {
		const now = Date.now();
		const anchorAt = usesGoogleImplicitCache(run.model.api) ? run.anchorAt : now;
		const { dueAt, deadlineAt: refreshDeadlineAt } = getCacheWarmingDispatchWindow(anchorAt, run.ttlMs, run.delayMs);
		const nextWarmAt = Math.max(now, dueAt);
		if (nextWarmAt > refreshDeadlineAt) {
			this.stop("cache refresh deadline missed");
			return undefined;
		}
		const { deadline, reason } = getSafetyLimit(run);
		if (nextWarmAt > deadline || now >= deadline) {
			this.stop(reason);
			return undefined;
		}
		const timer = setTimeout(() => {
			// The timer is armed for one run: the one that holds this cycle.
			if (this.run?.cycle === cycle) void this.refresh(this.run);
		}, nextWarmAt - now);
		timer.unref?.();
		const cycle: ScheduledRefresh = {
			kind: "scheduled",
			timer,
			nextWarmAt,
			refreshDeadlineAt,
		};
		return cycle;
	}

	private async refresh(run: ActiveRun): Promise<void> {
		const { cycle } = run;
		if (cycle.kind !== "scheduled") return;
		const { nextWarmAt, refreshDeadlineAt } = cycle;
		run.cycle = { kind: "deciding", nextWarmAt };
		if (!this.validateRun(run)) return;
		if (this.refreshDeadlineMissed(refreshDeadlineAt)) return;
		const promptTokens = lastPromptTokens(this.sessionManager.getBranch());
		let decision: CacheWarmingDecision;
		let action: CacheWarmingAction;
		do {
			decision = this.evaluate(run, promptTokens);
			const { warmCost, missCost, continuationProbability } = decision;
			action = decision.action;
			try {
				action = await this.decide({
					type: "cache_warming_decision",
					warmCost,
					missCost,
					continuationProbability,
					action,
				});
			} catch {
				// Extension failures fall back to pi's own decision.
			}
			if (!this.validateRun(run) || this.refreshDeadlineMissed(refreshDeadlineAt)) return;
		} while (decision.phase !== run.phase);
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.stop(reason, { decision, extensionOverride });
			return;
		}

		run.cycle = { kind: "refreshing", nextWarmAt, extensionOverride };
		const signal = run.controller.signal;
		const google = usesGoogleImplicitCache(run.model.api);
		const replayOptions = getCacheWarmingRequestOptions(run.options, signal);
		let warmDispatchedAt = Date.now();
		if (google) {
			replayOptions.onPayload = async (payload, model) => {
				const replacement = await run.options.onPayload?.(payload, model);
				// A payload hook can consume the rest of Google's short refresh window.
				if (!this.validateRun(run) || this.refreshDeadlineMissed(refreshDeadlineAt)) signal.throwIfAborted();
				warmDispatchedAt = Date.now();
				return replacement;
			};
		}
		let refreshed = false;
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, replayOptions, (model, options) => {
					if (!this.validateRun(run) || this.refreshDeadlineMissed(refreshDeadlineAt)) {
						signal.throwIfAborted();
						return;
					}
					const timing = getCacheWarmingTiming(model, options, run.ttlMs);
					if (!timing) {
						this.stop("cache lifetime unavailable");
						signal.throwIfAborted();
						return;
					}
					Object.assign(run, timing);
					warmDispatchedAt = Date.now();
				})
				.result();
			if (!this.validateRun(run)) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				refreshed = true;
				run.anchorAt = warmDispatchedAt;
				const missed = shouldStopAfterColdCacheWarm(run.model, promptTokens, message.usage);
				const entry = this.sessionManager.appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					extensionOverride ? "extension override" : undefined,
					{
						cacheIdentity: message.cacheIdentity,
						cacheWarmMissed: missed || undefined,
						durationMs: message.durationMs ?? Math.max(0, Date.now() - warmDispatchedAt),
						thinkingLevel: message.thinkingLevel ?? run.options.reasoning ?? "off",
						providerThinkingLevel: message.providerThinkingLevel,
					},
				);
				if (missed) this.stop("cache warm missed");
				this.onWarmed?.(entry);
			}
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		if (this.run !== run) return;
		// A failed Google replay did not reset the cache clock.
		if (!refreshed && google) {
			this.stop("cache warm failed");
			return;
		}
		const next = this.schedule(run);
		if (next) run.cycle = next;
	}

	private refreshDeadlineMissed(refreshDeadlineAt: number): boolean {
		if (Date.now() <= refreshDeadlineAt) return false;
		this.stop("cache refresh deadline missed");
		return true;
	}

	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
		if (!reason) return true;
		this.stop(reason);
		return false;
	}

	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getMode();
		if (mode === "off") return "cache warming disabled";
		if (run.phase === "idle" && (mode === "streaming" || getCacheWarmingMaxIdleAgeMs(run.model) <= 0))
			return "agent run settled";
		return undefined;
	}

	private evaluate(
		run: ActiveRun,
		promptTokens = lastPromptTokens(this.sessionManager.getBranch()),
	): CacheWarmingDecision {
		return evaluateCacheWarming(run.model, promptTokens, run.phase, run.retention);
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	const comparison = decision.action === "warm" ? ">=" : "<";
	return `catalog estimate, ${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** One-line status for `/session`. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// A decision is attached once pi (or an extension) acted on it; "inactive"
	// without one never got that far.
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	const details = status.extensionOverride
		? `extension override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** One-line transcript text for the total cost of one or more consecutive cache warms. */
export function formatCacheWarmingUsage(totalCost: number, note?: string, missed = false): string {
	const noteText = note ? ` (${note})` : "";
	const cost = totalCost.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	return `${missed ? "Cache warm missed" : "Cache warmed"}${noteText}: $${cost}`;
}
