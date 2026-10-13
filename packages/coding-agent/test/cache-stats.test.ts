import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
	type ModelPriceSource,
} from "../src/core/cache-stats.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const models: ModelPriceSource = { getModel: () => ({ cost: { cacheRead: 0.3 } }) };

function assistant(options: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: Partial<typeof zeroCost>;
	provider?: string;
	model?: string;
	responseModel?: string;
	timestamp?: number;
}): AssistantMessage {
	const input = options.input ?? 0;
	const cacheRead = options.cacheRead ?? 0;
	const cacheWrite = options.cacheWrite ?? 0;
	const cost = { ...zeroCost, ...options.cost };
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: options.provider ?? "test",
		model: options.model ?? "test-model",
		responseModel: options.responseModel,
		usage: { input, output: 10, cacheRead, cacheWrite, totalTokens: input + 10 + cacheRead + cacheWrite, cost },
		stopReason: "stop",
		timestamp: options.timestamp ?? 0,
	};
}

function session(...messages: AssistantMessage[]): SessionManager {
	const manager = SessionManager.inMemory();
	for (const message of messages) manager.appendMessage(message);
	return manager;
}

// Fresh 100k cache write at $3.75/M, then healthy reads at $0.30/M.
const turn1 = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, timestamp: 0 });
const turn2 = assistant({
	cacheRead: 100_000,
	cacheWrite: 5_000,
	cost: { cacheRead: 0.03, cacheWrite: 0.019 },
	timestamp: 60_000,
});

describe("computeCacheWaste", () => {
	it("accumulates overlap and cost estimates across turns", () => {
		const turn3 = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const totals = computeCacheWaste(session(turn1, turn2, turn3).getEntries(), models);
		expect(totals.missedTokens).toBe(105_000);
		// Hypothetical 105k reads instead of writes: 105k * ($3.75 - $0.30)/M.
		expect(totals.missedCost).toBeCloseTo(0.36225, 5);
		expect(totals.catalogPriceCount).toBe(0);
		expect(totals.ancestorPriceCount).toBe(1);
	});

	it("counts nothing for healthy sessions", () => {
		const totals = computeCacheWaste(session(turn1, turn2).getEntries(), models);
		expect(totals.missedTokens).toBe(0);
		expect(totals.missedCost).toBe(0);
	});

	it.each(["compaction", "branch_summary"] as const)("skips the turn after a %s reset", (kind) => {
		const manager = session(turn1);
		if (kind === "compaction") manager.appendCompaction("summary", null, 100_000);
		else manager.branchWithSummary(manager.getLeafId(), "summary");
		manager.appendMessage(assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } }));
		expect(computeCacheWaste(manager.getEntries(), models).missedTokens).toBe(0);
	});

	it.each([{ model: "other-model" }, { provider: "other-provider" }])(
		"retains expected same-branch transitions: %j",
		(route) => {
			const otherModel = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, ...route });
			const totals = computeCacheWaste(session(turn1, otherModel).getEntries(), models);
			expect(totals.missedTokens).toBe(100_000);
			expect(totals.missCount).toBe(1);
			expect(totals.modelSwitchCount).toBe(1);
		},
	);

	it("skips providers that report no cache activity", () => {
		const manager = session(assistant({ input: 100_000 }), assistant({ input: 110_000 }));
		expect(computeCacheWaste(manager.getEntries(), models).missedTokens).toBe(0);
	});

	it("compares historical notices and totals with each request's native ancestry", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 0 });
		manager.appendMessage(turn1);
		const abandonedMiss = assistant({ cacheWrite: 110_000 });
		manager.appendMessage(abandonedMiss);
		manager.branch(root);
		const freshRoute = assistant({ provider: "gateway", cacheWrite: 25_854 });
		// This matches the Tars rewind: no assistant ancestor, despite paid abandoned work.
		expect(detectCacheMiss(manager.getBranch(), freshRoute, models)).toBeUndefined();
		manager.appendMessage(freshRoute);
		const gatewayMiss = assistant({ provider: "gateway", cacheWrite: 30_239 });
		manager.appendMessage(gatewayMiss);

		const notices = collectCacheMisses(manager.getEntries(), models);
		expect([...notices.keys()]).toEqual([abandonedMiss, gatewayMiss]);
		expect(notices.get(gatewayMiss)?.missedTokens).toBe(25_854);
		const totals = computeCacheWaste(manager.getEntries(), models);
		expect(totals.missedTokens).toBe(125_854); // 100k on the old branch + 25,854 on the new one.
		expect(totals.missCount).toBe(2);
		expect(totals.modelSwitchCount).toBe(0);
	});

	it("does not inherit abandoned growth or resets when continuing a common ancestor", () => {
		const manager = session(assistant({ cacheWrite: 30_000 }));
		const common = manager.getLeafId()!;
		manager.appendCompaction("abandoned summary", null, 30_000);
		manager.appendMessage(assistant({ cacheWrite: 100_000 }));
		manager.branch(common);
		manager.appendCustomEntry("branch metadata", {});
		const continuation = assistant({ cacheRead: 30_000, cacheWrite: 5_000 });
		expect(detectCacheMiss(manager.getBranch(), continuation, models)).toBeUndefined();
		manager.appendMessage(continuation);
		expect(collectCacheMisses(manager.getEntries(), models).size).toBe(0);
		expect(computeCacheWaste(manager.getEntries(), models).missCount).toBe(0);
	});
});

describe("collectCacheMisses", () => {
	it("maps estimates to their assistant messages by reference", () => {
		const missTurn = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const misses = collectCacheMisses(session(turn1, turn2, missTurn).getEntries(), models);
		expect(misses.size).toBe(1);
		expect(misses.get(missTurn)?.missedTokens).toBe(105_000);
	});
});

describe("detectCacheMiss", () => {
	it("reports a request-start gap, not an observed idle period", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });
		const miss = detectCacheMiss(session(turn1, turn2).getBranch(), missMessage, models);
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.missedCost).toBeCloseTo(0.36225, 5);
		expect(miss?.idleMs).toBe(540_000);
		expect(miss?.modelChanged).toBe(false);
	});

	it("does not reuse a previous route's observed price for a same-branch switch", () => {
		const otherModel = assistant({ cacheWrite: 110_000, model: "other-model", timestamp: 120_000 });
		const miss = detectCacheMiss(session(turn1, turn2).getBranch(), otherModel, models);
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.modelChanged).toBe(true);
		expect(miss?.readPriceSource).toBe("catalog");
	});

	it("uses an observed same-route read rate instead of a mismatched catalog fallback", () => {
		const healthy = assistant({ cacheRead: 100_000, cost: { cacheRead: 0.04 } });
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 1.65 } });
		const catalog: ModelPriceSource = { getModel: () => ({ cost: { cacheRead: 0.2 } }) };
		const miss = detectCacheMiss(session(healthy).getBranch(), missMessage, catalog);
		// 100k * ($15 - $0.4)/M, independently derived from the recorded tariff.
		expect(miss?.missedCost).toBeCloseTo(1.46, 8);
		expect(miss?.readPriceSource).toBe("ancestor");
	});

	it("uses the current partial-read price rather than an older observed rate", () => {
		const partial = assistant({
			cacheRead: 40_000,
			cacheWrite: 60_000,
			cost: { cacheRead: 0.024, cacheWrite: 0.225 },
		});
		const miss = detectCacheMiss(session(turn1, turn2).getBranch(), partial, models);
		expect(miss?.missedTokens).toBe(60_000);
		// 60k * ($3.75 - $0.60)/M.
		expect(miss?.missedCost).toBeCloseTo(0.189, 8);
		expect(miss?.readPriceSource).toBe("usage");
	});

	it("identifies current catalog estimates and unknown read prices without inventing a zero tariff", () => {
		const manager = session(turn1);
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 } });
		const catalogMiss = detectCacheMiss(manager.getBranch(), missMessage, models);
		expect(catalogMiss?.missedCost).toBeCloseTo(0.345, 8); // 100k * ($3.75 - $0.30)/M.
		expect(catalogMiss?.readPriceSource).toBe("catalog");
		const unknown: ModelPriceSource = { getModel: () => undefined };
		const unpriced = detectCacheMiss(manager.getBranch(), missMessage, unknown);
		expect(unpriced?.missedTokens).toBe(100_000);
		expect(unpriced?.readPriceSource).toBe("unknown");
		expect(unpriced?.missedCost).toBe(0);
		manager.appendMessage(missMessage);
		expect(computeCacheWaste(manager.getEntries(), unknown).unpricedMissCount).toBe(1);
	});

	it("tracks concrete response models for routed requests", () => {
		const a = assistant({ model: "auto", responseModel: "route-a", cacheRead: 100_000, cost: { cacheRead: 0.04 } });
		const b = assistant({ model: "auto", responseModel: "route-b", cacheWrite: 110_000 });
		const catalog: ModelPriceSource = {
			getModel: (_provider, model) => (model === "route-b" ? { cost: { cacheRead: 0.6 } } : undefined),
		};
		const miss = detectCacheMiss(session(a).getBranch(), b, catalog);
		expect(miss?.modelChanged).toBe(true);
		expect(miss?.readPriceSource).toBe("catalog");
	});

	it("uses only same-branch cache-warm usage entries as cache refreshes", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(500_000);
			const manager = session(turn1);
			const parent = manager.getLeafId()!;
			manager.appendUsage("cache_warm", "test", "test-model", turn2.usage);
			const missMessage = assistant({ cacheWrite: 110_000, timestamp: 600_000 });
			expect(detectCacheMiss(manager.getBranch(), missMessage, models)?.idleMs).toBe(100_000);
			manager.branch(parent);
			manager.appendUsage("custom_operation", "test", "test-model", turn2.usage);
			expect(detectCacheMiss(manager.getBranch(), missMessage, models)?.idleMs).toBe(600_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("detects total misses on cache-read-only providers after observed cache activity", () => {
		const previous = assistant({ cacheRead: 100_000, cost: { cacheRead: 0.03 } });
		const miss = detectCacheMiss(session(previous).getBranch(), assistant({ input: 110_000 }), models);
		expect(miss?.missedTokens).toBe(100_000);
	});

	it("returns undefined for healthy turns and first requests", () => {
		const healthy = assistant({ cacheRead: 105_000, cacheWrite: 2_000 });
		expect(detectCacheMiss(session(turn1, turn2).getBranch(), healthy, models)).toBeUndefined();
		expect(detectCacheMiss([], turn1, models)).toBeUndefined();
	});
});
