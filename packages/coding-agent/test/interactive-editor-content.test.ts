import { type Component, Container, type EditorComponent, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { EditorFactory, ExtensionAPI } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { editInExternalEditor } from "../src/modes/interactive/external-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/modes/interactive/external-editor.ts", () => ({ editInExternalEditor: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ CustomEditor }));

import rainbowEditor from "../examples/extensions/rainbow-editor.ts";

const methods = InteractiveMode.prototype as unknown as {
	setCustomEditorComponent(this: object, factory: EditorFactory | undefined): void;
	showExtensionCustom<T>(
		this: object,
		factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (value: T) => void) => Component,
	): Promise<T>;
	restoreQueuedMessagesToEditor(this: object): number;
};

function createHost() {
	const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const keybindings = KeybindingsManager.create();
	setKeybindings(keybindings);
	const defaultEditor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const editorContainer = new Container();
	editorContainer.addChild(defaultEditor);
	ui.setFocus(defaultEditor);
	return {
		ui,
		renderer: ui,
		keybindings,
		defaultEditor,
		editor: defaultEditor as EditorComponent,
		editorContainer,
		pendingCustomFocus: new WeakMap<Component, Component | null>(),
		disposeActiveSelector: vi.fn(),
		checkpointCallback:
			<Args extends unknown[], Result>(callback: (...args: Args) => Result) =>
			(...args: Args) =>
				Promise.resolve(callback(...args)),
	};
}

const payload = Array.from({ length: 12 }, (_, i) => `payload line ${i}`).join("\n");

beforeEach(() => {
	initTheme("dark");
	vi.clearAllMocks();
});

describe("interactive editor content transfers", () => {
	test("transfers semantic content from custom editors and supports getText-only editors", () => {
		const host = createHost();
		const expanded = `${payload}\n[paste #1 +12 lines]`;
		host.editor = {
			getText: () => "[paste #1 +12 lines]",
			getExpandedText: () => expanded,
			setText() {},
			handleInput() {},
			render: () => [],
			invalidate() {},
		};
		const replacement = new CustomEditor(host.ui, getEditorTheme(), host.keybindings);
		methods.setCustomEditorComponent.call(host, () => replacement);
		expect(replacement.getExpandedText()).toBe(expanded);

		host.editor = {
			getText: () => "plain custom draft",
			setText() {},
			handleInput() {},
			render: () => [],
			invalidate() {},
		};
		methods.setCustomEditorComponent.call(host, undefined);
		expect(host.defaultEditor.getExpandedText()).toBe("plain custom draft");
	});

	test("restores a same-editor draft after a temporary dialog without unfolding it or moving its cursor", async () => {
		const host = createHost();
		const editor = host.defaultEditor;
		editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
		editor.handleInput(" suffix");
		editor.handleInput("\x1b[D");
		const rendered = editor.render(80);
		const cursor = editor.getCursor();
		let close: (value: unknown) => void = () => {};
		const dialog = methods.showExtensionCustom.call(host, (_ui, _theme, _keybindings, done) => {
			close = done;
			return new Container();
		});
		await Promise.resolve();
		editor.setText("temporary dialog input");
		close("done");
		await dialog;
		expect(editor.getExpandedText()).toBe(`${payload} suffix`);
		expect(editor.getCursor()).toEqual(cursor);
		expect(editor.render(80)).toEqual(rendered);
		editor.handleInput("\x1f");
		expect(editor.getExpandedText()).toBe(payload);
		expect(editor.render(80).join("\n")).toContain("[paste #1");
	});

	test("restores full content when a dialog replaces the editor instance", async () => {
		const host = createHost();
		host.defaultEditor.handleInput(`\x1b[200~${payload}\x1b[201~`);
		let close: (value: unknown) => void = () => {};
		const dialog = methods.showExtensionCustom.call(host, (_ui, _theme, _keybindings, done) => {
			close = done;
			return new Container();
		});
		await Promise.resolve();
		const replacement = new CustomEditor(host.ui, getEditorTheme(), host.keybindings);
		host.editor = replacement;
		close("done");
		await dialog;
		expect(replacement.getExpandedText()).toBe(payload);
	});

	test("combines queued messages with custom editor semantic content", () => {
		const setText = vi.fn();
		const host = {
			editor: { getText: () => "[paste label]", getExpandedText: () => payload, setText },
			clearAllQueues: () => ({ steering: ["queued"], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
		};
		expect(methods.restoreQueuedMessagesToEditor.call(host)).toBe(1);
		expect(setText).toHaveBeenCalledWith(`queued\n\n${payload}`);
	});

	test("sends folded extension-dialog contents to the external editor", async () => {
		const host = createHost();
		const dialog = new ExtensionEditorComponent(host.ui, host.keybindings, "Edit", undefined, vi.fn(), vi.fn());
		dialog.handleInput(`\x1b[200~${payload}\x1b[201~`);
		vi.mocked(editInExternalEditor).mockResolvedValue({ status: "failed" });
		vi.spyOn(host.ui, "stop").mockImplementation(() => {});
		vi.spyOn(host.ui, "start").mockImplementation(() => {});
		const open = Reflect.get(dialog, "handleOpenExternalEditor") as () => Promise<void>;
		await open.call(dialog);
		expect(editInExternalEditor).toHaveBeenCalledWith(expect.objectContaining({ content: payload }));
	});

	test("animates the rainbow example only when the keyword is rendered", () => {
		vi.useFakeTimers();
		try {
			const host = createHost();
			const on = vi.fn();
			rainbowEditor({ on } as unknown as ExtensionAPI);
			const setEditorComponent = vi.fn();
			const start = on.mock.calls[0][1] as (
				event: unknown,
				context: { ui: { setEditorComponent: typeof setEditorComponent } },
			) => void;
			start({}, { ui: { setEditorComponent } });
			const factory = setEditorComponent.mock.calls[0][0] as EditorFactory;
			const editor = factory(host.ui, getEditorTheme(), host.keybindings);
			editor.handleInput(`\x1b[200~ultrathink\n${payload}\x1b[201~`);
			editor.render(80);
			expect(vi.getTimerCount()).toBe(0);

			editor.setText("ultrathink");
			editor.render(80);
			expect(vi.getTimerCount()).toBe(1);

			editor.setText("ordinary text");
			editor.render(80);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
