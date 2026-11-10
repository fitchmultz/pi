import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Container, Markdown, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import { VisualLinePreview } from "../src/modes/interactive/components/visual-truncate.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("source selection in native renderers", () => {
	it("copies a transformed Mermaid diagram as visible text without ANSI source fragments", async () => {
		initTheme("dark");
		const transform = createMermaidMarkdownTransformer({ getMode: () => "streaming", theme });
		const terminal = new VirtualTerminal(40, 10);
		let copied: string | undefined;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		tui.addChild(
			new Markdown("```mermaid\ngraph LR\nA-->B\n```", 0, 0, getMarkdownTheme(), undefined, {
				transform: (markdown, availableWidth) =>
					transform(markdown, { availableWidth, isStreaming: false, messageType: "assistant" }),
			}),
		);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;40;3M");
			terminal.sendInput("\x1b[<0;40;3m");
			await terminal.waitForRender();
			expect(copied).toBe("┌───┐    ┌───┐\n│ A ├───▶│ B │\n└───┘    └───┘");
		} finally {
			tui.stop();
		}
	});

	it("keeps preview source and raw hint row boundaries after garbage collection", async () => {
		const terminal = new VirtualTerminal(24, 10);
		let copied: string | undefined;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		const container = new Container();
		container.addChild(new Text("$ ls", 0, 0));
		container.addChild(
			new VisualLinePreview({
				text: "a-long-filename-that-wraps.txt\nb.txt\nc.txt",
				maxVisualLines: 2,
				keep: "start",
				formatHint: () => "... more",
			}),
		);
		tui.addChild(container);
		tui.start();
		try {
			await terminal.waitForRender();
			setFlagsFromString("--expose-gc");
			const gc = runInNewContext("gc") as () => void;
			await new Promise((resolve) => setImmediate(resolve));
			gc();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;24;4M");
			terminal.sendInput("\x1b[<0;24;4m");
			await terminal.waitForRender();
			expect(copied).toBe("$ ls\na-long-filename-that-wraps.txt\n... more");
		} finally {
			tui.stop();
		}
	});

	// Both previews cache lines of a retained Text. The cache must not replay a frame's lines to another caller,
	// nor that caller's lines to the next frame.
	it("returns preview lines without private markers after a fullscreen frame and keeps the frame source-aware", async () => {
		initTheme("dark");
		const terminal = new VirtualTerminal(40, 12);
		let copied: string | undefined;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		const preview = new VisualLinePreview({
			text: "tool\toutput",
			maxVisualLines: 2,
			keep: "start",
			formatHint: () => "... more",
		});
		const shell = new BashExecutionComponent("printf", tui);
		shell.appendOutput("shell\toutput");
		shell.setComplete(0, false);
		tui.addChild(preview);
		tui.addChild(shell);
		tui.start();
		try {
			await terminal.waitForRender();
			expect(preview.render(40)).toEqual([`tool   output${" ".repeat(27)}`]);
			for (const line of shell.render(40)) expect(line).not.toContain("\x1b]pi:");
			tui.requestRender();
			await terminal.waitForRender();
			const copy = (first: string) => {
				const lines = terminal.getViewport();
				const row = lines.findIndex((line) => line.includes(first));
				const start = lines[row].indexOf(first);
				terminal.sendInput(`\x1b[<0;${start + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${start + 14};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${start + 14};${row + 1}m`);
				return copied;
			};
			expect(copy("tool")).toBe("tool\toutput");
			expect(copy("shell")).toBe("shell\toutput");
		} finally {
			tui.stop();
		}
	});
});
