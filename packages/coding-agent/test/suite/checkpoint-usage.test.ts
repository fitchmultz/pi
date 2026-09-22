import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type AssistantMessage, fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { collectCacheMisses, computeCacheWaste } from "../../src/core/cache-stats.ts";
import { CacheWarmer } from "../../src/core/cache-warmer.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness } from "./harness.ts";

it("keeps completed-response billing and cache statistics unchanged by late execution snapshots", async () => {
	const harness = await createHarness({ tools: [] });
	vi.useFakeTimers();
	const model = {
		...harness.getModel(),
		cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 },
		promptCache: { short: 300 },
	};
	const manager = harness.sessionManager;
	const first: AssistantMessage = {
		...fauxAssistantMessage([{ type: "toolCall", id: "work", name: "work", arguments: {} }]),
		api: model.api,
		responseId: "first",
		usage: {
			input: 10_000,
			output: 100,
			cacheRead: 90_000,
			cacheWrite: 0,
			totalTokens: 100_100,
			cost: { input: 0.01, output: 0.001, cacheRead: 0.009, cacheWrite: 0, total: 0.02 },
		},
	};
	const second: AssistantMessage = {
		...fauxAssistantMessage("independent answer"),
		api: model.api,
		responseId: "second",
		usage: {
			input: 200_000,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 200_200,
			cost: { input: 0.2, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.202 },
		},
	};
	const streamSimple = vi.fn(() => {
		throw new Error("A statistics read must not make a provider request");
	});
	const warmer = new CacheWarmer({ streamSimple }, manager, () => "idle");
	try {
		manager.appendMessage(first);
		manager.appendMessage(second);
		harness.session.agent.state.messages = manager.buildSessionContext().messages;
		initTheme("dark", false);
		const footer = new FooterComponent(harness.session, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		});
		const footerBefore = footer.render(200).map(stripAnsi);
		warmer.start(
			{ model, context: normalizeContext({ messages: [] }), options: { cacheRetention: "short" } },
			() => true,
		);
		const warmingBefore = warmer.status.decision;
		const prices = { getModel: () => model };
		const cacheBefore = computeCacheWaste(manager.getEntries(), prices);
		expect(cacheBefore).toMatchObject({ missedTokens: 100_000, missCount: 1 });
		expect(warmingBefore?.economicsAvailable).toBe(true);

		// A delayed detach/resume snapshots the first response after the second has completed.
		manager.appendMessage(structuredClone(first), true);
		const entries = manager.getEntries();
		expect(entries.at(-1)).toMatchObject({ checkpoint: true, message: { usage: first.usage } });
		expect.soft(harness.session.getSessionStats()).toMatchObject({
			assistantMessages: 2,
			totalMessages: 2,
			toolCalls: 1,
			tokens: { input: 210_000, output: 300, cacheRead: 90_000, cacheWrite: 0, total: 300_300 },
		});
		expect.soft(harness.session.getSessionStats().cost).toBeCloseTo(0.222);
		expect.soft(getUsageCostBreakdown(entries)).toMatchObject([{ tokens: 300_300 }]);
		expect.soft(getUsageCostBreakdown(entries)[0].cost).toBeCloseTo(0.222);
		expect.soft(computeCacheWaste(entries, prices)).toEqual(cacheBefore);
		expect.soft([...collectCacheMisses(entries, prices).keys()]).toEqual([second]);
		expect.soft(warmer.status.decision).toEqual(warmingBefore);
		expect.soft(footer.render(200).map(stripAnsi)).toEqual(footerBefore);

		const template = readFileSync(new URL("../../src/core/export-html/template.js", import.meta.url), "utf8");
		const statsSource = template.slice(
			template.indexOf("function computeStats("),
			template.indexOf("const globalStats ="),
		);
		const exportedStats: unknown = runInNewContext(`${statsSource}\ncomputeStats(entries)`, { entries });
		expect.soft(exportedStats).toMatchObject({
			assistantMessages: 2,
			toolCalls: 1,
			tokens: { input: 210_000, output: 300, cacheRead: 90_000, cacheWrite: 0 },
		});
		expect(streamSimple).not.toHaveBeenCalled();
	} finally {
		warmer.cancel();
		vi.useRealTimers();
		harness.cleanup();
	}
});
