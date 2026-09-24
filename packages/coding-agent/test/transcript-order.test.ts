import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Editor,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CheckpointActivity } from "../src/core/checkpoint.ts";
import { SettingsManager, type TuiMode } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function click(component: ChatContainer, y: number): void {
	const height = component.render(80).length;
	expect(
		component.handleMouse({
			type: "click",
			button: "left",
			x: 1,
			y,
			screenX: 1,
			screenY: y,
			width: 80,
			height,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		})?.handled,
	).toBe(true);
}

describe("native transcript presentation order", () => {
	test("reverses native message blocks without changing Markdown lines, spacing, or backing children", () => {
		const chat = new ChatContainer();
		const message = fauxAssistantMessage("## Answer\n\nFirst line\n\n- item one\n- item two");
		const saved = structuredClone(message);
		const user = new UserMessageComponent("User prompt");
		const assistant = new AssistantMessageComponent(message);
		const spacer = new Spacer(1);
		chat.children = [user, spacer, assistant];
		const chronological = chat.render(80);
		const expected = [...spacer.render(80), ...assistant.render(80), ...user.render(80)];
		chat.setTranscriptOrder("newest-first");
		expect(chat.render(80)).toEqual(expected);
		expect(chat.render(80)).toEqual(expected);
		expect(chat.children).toEqual([user, spacer, assistant]);
		expect(message).toEqual(saved);
		chat.setTranscriptOrder("oldest-first");
		expect(chat.render(80)).toEqual(chronological);
	});

	test("preserves collapsed Activity counts, local expansion, hidden thinking and newest live calls", () => {
		const chat = new ChatContainer();
		chat.setCompactView(true);
		chat.setTranscriptOrder("newest-first");
		const ui = { requestRender() {} } as TUI;
		const tool = (name: string) =>
			new ToolExecutionComponent(
				name,
				name,
				{},
				{ compactView: true },
				{
					renderCall: () => new Text(`CALL ${name}`, 0, 0),
					renderResult: () => new Text(`RESULT ${name}\nDETAIL ${name}`, 0, 0),
				},
				ui,
				process.cwd(),
			);
		const first = tool("first");
		const second = tool("second");
		const hidden = new AssistantMessageComponent(
			fauxAssistantMessage([{ type: "thinking", thinking: "private" }]),
			true,
			undefined,
			undefined,
			0,
			[],
			true,
		);
		chat.children = [first, hidden, second];
		expect(
			chat
				.render(80)
				.map(stripAnsi)
				.map((line) => line.trimEnd()),
		).toEqual(["▸ Activity · 2 calls · 2 running"]);
		click(chat, 0);
		let lines = chat.render(80).map(stripAnsi);
		expect(lines.findIndex((line) => line.includes("CALL second"))).toBeLessThan(
			lines.findIndex((line) => line.includes("CALL first")),
		);
		const third = tool("third");
		chat.addChild(third);
		third.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		lines = chat.render(80).map(stripAnsi);
		expect(lines[0]).toContain("▾ Activity · 3 calls");
		expect(lines.findIndex((line) => line.includes("CALL third"))).toBeLessThan(
			lines.findIndex((line) => line.includes("CALL second")),
		);
		click(
			chat,
			lines.findIndex((line) => line.includes("CALL third")),
		);
		lines = chat.render(80).map(stripAnsi);
		expect(lines.findIndex((line) => line.includes("RESULT third"))).toBeLessThan(
			lines.findIndex((line) => line.includes("DETAIL third")),
		);
		expect(lines.join("\n")).not.toContain("private");
		chat.setTranscriptOrder("oldest-first");
		lines = chat.render(80).map(stripAnsi);
		expect(lines[0]).toContain("▾ Activity");
		expect(lines.findIndex((line) => line.includes("CALL first"))).toBeLessThan(
			lines.findIndex((line) => line.includes("CALL third")),
		);
		expect(lines.join("\n")).toContain("DETAIL third");
		expect(chat.children).toEqual([first, hidden, second, third]);
	});

	test("routes mouse input through reversed native custom components", () => {
		const events: TuiMouseEvent[] = [];
		const chat = new ChatContainer();
		chat.addChild(new Text("old\nsecond old row", 0, 0));
		chat.addChild(
			new MouseRegion(new Text("new\nsecond new row", 0, 0), (event) => {
				events.push(event);
				return { handled: true };
			}),
		);
		chat.setTranscriptOrder("newest-first");
		click(chat, 1);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ y: 1, height: 2 });
	});
});

function createMode(tuiMode: TuiMode) {
	const terminal = new VirtualTerminal(80, 18);
	const renderer = createInteractiveTui({ tuiMode, terminal, showHardwareCursor: false, logDirectory: "/tmp" });
	const chatContainer = new ChatContainer();
	const headerContainer = new Container();
	headerContainer.addChild(new Text("STARTUP HEADER", 0, 0));
	const loadedResourcesContainer = new Container();
	loadedResourcesContainer.addChild(new Text("LOADED RESOURCES", 0, 0));
	const documentContainer = new Container();
	documentContainer.children = [headerContainer, loadedResourcesContainer, chatContainer];
	const editor = new Editor(renderer, getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const footer = new Text("NATIVE FOOTER", 0, 0);
	const above = new Text("WIDGET ABOVE", 0, 0);
	const below = new Text("WIDGET BELOW", 0, 0);
	const pending = new Container();
	const status = new Container();
	const viewport = createChatViewport({
		document: documentContainer,
		pendingMessages: pending,
		status,
		editor: editorContainer,
		footer,
		widgetsAbove: above,
		widgetsBelow: below,
		scrollbar: "hidden",
	});
	const settingsManager = SettingsManager.inMemory({ tuiMode });
	const context = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			session: {
				settingsManager,
				notifyCheckpointStateChanged() {},
				modelRuntime: { getAvailableSnapshot: () => [] },
			},
		},
		renderer,
		ui: undefined as unknown as TUI,
		chatContainer,
		documentContainer,
		headerContainer,
		loadedResourcesContainer,
		editor,
		defaultEditor: editor,
		statusContainer: status,
		checkpointUIActivity: new CheckpointActivity(),
		editorContainer,
		chatViewport: viewport,
		transcriptOrder: "oldest-first",
		tuiModeBeforeNewestFirst: undefined,
		isInitialized: true,
		hosted: false,
		options: { tuiMode },
		themeController: { rebindTui() {}, getThemeSelection: () => "dark", getTerminalTheme: () => undefined },
		extensionTerminalInputSubscriptions: new Set(),
	}) as {
		renderer: ReturnType<typeof createInteractiveTui>;
		ui: TUI;
		hosted: boolean;
		hostedActive: boolean;
		isInitialized: boolean;
		transcriptOrder: "oldest-first" | "newest-first";
		setTranscriptOrder(order: "oldest-first" | "newest-first"): void;
		setupEditorSubmitHandler(): void;
		showSettingsSelector(): void;
		resetExtensionUI(): void;
		activateHosted(): Promise<void>;
		mountInteractiveTui(renderer: ReturnType<typeof createInteractiveTui>, components: readonly Component[]): void;
	};
	context.ui = createInteractiveTuiReference(() => context.renderer);
	context.mountInteractiveTui(renderer, [documentContainer, pending, status, above, editorContainer, below, footer]);
	renderer.setFocus(editor);
	context.setupEditorSubmitHandler();
	return {
		submit: async (text: string) => {
			editor.setText(text);
			await editor.onSubmit?.(text);
		},
		context,
		terminal,
		chatContainer,
		editor,
		viewport,
		documentContainer,
		headerContainer,
		loadedResourcesContainer,
		settingsManager,
	};
}

describe("native top view", () => {
	test("discovers and handles /topview locally, including toggle, explicit values and invalid arguments", async () => {
		const { context, terminal, submit, editor, chatContainer } = createMode("regular");
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "topview",
			description: "Show newest conversation blocks at the top",
			argumentHint: "[on|off]",
		});
		context.renderer.start();
		try {
			for (const [command, order] of [
				["/topview", "newest-first"],
				["/topview off", "oldest-first"],
				["/topview on", "newest-first"],
				["/topview on", "newest-first"],
				["/topview invalid", "newest-first"],
				["/topview", "oldest-first"],
			] as const) {
				await submit(command);
				await terminal.waitForRender();
				expect(context.transcriptOrder).toBe(order);
				expect(context.ui.mode).toBe(order === "newest-first" ? "fullscreen" : "regular");
				expect(editor.getText()).toBe("");
			}
			expect(stripAnsi(chatContainer.render(80).join("\n"))).toContain("Usage: /topview [on|off]");
			const overlay = context.renderer.showOverlay(new Text("overlay", 0, 0));
			await submit("/topview on");
			expect(context.transcriptOrder).toBe("oldest-first");
			expect(stripAnsi(chatContainer.render(80).join("\n"))).toContain("Close active overlays");
			overlay.hide();
		} finally {
			context.renderer.stop();
		}
	});

	test.each(["regular", "fullscreen"] as const)("keeps native dock and drafts and restores %s mode", async (mode) => {
		const fixture = createMode(mode);
		const {
			context,
			terminal,
			chatContainer,
			editor,
			viewport,
			documentContainer,
			headerContainer,
			loadedResourcesContainer,
		} = fixture;
		expect(context.transcriptOrder).toBe("oldest-first");
		for (let i = 0; i < 25; i++) chatContainer.addChild(new Text(`message ${i}\nsecond line ${i}`, 0, 0));
		editor.setText("unsent draft\nsecond draft line");
		const draft = editor.saveDraft();
		const normalRoot = [...(viewport.root as Container).children];
		const dock = normalRoot[1] as Container;
		const normalDock = [...dock.children];
		context.renderer.start();
		try {
			await terminal.waitForRender();
			context.setTranscriptOrder("newest-first");
			await terminal.waitForRender();
			expect(context.transcriptOrder).toBe("newest-first");
			expect(context.ui.mode).toBe("fullscreen");
			expect(context.renderer.getFocusedComponent()).toBe(editor);
			expect(editor.saveDraft()).toEqual(draft);
			expect((viewport.root as Container).children).toEqual([...normalRoot].reverse());
			expect(dock.children).toEqual([...normalDock].reverse());
			expect(viewport.transcript.scrollTop).toBe(0);
			const screen = terminal.getViewport();
			expect(screen[0]).toContain("NATIVE FOOTER");
			expect(screen[1]).toContain("WIDGET BELOW");
			const draftY = screen.findIndex((line) => line.includes("unsent draft"));
			expect(draftY).toBeGreaterThan(1);
			expect(screen[draftY + 1]).toContain("second draft line");
			const aboveY = screen.findIndex((line) => line.includes("WIDGET ABOVE"));
			expect(aboveY).toBeGreaterThan(draftY + 1);
			const transcriptY = aboveY + 1;
			expect(screen[transcriptY]).toContain("message 24");
			expect(screen[transcriptY + 1]).toContain("second line 24");
			expect(terminal.getCursorPosition().y).toBe(draftY + 1);
			expect(terminal.getViewport().join("\n")).not.toContain("STARTUP HEADER");
			chatContainer.addChild(new Text("live newest\nlive second line", 0, 0));
			context.ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport()[transcriptY]).toContain("live newest");
			expect(terminal.getViewport()[transcriptY + 1]).toContain("live second line");
			terminal.sendInput(`\x1b[<73;1;${transcriptY + 1}M`);
			await terminal.waitForRender();
			expect(viewport.transcript.scrollTop).toBe(5);
			expect(terminal.getViewport()[transcriptY]).toContain("↑ Jump to latest message");
			const reading = terminal.getViewport().slice(transcriptY + 1, transcriptY + 3);
			const streaming = new Text("new while reading\nfirst line", 0, 0);
			chatContainer.addChild(streaming);
			context.ui.requestRender();
			await terminal.waitForRender();
			expect(viewport.transcript.scrollTop).toBe(7);
			expect(terminal.getViewport().slice(transcriptY + 1, transcriptY + 3)).toEqual(reading);
			streaming.setText("new while reading\nfirst line\nsecond line");
			context.ui.requestRender();
			await terminal.waitForRender();
			expect(viewport.transcript.scrollTop).toBe(8);
			expect(terminal.getViewport().slice(transcriptY + 1, transcriptY + 3)).toEqual(reading);
			terminal.sendInput(`\x1b[<0;40;${transcriptY + 1}M`);
			terminal.sendInput(`\x1b[<0;40;${transcriptY + 1}m`);
			await terminal.waitForRender();
			expect(viewport.transcript.scrollTop).toBe(0);
			expect(terminal.getViewport()[transcriptY]).toContain("new while reading");
			context.setTranscriptOrder("oldest-first");
			await terminal.waitForRender();
			expect(context.transcriptOrder).toBe("oldest-first");
			expect(context.ui.mode).toBe(mode);
			expect(editor.saveDraft()).toEqual(draft);
			expect(documentContainer.children).toEqual([headerContainer, loadedResourcesContainer, chatContainer]);
			expect(viewport.transcript.followEnd).toBe(true);
			expect((viewport.root as Container).children).toEqual(normalRoot);
			expect(dock.children).toEqual(normalDock);
			const restored = terminal.getViewport();
			expect(restored.findIndex((line) => line.includes("NATIVE FOOTER"))).toBeGreaterThan(
				restored.findIndex((line) => line.includes("unsent draft")),
			);
		} finally {
			context.renderer.stop();
		}
	});

	test("keeps native Activity clicks and editor input aligned below the mirrored dock across resizes", async () => {
		const { context, terminal, chatContainer, editor } = createMode("fullscreen");
		chatContainer.setCompactView(true);
		const tool = new ToolExecutionComponent(
			"read",
			"read-file",
			{},
			{ compactView: true },
			{
				renderCall: () => new Text("READ FILE", 0, 0),
				renderResult: () => new Text("result first\nresult second\nresult third", 0, 0),
			},
			context.ui,
			process.cwd(),
		);
		tool.updateResult({ content: [], isError: false });
		chatContainer.addChild(tool);
		editor.setText("draft");
		context.renderer.start();
		try {
			context.setTranscriptOrder("newest-first");
			await terminal.waitForRender();
			const activityY = terminal.getViewport().findIndex((line) => line.includes("Activity"));
			const editorY = terminal.getViewport().findIndex((line) => line.includes("draft"));
			expect(activityY).toBeGreaterThan(editorY);
			terminal.sendInput(`\x1b[<0;2;${activityY + 1}M`);
			terminal.sendInput(`\x1b[<0;2;${activityY + 1}m`);
			await terminal.waitForRender();
			const callY = terminal.getViewport().findIndex((line) => line.includes("READ FILE"));
			expect(callY).toBeGreaterThan(activityY);
			terminal.sendInput(`\x1b[<0;2;${callY + 1}M`);
			terminal.sendInput(`\x1b[<0;2;${callY + 1}m`);
			await terminal.waitForRender();
			const result = terminal.getViewport().filter((line) => line.includes("result "));
			expect(result.map((line) => line.trim())).toEqual(["result first", "result second", "result third"]);
			terminal.sendInput(`\x1b[<0;1;${editorY + 1}M`);
			terminal.sendInput(`\x1b[<0;1;${editorY + 1}m`);
			terminal.sendInput("x");
			await terminal.waitForRender();
			expect(editor.getText()).toBe("xdraft");
			expect(terminal.getCursorPosition().y).toBe(editorY);
			for (const [width, height] of [
				[12, 8],
				[1, 1],
				[80, 18],
			] as const) {
				terminal.resize(width, height);
				await terminal.waitForRender();
				expect(editor.getText()).toBe("xdraft");
				expect(terminal.getViewport()).toHaveLength(height);
				// A one-row terminal clips the editor; check its caret when it is visible.
				if (height > 1) {
					expect(terminal.getViewport().join("\n")).toContain("xdraft");
					const cursor = terminal.getCursorPosition();
					expect(cursor.x).toBeLessThan(width);
					expect(cursor.y).toBeLessThan(height);
				}
			}
			expect(terminal.getViewport()[0]).toContain("NATIVE FOOTER");
			expect(terminal.getViewport().join("\n")).toContain("result third");
		} finally {
			context.renderer.stop();
		}
	});

	test("rejects settings changes that would leave newest-first without its viewport", async () => {
		const { context, terminal, settingsManager } = createMode("fullscreen");
		context.renderer.start();
		try {
			await terminal.waitForRender();
			context.setTranscriptOrder("newest-first");
			context.showSettingsSelector();
			const focused = context.renderer.getFocusedComponent();
			const selector = context.renderer.children
				.flatMap((child) => (child instanceof Container ? child.children : []))
				.find((child) => child instanceof SettingsSelectorComponent);
			expect(selector).toBeInstanceOf(SettingsSelectorComponent);
			expect(focused).toBe((selector as SettingsSelectorComponent).getSettingsList());
			terminal.sendInput("TUI mode");
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(context.ui.mode).toBe("fullscreen");
			expect(context.transcriptOrder).toBe("newest-first");
			expect(settingsManager.getTuiMode()).toBe("fullscreen");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Use /topview off");
		} finally {
			context.renderer.stop();
		}
	});

	test("keeps an explicit fullscreen preference when top view is disabled", async () => {
		const { context, terminal, submit, settingsManager } = createMode("regular");
		context.renderer.start();
		try {
			await submit("/topview on");
			await terminal.waitForRender();
			expect(context.ui.mode).toBe("fullscreen");
			expect(settingsManager.getTuiMode()).toBe("regular");
			context.showSettingsSelector();
			terminal.sendInput("TUI mode");
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(settingsManager.getTuiMode()).toBe("fullscreen");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			await submit("/topview off");
			await terminal.waitForRender();
			expect(context.transcriptOrder).toBe("oldest-first");
			expect(context.ui.mode).toBe("fullscreen");
			expect(settingsManager.getTuiMode()).toBe("fullscreen");
		} finally {
			context.renderer.stop();
		}
	});

	test.each([false, true])("keeps native ordering through extension cleanup (detached=%s)", async (detached) => {
		const { context, terminal, editor } = createMode("regular");
		context.renderer.start();
		try {
			await terminal.waitForRender();
			context.setTranscriptOrder("newest-first");
			context.renderer.showOverlay(new Text("extension overlay", 0, 0));
			editor.setText("saved draft");
			if (detached) {
				context.renderer.stop({ preserveScreen: true });
				context.hosted = true;
				context.hostedActive = false;
			}
			const start = vi.spyOn(terminal, "start");
			const stop = vi.spyOn(terminal, "stop");
			const write = vi.spyOn(terminal, "write");
			Object.assign(context, {
				setExtensionFooter() {},
				setExtensionHeader() {},
				clearExtensionWidgets() {},
				footerDataProvider: { clearExtensionStatuses() {} },
				footer: { invalidate() {} },
				setCustomEditorComponent() {},
				setupAutocompleteProvider() {},
				defaultEditor: editor,
				updateTerminalTitle() {},
				setWorkingIndicator() {},
				setHiddenThinkingLabel() {},
			});
			context.resetExtensionUI();
			expect(context.transcriptOrder).toBe("newest-first");
			expect(context.renderer.hasOverlayEntries).toBe(false);
			expect(editor.getText()).toBe("saved draft");
			await terminal.waitForRender();
			expect(start).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
			if (detached) {
				expect(write).not.toHaveBeenCalled();
				await context.activateHosted();
				await terminal.waitForRender();
			}
			expect(context.ui.mode).toBe("fullscreen");
			start.mockRestore();
			stop.mockRestore();
			write.mockRestore();
			context.setTranscriptOrder("oldest-first");
			expect(context.transcriptOrder).toBe("oldest-first");
			expect(context.ui.mode).toBe("regular");
		} finally {
			context.renderer.stop();
		}
	});

	test("throws without changing order when an overlay blocks renderer transition", async () => {
		const { context, terminal } = createMode("regular");
		context.renderer.start();
		try {
			await terminal.waitForRender();
			const first = context.renderer.showOverlay(new Text("overlay", 0, 0));
			expect(() => context.setTranscriptOrder("newest-first")).toThrow("Close active overlays");
			expect(context.transcriptOrder).toBe("oldest-first");
			expect(context.ui.mode).toBe("regular");
			first.hide();
			context.setTranscriptOrder("newest-first");
			const second = context.renderer.showOverlay(new Text("overlay", 0, 0));
			expect(() => context.setTranscriptOrder("oldest-first")).toThrow("Close active overlays");
			expect(context.transcriptOrder).toBe("newest-first");
			expect(context.ui.mode).toBe("fullscreen");
			second.hide();
			context.setTranscriptOrder("oldest-first");
			expect(context.ui.mode).toBe("regular");
		} finally {
			context.renderer.stop();
		}
	});
});
