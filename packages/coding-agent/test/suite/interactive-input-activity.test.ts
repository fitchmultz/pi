import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { createInteractiveTui, InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

type InputView = {
	renderer: ReturnType<typeof createInteractiveTui>;
	isInitialized: boolean;
	defaultEditor: CustomEditor;
	setupEditorSubmitHandler(): void;
	setupKeyHandlers(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	handleDequeue(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
};

async function createInputView(harness: Harness) {
	initTheme("dark");
	const mode = new InteractiveMode({
		session: harness.session,
		setBeforeSessionInvalidate() {},
		setRebindSession() {},
	} as unknown as AgentSessionRuntime);
	const view = mode as unknown as InputView;
	// Keep native input/queue/context bindings; only replace the physical terminal.
	view.renderer = createInteractiveTui({
		tuiMode: "regular",
		terminal: new VirtualTerminal(120, 40),
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
	});
	view.isInitialized = true;
	view.setupKeyHandlers();
	view.setupEditorSubmitHandler();
	await view.bindCurrentSessionExtensions();
	view.renderer.start();
	onTestFinished(() => mode.stop("resume-hint"));
	return { mode, view, ctx: harness.session.extensionRunner.createContext() };
}

describe("native pending input visibility", () => {
	it("reports TUI input waiting for the native prompt loop", async () => {
		const harness = await createHarness({ tools: [] });
		onTestFinished(() => harness.cleanup());
		const { mode, view, ctx } = await createInputView(harness);
		await view.defaultEditor.onSubmit?.("submitted before the prompt loop waits");
		expect(ctx.isIdle()).toBe(true);
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(ctx.getPendingInputCount()).toBe(1);
		expect(await mode.getUserInput()).toBe("submitted before the prompt loop waits");
		expect(ctx.getPendingInputCount()).toBe(0);
	});

	it.each([false, true])("cancels TUI prompt preparation and recovers queued input (queued: %s)", async (queued) => {
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						markEntered();
						await released;
					});
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		const { view, ctx } = await createInputView(harness);
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "retained aside", display: false },
			{ deliverAs: "nextTurn" },
		);
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);
		const run = Promise.allSettled([
			queued
				? harness.session.prompt("cancelled prompt")
				: harness.session.sendCustomMessage(
						{ customType: "wakeup", content: "cancelled wakeup", display: false },
						{ triggerTurn: true },
					),
		]);
		try {
			await entered;
			expect(ctx.isIdle()).toBe(false);
			expect(ctx.signal).toBeUndefined();
			if (queued) {
				await harness.session.followUp("recover queued input");
				view.defaultEditor.onEscape?.();
			} else {
				ctx.abort();
			}
			release();
			const result = await run;
			await harness.session.waitForIdle();
			expect(harness.faux.state.callCount).toBe(0);
			expect(result).toEqual([{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]);
			expect(ctx.isIdle()).toBe(true);
			expect(ctx.hasPendingMessages()).toBe(false);
			expect(ctx.getPendingInputCount()).toBe(0);
			expect(ctx.getPendingNextTurnCount()).toBe(1);
			expect(ctx.ui.getEditorText()).toBe(queued ? "recover queued input" : "");
		} finally {
			release();
			await run;
		}
	});

	it.each([true, false])(
		"counts the compaction-queue handler and restores failed input (retry: %s)",
		async (willRetry) => {
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let markEntered!: () => void;
			const entered = new Promise<void>((resolve) => {
				markEntered = resolve;
			});
			const inputs: string[] = [];
			const harness = await createHarness({
				tools: [],
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							inputs.push(event.text);
							if (event.text !== "held input") return;
							markEntered();
							await released;
							return { action: "transform", text: "transformed input" };
						});
					},
				],
			});
			onTestFinished(() => harness.cleanup());
			harness.setResponses([fauxAssistantMessage("done")]);
			const settled = new Promise<void>((resolve) => {
				harness.session.subscribe((event) => {
					if (event.type === "agent_settled") resolve();
				});
			});
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "queue_update" && event.followUp.includes("transformed input")) {
					unsubscribe();
					throw new Error("queue observer failed");
				}
			});
			const { view, ctx } = await createInputView(harness);
			if (!willRetry) view.queueCompactionMessage("first prompt", "steer");
			view.queueCompactionMessage("held input", "followUp");
			const flush = view.flushCompactionQueue({ willRetry });
			try {
				await entered;
				if (!willRetry) await settled;
				expect(ctx.isIdle()).toBe(true);
				expect(ctx.hasPendingMessages()).toBe(false);
				expect(ctx.getPendingInputCount()).toBe(1);
				release();
				await flush;
				expect(ctx.hasPendingMessages()).toBe(false);
				expect(ctx.getPendingInputCount()).toBe(willRetry ? 1 : 2);
				expect(inputs).toEqual(willRetry ? ["held input"] : ["first prompt", "held input"]);
				view.handleDequeue();
				expect(ctx.ui.getEditorText()).toBe(willRetry ? "held input" : "first prompt\n\nheld input");
				expect(ctx.getPendingInputCount()).toBe(0);
			} finally {
				release();
				await flush;
				unsubscribe();
			}
		},
	);

	it.each(["cancel", "error"] as const)("retains visible queued input after branch summary %s", async (outcome) => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({ tools: [], settings: { retry: { enabled: false } } });
		onTestFinished(() => harness.cleanup());
		const target = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.sessionManager.appendMessage(userMsg("second"));
		harness.setResponses([
			async () => {
				markStarted();
				await released;
				return fauxAssistantMessage("", {
					stopReason: outcome === "cancel" ? "aborted" : "error",
					errorMessage: "fixture summary failure",
				});
			},
		]);
		const { view, ctx } = await createInputView(harness);
		const navigation = harness.session.navigateTree(target, { summarize: true }).catch((error: unknown) => error);
		try {
			await started;
			await view.defaultEditor.onSubmit?.("retain this submitted input");
			if (outcome === "cancel") harness.session.abortBranchSummary();
			release();
			const result = await navigation;
			if (outcome === "cancel") expect(result).toMatchObject({ cancelled: true, aborted: true });
			else expect(result).toBeInstanceOf(Error);
			expect(ctx.isIdle()).toBe(true);
			expect(ctx.hasPendingMessages()).toBe(false);
			expect(ctx.getPendingInputCount()).toBe(1);
			view.handleDequeue();
			expect(ctx.ui.getEditorText()).toBe("retain this submitted input");
			expect(ctx.getPendingInputCount()).toBe(0);
		} finally {
			harness.session.abortBranchSummary();
			release();
			await navigation;
		}
	});
});
