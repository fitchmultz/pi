import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Box } from "../src/components/box.ts";
import { HStack } from "../src/components/h-stack.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { visibleWidth } from "../src/utils.ts";
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

	for (const { name, markdown, first, last, expected, width = 34, collect = false, hyperlinks = true } of [
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
				const firstRow = lines.findIndex((line) => line.includes(first));
				const lastRow = lines.findIndex((line, index) => index >= firstRow && line.includes(last));
				assert.ok(firstRow >= 0 && lastRow >= firstRow, lines.join("\n"));
				const start = visibleWidth(lines[firstRow].slice(0, lines[firstRow].indexOf(first)));
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
});
