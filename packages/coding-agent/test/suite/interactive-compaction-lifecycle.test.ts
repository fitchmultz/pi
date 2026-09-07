import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { estimateContextTokens, prepareCompaction } from "../../src/core/compaction/index.ts";
import type { StatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

type CompactionView = {
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	clearStatusIndicator(): void;
	defaultEditor: { onSubmit: (text: string) => Promise<void>; onEscape: () => void };
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	activeStatusIndicator: StatusIndicator | undefined;
	showError: ReturnType<typeof vi.fn>;
};

function createCompactionView(harness: Harness) {
	initTheme("dark");
	// Run native Enter, Escape, queue, and event handling without a terminal or transcript rendering.
	const view = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		isInitialized: true,
		defaultEditor: { onAction() {} },
		editor: { addToHistory() {}, setText() {}, getText: () => "" },
		compactionQueuedMessages: [],
		chatContainer: new Container(),
		footer: { invalidate() {} },
		ui: { requestRender() {}, terminal: { setProgress() {} } },
		activeStatusIndicator: undefined as StatusIndicator | undefined,
		showStatusIndicator(indicator: StatusIndicator) {
			this.activeStatusIndicator?.dispose();
			this.activeStatusIndicator = indicator;
		},
		clearStatusIndicator() {
			this.activeStatusIndicator?.dispose();
			this.activeStatusIndicator = undefined;
		},
		updatePendingMessagesDisplay() {},
		renderSessionEntries() {},
		addMessageToChat() {},
		addCompactionCostNotice() {},
		showStatus: vi.fn(),
		showError: vi.fn(),
	}) as CompactionView;
	view.setupKeyHandlers();
	view.setupEditorSubmitHandler();
	const events: Promise<void>[] = [];
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "compaction_start" || event.type === "compaction_end" || event.type === "agent_settled") {
			events.push(view.handleEvent(event));
		}
	});
	onTestFinished(() => {
		unsubscribe();
		view.clearStatusIndicator();
	});
	return { view, events };
}

describe("early compaction lifecycle", () => {
	it.each([
		{ input: "system prefix", cancel: false },
		{ input: "user history", cancel: false },
		{ input: "system prefix", cancel: true },
	])("delivers accepted input once ($input, cancel=$cancel)", async ({ input, cancel }) => {
		const prefixOnly = input === "system prefix";
		let markHookStarted!: () => void;
		const hookStarted = new Promise<void>((resolve) => {
			markHookStarted = resolve;
		});
		let releaseHook!: () => void;
		const hookReleased = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const queuedText = "UI queued follow-up";
		const canSummarize: boolean[] = [];
		let hookSignal: AbortSignal | undefined;
		let deliveries = 0;
		const harness = await createHarness({
			tools: [],
			models: [{ id: "small", contextWindow: 64_000, maxTokens: 2048 }],
			settings: { compaction: { reserveTokens: 16_000, keepRecentTokens: 20_000 }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (prefixOnly && event.prompt === "finish the current task")
							return { systemPrompt: "p".repeat(200_000) };
					});
					pi.on("session_before_auto_compact", async (event, ctx) => {
						canSummarize.push(prepareCompaction(event.branchEntries, ctx.getCompactionSettings()) !== undefined);
						if (canSummarize.length === 1) {
							if (cancel) ctx.newContext({ handoff: "must not survive cancellation" });
							hookSignal = event.signal;
							markHookStarted();
							await hookReleased;
						}
					});
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		const { view, events } = createCompactionView(harness);
		harness.setResponses(
			["seeded", "current finished", "summary", "queued finished"].map((response) => (context) => {
				deliveries += context.messages.filter((message) => getMessageText(message) === queuedText).length;
				return fauxAssistantMessage(response);
			}),
		);
		await harness.session.prompt(prefixOnly ? "seed" : "s".repeat(20_000));
		expect(canSummarize).toEqual([]);

		const run = harness.session.prompt(prefixOnly ? "finish the current task" : "x".repeat(200_000));
		let phase: string | undefined;
		try {
			await hookStarted;
			expect(canSummarize).toEqual([false]);
			expect(harness.session.isCompacting).toBe(true);
			const tokens = estimateContextTokens(harness.session.messages, {
				systemPrompt: harness.session.systemPrompt,
				tools: harness.session.agent.state.tools,
				useReportedUsage: false,
			}).tokens;
			expect(tokens).toBeGreaterThan(48_000);
			expect(tokens).toBeLessThan(64_000);
			if (prefixOnly) expect(tokens).toBe(50_009);

			await view.defaultEditor.onSubmit(queuedText);
			expect(view.compactionQueuedMessages).toEqual([{ text: queuedText, mode: "steer" }]);
			phase = view.activeStatusIndicator?.kind;
			if (cancel) {
				view.defaultEditor.onEscape();
				expect(hookSignal?.aborted).toBe(true);
				expect(harness.session.agent.signal?.aborted).toBe(false);
			}
		} finally {
			releaseHook();
			await run;
			await Promise.all(events);
		}

		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
		expect(view.compactionQueuedMessages).toEqual([]);
		expect(deliveries).toBe(1);
		expect(view.showError).not.toHaveBeenCalled();
		expect(phase).toBe("compaction");
		expect(harness.session.isIdle).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && getMessageText(entry.message) === queuedText),
		).toHaveLength(1);
		const completions = harness.eventsOfType("compaction_end");
		expect(completions).toHaveLength(harness.eventsOfType("compaction_start").length);
		expect(completions.every((event) => !event.errorMessage && !event.contextWindowStarted)).toBe(true);
		if (prefixOnly) {
			expect(canSummarize.length).toBeGreaterThanOrEqual(2);
			expect(canSummarize.every((value) => !value)).toBe(true);
			expect(completions.every((event) => event.result === undefined)).toBe(true);
			expect(completions.some((event) => event.aborted)).toBe(cancel);
			expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		} else {
			expect(canSummarize).toContain(true);
			expect(completions.filter((event) => event.result)).toEqual([
				expect.objectContaining({
					result: expect.objectContaining({ summary: expect.stringContaining("summary") }),
					aborted: false,
				}),
			]);
		}
	});
});
