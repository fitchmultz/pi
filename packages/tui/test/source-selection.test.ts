import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Box } from "../src/components/box.ts";
import { HStack } from "../src/components/h-stack.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { SELECTION_SOURCE_END } from "../src/selection-markers.ts";
import { copySelectionSource, renderForSelectionReader } from "../src/selection-source.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { sliceWithWidth, visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const response = `**Yes—I’d switch it from Performance to Balanced for always-on use.** It’s currently set to Performance, including the CPU’s energy preference.

The good news from the live check:
- The machine is almost completely idle.
- The **RTX 4080 is already drawing only about 12 W**, in its low-power state.
- The inference service is still stopped and disabled.

My recommendation:

1. **Use Balanced as the default.** That’s the sensible starting point before trying aggressive CPU limits or undervolting.
2. **Keep the 6.0 GHz stability ceiling.** Don’t restore the problematic 6.2 GHz setting.
3. **Let the display turn off, but keep the computer awake** if you want SSH and remote jobs available anytime.
4. **Leave inference manual-start.** No reason to keep its model loaded while unused.

We still need a **wall-power measurement** to know the actual electricity cost. The GPU’s 12 W excludes the CPU, motherboard, RAM, fans, and power-supply losses. Balanced might help, but I wouldn’t promise a large idle-power reduction without measuring it.

**No settings changed yet.**`;

describe("source-aware fullscreen selection", () => {
	it("copies the highlighted response as original Markdown rather than padded display rows", async () => {
		const terminal = new VirtualTerminal(72, 70);
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			assert.ok(!data.includes("\x1b]pi:"), "selection metadata must not reach the terminal");
			write(data);
		};
		let copied: string | undefined;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		const box = new Box(1, 0);
		box.addChild(new Markdown(response, 1, 0, defaultMarkdownTheme));
		tui.addChild(box);
		tui.start();
		try {
			await terminal.waitForRender();
			const lines = terminal.getViewport();
			const firstRow = lines.findIndex((line) => line.includes("Yes—I’d switch"));
			const lastRow = lines.findIndex((line) => line.includes("No settings changed yet."));
			assert.ok(firstRow >= 0 && lastRow > firstRow);
			terminal.sendInput(`\x1b[<0;1;${firstRow + 1}M`);
			terminal.sendInput(`\x1b[<32;70;${lastRow + 1}M`);
			terminal.sendInput(`\x1b[<0;70;${lastRow + 1}m`);
			await terminal.waitForRender();
			assert.equal(copied, response);
		} finally {
			tui.stop();
		}
	});

	for (const {
		name,
		markdown,
		first,
		last,
		expected,
		width = 34,
		collect = false,
		hyperlinks = true,
		startRowDelta = 0,
	} of [
		{
			name: "a complete bold phrase within a response",
			markdown: "Before. **Use Balanced as the default.** After.",
			first: "Use",
			last: "default.",
			expected: "**Use Balanced as the default.**",
		},
		{
			name: "only the highlighted words inside bold text",
			markdown: "Before. **Use Balanced as the default.** After.",
			first: "Balanced",
			last: "Balanced",
			expected: "Balanced",
		},
		{
			name: "a partial paragraph across visual wraps",
			markdown:
				"Before. The GPU’s **12 W** excludes the CPU, motherboard, RAM, fans, and power-supply losses. After.",
			first: "The",
			last: "losses.",
			expected: "The GPU’s **12 W** excludes the CPU, motherboard, RAM, fans, and power-supply losses.",
		},
		{
			name: "one ordered list item with its original marker",
			markdown:
				"3) First item.\n4) **Keep the 6.0 GHz stability ceiling.** Don’t restore the problematic setting.\n5) Final item.",
			first: "4.",
			last: "setting.",
			expected: "4) **Keep the 6.0 GHz stability ceiling.** Don’t restore the problematic setting.",
		},
		{
			name: "an inline code fragment without unselected words",
			markdown: "Run `npm run check --workspace=tui` before committing.",
			first: "check",
			last: "tui",
			expected: "check --workspace=tui",
		},
		{
			name: "an entire Markdown link",
			markdown: "Read [the documentation](https://example.com/docs) before continuing.",
			first: "the",
			last: "documentation",
			expected: "[the documentation](https://example.com/docs)",
		},
		{
			name: "a URL printed by the non-hyperlink fallback",
			markdown: "Read [docs](https://example.com/docs) before continuing.",
			first: "https",
			last: "/docs",
			expected: "https://example.com/docs",
			width: 60,
			hyperlinks: false,
		},
		{
			name: "a long unbroken URL",
			markdown: "Before https://example.com/this/is/a/long/path/without/any/spaces?ready=yes after.",
			first: "https",
			last: "yes",
			expected: "https://example.com/this/is/a/long/path/without/any/spaces?ready=yes",
		},
		{
			name: "code lines with meaningful indentation and tabs",
			markdown: "Before.\n\n~~~ts\nif (ready) {\n\t  work();\n}\n~~~\n\nAfter.",
			first: "if (ready)",
			last: "}",
			expected: "if (ready) {\n\t  work();\n}",
		},
		{
			name: "source line endings instead of layout line endings",
			markdown: "Before.\r\n\r\nFirst **line** here.\r\nSecond line here.\r\n\r\nAfter.",
			first: "First",
			last: "Second line here.",
			expected: "First **line** here.\r\nSecond line here.",
			width: 60,
		},
		{
			name: "Unicode source positions",
			markdown: "Before. **中文 👩🏽‍💻 café é** follows. After.",
			first: "中文",
			last: "é",
			expected: "**中文 👩🏽‍💻 café é**",
			width: 60,
		},
		{
			name: "a selection spanning partial and complete paragraphs",
			markdown: "Before.\n\nFirst **paragraph** here.\n\nSecond paragraph here.\n\nAfter.",
			first: "paragraph",
			last: "Second paragraph here.",
			expected: "**paragraph** here.\n\nSecond paragraph here.",
			width: 60,
		},
		{
			name: "a nested list with source indentation",
			markdown: "- Parent\n  + Child **one**\n    - Deep child\n  + Child two\n- Last",
			first: "- Parent",
			last: "- Last",
			expected: "- Parent\n  + Child **one**\n    - Deep child\n  + Child two\n- Last",
			width: 60,
		},
		{
			name: "a blockquote with original source prefixes",
			markdown: "> First **quoted** line.\n> Second quoted line.",
			first: "First",
			last: "Second quoted line.",
			expected: "> First **quoted** line.\n> Second quoted line.",
			width: 60,
		},
		{
			name: "a cell without the table borders or other cells",
			markdown: "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |",
			first: "Alice",
			last: "Alice",
			expected: "Alice",
			width: 60,
		},
		{
			name: "text in a table rendered as raw Markdown at a narrow width",
			markdown: "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |",
			first: "Alice",
			last: "Alice",
			expected: "Alice",
			width: 12,
		},
		{
			name: "the source of a complete table",
			markdown: "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |",
			first: "Name",
			last: "25",
			expected: "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |",
			width: 60,
		},
		{
			name: "a partial bold phrase followed immediately by a list",
			markdown: "Some **intro sentence**\n- item one\n- item two",
			first: "sentence",
			last: "item two",
			expected: "sentence\n- item one\n- item two",
			width: 100,
		},
		{
			name: "a partial paragraph followed immediately by a heading",
			markdown: "Some intro sentence\r\n# Heading here",
			first: "intro",
			last: "Heading here",
			expected: "intro sentence\r\n# Heading here",
			width: 100,
		},
		{
			name: "a partial paragraph followed immediately by a quote",
			markdown: "Some intro sentence\n> Quoted text",
			first: "intro",
			last: "Quoted text",
			expected: "intro sentence\n> Quoted text",
			width: 100,
		},
		{
			name: "a partial paragraph followed immediately by a fence",
			markdown: "Some intro sentence\n```\ncode\n```",
			first: "intro",
			last: "code",
			expected: "intro sentence\n```\ncode",
			width: 100,
		},
		{
			name: "a formatted reference link without terminal hyperlinks",
			markdown: "Use **[Balanced][mode]** as the default.\n\n[mode]: https://example.com/balanced",
			first: "Balanced",
			last: "/balanced)",
			expected: "**[Balanced][mode]**",
			width: 100,
			hyperlinks: false,
		},
		{
			name: "only a reference link's displayed URL",
			markdown: "Use **[Balanced][mode]** as the default.\n\n[mode]: https://example.com/balanced",
			first: "https",
			last: "/balanced",
			expected: "https://example.com/balanced",
			width: 100,
			hyperlinks: false,
		},
		{
			name: "a response with reference definitions between visible blocks",
			markdown: "Intro\n\nSee [text][ref] for details.\n\n[ref]: https://example.com/path\n\nOutro",
			first: "Intro",
			last: "Outro",
			expected: "Intro\n\nSee [text][ref] for details.\n\n[ref]: https://example.com/path\n\nOutro",
			width: 100,
		},
		{
			name: "a response ending in a reference definition",
			markdown: "Use **[Balanced][mode]** as the default.\n\n[mode]: https://example.com/balanced",
			first: "Use",
			last: "default.",
			expected: "Use **[Balanced][mode]** as the default.\n\n[mode]: https://example.com/balanced",
			width: 100,
			hyperlinks: false,
		},
		{
			name: "a response starting with a reference definition",
			markdown: "[ref]: https://example.com/path\n\nSee [text][ref] for details.",
			first: "See",
			last: "details.",
			expected: "[ref]: https://example.com/path\n\nSee [text][ref] for details.",
			width: 100,
		},
		{
			name: "only a paragraph before an unselected reference definition",
			markdown: "Intro\n\n[ref]: https://example.com/path\n\nOutro with [text][ref] here.",
			first: "Intro",
			last: "Intro",
			expected: "Intro",
			width: 100,
		},
		{
			name: "a partial response without pulling in earlier reference definitions",
			markdown: "Intro\n\n[ref]: https://example.com/path\n\nOutro with [text][ref] here.",
			first: "Outro",
			last: "here.",
			expected: "Outro with [text][ref] here.",
			width: 100,
		},
		{
			name: "a partial heading followed immediately by a paragraph",
			markdown: "# Head\nPara text",
			first: "ead",
			last: "Para text",
			expected: "ead\nPara text",
			width: 100,
		},
		{
			name: "a partial heading followed immediately by a list",
			markdown: "## Head\r\n- item",
			first: "ead",
			last: "item",
			expected: "ead\r\n- item",
			width: 100,
		},
		{
			name: "a partial setext heading followed by a paragraph",
			markdown: "Head\n====\nPara text",
			first: "ead",
			last: "Para text",
			expected: "ead\nPara text",
			width: 100,
		},
		{
			name: "the selected occurrence of a reused paragraph",
			markdown: "Repeat **this**.\n\nBetween.\n\nRepeat **this**.\n\nEnd.",
			first: "Between.",
			last: "End.",
			expected: "Between.\n\nRepeat **this**.\n\nEnd.",
			width: 100,
		},
		{
			name: "paragraphs after an HTML comment containing matching text",
			markdown: "Before.\n\n<!-- Hello -->\n\nHello\n\nWorld",
			first: "Hello",
			last: "World",
			expected: "Hello\n\nWorld",
			width: 60,
		},
		{
			name: "partial paragraphs after a leading HTML comment containing matching text",
			markdown: "<!-- Hello -->\n\nHello\n\nWorld",
			first: "Hello",
			last: "Wor",
			expected: "Hello\n\nWor",
			width: 60,
		},
		{
			name: "only a paragraph before an unselected empty table",
			markdown: "Intro\n\n|  |\n| --- |\n|  |",
			first: "Intro",
			last: "Intro",
			expected: "Intro",
			width: 100,
		},
		{
			name: "only a paragraph before an unselected empty list item",
			markdown: "Intro\n\n- ",
			first: "Intro",
			last: "Intro",
			expected: "Intro",
			width: 100,
		},
		{
			name: "an unmapped empty table as displayed text",
			markdown: "Intro\n\n|  |\n| --- |\n|  |",
			first: "┌",
			last: "┘",
			expected: "┌───┐\n  │   │\n  ├───┤\n  │   │\n  └───┘",
			width: 100,
		},
		{
			name: "only a paragraph before an unselected empty heading",
			markdown: "Intro\n\n# ",
			first: "Intro",
			last: "Intro",
			expected: "Intro",
			width: 100,
		},
		{
			name: "only a paragraph before an unselected empty quote",
			markdown: "Intro\n\n>",
			first: "Intro",
			last: "Intro",
			expected: "Intro",
			width: 100,
		},
		{
			name: "an indented-code fence decoration as displayed text",
			markdown: "Before.\n\n    hello()\n\nAfter.",
			first: "```",
			last: "```",
			expected: "```",
			width: 100,
		},
		{
			name: "a fence decoration with its preceding blank row",
			markdown: "Before.\n\n    hello()\n\nAfter.",
			first: "```",
			last: "```",
			expected: "\n  ```",
			startRowDelta: -1,
			width: 100,
		},
		{
			name: "an incomplete fence as displayed text",
			markdown: "```",
			first: "```",
			last: "```",
			expected: "```",
			width: 100,
		},
		{
			name: "cached source after parser and block caches are collected",
			markdown: "Before. **Use Balanced as the default.** After.",
			first: "Use",
			last: "default.",
			expected: "**Use Balanced as the default.**",
			collect: true,
		},
	]) {
		it(`copies ${name}`, async () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks });
			const terminal = new VirtualTerminal(width, 30);
			let copied: string | undefined;
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied = text;
					return true;
				},
			});
			tui.addChild(new Markdown(markdown, 2, 0, defaultMarkdownTheme));
			tui.start();
			try {
				await terminal.waitForRender();
				if (collect) {
					setFlagsFromString("--expose-gc");
					const gc = runInNewContext("gc") as () => void;
					await new Promise((resolve) => setImmediate(resolve));
					gc();
				}
				const lines = terminal.getViewport();
				const firstRow = lines.findIndex((line) => line.includes(first)) + startRowDelta;
				const lastRow = lines.findIndex((line, index) => index >= firstRow && line.includes(last));
				assert.ok(firstRow >= 0 && lastRow >= firstRow, lines.join("\n"));
				if (startRowDelta) assert.equal(lines[firstRow].trim(), "");
				const start = startRowDelta ? 0 : visibleWidth(lines[firstRow].slice(0, lines[firstRow].indexOf(first)));
				const end = visibleWidth(lines[lastRow].slice(0, lines[lastRow].indexOf(last) + last.length)) - 1;
				terminal.sendInput(`\x1b[<0;${start + 1};${firstRow + 1}M`);
				terminal.sendInput(`\x1b[<32;${end + 1};${lastRow + 1}M`);
				terminal.sendInput(`\x1b[<0;${end + 1};${lastRow + 1}m`);
				await terminal.waitForRender();
				assert.equal(copied, expected);
			} finally {
				tui.stop();
				resetCapabilitiesCache();
			}
		});
	}

	it("copies wrapped tool text after resizing and scrolling with manual copy", async () => {
		const output = "  Keep this indentation while removing only display wraps.\n\tNext line stays indented.";
		const terminal = new VirtualTerminal(80, 8);
		let copied: string | undefined;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		tui.addChild(new Text("Earlier output\n".repeat(10), 1, 0));
		tui.addChild(new Text(`\x1b[32m${output}\x1b[0m`, 2, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.resize(34, 8);
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			tui.scrollToBottom();
			await terminal.waitForRender();
			assert.ok(tui.viewportTop > 0);
			const lines = terminal.getViewport();
			const firstRow = lines.findIndex((line) => line.includes("Keep this"));
			const lastRow = lines.findIndex((line) => line.includes("indented."));
			assert.ok(firstRow >= 0 && lastRow > firstRow, lines.join("\n"));
			terminal.sendInput(`\x1b[<0;1;${firstRow + 1}M`);
			terminal.sendInput(`\x1b[<32;34;${lastRow + 1}M`);
			terminal.sendInput(`\x1b[<0;34;${lastRow + 1}m`);
			await terminal.waitForRender();
			assert.equal(copied, undefined);
			assert.equal(await tui.copyActiveSelectionToClipboard(), true);
			assert.equal(copied, output);
		} finally {
			tui.stop();
		}
	});

	it("keeps display order when a selection crosses independent horizontal components", async () => {
		for (const left of [new Text("left", 0, 0), { render: () => ["left"], invalidate() {} }]) {
			const terminal = new VirtualTerminal(10, 4);
			let copied: string | undefined;
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied = text;
					return true;
				},
			});
			tui.addChild(
				new HStack(
					[
						{ component: left, basis: 4 },
						{ component: new Text("right", 0, 0), basis: 5 },
					],
					{ gap: 1 },
				),
			);
			tui.start();
			try {
				await terminal.waitForRender();
				assert.equal(terminal.getViewport()[0], "left right");
				terminal.sendInput("\x1b[<0;1;1M");
				terminal.sendInput("\x1b[<32;10;1M");
				terminal.sendInput("\x1b[<0;10;1m");
				await terminal.waitForRender();
				assert.equal(copied, "left right");
			} finally {
				tui.stop();
			}
		}
	});

	it("preserves selection sources across sliceWithWidth ASCII fast-path slices", () => {
		// Pure ASCII line sliced at startCol = 0 breaking at endCol must close with SELECTION_SOURCE_END
		// so trailing text on the same composited row does not inherit the open source run.
		const asciiLine = renderForSelectionReader(() =>
			new Markdown("before **world** after", 0, 0, defaultMarkdownTheme).render(40),
		)[0];
		const prefixSlice = sliceWithWidth(asciiLine, 0, 12, true);
		assert.ok(prefixSlice.text.endsWith(SELECTION_SOURCE_END));
		assert.equal(copySelectionSource([`${prefixSlice.text} plain`], [{ row: 0, start: 13, end: 18 }]), "plain");

		// Pure ASCII slice with startCol > 0 must emit source.marker at the sliced offset and close cleanly.
		const midSlice = sliceWithWidth(asciiLine, 7, 5, true);
		assert.ok(midSlice.text.endsWith(SELECTION_SOURCE_END));
		assert.equal(copySelectionSource([midSlice.text], [{ row: 0, start: 0, end: 5 }]), "**world**");

		// ASCII preceding non-ASCII in the same run must advance the source offset before the non-ASCII text.
		const mixedLine = renderForSelectionReader(() =>
			new Markdown("hello **café** world", 0, 0, defaultMarkdownTheme).render(40),
		)[0];
		const mixedSlice = sliceWithWidth(mixedLine, 6, 4, true);
		assert.equal(copySelectionSource([mixedSlice.text], [{ row: 0, start: 0, end: 4 }]), "**café**");
	});

	it("keeps overlay and base text selection sources isolated on pure ASCII overlay rows", async () => {
		const terminal = new VirtualTerminal(30, 6);
		let copied: string | undefined;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		// Base row has no selection source markers of its own; an overlay that renders wider than its declared width
		// is truncated mid-bold-run by compositeOverlays -> sliceWithWidth, which must close the run before base text.
		tui.addChild({ render: () => ["0123456789abcdefghij0123456789"], invalidate() {} });
		const wideMarkdown = new Markdown("**overlay** text", 0, 0, defaultMarkdownTheme);
		tui.showOverlay(
			{
				render: () => wideMarkdown.render(40),
				invalidate: () => wideMarkdown.invalidate(),
			},
			{
				width: 7,
				anchor: "top-left",
				offsetX: 4,
				offsetY: 0,
			},
		);
		tui.start();
		try {
			await terminal.waitForRender();
			const row = terminal.getViewport()[0];
			assert.ok(row.includes("overlay"), row);
			// Select inside the truncated ASCII overlay (cols 4..10 = "overlay")
			terminal.sendInput("\x1b[<0;5;1M");
			terminal.sendInput("\x1b[<32;11;1M");
			terminal.sendInput("\x1b[<0;11;1m");
			await terminal.waitForRender();
			assert.equal(copied, "**overlay**");

			// Select base text to the right of the overlay (cols 15..20 = "fghij0")
			copied = undefined;
			terminal.sendInput("\x1b[<0;16;1M");
			terminal.sendInput("\x1b[<32;21;1M");
			terminal.sendInput("\x1b[<0;21;1m");
			await terminal.waitForRender();
			assert.equal(copied, "fghij0");
		} finally {
			tui.stop();
		}
	});

	describe("transformed Markdown", () => {
		// Simulates display-only Markdown transformers (such as pi-emphasis): ANSI bold color, prefix icons
		// in headings and bold labels, and rounded status pills using NBSPs (equal length for single-word pills).
		const decorateDisplay = (markdown: string): string =>
			markdown
				.replace(/^## (.+)$/gm, "## \uf002 $1")
				.replace(/\*\*Status:\*\*/g, "**\x1b[34m\uf012 Status:\x1b[39m**")
				.replace(/\*\*Next:\*\*/g, "**\x1b[34m\uf061 Next:\x1b[39m**")
				.replace(/\*\*([^*]+)\*\*/g, (match, inner: string) =>
					inner.startsWith("\x1b[34m") ? match : `**\x1b[34m${inner}\x1b[39m**`,
				)
				.replace(/\[\[([^\]]+)\]\]/g, (_match, label: string) => {
					const body = label.replace(/ /g, "\u00a0");
					return `\x1b[36m\ue0b6\x1b[39m\x1b[36m\x1b[7m\x1b[1m\uf0ad\u00a0${body}\x1b[22;27m\x1b[39m\x1b[49m\x1b[36m\ue0b4\x1b[39m`;
				});

		const selectTransformed = async (
			markdown: string,
			transform: (text: string, width: number) => string,
			first: string,
			last: string,
			width = 50,
		): Promise<string | undefined> => {
			const terminal = new VirtualTerminal(width, 40);
			let copied: string | undefined;
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied = text;
					return true;
				},
			});
			tui.addChild(new Markdown(markdown, 1, 0, defaultMarkdownTheme, undefined, { transform }));
			tui.start();
			try {
				await terminal.waitForRender();
				const lines = terminal.getViewport();
				const firstRow = lines.findIndex((line) => line.includes(first));
				const lastRow = lines.findIndex((line, index) => index >= firstRow && line.includes(last));
				assert.ok(firstRow >= 0 && lastRow >= firstRow, lines.join("\n"));
				const start = visibleWidth(lines[firstRow].slice(0, lines[firstRow].indexOf(first)));
				const end = visibleWidth(lines[lastRow].slice(0, lines[lastRow].indexOf(last) + last.length)) - 1;
				terminal.sendInput(`\x1b[<0;${start + 1};${firstRow + 1}M`);
				terminal.sendInput(`\x1b[<32;${end + 1};${lastRow + 1}M`);
				terminal.sendInput(`\x1b[<0;${end + 1};${lastRow + 1}m`);
				await terminal.waitForRender();
				return copied;
			} finally {
				tui.stop();
			}
		};

		const decoratedReply = `## Finding

**Status:** [[Implement]] All four active watchers are running normally across a long wrapped sentence. **Next:** check [[In progress]].

- Keep **run \`npm test\` now** and **anchor term** clean.

| Check | State |
| --- | --- |
| **Build** | [[Passed 12/12]] |`;

		for (const { name, markdown, transform = decorateDisplay, first, last, expected } of [
			{
				name: "a full decorated reply as original Markdown without icons or wrap breaks",
				markdown: decoratedReply,
				first: "Finding",
				last: "12/12",
				expected: decoratedReply,
			},
			{
				name: "a wrapped paragraph fragment unwrapped across terminal rows",
				markdown: decoratedReply,
				first: "All four",
				last: "sentence.",
				expected: "All four active watchers are running normally across a long wrapped sentence.",
			},
			{
				name: "an icon-prefixed bold label as original Markdown bold without the icon",
				markdown: decoratedReply,
				first: "\uf012",
				last: "Status:",
				expected: "**Status:**",
			},
			{
				name: "an equal-length status pill atomically even when dragging mid-pill",
				markdown: decoratedReply,
				first: "plem",
				last: "All",
				expected: "[[Implement]] All",
			},
			{
				name: "a multi-word NBSP status pill back to its original bracket syntax",
				markdown: decoratedReply,
				first: "In",
				last: "progress",
				expected: "[[In progress]]",
			},
			{
				name: "a heading wrapping bold after an inserted prefix icon",
				markdown: "## **Finding**\n\nBody text.",
				first: "Finding",
				last: "Finding",
				expected: "## **Finding**",
			},
			{
				name: "bold text containing inline code without ANSI offset drift",
				markdown: decoratedReply,
				first: "run npm",
				last: "now",
				expected: "**run `npm test` now**",
			},
			{
				name: "selected original blocks when a transformer prepends a banner",
				markdown: "First paragraph.\n\nSecond paragraph.",
				transform: (md: string) => `> Banner notice\n\n${md}`,
				first: "First",
				last: "Second paragraph.",
				expected: "First paragraph.\n\nSecond paragraph.",
			},
			{
				name: "only the rendered paragraph without resurrecting a deleted block",
				markdown: "First paragraph.\n\nSecond paragraph.",
				transform: () => "Second paragraph.",
				first: "Second",
				last: "paragraph.",
				expected: "Second paragraph.",
			},
			{
				name: "displayed text when a transformer replaces content with unrelated text",
				markdown: "secret original text",
				transform: () => "completely different display widget",
				first: "different",
				last: "widget",
				expected: "different display widget",
			},
		]) {
			it(`copies ${name}`, async () => {
				assert.equal(await selectTransformed(markdown, transform, first, last), expected);
			});
		}

		it("updates cached blocks and stays marker-free outside selection reader renders", () => {
			let streaming = true;
			const md = new Markdown("Hello **world**", 0, 0, defaultMarkdownTheme, undefined, {
				transform: (text) => (streaming ? text : decorateDisplay(text)),
			});
			const plainOutside = md.render(40);
			for (const line of plainOutside) assert.ok(!line.includes("\x1b]pi:"), JSON.stringify(line));

			renderForSelectionReader(() => md.render(40));
			streaming = false;
			md.setText("Hello **world**");
			const decoratedOutside = md.render(40);
			assert.ok(decoratedOutside[0].includes("\x1b[34m"));
			for (const line of decoratedOutside) assert.ok(!line.includes("\x1b]pi:"), JSON.stringify(line));

			const decoratedReader = renderForSelectionReader(() => md.render(40));
			assert.equal(copySelectionSource(decoratedReader, [{ row: 0, start: 0, end: 40 }]), "Hello **world**");
		});
	});
});

describe("selection sources outside the fullscreen renderer", () => {
	// Extensions, the HTML export and the CLI call render() like this: no TUI renders the component.
	it("returns lines without private markers from render()", () => {
		const text = new Text("plain \x1b[32mgreen\x1b[0m", 1, 0);
		const markdown = new Markdown("Use **bold** text.", 0, 0, defaultMarkdownTheme);
		const box = new Box(1, 0);
		box.addChild(new Markdown(response, 1, 0, defaultMarkdownTheme));
		box.addChild(new Text("Earlier output\n".repeat(3), 1, 1));
		assert.deepEqual(text.render(14), [" plain \x1b[32mgreen\x1b[0m  "]);
		assert.deepEqual(markdown.render(20), ["Use \x1b[1mbold\x1b[22m text.      "]);
		for (const line of box.render(40)) assert.ok(!line.includes("\x1b]pi:"), JSON.stringify(line));
	});

	it("keeps the displayed frame source-aware after render() for another caller", async () => {
		const terminal = new VirtualTerminal(60, 10);
		let copied: string | undefined;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		const markdown = new Markdown("Before. **Use Balanced as the default.** After.", 0, 0, defaultMarkdownTheme);
		const text = new Text("tool\toutput", 0, 0);
		tui.addChild(markdown);
		tui.addChild(text);
		tui.start();
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		// Select in the displayed frame after a caller outside it, such as an extension measuring the component,
		// rendered the same components. The frame's sources must outlive that render.
		const copy = async (first: string, last: string) => {
			await terminal.waitForRender();
			assert.deepEqual(markdown.render(60), [
				`Before. \x1b[1mUse Balanced as the default.\x1b[22m After.${" ".repeat(17)}`,
			]);
			assert.deepEqual(text.render(60), [`tool   output${" ".repeat(47)}`]);
			await new Promise((resolve) => setImmediate(resolve));
			gc();
			const lines = terminal.getViewport();
			const row = lines.findIndex((line) => line.includes(first));
			const start = lines[row].indexOf(first);
			const end = lines[row].indexOf(last) + last.length - 1;
			terminal.sendInput(`\x1b[<0;${start + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${end + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${end + 1};${row + 1}m`);
			return copied;
		};
		try {
			assert.equal(await copy("Use", "default."), "**Use Balanced as the default.**");
			assert.equal(await copy("tool", "output"), "tool\toutput");
		} finally {
			tui.stop();
		}
	});
});
