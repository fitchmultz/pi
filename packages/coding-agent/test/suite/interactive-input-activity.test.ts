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
	bindCurrentSessionExtensions(): Promise<void>;
	handleDequeue(): void;
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
