import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts } from "./harness.ts";

it("Alt+Up restores queued input without recalling input already delivered at a request boundary", async () => {
	const harness = await createHarness({ tools: [], settings: { compaction: { enabled: false } } });
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	harness.setResponses([
		async () => {
			entered();
			await held;
			return fauxAssistantMessage("first");
		},
		fauxAssistantMessage("second"),
	]);
	initTheme("dark");
	const terminal = new VirtualTerminal(80, 24);
	const ui = new TuiMainScreen(terminal);
	const pending = new Container();
	ui.addChild(pending);
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const editor = new CustomEditor(ui, getEditorTheme(), keys);
	const view = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		editor,
		ui,
		compactionQueuedMessages: [],
		pendingMessagesContainer: pending,
		keybindings: keys,
		showStatus: vi.fn(),
	}) as { handleDequeue(): void; updatePendingMessagesDisplay(): void };
	editor.onAction("app.message.dequeue", () => view.handleDequeue());
	ui.start();
	const run = harness.session.prompt("original");
	try {
		await started;
		await harness.session.steer("OLD");
		await harness.session.followUp("LATER");
		view.updatePendingMessagesDisplay();
		for (const width of [80, 32]) {
			terminal.resize(width, 24);
			ui.requestRender(true);
			await terminal.waitForRender();
			const screen = terminal.getViewport().join("\n");
			expect(screen).toContain("Steering: OLD");
			expect(screen).toContain("Follow-up: LATER");
			expect(screen).toContain("to edit");
		}
		editor.setText("draft");
		editor.handleInput("\u001b[1;3A");
		expect(editor.getText()).toBe("OLD\n\nLATER\n\ndraft");
		expect(harness.session.hasPendingMessages).toBe(false);
		await harness.session.steer("NEW");
		release();
		await run;
		expect(getUserTexts(harness)).toEqual(["original", "NEW"]);
		expect(harness.faux.state.callCount).toBe(2);
		editor.setText("");
		editor.handleInput("\u001b[1;3A");
		expect(editor.getText()).toBe("");
		ui.requestRender(true);
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).not.toContain("Steering:");
	} finally {
		release();
		await run;
		ui.stop();
		harness.cleanup();
	}
});
