import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession context usage estimate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["root", "window", "compaction", "response"])(
		"avoids historical arrays when checking current usage after %s",
		async (boundary) => {
			const harness = await createHarness({ tools: [] });
			harnesses.push(harness);
			const sm = harness.sessionManager;
			for (let i = 0; i < 100; i++) sm.appendCustomEntry("old", i);
			const kept = sm.appendMessage({ ...fauxAssistantMessage("old"), usage: usage(60_000) });
			if (boundary !== "root") sm.appendCompaction("summary", kept, 60_000);
			if (boundary === "window") sm.appendContextWindow("fresh", 60_000);
			if (boundary === "response") sm.appendMessage({ ...fauxAssistantMessage("new"), usage: usage(1234) });
			sm.appendCustomEntry("metadata");
			harness.session.agent.state.messages = sm.buildSessionContext().messages;
			const scans = [vi.spyOn(sm, "getEntries"), vi.spyOn(sm, "getBranch"), vi.spyOn(sm, "buildContextEntries")];
			const parents = vi.spyOn(sm, "getEntry");
			const state = harness.session.agent.state;
			const options = { model: harness.getModel(), systemPrompt: state.systemPrompt, tools: state.tools };
			const expected =
				boundary === "compaction"
					? null
					: Math.max(
							estimateContextTokens(state.messages, options).tokens,
							estimateContextTokens(state.messages, { ...options, useReportedUsage: false }).tokens,
						);
			for (let i = 0; i < 3; i++) expect(harness.session.getContextUsage()?.tokens).toBe(expected);
			for (const scan of scans) expect(scan).not.toHaveBeenCalled();
			expect(parents.mock.calls.length).toBeLessThanOrEqual(6);
		},
	);

	it("keeps retained usage unknown until a valid matching-model response follows the latest active compaction", async () => {
		const harness = await createHarness({ tools: [], models: [{ id: "faux-1" }, { id: "other" }] });
		harnesses.push(harness);
		const sm = harness.sessionManager;
		const old = { ...fauxAssistantMessage("retained"), usage: usage(60_000) };
		const kept = sm.appendMessage(old);
		const compaction = sm.appendCompaction("summary", kept, 60_000);
		const sync = () => {
			harness.session.agent.state.messages = sm.buildSessionContext().messages;
		};
		sync();
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(harness.session.messages).toContain(old);
		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		for (const message of [
			{ ...fauxAssistantMessage("error", { stopReason: "error" }), usage: usage(1000) },
			{ ...fauxAssistantMessage("aborted", { stopReason: "aborted" }), usage: usage(1000) },
			{ ...fauxAssistantMessage("zero"), usage: usage(0) },
			{ ...fauxAssistantMessage("other model"), model: "other", usage: usage(1000) },
			{ ...fauxAssistantMessage("other provider"), provider: "other", usage: usage(1000) },
		]) {
			sm.appendMessage(message);
			sync();
			expect(harness.session.getContextUsage()).toMatchObject({ tokens: null, percent: null });
		}
		const valid = sm.appendMessage({ ...fauxAssistantMessage("valid"), usage: usage(1234) });
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBe(1234);
		sm.appendMessage({ ...fauxAssistantMessage("zero"), usage: usage(0) });
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThanOrEqual(1234);
		await harness.session.setModel(harness.getModel("other")!);
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThanOrEqual(1000);
		sm.branch(compaction);
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		sm.branch(valid);
		sm.appendCompaction("second summary", kept, 1234);
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		sm.appendContextWindow(undefined, 1234);
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(0);
		sm.resetLeaf();
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(0);
	});

	it("counts the system prompt and tool definitions before the model reports usage", async () => {
		const tool: AgentTool = {
			name: "lookup",
			label: "Lookup",
			description: "d".repeat(400),
			parameters: Type.Object({ query: Type.String({ description: "q".repeat(400) }) }),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		const systemPromptChars = harness.session.agent.state.systemPrompt.length;
		expect(systemPromptChars).toBeGreaterThan(1000);
		const before = harness.session.getContextUsage();
		// System prompt plus at least the 800 padded description characters of the tool schema.
		expect(before?.tokens).toBeGreaterThanOrEqual(Math.ceil(systemPromptChars / 4) + 200);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hi");

		const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		expect(reported).toBeGreaterThan(0);
		expect(harness.session.getContextUsage()?.tokens).toBe(reported);
	});

	it("does not reuse usage or trigger rollover from a different model after a model switch", async () => {
		const autoCompactionReasons: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "big", contextWindow: 128_000 },
				{ id: "small", contextWindow: 64_000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_auto_compact", (event) => {
						autoCompactionReasons.push(event.reason);
						return { newContext: { handoff: "unexpected rollover" } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hi");
		(harness.session.messages.at(-1) as AssistantMessage).usage = usage(60_000);
		expect(harness.session.getContextUsage()).toMatchObject({ tokens: 60_000, contextWindow: 128_000 });

		await harness.session.setModel(harness.getModel("small")!);

		const switched = harness.session.getContextUsage();
		expect(switched?.contextWindow).toBe(64_000);
		expect(switched?.tokens).toBeGreaterThan(0);
		expect(switched?.tokens).toBeLessThan(60_000);

		harness.setResponses([fauxAssistantMessage("small ok")]);
		await harness.session.prompt("again");

		expect(autoCompactionReasons).toEqual([]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
		const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		expect(harness.session.getContextUsage()?.tokens).toBe(reported);
	});
});
