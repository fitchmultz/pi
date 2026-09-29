import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss as detectLiveCacheMiss,
	type ModelPriceSource,
} from "../src/core/cache-stats.ts";
import { type SessionEntry, SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";

function detectCacheMiss(entries: SessionEntry[], message: AssistantMessage, prices: ModelPriceSource) {
	// Live detection follows the active branch, so link the fixture entries into one.
	const branch = entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
	return detectLiveCacheMiss(SessionManager.inMemory(undefined, undefined, branch), message, prices);
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const models: ModelPriceSource = {
	// $/million tokens; used as cache-read price fallback on full-miss turns
	getModel: () => ({ cost: { cacheRead: 0.3 } }),
};

function assistant(options: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: Partial<typeof zeroCost>;
	model?: string;
	timestamp?: number;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test",
		model: options.model ?? "test-model",
		usage: {
			input: options.input ?? 0,
			output: 10,
			cacheRead: options.cacheRead ?? 0,
			cacheWrite: options.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { ...zeroCost, ...options.cost },
		},
		stopReason: "stop",
		timestamp: options.timestamp ?? 0,
	} as AssistantMessage;
}

let nextEntryId = 0;

function entry(message: AssistantMessage): SessionMessageEntry {
	return { type: "message", id: `entry-${nextEntryId++}`, parentId: null, timestamp: "", message };
}

function usageEntry(kind: string, timestamp: number): SessionEntry {
	return {
		type: "usage",
		id: `usage-${nextEntryId++}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		kind,
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 100_000,
			cacheWrite: 0,
			totalTokens: 100_000,
			cost: zeroCost,
		},
	};
}

// Turn 1: fresh 100k cache write at $3.75/M
const turn1 = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, timestamp: 0 });
// Turn 2: healthy, everything read back at $0.30/M
const turn2 = assistant({
	cacheRead: 100_000,
	cacheWrite: 5_000,
	cost: { cacheRead: 0.03, cacheWrite: 0.019 },
	timestamp: 60_000,
});

describe("computeCacheWaste", () => {
	it("accumulates missed tokens and cost across turns", () => {
		// Turn 3: full miss, previous 105k prompt re-billed at $3.75/M write
		const turn3 = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const totals = computeCacheWaste([entry(turn1), entry(turn2), entry(turn3)], models);
		expect(totals.missedTokens).toBe(105_000);
		// 105k at ($3.75 - $0.30)/M
		expect(totals.missedCost).toBeCloseTo(0.36225, 5);
	});

	it("counts nothing for healthy sessions", () => {
		const totals = computeCacheWaste([entry(turn1), entry(turn2)], models);
		expect(totals.missedTokens).toBe(0);
		expect(totals.missedCost).toBe(0);
	});

	it("skips the turn after a compaction reset", () => {
		const reset = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;
		const afterReset = assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } });
		const totals = computeCacheWaste([entry(turn1), reset, entry(afterReset)], models);
		expect(totals.missedTokens).toBe(0);
	});

	it("skips the turn after a branch summary", () => {
		const reset = { type: "branch_summary", id: "w", parentId: null, timestamp: "" } as SessionEntry;
		const afterReset = assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } });
		const totals = computeCacheWaste([entry(turn1), reset, entry(afterReset)], models);
		expect(totals.missedTokens).toBe(0);
	});

	it("counts misses caused by model switches", () => {
		const otherModel = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, model: "other-model" });
		const totals = computeCacheWaste([entry(turn1), entry(otherModel)], models);
		expect(totals.missedTokens).toBe(100_000);
		expect(totals.missCount).toBe(1);
	});

	it("skips providers that report no cache activity", () => {
		const a = assistant({ input: 100_000 });
		const b = assistant({ input: 110_000 });
		const totals = computeCacheWaste([entry(a), entry(b)], models);
		expect(totals.missedTokens).toBe(0);
	});
});

describe("collectCacheMisses", () => {
	it("maps counted misses to their assistant messages by reference", () => {
		const missTurn = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const misses = collectCacheMisses([entry(turn1), entry(turn2), entry(missTurn)], models);
		expect(misses.size).toBe(1);
		expect(misses.get(missTurn)?.missedTokens).toBe(105_000);
	});
});

describe("detectCacheMiss", () => {
	it("detects a miss on a just-completed message with idle time", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], missMessage, models);
		expect(miss).toBeDefined();
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.missedCost).toBeCloseTo(0.36225, 5);
		// 600s - 60s since the previous request
		expect(miss?.idleMs).toBe(540_000);
		expect(miss?.modelChanged).toBe(false);
	});

	it("flags model switches on detected misses", () => {
		const otherModel = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			model: "other-model",
			timestamp: 120_000,
		});
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], otherModel, models);
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.modelChanged).toBe(true);
	});

	it("uses only cache-warm usage entries as cache refreshes", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });

		const afterCacheWarm = detectCacheMiss([entry(turn1), usageEntry("cache_warm", 500_000)], missMessage, models);
		const afterOtherUsage = detectCacheMiss(
			[entry(turn1), usageEntry("custom_operation", 500_000)],
			missMessage,
			models,
		);

		expect(afterCacheWarm?.idleMs).toBe(100_000);
		expect(afterOtherUsage?.idleMs).toBe(600_000);
	});

	it("returns undefined for healthy turns", () => {
		const healthy = assistant({
			cacheRead: 105_000,
			cacheWrite: 2_000,
			cost: { cacheRead: 0.0315, cacheWrite: 0.0075 },
			timestamp: 120_000,
		});
		expect(detectCacheMiss([entry(turn1), entry(turn2)], healthy, models)).toBeUndefined();
	});

	it("returns undefined for the first turn of a session", () => {
		expect(detectCacheMiss([], turn1, models)).toBeUndefined();
	});
});

function withDiagnostics(message: AssistantMessage, details: JsonObject): AssistantMessage {
	return { ...message, diagnostics: [{ type: "provider_request", timestamp: message.timestamp, details }] };
}

const fullMiss = assistant({ input: 110_000, timestamp: 120_000 });

describe("incremental live cache comparisons", () => {
	it("reads only appended entries after initial hydration and matches replay", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(turn2);
		const reads = vi.spyOn(manager, "getBranch");
		for (let index = 0; index < 20; index++) {
			const message = assistant({ input: 30_000, cacheRead: 70_000, timestamp: 120_000 + index });
			const miss = detectLiveCacheMiss(manager, message, models);
			expect(miss?.missedTokens).toBe(30_000);
			expect(detectLiveCacheMiss(manager, message, models)).toEqual(miss);
			manager.appendMessage(message);
		}
		expect(reads).toHaveBeenCalledTimes(1);
		const message = assistant({ input: 100_000, model: "switched", timestamp: 120_100 });
		const live = detectLiveCacheMiss(manager, message, models);
		manager.appendMessage(message);
		expect(collectCacheMisses(manager.getEntries(), models).get(message)).toEqual(live);
		expect(live?.observedChanges).toEqual(["model changed"]);
		manager.newSession();
		expect(detectLiveCacheMiss(manager, message, models)).toBeUndefined();
	});

	it("compares with the active branch after navigation that appends nothing", () => {
		const manager = SessionManager.inMemory();
		const anchor = manager.appendMessage(turn2);
		manager.appendMessage({ ...fullMiss, model: "other-branch" });
		detectLiveCacheMiss(manager, { ...fullMiss }, models);
		manager.branch(anchor);
		const live = detectLiveCacheMiss(manager, fullMiss, models);
		expect(live).toMatchObject({ missedTokens: 105_000, observedChanges: ["unclassified"] });
		manager.appendMessage(fullMiss);
		expect(collectCacheMisses(manager.getBranch(), models).get(fullMiss)).toEqual(live);
	});

	it.each([0, 40_000])("ingests an aborted response with %s prompt tokens even when no live warning ran", (tokens) => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(turn2);
		detectLiveCacheMiss(manager, fullMiss, models);
		const aborted = assistant({ input: tokens, model: "aborted-model", timestamp: 90_000 });
		aborted.stopReason = "aborted";
		manager.appendMessage(aborted);
		const next = assistant({ input: 100_000, timestamp: 120_000 });
		const live = detectLiveCacheMiss(manager, next, models);
		expect(live?.missedTokens).toBe(tokens || 100_000);
		expect(live?.observedChanges).toEqual([tokens ? "model changed" : "unclassified"]);
		manager.appendMessage(next);
		expect(collectCacheMisses(manager.getEntries(), models).get(next)).toEqual(live);
	});
});

describe("observed cache changes", () => {
	it.each<[string, JsonObject, JsonObject]>([
		["service tier changed", { requestedServiceTier: "priority" }, { requestedServiceTier: "default" }],
		["service tier changed", { returnedServiceTier: "priority" }, { returnedServiceTier: "default" }],
		["tool definitions changed", { requestShape: { toolsBytes: 100 } }, { requestShape: { toolsBytes: 101 } }],
		[
			"tool definitions changed",
			{ requestShape: { toolsBytes: 100, toolDefinitionBytes: [40, 60] } },
			{ requestShape: { toolsBytes: 100, toolDefinitionBytes: [60, 40] } },
		],
		[
			"instructions changed",
			{ requestShape: { instructionsBytes: 100 } },
			{ requestShape: { instructionsBytes: 101 } },
		],
		["new connection", {}, { socketReused: false }],
		["full resend", { websocketRequestMode: "delta" }, { websocketRequestMode: "full" }],
		["unclassified", { websocketRequestMode: "full" }, { websocketRequestMode: "full" }],
		["unclassified", {}, { requestedServiceTier: "default", requestShape: { instructionsBytes: 100 } }],
		["unclassified", { requestedServiceTier: "unknown" }, { requestedServiceTier: "default" }],
	])("reports %s only from comparable evidence (%j → %j)", (label, before, after) => {
		expect(
			detectCacheMiss([entry(withDiagnostics(turn2, before))], withDiagnostics(fullMiss, after), models)
				?.observedChanges,
		).toEqual([label]);
	});

	it("keeps the warning deficit independent of an actual cached-read decline", () => {
		const previous = assistant({ input: 30_000, cacheRead: 70_000 });
		const current = assistant({ input: 40_000, cacheRead: 70_000 });
		expect(detectCacheMiss([entry(previous)], current, models)).toMatchObject({
			missedTokens: 30_000,
			cacheReadDecline: 0,
			observedChanges: ["unclassified"],
		});
		expect(detectCacheMiss([entry(turn2)], fullMiss, models)).toMatchObject({
			missedTokens: 105_000,
			cacheReadDecline: 100_000,
		});
	});

	it("measures idle from the previous completion, respects known lifetimes, and resets after warming", () => {
		const previous = { ...entry(turn2), timestamp: new Date(300_000).toISOString() };
		const next = assistant({ input: 110_000, timestamp: 660_000 });
		expect(detectCacheMiss([previous], next, models)?.observedChanges).toEqual(["idle 6m"]);
		const longerLifetime: ModelPriceSource = {
			getModel: () => ({ cost: { cacheRead: 0.3 }, promptCache: { short: 600, long: 600 } }),
		};
		expect(detectCacheMiss([previous], next, longerLifetime)?.observedChanges).toEqual(["unclassified"]);
		expect(detectCacheMiss([previous, usageEntry("cache_warm", 600_000)], next, models)?.observedChanges).toEqual([
			"unclassified",
		]);
		const longResponse = { ...previous, timestamp: new Date(600_000).toISOString() };
		expect(detectCacheMiss([longResponse], next, models)?.observedChanges).toEqual(["unclassified"]);
		const measured = { ...longResponse, message: withDiagnostics(turn2, { terminalEventMs: 240_000 }) };
		expect(detectCacheMiss([measured], next, models)?.observedChanges).toEqual(["idle 6m"]);
	});

	it("escapes provider control characters instead of sending them to the terminal", () => {
		const current = {
			...fullMiss,
			diagnostics: [
				{
					type: "anthropic_input_transformations",
					timestamp: 1,
					details: { transformations: [{ type: "thinking_dropped", reason: "bad\u001b[2J\nreason" }] },
				},
			],
		};
		expect(detectCacheMiss([entry(turn2)], current, models)?.providerReasons).toEqual([
			"dropped 1 thinking block (bad\\u001b[2J\\u000areason)",
		]);
	});

	it.each<[JsonObject, string[]]>([
		[{ type: "unavailable" }, []],
		[{ type: "unavailable", reason: "input_changed" }, []],
		[{ type: "cache_miss", reason: "tools_changed" }, ["tools changed"]],
		[{ type: "cache_miss", reason: "future_reason" }, ["future_reason"]],
		[{ type: "cache_hit" }, ["cache hit"]],
		[{ type: "comparison_response_not_found" }, ["comparison response not found"]],
		[{ type: "cache_miss", reason: { unexpected: true } }, ["cache miss"]],
	])("formats provider diagnostic %j without dumping JSON", (diagnostics, expected) => {
		const current = withDiagnostics(fullMiss, { prompt_cache_diagnostics: diagnostics });
		expect(detectCacheMiss([entry(turn2)], current, models)?.providerReasons).toEqual(expected);
	});

	it("groups transformations by both type and reason across diagnostic entries", () => {
		const current = {
			...fullMiss,
			diagnostics: [
				{
					type: "anthropic_input_transformations",
					timestamp: 1,
					details: {
						transformations: [
							{ type: "thinking_dropped", reason: "prefix_binding_mismatch" },
							{ type: "thinking_dropped", reason: "model_binding_mismatch" },
							{ type: "future_transformation", reason: "future_reason" },
						],
					},
				},
				{
					type: "anthropic_input_transformations",
					timestamp: 2,
					details: { transformations: [{ type: "thinking_dropped", reason: "prefix_binding_mismatch" }] },
				},
			],
		};
		expect(detectCacheMiss([entry(turn2)], current, models)?.providerReasons).toEqual([
			"dropped 2 thinking blocks (prefix binding mismatch)",
			"dropped 1 thinking block (model binding mismatch)",
			"future_transformation (1) (future_reason)",
		]);
	});

	it("preserves provider reasons and all concurrent observations in session totals", () => {
		const previous = withDiagnostics(turn2, { requestedServiceTier: "priority", websocketRequestMode: "delta" });
		const current = withDiagnostics(fullMiss, {
			requestedServiceTier: "default",
			websocketRequestMode: "full",
			socketReused: false,
			prompt_cache_diagnostics: { type: "cache_miss", reason: "input_changed" },
		});
		current.diagnostics!.push({
			type: "anthropic_input_transformations",
			timestamp: 1,
			details: { transformations: [{ type: "thinking_dropped", reason: "prefix_binding_mismatch" }] },
		});
		const miss = detectCacheMiss([entry(previous)], current, models);
		expect(miss?.observedChanges).toEqual(["service tier changed", "new connection", "full resend"]);
		expect(miss?.providerReasons).toEqual(["input changed", "dropped 1 thinking block (prefix binding mismatch)"]);
		const totals = computeCacheWaste([entry(previous), entry(current)], models);
		expect([...totals.observedChanges]).toEqual([
			["service tier changed", 1],
			["new connection", 1],
			["full resend", 1],
		]);
		expect([...totals.providerReasons.keys()]).toEqual(miss?.providerReasons);
	});
});
