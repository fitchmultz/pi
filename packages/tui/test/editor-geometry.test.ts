import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { CURSOR_MARKER, type TuiMouseEvent } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const payload = Array.from({ length: 12 }, (_, i) => `hidden-${i}`).join("\n");
const paste = (editor: Editor) => editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
function editor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
}
function offset(target: Editor): number {
	const cursor = target.getCursor();
	return (
		target
			.getLines()
			.slice(0, cursor.line)
			.reduce((n, line) => n + line.length + 1, 0) + cursor.col
	);
}
function click(x: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y: 1,
		screenX: x,
		screenY: 1,
		width: 80,
		height: 3,
		shift: false,
		ctrl: false,
		alt: false,
		clickCount: 1,
	};
}

describe("Editor source and cell geometry", () => {
	it("does not retain the previous column when crossing into a final empty line", () => {
		const target = editor();
		target.setText("abcdefg\n");
		target.handleInput("\x1b[D");
		assert.deepEqual(target.getCursor(), { line: 0, col: 7 });
		target.handleInput("\x1b[C");
		assert.deepEqual(target.getCursor(), { line: 1, col: 0 });
		target.handleInput("\x1b[A");
		assert.deepEqual(target.getCursor(), { line: 0, col: 0 });
	});

	it("jumps to grapheme boundaries while excluding the current grapheme", () => {
		const target = editor();
		target.setText("a\u0301 x a\u0301");
		target.handleInput("\x01");
		target.handleInput("\x1d");
		target.handleInput("\u0301");
		assert.deepEqual(target.getCursor(), { line: 0, col: 5 });
		target.handleInput("\x1b\x1d");
		target.handleInput("\u0301");
		assert.deepEqual(target.getCursor(), { line: 0, col: 0 });
	});

	it("jumps through fold labels atomically without treating identical literals as folds", () => {
		const target = editor();
		paste(target);
		const label = "[paste #1 +12 lines]";
		target.insertTextAtCursor(label);
		target.handleInput("\x01");
		target.handleInput("\x1d");
		target.handleInput("p");
		assert.equal(offset(target), payload.length + 1);
		target.handleInput("\x1b\x1d");
		target.handleInput("p");
		assert.equal(offset(target), 0);
	});

	it("jumps to an editable combining mark immediately after a fold", () => {
		const target = editor();
		paste(target);
		target.insertTextAtCursor("\u0301");
		target.handleInput("\x01");
		target.handleInput("\x1d");
		target.handleInput("\u0301");
		assert.deepEqual(target.getCursor(), { line: 11, col: 9 });
		target.handleInput("\x1b[3~");
		assert.equal(target.getText(), payload);
		assert.match(target.render(80).map(stripTerminalSequences).join("\n"), /\[paste #1 \+12 lines\]/);
	});

	it("jumps to a distant match in a large unfolded programmatic draft", () => {
		const target = editor();
		target.setText(`${"a".repeat(1_000_000)}z`);
		target.handleInput("\x01");
		target.handleInput("\x1d");
		target.handleInput("z");
		assert.deepEqual(target.getCursor(), { line: 0, col: 1_000_000 });
	});

	it("uses terminal cells rather than UTF-16 columns for vertical movement", () => {
		const target = editor();
		target.setText("ab\n界a");
		target.handleInput("\x01");
		target.handleInput("\x1b[A");
		target.handleInput("\x1b[C");
		target.handleInput("\x1b[C");
		target.handleInput("\x1b[B");
		assert.deepEqual(target.getCursor(), { line: 1, col: 1 });
	});

	it("maps fold clicks and the IME cursor to the same cell after wide text", () => {
		const target = editor();
		target.focused = true;
		target.setText("界A");
		paste(target);
		target.handleInput("Z");
		const label = target
			.render(80)
			.join("\n")
			.match(/\[paste #[^\]]+\]/)![0];
		target.handleMouse(click(8));
		assert.equal(offset(target), 2);
		let row = target.render(80).find((line) => line.includes(CURSOR_MARKER))!;
		assert.equal(visibleWidth(row.split(CURSOR_MARKER)[0]!), 3);
		assert.ok(row.includes(`\x1b[7m${label}\x1b[0m`));
		target.handleMouse(click(3 + label.length));
		assert.equal(offset(target), 2 + payload.length);
		row = target.render(80).find((line) => line.includes(CURSOR_MARKER))!;
		assert.equal(visibleWidth(row.split(CURSOR_MARKER)[0]!), 3 + label.length);
	});

	it("keeps caret stops outside a fold across narrow wrapping and resize", () => {
		const target = editor();
		target.setText("A");
		paste(target);
		target.handleInput("B");
		for (const width of [8, 4, 20, 2, 80]) {
			target.render(width);
			target.handleInput("\x01");
			for (let n = 0; n < 40; n++) {
				target.handleInput("\x1b[B");
				const at = offset(target);
				assert.ok(at <= 1 || at >= 1 + payload.length, `width ${width}: caret ${at} inside fold`);
				target.render(width);
			}
			assert.equal(offset(target), payload.length + 2);
			for (let n = 0; n < 40; n++) {
				target.handleInput("\x1b[A");
				const at = offset(target);
				assert.ok(at <= 1 || at >= 1 + payload.length);
				target.render(width);
			}
			assert.equal(offset(target), 0);
		}
	});

	it("makes progress wrapping one wide grapheme in a one-cell row", () => {
		assert.deepEqual(wordWrapLine("界", 1), [{ text: "界", startIndex: 0, endIndex: 1 }]);
		const target = editor();
		target.setText("👩‍💻界");
		for (const width of [1, 2, 3]) {
			assert.ok(target.render(width).every((line) => visibleWidth(line) <= width));
		}
	});

	it("preserves exclusive fold edges when inserting on either side", () => {
		const target = editor();
		target.setText("A");
		paste(target);
		target.handleInput("Z");
		target.handleInput("\x01");
		target.handleInput("\x1b[C");
		target.handleInput("L");
		target.handleInput("\x1b[C");
		target.handleInput("R");
		assert.equal(target.getText(), `AL${payload}RZ`);
		target.handleInput("\x1b[D");
		target.handleInput("\x7f");
		assert.equal(target.getText(), "ALRZ");
	});

	it("removes an overlapped fold during yank-pop replacement", () => {
		const target = editor();
		paste(target);
		target.handleInput("\x17");
		target.handleInput("word");
		target.handleInput("\x17");
		target.handleInput("\x19");
		target.handleInput("\x1by");
		assert.equal(target.getText(), payload);
		assert.match(target.render(80).map(stripTerminalSequences).join("\n"), /\[paste #/);
		target.handleInput("\x1by");
		assert.equal(target.getText(), "word");
		assert.doesNotMatch(target.render(80).map(stripTerminalSequences).join("\n"), /\[paste #/);
		target.handleInput("\x7f");
		assert.equal(target.getText(), "wor");
	});

	it("undoes literal setText of the same canonical content back to a folded draft", () => {
		const target = editor();
		paste(target);
		target.setText(payload);
		target.handleInput("\x1b[45;5u");
		target.handleInput("\x7f");
		assert.equal(target.getText(), "");
	});

	it("preserves slash-confirm clear-before-submit notifications", async () => {
		const target = editor();
		target.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "hello" }], "/tmp"));
		target.setText("/he");
		const events: string[] = [];
		target.onChange = (text) => events.push(`change:${text}`);
		target.onSubmit = (text) => events.push(`submit:${text}`);
		target.handleInput("\t");
		await new Promise((resolve) => setImmediate(resolve));
		target.handleInput("\r");
		assert.deepEqual(events, ["change:", "submit:/hello"]);
	});
});
