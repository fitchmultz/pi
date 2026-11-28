import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { Container, type TuiMouseEvent, type TuiMouseEventType } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function mouse(type: TuiMouseEventType, x: number, y: number, width = 80, height = 10): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

const settingsTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: selectTheme,
};

class InputOverlay extends Container {
	readonly input = new Input();

	constructor() {
		super();
		this.addChild(this.input);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

/** A settings submenu that routes keys to its nested list, like the coding agent's theme submenu. */
class SubmenuHost extends Container {
	readonly list = new SelectList(
		[
			{ value: "first", label: "First" },
			{ value: "second", label: "Second" },
		],
		5,
		selectTheme,
	);

	constructor(done: (value?: string) => void) {
		super();
		this.list.onSelect = (item) => done(item.value);
		this.list.onCancel = () => done();
		this.addChild(this.list);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

describe("mouse-aware components", () => {
	// #243: cached Box output must not retain stale child identity or row geometry.
	it("routes unchanged and partially changed Box rows to the current children", () => {
		const first = new Text("a\nb", 0, 0);
		const second = new Text("", 0, 0);
		const hits: Array<Array<string | number>> = [];
		const region = (id: string, child: Text) =>
			new MouseRegion(child, (event) => {
				hits.push([id, event.x, event.y, event.width, event.height]);
				return { handled: true };
			});
		const firstRegion = region("first", first);
		const box = new Box(1, 1);
		box.addChild(firstRegion);
		box.addChild(region("second", second));
		const unchanged = ["     ", " a   ", " b   ", "     "];
		assert.deepStrictEqual(box.render(5), unchanged);
		box.handleMouse(mouse("press", 1, 2, 5, 4));
		first.setText("a");
		second.setText("b");
		assert.deepStrictEqual(box.render(5), unchanged);
		box.handleMouse(mouse("press", 1, 2, 5, 4));
		box.children = [firstRegion, region("replacement", new Text("b", 0, 0))];
		assert.deepStrictEqual(box.render(5), unchanged);
		box.handleMouse(mouse("press", 1, 2, 5, 4));
		first.setText("a\nc");
		assert.deepStrictEqual(box.render(5), ["     ", " a   ", " c   ", " b   ", "     "]);
		box.handleMouse(mouse("press", 1, 3, 5, 5));
		assert.deepStrictEqual(hits, [
			["first", 0, 1, 3, 2],
			["second", 0, 0, 3, 1],
			["replacement", 0, 0, 3, 1],
			["replacement", 0, 0, 3, 1],
		]);
	});

	it("positions the input cursor using the visible prompt width", () => {
		for (const { prompt, x, expected } of [
			{ prompt: undefined, x: 4, expected: "heXllo" },
			{ prompt: "", x: 2, expected: "heXllo" },
			{ prompt: "Search: ", x: 8, expected: "Xhello" },
			{ prompt: "\x1b[36m查找: \x1b[0m", x: 8, expected: "heXllo" },
		]) {
			const input = new Input({ prompt });
			input.handleInput("hello");
			assert.strictEqual(
				stripTerminalSequences(input.render(20)[0]).trimEnd(),
				`${stripTerminalSequences(prompt ?? "> ")}hello`,
			);
			assert.strictEqual(input.handleMouse(mouse("press", x, 0, 20, 1))?.handled, true);
			input.handleInput("X");
			assert.strictEqual(input.getValue(), expected);
		}
	});

	it("positions the cursor at both ends of scrolled wide text", () => {
		for (const { width, visible, hidden, endX, padding } of [
			{ width: 8, visible: "再见", hidden: "你好吗世界", endX: 6, padding: " " },
			{ width: 9, visible: "界再见", hidden: "你好吗世", endX: 8, padding: "" },
		]) {
			for (const atEnd of [false, true]) {
				const input = new Input();
				const value = "你好吗世界再见";
				input.handleInput(value);
				assert.deepStrictEqual(input.render(width).map(stripTerminalSequences), [`> ${visible} ${padding}`]);
				input.handleMouse(mouse("press", atEnd ? endX : 2, 0, width, 1));
				input.handleInput("X");
				assert.strictEqual(input.getValue(), atEnd ? `${value}X` : `${hidden}X${visible}`);
			}
		}
	});

	it("selects and activates list rows", () => {
		const list = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
				{ value: "d", label: "D" },
				{ value: "e", label: "E" },
			],
			3,
			selectTheme,
		);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};

		assert.strictEqual(list.handleMouse(mouse("press", 1, 2, 40, 3))?.handled, true);
		assert.strictEqual(list.getSelectedItem()?.value, "c");
		assert.strictEqual(list.handleMouse(mouse("click", 1, 2, 40, 3))?.handled, true);
		assert.strictEqual(selected, "c");
	});

	it("activates settings rows", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two"] },
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
				{ id: "third", label: "Third", currentValue: "low", values: ["low", "high"] },
				{ id: "fourth", label: "Fourth", currentValue: "x", values: ["x", "y"] },
			],
			3,
			settingsTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);

		list.handleMouse(mouse("press", 1, 2, 40, 5));
		list.handleMouse(mouse("click", 1, 2, 40, 5));
		assert.deepStrictEqual(changes, [{ id: "third", value: "high" }]);
	});

	it("scrolls settings from the search field, spacer, description, and hint", () => {
		const list = new SettingsList(
			Array.from({ length: 8 }, (_, i) => ({
				id: `item-${i}`,
				label: `Item ${i}`,
				description: `Description ${i}`,
				currentValue: "off",
			})),
			3,
			settingsTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		list.handleInput("Item");
		const lines = list.render(80);
		const rows = [0, 1, lines.length - 3, lines.length - 1];
		for (const [index, row] of rows.entries()) {
			assert.strictEqual(
				list.handleMouse({ ...mouse("wheel", 1, row, 80, lines.length), wheelDelta: 1 })?.handled,
				true,
			);
			assert.ok(list.render(80).some((line) => line.startsWith(`> Item ${index + 1}`)));
		}

		assert.strictEqual(list.handleMouse(mouse("press", 2, 0, 80, lines.length))?.focus, true);
		list.handleInput("X");
		const emptyResults = list.render(80);
		assert.match(stripTerminalSequences(emptyResults[0]), /^> XItem/);
		assert.match(emptyResults[2], /No matching settings/);
		assert.deepStrictEqual(list.handleMouse({ ...mouse("wheel", 1, 0, 80, emptyResults.length), wheelDelta: 1 }), {
			handled: true,
			render: false,
		});
	});

	for (const row of [0, 4]) {
		it(`ignores hover and clicks visible select-list row ${row} after scrolling`, () => {
			const list = new SelectList(
				Array.from({ length: 12 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` })),
				5,
				selectTheme,
			);
			const changes: string[] = [];
			let selected: string | undefined;
			list.onSelectionChange = (item) => changes.push(item.value);
			list.onSelect = (item) => {
				selected = item.value;
			};
			list.setSelectedIndex(5);
			list.handleMouse({ ...mouse("wheel", 1, row), wheelDelta: 1 });
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			assert.deepStrictEqual(changes, ["item-6"]);
			const before = list.render(80);
			assert.match(before[row], new RegExp(`Item ${4 + row}$`));

			for (const y of [0, 1, 2, 3, 4, row]) {
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y), button: "none" }), undefined);
				assert.deepStrictEqual(list.render(80), before);
			}
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			assert.deepStrictEqual(changes, ["item-6"]);
			assert.strictEqual(selected, undefined);

			list.handleMouse(mouse("press", 1, row));
			list.render(80);
			list.handleMouse(mouse("click", 1, row));
			assert.strictEqual(selected, `item-${4 + row}`);
			assert.deepStrictEqual(changes, ["item-6", `item-${4 + row}`]);
		});

		it(`ignores hover and clicks visible settings row ${row} after scrolling`, () => {
			const changes: Array<{ id: string; value: string }> = [];
			const list = new SettingsList(
				Array.from({ length: 12 }, (_, i) => ({
					id: `item-${i}`,
					label: `Item ${i}`,
					description: `Description ${i}`,
					currentValue: "off",
					values: ["off", "on"],
				})),
				5,
				settingsTheme,
				(id, value) => changes.push({ id, value }),
				() => {},
				{ enableSearch: true },
			);
			list.selectItem("item-5");
			list.handleMouse({ ...mouse("wheel", 1, row + 2), wheelDelta: 1 });
			const before = list.render(80);
			assert.match(before[4], /^> Item 6/);
			assert.match(before[row + 2], new RegExp(`Item ${4 + row} `));

			for (const y of [0, 1, 2, 3, 4, row]) {
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y + 2), button: "none" }), undefined);
				assert.deepStrictEqual(list.render(80), before);
			}
			assert.deepStrictEqual(changes, []);

			list.handleMouse(mouse("press", 1, row + 2));
			list.render(80);
			list.handleMouse(mouse("click", 1, row + 2));
			assert.deepStrictEqual(changes, [{ id: `item-${4 + row}`, value: "on" }]);
		});
	}

	it("keeps a delegating overlay focused when its nested input is clicked", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const overlay = new InputOverlay();
		overlay.input.setValue("hi");
		tui.start();
		tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<0;5;1m");
		terminal.sendInput("!");
		await terminal.waitForRender();

		assert.strictEqual(overlay.input.getValue(), "hi!");
		assert.strictEqual(tui.getFocusedComponent(), overlay);
		tui.stop();
	});

	it("keeps a settings list focused when a click in its submenu closes the submenu", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal);
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "theme", label: "Theme", currentValue: "first", submenu: (_value, done) => new SubmenuHost(done) },
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
			],
			5,
			settingsTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);
		tui.addChild(list);
		tui.setFocus(list);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\r");
		await terminal.waitForRender();
		// Press and release on the submenu's second row selects it and closes the submenu.
		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(changes, [{ id: "theme", value: "second" }]);
		assert.strictEqual(tui.getFocusedComponent(), list);

		// Keys reach the visible list again instead of the closed submenu.
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		assert.deepStrictEqual(changes, [
			{ id: "theme", value: "second" },
			{ id: "other", value: "on" },
		]);
		tui.stop();
	});

	it("routes wheel input to a settings submenu and consumes it over the submenu hint", () => {
		const list = new SettingsList(
			[
				{
					id: "theme",
					label: "Theme",
					currentValue: "first",
					submenu: (_value, done) => {
						const submenu = new SubmenuHost(done);
						submenu.addChild(new Text("Choose a theme", 0, 0));
						return submenu;
					},
				},
			],
			5,
			settingsTheme,
			() => {},
			() => {},
		);
		list.handleInput("\r");
		const lines = list.render(30);
		assert.strictEqual(list.handleMouse({ ...mouse("wheel", 1, 0, 30, lines.length), wheelDelta: 1 })?.handled, true);
		assert.match(list.render(30)[1], /^→ Second/);
		assert.strictEqual(
			list.handleMouse({ ...mouse("wheel", 1, 2, 30, lines.length), wheelDelta: -1 })?.handled,
			true,
		);
		assert.match(list.render(30)[1], /^→ Second/);
	});

	it("positions and focuses the multiline editor through alternate-screen dispatch", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		assert.strictEqual(editor.getText(), "heXllo");
		assert.strictEqual(tui.getFocusedComponent(), editor);
		tui.stop();
	});

	it("scrolls editor autocomplete from the text and borders while leaving text clicks for the caret", async () => {
		const editor = new Editor(new TuiAltScreen(new VirtualTerminal()), editorTheme);
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				prefix: "/",
				items: ["first", "second", "third", "fourth"].map((label) => ({ label, value: `/${label}` })),
			}),
			applyCompletion: (_lines, cursorLine, _cursorCol, item) => ({
				lines: [item.value],
				cursorLine,
				cursorCol: item.value.length,
			}),
		});
		editor.handleInput("/");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		const lines = editor.render(30);
		assert.match(lines[3], /^→ first/);
		for (const [row, label] of ["second", "third", "fourth"].entries()) {
			assert.strictEqual(
				editor.handleMouse({ ...mouse("wheel", 1, row, 30, lines.length), wheelDelta: 1 })?.handled,
				true,
			);
			assert.match(editor.render(30)[4 + row], new RegExp(`^→ ${label}`));
		}

		assert.strictEqual(editor.handleMouse(mouse("click", 0, 1, 30, lines.length))?.focus, true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("scrolls wrapped editor rows without moving the caret and yields the wheel when the text fits", async () => {
		const terminal = new VirtualTerminal(9, 10);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 2 });
		const editor = new Editor(tui, editorTheme);
		editor.setText("11111111222222223333333344444444555555556666666677777777\nlast");
		const transcript = new ScrollView(new Text("output\n".repeat(12).trimEnd(), 0, 0), {
			primary: true,
			follow: "end",
		});
		tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }, editor]));
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[4], /^44444444/);
			const top = transcript.scrollTop;
			const cursor = editor.getCursor();

			terminal.sendInput("\x1b[<64;2;5M");
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[4], /^22222222/);
			assert.strictEqual(transcript.scrollTop, top);

			tui.setWheelScrollLines(1);
			terminal.sendInput("\x1b[<65;2;5M");
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[4], /^33333333/);
			assert.deepStrictEqual(editor.getCursor(), cursor);

			terminal.sendInput("X");
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[4], /^44444444/);
			assert.match(editor.getText(), /\nlastX$/);

			// A click before the wheel frame is drawn still hits the row the user can see.
			terminal.sendInput("\x1b[<64;2;5M");
			terminal.sendInput("\x1b[<0;2;5M");
			terminal.sendInput("\x1b[<0;2;5m");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 25 });

			editor.setText("short");
			tui.requestRender();
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[8], /^short/);
			const topWithShortEditor = transcript.scrollTop;
			terminal.sendInput("\x1b[<64;2;9M");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, topWithShortEditor - 1);
		} finally {
			tui.stop();
		}
	});

	it("selects and copies editor text on drag instead of moving the cursor", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello world");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();
		const cursorBefore = editor.getCursor();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["hello"]);
		assert.deepStrictEqual(editor.getCursor(), cursorBefore);
		tui.stop();
	});
});
