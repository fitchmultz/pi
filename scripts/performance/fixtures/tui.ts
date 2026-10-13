// N controls repetitions; SIZE controls source characters; DEPTH and LEAVES control tree shape.
// Times are CPU/wall measurements, not terminal-emulator throughput or allocation estimates.
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "/pi-performance-source/packages/ai/src/types.ts";
import type { SessionTreeNode } from "/pi-performance-source/packages/coding-agent/src/core/session-manager.ts";
import { AssistantMessageComponent } from "/pi-performance-source/packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { createMermaidMarkdownTransformer } from "/pi-performance-source/packages/coding-agent/src/modes/interactive/components/mermaid.ts";
import { TreeSelectorComponent } from "/pi-performance-source/packages/coding-agent/src/modes/interactive/components/tree-selector.ts";
import { truncateToVisualLines } from "/pi-performance-source/packages/coding-agent/src/modes/interactive/components/visual-truncate.ts";
import {
	getMarkdownTheme,
	initTheme,
} from "/pi-performance-source/packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { Editor } from "/pi-performance-source/packages/tui/src/components/editor.ts";
import { Input } from "/pi-performance-source/packages/tui/src/components/input.ts";
import type { MarkdownTheme } from "/pi-performance-source/packages/tui/src/components/markdown.ts";
import type { Terminal } from "/pi-performance-source/packages/tui/src/terminal.ts";
import { TuiMainScreen } from "/pi-performance-source/packages/tui/src/tui-main-screen.ts";
import { visibleWidth, wrapTextWithAnsi } from "/pi-performance-source/packages/tui/src/utils.ts";
import { witness } from "../proof.mjs";

class NullTerminal implements Terminal {
	columns = 100;
	rows = 30;
	start() {}
	stop() {}
	async drainInput() {}
	write() {}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
	get kittyProtocolActive() {
		return false;
	}
}

initTheme("dark");
const scenario = process.argv[2] ?? "probe";
const count = Number(process.env.N ?? 40);
const size = Number(process.env.SIZE ?? 16000);
let checksum = 0;
let lastOutput: unknown;
function measure(name: string, iterations: number, fn: (index: number) => void) {
	const cpu = process.cpuUsage();
	const start = performance.now();
	for (let index = 0; index < iterations; index++) fn(index);
	const elapsedMs = performance.now() - start;
	const usage = process.cpuUsage(cpu);
	console.log(
		JSON.stringify({
			name,
			iterations,
			elapsedMs,
			msPerOp: elapsedMs / iterations,
			cpuMs: (usage.user + usage.system) / 1000,
			checksum,
		}),
	);
	witness(name, { iterations, size }, lastOutput);
}
function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}
let highlights = 0;
const identity = (text: string) => text;
const realHighlighter = process.env.REAL_HIGHLIGHT === "1" ? getMarkdownTheme().highlightCode : undefined;
const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
	highlightCode(code, lang) {
		highlights++;
		return realHighlighter ? realHighlighter(code, lang) : code.split("\n");
	},
};
function stream(iterations: number, sourceSize: number) {
	const component = new AssistantMessageComponent(undefined, false, theme);
	const completed = `\`\`\`ts\n${"const unchanged = 1;\n".repeat(Math.ceil(sourceSize / 21))}\`\`\``;
	const msg = message([
		{ type: "thinking", thinking: completed },
		{ type: "text", text: "growing answer" },
	]);
	component.updateContent(msg, true);
	component.render(100);
	highlights = 0;
	measure("assistant-stream", iterations, (index) => {
		// Providers may reuse the same message object while mutating its blocks.
		msg.content[1] = { type: "text", text: `growing answer ${"word ".repeat(index + 1)}` };
		component.updateContent(msg, true);
		const result = component.render(100);
		lastOutput = result;
		checksum += result.length;
	});
	console.log(JSON.stringify({ unchangedBlockHighlightCalls: highlights, sourceSize }));
}
function tree(depth: number, leaves: number, instrument = false) {
	let reads = 0;
	const make = (id: string, parentId: string | null, visible: boolean): SessionTreeNode => {
		const entry = visible
			? {
					type: "message" as const,
					id,
					parentId,
					timestamp: "2026-01-01",
					message: { role: "user" as const, content: "needleq", timestamp: 0 },
				}
			: { type: "model_change" as const, id, parentId, timestamp: "2026-01-01", provider: "faux", modelId: "faux" };
		if (instrument)
			Object.defineProperty(entry, "parentId", {
				get() {
					reads++;
					return parentId;
				},
			});
		return { entry, children: [] };
	};
	const root = make("root", null, false);
	let parent = root;
	for (let i = 1; i < depth; i++) {
		const child = make(`hidden${i}`, parent.entry.id, false);
		parent.children.push(child);
		parent = child;
	}
	for (let i = 0; i < leaves; i++) parent.children.push(make(`visible${i}`, parent.entry.id, true));
	const selector = new TreeSelectorComponent(
		[root],
		null,
		30,
		() => {},
		() => {},
	);
	reads = 0;
	return { selector, getReads: () => reads };
}
if (scenario === "probe") {
	stream(2, 80);
	const t = tree(10, 3, true);
	t.selector.handleInput("q");
	console.log(
		JSON.stringify({
			treeHiddenDepth: 10,
			visibleLeaves: 3,
			parentIdReadsForFilter: t.getReads(),
			renderedTreeRows: t.selector.render(80).length,
		}),
	);
	const transform = createMermaidMarkdownTransformer({ getMode: () => "streaming" });
	for (const value of [
		"plain prose",
		"line\r\nnext",
		"line\rnext",
		"[foo]: https://example.com\n\n[foo]",
		"\tindented\n",
		"    \n\n",
	]) {
		const rendered = transform(value, { messageType: "assistant", isStreaming: true, availableWidth: 98 });
		console.log(
			JSON.stringify({ noMermaidInput: value, noMermaidOutput: rendered, byteIdentical: rendered === value }),
		);
	}
	for (const value of ["x".repeat(81), `\x1b[31m${"x".repeat(81)}\x1b[0m`, "👨‍👩‍👧‍👦漢字".repeat(8)]) {
		const lines = wrapTextWithAnsi(value, 20);
		if (lines.some((line) => visibleWidth(line) > 20)) throw new Error("over-wide wrap probe");
		console.log(JSON.stringify({ wrapInputBytes: Buffer.byteLength(value), lines: lines.length }));
	}
} else if (scenario === "stream") {
	stream(count, size);
} else if (scenario === "mermaid") {
	const transform = createMermaidMarkdownTransformer({ getMode: () => "streaming" });
	const source = "Normal **prose** with a [link](https://example.com) and no diagram.\n\n".repeat(
		Math.ceil(size / 68),
	);
	measure("mermaid-transform-no-diagram", count, () => {
		const result = transform(source, { messageType: "assistant", isStreaming: true, availableWidth: 98 });
		lastOutput = result;
		checksum += result.length;
	});
} else if (scenario === "wrap" || scenario === "preview") {
	for (const [kind, source] of [
		["ascii-long-token", "x".repeat(size)],
		["ansi-long-token", `\x1b[31m${"x".repeat(size)}\x1b[0m`],
		["ascii-prose", "representative tool output ".repeat(Math.ceil(size / 27))],
		["unicode", "漢字👨‍👩‍👧‍👦 ".repeat(Math.ceil(size / 17))],
	]) {
		measure(`${scenario}-${kind}`, count, () => {
			if (scenario === "wrap") {
				const result = wrapTextWithAnsi(source, 98);
				lastOutput = result;
				checksum += result.length;
			} else {
				const result = truncateToVisualLines(source, 5, 98, 0, "end");
				lastOutput = result;
				checksum += result.skippedCount + result.visualLines.length;
			}
		});
	}
} else if (scenario === "editor") {
	const editor = new Editor(new TuiMainScreen(new NullTerminal()), {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	});
	editor.setText("word ".repeat(Math.ceil(size / 5)));
	editor.render(100);
	measure("unchanged-large-editor", count, () => {
		const result = editor.render(100);
		lastOutput = result;
		checksum += result.length;
	});
	measure("cursor-movement-large-editor", count, () => {
		editor.handleInput("\x1b[D");
		const result = editor.render(100);
		lastOutput = result;
		checksum += result.length;
	});
} else if (scenario === "input") {
	const input = new Input();
	input.setValue("a".repeat(size));
	input.handleInput("\x01");
	measure("input-right-large-value", count, () => {
		input.handleInput("\x1b[C");
		const result = input.getValue();
		lastOutput = result;
		checksum += result.length;
	});
	witness("input-render", { size, count }, input.render(100));
} else if (scenario === "tree") {
	const depth = Number(process.env.DEPTH ?? 1000);
	const leaves = Number(process.env.LEAVES ?? 1000);
	const t = tree(depth, leaves);
	measure(`tree-filter-${depth}x${leaves}`, count, () => {
		t.selector.handleInput("q");
		t.selector.handleInput("\x7f");
		lastOutput = t.selector.getTreeList().getSelectedNode()?.entry.id;
		checksum += typeof lastOutput === "string" ? lastOutput.length : 0;
	});
	witness("tree-render", { depth, leaves }, t.selector.render(80));
} else if (scenario === "primitives") {
	const editorTheme = {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
	// Same warm operations and inputs as the original paired probe, without copying production owners.
	function warmed(name: string, repetitions: number, fn: (i: number) => void) {
		for (let i = 0; i < Math.min(repetitions, 40); i++) fn(i);
		measure(name, repetitions, fn);
	}
	for (const sourceSize of [40, size]) {
		const editor = new Editor(new TuiMainScreen(new NullTerminal()), editorTheme);
		editor.setText("word ".repeat(Math.ceil(sourceSize / 5)));
		editor.render(100);
		const repetitions = process.env.PERF_SMOKE === "1" ? 2 : sourceSize === 40 ? 10000 : 40;
		const render = () => {
			const result = editor.render(100);
			lastOutput = result;
			checksum += result.length;
		};
		warmed(`editor-unchanged-${sourceSize}`, repetitions, render);
		editor.handleInput("\x01");
		warmed(`editor-cursor-${sourceSize}`, repetitions, (i) => {
			editor.handleInput(i % 2 ? "\x1b[D" : "\x1b[C");
			render();
		});
		if (sourceSize !== 40)
			warmed(`editor-typing-${sourceSize}`, repetitions, () => {
				editor.handleInput("x");
				render();
			});
	}
	const unicode = "漢字👨‍👩‍👧‍👦 ".repeat(process.env.PERF_SMOKE === "1" ? 3 : 1000);
	const editor = new Editor(new TuiMainScreen(new NullTerminal()), editorTheme);
	editor.setText(unicode);
	editor.render(100);
	warmed(`editor-typing-unicode-${unicode.length}`, process.env.PERF_SMOKE === "1" ? 2 : 40, () => {
		editor.handleInput("x");
		const result = editor.render(100);
		lastOutput = result;
		checksum += result.length;
	});
	const wrapSize = process.env.PERF_SMOKE === "1" ? size : 50000;
	for (const source of ["x".repeat(wrapSize), `\x1b[4;44m${"x".repeat(wrapSize)}\x1b[24m\x1b[0m`]) {
		warmed(`wrap-${source.length}`, count, () => {
			const result = wrapTextWithAnsi(source, 98);
			lastOutput = result;
			checksum += result.length;
		});
	}
	const input = new Input();
	input.setValue("a".repeat(process.env.PERF_SMOKE === "1" ? 40 : 10000));
	input.handleInput("\x01");
	warmed("input-right", process.env.PERF_SMOKE === "1" ? 2 : 100, () => {
		input.handleInput("\x1b[C");
		const result = input.getValue();
		lastOutput = result;
		checksum += result.length;
	});
	witness("input-render", { scenario }, input.render(100));
} else throw new Error(`Unknown scenario: ${scenario}`);
