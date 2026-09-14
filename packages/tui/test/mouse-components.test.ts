import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
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

describe("mouse-aware components", () => {
	for (const { name, prompt, x, expected } of [
		{ name: "default", prompt: undefined, x: 4, expected: "heXllo" },
		{ name: "empty", prompt: "", x: 2, expected: "heXllo" },
		{ name: "long", prompt: "Search: ", x: 8, expected: "Xhello" },
		{ name: "styled wide", prompt: "\x1b[36m查找: \x1b[0m", x: 8, expected: "heXllo" },
	]) {
		it(`positions a single-line input cursor with the ${name} prompt`, () => {
			const input = new Input({ prompt });
			const container = new Container();
			container.addChild(input);
			input.handleInput("hello");
			assert.strictEqual(
				stripTerminalSequences(container.render(20)[0]).trimEnd(),
				`${stripTerminalSequences(prompt ?? "> ")}hello`,
			);

			assert.strictEqual(container.handleMouse(mouse("press", x, 0, 20, 1))?.handled, true);
			input.handleInput("X");
			assert.strictEqual(input.getValue(), expected);
		});
	}

	for (const { width, value, visible, hidden, endX, padding } of [
		{ width: 8, value: "你好吗世界再见", visible: "再见", hidden: "你好吗世界", endX: 6, padding: " " },
		{ width: 9, value: "你好吗世界再见", visible: "界再见", hidden: "你好吗世", endX: 8, padding: "" },
		{
			width: 80,
			value: `${"甲".repeat(40)}世界再见`,
			visible: `${"甲".repeat(34)}世界再见`,
			hidden: "甲".repeat(6),
			endX: 78,
			padding: " ",
		},
	]) {
		for (const atEnd of [false, true]) {
			it(`positions a scrolled wide input cursor at the visible ${atEnd ? "end" : "start"} at width ${width}`, () => {
				const input = new Input();
				const container = new Container();
				container.addChild(input);
				input.handleInput(value);
				assert.deepStrictEqual(container.render(width), [`> ${visible}\x1b[7m \x1b[27m${padding}`]);

				assert.strictEqual(container.handleMouse(mouse("press", atEnd ? endX : 2, 0, width, 1))?.handled, true);
				input.handleInput("X");
				assert.strictEqual(input.getValue(), atEnd ? `${value}X` : `${hidden}X${visible}`);
			});
		}
	}

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
