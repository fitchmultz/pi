import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider, AutocompleteSuggestions } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { document, EditorProjection } from "../src/editor-document.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const payload = Array.from({ length: 12 }, (_, i) => `hidden-${i}`).join("\n");

function editor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

function paste(target: Editor, text = payload): void {
	target.handleInput(`\x1b[200~${text}\x1b[201~`);
}

function rendered(target: Editor): string {
	return target.render(80).map(stripVTControlCharacters).join("\n");
}

function labels(target: Editor): string[] {
	return rendered(target).match(/\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]/g) ?? [];
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

const applyCompletion: AutocompleteProvider["applyCompletion"] = (lines, line, col, item, prefix) => {
	const result = [...lines];
	result[line] = result[line]!.slice(0, col - prefix.length) + item.value + result[line]!.slice(col);
	return { lines: result, cursorLine: line, cursorCol: col - prefix.length + item.value.length };
};

describe("Editor canonical document", () => {
	it("projects the first word without consuming unrelated trailing segments", () => {
		const segmenter = new Intl.Segmenter("en", { granularity: "word" });
		const nativeSegment = segmenter.segment.bind(segmenter);
		let consumed = 0;
		segmenter.segment = (text) => {
			const segments = nativeSegment(text);
			const nativeIterator = segments[Symbol.iterator].bind(segments);
			segments[Symbol.iterator] = function* (): Generator<Intl.SegmentData, undefined, unknown> {
				for (const segment of nativeIterator()) {
					consumed++;
					yield segment;
				}
			};
			return segments;
		};
		const projection = new EditorProjection(document("foo bar ".repeat(12_500)));
		for (const segment of projection.segments(0, projection.text.length, segmenter)) {
			assert.equal(segment.segment, "foo");
			break;
		}
		assert.equal(consumed, 1);
	});

	it("exposes normalized content and source coordinates while rendering a collapsed paste", () => {
		const target = editor();
		const changes: string[] = [];
		target.onChange = (text) => changes.push(text);
		paste(target, payload.replaceAll("\n", "\r\n"));
		assert.equal(target.getText(), payload);
		assert.equal(target.getExpandedText(), payload);
		assert.deepEqual(target.getLines(), payload.split("\n"));
		assert.deepEqual(target.getCursor(), { line: 11, col: 9 });
		assert.deepEqual(changes, [payload]);
		assert.equal(labels(target).length, 1);
		assert.ok(!rendered(target).includes("hidden-0"));
	});

	it("keeps a literal label identical to a real paste label editable and literal on submit", () => {
		const target = editor();
		paste(target);
		const label = labels(target)[0]!;
		assert.ok(label);
		target.handleInput("\x01");
		target.insertTextAtCursor(label);
		target.handleInput("\x01");
		target.handleInput("\x1b[C");
		assert.deepEqual(target.getCursor(), { line: 0, col: 1 });
		target.handleInput("\x7f");
		let submitted = "";
		target.onSubmit = (text) => {
			submitted = text;
		};
		target.handleInput("\r");
		assert.equal(submitted, label.slice(1) + payload);
	});

	it("retains killed paste content and its fold after submit clears the draft", () => {
		const target = editor();
		paste(target);
		target.handleInput("\x17");
		assert.equal(target.getExpandedText(), "");
		target.handleInput("next");
		target.handleInput("\r");
		target.handleInput("\x19");
		assert.equal(target.getExpandedText(), payload);
		assert.equal(labels(target).length, 1);
		target.handleInput("\x7f");
		assert.equal(target.getText(), "");
	});

	it("owns duplicate yanks independently when one is deleted", () => {
		const target = editor();
		paste(target);
		target.handleInput("\x17");
		target.handleInput("\x19");
		target.handleInput("\x19");
		assert.equal(target.getExpandedText(), payload + payload);
		assert.equal(labels(target).length, 2);
		target.handleInput("\x01");
		target.handleInput("\x1b[3~");
		assert.equal(target.getExpandedText(), payload);
		assert.equal(labels(target).length, 1);
		target.handleInput("\x1b[C");
		assert.deepEqual(target.getCursor(), { line: 11, col: 9 });
		target.handleInput("\x7f");
		assert.equal(target.getText(), "");
	});

	it("restores folded history drafts after history replaces the active document", () => {
		const target = editor();
		target.addToHistory("old prompt");
		paste(target);
		target.handleInput("\x01");
		target.handleInput("\x1b[A");
		assert.equal(target.getText(), "old prompt");
		target.handleInput("\x05");
		target.handleInput("\x1b[B");
		assert.equal(target.getExpandedText(), payload);
		assert.equal(labels(target).length, 1);
		assert.deepEqual(target.getCursor(), { line: 0, col: 0 });
		target.handleInput("\x1b[3~");
		assert.equal(target.getText(), "");
	});

	it("setText treats label text literally and undo restores the original folded draft", () => {
		const target = editor();
		paste(target);
		const label = labels(target)[0]!;
		target.setText(label);
		assert.equal(target.getExpandedText(), label);
		target.handleInput("\x1b[D");
		assert.deepEqual(target.getCursor(), { line: 0, col: label.length - 1 });
		target.handleInput("\x1b[45;5u");
		assert.equal(target.getExpandedText(), payload);
		assert.equal(labels(target).length, 1);
		target.handleInput("\x7f");
		assert.equal(target.getText(), "");
	});

	for (const [name, home, end] of [
		["Home/End", "\x1b[H", "\x1b[F"],
		["Ctrl+A/E", "\x01", "\x05"],
	]) {
		it(`${name} and Ctrl+U/K use visible boundaries across hidden newlines`, () => {
			const target = editor();
			target.setText("before\nA");
			paste(target);
			target.handleInput("B");
			target.handleInput(home!);
			assert.deepEqual(target.getCursor(), { line: 1, col: 0 });
			target.handleInput(end!);
			assert.deepEqual(target.getCursor(), { line: 12, col: 10 });
			target.handleInput("\x15");
			assert.equal(target.getText(), "before\n");
			target.handleInput("\x19");
			assert.equal(target.getExpandedText(), `before\nA${payload}B`);
			assert.equal(labels(target).length, 1);
			target.handleInput(home!);
			target.handleInput("\x0b");
			assert.equal(target.getText(), "before\n");
			target.handleInput("\x19");
			assert.equal(target.getExpandedText(), `before\nA${payload}B`);
			assert.equal(labels(target).length, 1);
		});
	}

	it("does not enter history at source column zero immediately after a folded newline", () => {
		const target = editor();
		target.addToHistory("old prompt");
		paste(target, `${payload}\n`);
		assert.deepEqual(target.getCursor(), { line: 12, col: 0 });
		target.handleInput("\x1b[A");
		assert.equal(target.getExpandedText(), `${payload}\n`);
		assert.deepEqual(target.getCursor(), { line: 0, col: 0 });
		target.handleInput("\x1b[A");
		assert.equal(target.getText(), "old prompt");
	});
});

describe("Editor canonical completion", () => {
	it("unfolds a provider-selected interior cursor before notifying or editing", async () => {
		const target = editor();
		paste(target);
		target.setAutocompleteProvider({
			getSuggestions: async () => ({ prefix: "", items: [{ value: "go", label: "go" }] }),
			applyCompletion: (lines) => ({ lines, cursorLine: 5, cursorCol: 2 }),
		});
		const changes: Array<{ text: string; cursor: { line: number; col: number }; labels: string[] }> = [];
		target.onChange = (text) => changes.push({ text, cursor: target.getCursor(), labels: labels(target) });
		target.handleInput("\t");
		await flushAutocomplete();
		assert.deepEqual(changes, [{ text: payload, cursor: { line: 5, col: 2 }, labels: [] }]);

		target.handleInput("\x7f");
		assert.equal(target.getText(), payload.replace("hidden-5", "hdden-5"));
		assert.deepEqual(target.getCursor(), { line: 5, col: 1 });
		target.handleInput("\x1b[45;5u");
		target.handleInput("\x1b[45;5u");
		assert.equal(target.getText(), payload);
		assert.equal(labels(target).length, 1);
		assert.deepEqual(target.getCursor(), { line: 11, col: 9 });
	});

	it("rejects a completion prefix that begins inside a folded payload", async () => {
		const target = editor();
		const hidden = `${payload}\n./sr`;
		paste(target, hidden);
		target.handleInput("c");
		let applied = false;
		target.setAutocompleteProvider({
			getSuggestions: async () => ({ prefix: "./src", items: [{ value: "./src/", label: "./src/" }] }),
			applyCompletion: (...args) => {
				applied = true;
				return applyCompletion(...args);
			},
		});
		target.handleInput("\t");
		await flushAutocomplete();
		assert.equal(applied, false);
		assert.equal(target.getExpandedText(), `${hidden}c`);
		assert.equal(target.isShowingAutocomplete(), false);
	});

	it("bounds line-scoped completion to editable text between adjacent folds", async () => {
		const target = editor();
		paste(target);
		target.handleInput("ab");
		paste(target);
		target.handleInput("\x1b[D");
		let requests = 0;
		target.setAutocompleteProvider({
			inputContext: "line",
			getSuggestions: async (lines, line, col, options) => {
				requests++;
				assert.deepEqual(lines, ["ab"]);
				assert.equal(line, 0);
				assert.equal(col, 2);
				assert.equal(options.force, true);
				assert.equal(options.slashCommands, false);
				return { prefix: "ab", items: [{ value: "abc", label: "abc" }] };
			},
			applyCompletion,
		});
		target.handleInput("\t");
		await flushAutocomplete();
		assert.equal(requests, 1);
		assert.equal(target.getExpandedText(), `${payload}abc${payload}`);
		assert.equal(labels(target).length, 2);
	});

	for (const inside of [false, true]) {
		it(`accepts full-document provider replacements ${inside ? "inside" : "outside"} a fold`, async () => {
			const target = editor();
			target.setText("before\n");
			paste(target);
			target.handleInput("\n");
			target.handleInput("query");
			const original = `before\n${payload}\nquery`;
			const expected = inside ? original.replace("hidden-5", "changed-5") : original.replace("before", "BEFORE");
			target.setAutocompleteProvider({
				getSuggestions: async (lines, line, col) => {
					assert.equal(lines.join("\n"), original);
					assert.equal(line, 13);
					assert.equal(col, 5);
					return { prefix: "query", items: [{ value: "transform", label: "transform" }] };
				},
				applyCompletion: () => ({ lines: expected.split("\n"), cursorLine: 13, cursorCol: 5 }),
			});
			target.handleInput("\t");
			await flushAutocomplete();
			assert.equal(target.getExpandedText(), expected);
			assert.equal(labels(target).length, inside ? 0 : 1);
			target.handleInput("\x1b[45;5u");
			assert.equal(target.getExpandedText(), original);
			assert.equal(labels(target).length, 1);
		});
	}

	it("rejects a stale completion after undo returns to identical text and cursor", async () => {
		const target = editor();
		target.setText("query");
		let resolve!: (value: AutocompleteSuggestions) => void;
		const pending = new Promise<AutocompleteSuggestions>((done) => {
			resolve = done;
		});
		target.setAutocompleteProvider({ getSuggestions: async () => pending, applyCompletion });
		target.handleInput("\t");
		await flushAutocomplete();
		target.setText("changed");
		target.handleInput("\x1b[45;5u");
		assert.equal(target.getText(), "query");
		assert.deepEqual(target.getCursor(), { line: 0, col: 5 });
		resolve({ prefix: "query", items: [{ value: "stale", label: "stale" }] });
		await flushAutocomplete();
		assert.equal(target.getText(), "query");
		assert.equal(target.isShowingAutocomplete(), false);
	});
});
