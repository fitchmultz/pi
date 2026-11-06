import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Container, Markdown, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
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
});
