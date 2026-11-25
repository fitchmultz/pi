import { describe, expect, it } from "vitest";
import {
	evaluateCacheWarming,
	GOOGLE_IMPLICIT_CACHE_UNCACHED_TAIL_TOKENS,
	getCacheWarmingMaxIdleAgeMs,
	getEffectiveCacheRetention,
	isCacheWarmingReplayable,
	shouldStopAfterColdCacheWarm,
} from "../src/cache-warming.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

const neon = getBuiltinModel("google", "gemini-4-neon");

describe("Google implicit cache warming policy", () => {
	it.each(["google-generative-ai", "google-vertex"] as const)(
		"uses the short cache and applies the idle and miss limits for %s",
		(api) => {
			const model: Model<Api> = { ...neon, api };
			expect(getEffectiveCacheRetention(model, { cacheRetention: "long" })).toBe("short");
			expect(getEffectiveCacheRetention(model, { cacheRetention: "none" })).toBe("none");
			expect(isCacheWarmingReplayable(model, { reasoning: "xhigh" })).toBe(true);
			expect(getCacheWarmingMaxIdleAgeMs(model)).toBe(600_000);
			expect(shouldStopAfterColdCacheWarm(model, 4_095, { cacheRead: 0 })).toBe(false);
			expect(shouldStopAfterColdCacheWarm(model, 4_096, { cacheRead: 0 })).toBe(true);
			expect(shouldStopAfterColdCacheWarm(model, 60_000, { cacheRead: 57_950 })).toBe(false);
		},
	);

	it("keeps the original idle limit and miss behavior for Anthropic and OpenAI", () => {
		for (const model of [getBuiltinModel("anthropic", "claude-opus-4-6"), getBuiltinModel("openai", "gpt-5")]) {
			expect(getCacheWarmingMaxIdleAgeMs(model)).toBe(1_800_000);
			expect(shouldStopAfterColdCacheWarm(model, 60_000, { cacheRead: 0 })).toBe(false);
		}
	});

	it("prices Neon's 2,050-token uncached tail at the full input rate", () => {
		expect(GOOGLE_IMPLICIT_CACHE_UNCACHED_TAIL_TOKENS).toBe(2_050);
		expect(evaluateCacheWarming(neon, 2_050, "streaming")).toMatchObject({ missCost: 0, action: "stop" });

		const decision = evaluateCacheWarming(neon, 100_000, "streaming");
		// 97,950 cached @ $0.15/M + 2,050 tail @ $3/M + 1 output @ $15/M.
		expect(decision.warmCost).toBeCloseTo((97_950 * 0.15 + 2_050 * 3 + 15) / 1_000_000, 9);
		expect(decision.missCost).toBeCloseTo((97_950 * (3 - 0.15)) / 1_000_000, 9);
		expect(decision.action).toBe("warm");
		expect(evaluateCacheWarming(neon, 46_000, "idle")).toMatchObject({
			continuationProbability: 0.5,
			action: "stop",
		});
		expect(evaluateCacheWarming(neon, 47_000, "idle").action).toBe("warm");
	});
});
