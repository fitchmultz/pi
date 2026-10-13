import { describe, expect, it } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMarkdownTransform } from "../src/modes/interactive/components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transformer(markdown, {
		availableWidth: options.maxWidth ?? 100,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

describe("Mermaid rendering", () => {
	it.each([
		{ name: "CRLF", source: "line\r\nnext\r\n", expected: "line\nnext\n" },
		{ name: "bare CR", source: "line\rnext\r", expected: "line\nnext\n" },
		{ name: "tabs and blank lines", source: "\tcode\n \t \n\nnext\n", expected: "\tcode\n \t \n\nnext\n" },
		{
			name: "fences and Unicode",
			source: "```ts\r\n\t漢字 👨‍👩‍👧‍👦 é\r\n```\r\n",
			expected: "```ts\n\t漢字 👨‍👩‍👧‍👦 é\n```\n",
		},
		{
			name: "nested lists and quotes",
			source: "> quote\n>\n> - one\n> - two\n\n- item\n\tcontinuation\n",
			expected: "> quote\n>\n> - one\n> - two\n\n- item\n\tcontinuation\n",
		},
		{
			name: "quoted list with lazy continuation",
			source: "> quote\n> - list\nlazy\n> quote\n> - list\nlazy\n",
			expected: "> quote\n> - list\nlazy\n\n> quote\n> - list\nlazy\n",
		},
		{
			name: "link definitions",
			source: '[ref]: https://example.com "Title"\n\n[ref]\n',
			expected: '[ref]: https://example.com "Title"\n\n[ref]\n',
		},
		{
			name: "duplicate link definitions",
			source: "[ref]: /one\r\n\r\n[ref]: /two\r\n\r\n[ref]\r\n",
			expected: "[ref]: /one\n\n\n\n[ref]\n",
		},
		{
			name: "indented duplicate definitions",
			source: "   [ref]: /one\n\n   [ref]: /two\n",
			expected: "   [ref]: /one\n\n\n",
		},
		{
			name: "ANSI hyperlink payload",
			source: "\x1b]8;;https://example.com/a?x=1\x07link\x1b]8;;\x07\n",
			expected: "\x1b]8;;https://example.com/a?x=1\x07link\x1b]8;;\x07\n",
		},
	])("matches baseline lexer reconstruction without a Mermaid marker: $name", ({ source, expected }) => {
		let downstreamSource: string | undefined;
		const transform = createMarkdownTransform("assistant", true, [
			createMermaidMarkdownTransformer({ getMode: () => "streaming" }),
			(markdown) => {
				downstreamSource = markdown;
				return markdown;
			},
		]);
		transform(source, 100);
		expect(downstreamSource).toBe(expected);
	});

	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain("Before");
		expect(rendered).toContain("┌───────┐");
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("After");
	});

	it("leaves unsupported and oversized diagrams unchanged", () => {
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		const oversized = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		expect(transformMermaid(oversized, { maxWidth: 10 })).toBe(oversized);
	});

	it("maps semantic spans through the Pi theme", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		} as Theme;
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme });

		expect(rendered).toContain("<borderMuted>");
		expect(rendered).toContain("<accent>");
	});

	it("renders incomplete Mermaid blocks during streaming", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";

		expect(transformMermaid(partialMarkdown, { isStreaming: true })).toContain("───▶");
	});

	it("recognizes mixed-case markers with tilde fences and tab-separated options", () => {
		const markdown = "~~~MeRmAiD\toptions\nflowchart LR\n  A --> B\n~~~";
		expect(transformMermaid(markdown)).toContain("───▶");
		expect(transformMermaid(markdown)).not.toContain("~~~MeRmAiD");
	});

	it("renders diagrams with class assignments", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("Mermaid diagram not rendered");
		expect(rendered).toContain("│ Foo ├───▶│ Bar │");
	});

	it("falls back to the code block with a warning after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		const streaming = transformMermaid(markdown, { isStreaming: true });

		expect(final).toContain(markdown);
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		expect(final).toContain('dropped, expected a link: "invalid"');
		expect(final).not.toContain("more)");
		expect(followedByText).toContain("  \nFollowing text");
		expect(streaming).not.toContain("Mermaid diagram not rendered");
		expect(streaming).not.toContain("```mermaid");
		expect(streaming).toContain("│ Foo │");
	});

	it("summarizes additional partial-render warnings", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n  B[Bar] also-invalid\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain(markdown);
		expect(rendered).toContain('dropped, expected a link: "invalid"');
		expect(rendered).toContain("(+1 more)");
		expect(rendered).not.toContain('dropped, expected a link: "also-invalid"');
	});

	it("respects rendering modes and skips thinking blocks", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
	});
});
