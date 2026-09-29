import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { defineTool, type ToolDefinition } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

type ExportData = {
	header?: object;
	entries: SessionEntry[];
	leafId?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "namespace">>;
	renderedTools?: Record<string, { calls?: Record<string, string>; results?: Record<string, { expanded?: string }> }>;
};

function loadTemplate(data: ExportData) {
	const source = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");
	const base64 = Buffer.from(JSON.stringify(data)).toString("base64");
	let downloaded: Blob | undefined;
	const nodes: Array<{ html: string }> = [];
	const messages = {
		set innerHTML(_html: string) {
			nodes.length = 0;
		},
		appendChild(fragment: { children: Array<{ html: string }> }) {
			nodes.push(...fragment.children);
		},
		querySelectorAll: () => [],
	};
	function htmlNode(html: string) {
		return { html, cloneNode: () => htmlNode(html) };
	}
	const document = {
		getElementById: (id: string) => {
			if (id === "session-data") return { textContent: base64 };
			if (id === "messages") return messages;
			return { innerHTML: "" };
		},
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: (tag: string) => {
			if (tag === "template") {
				const template = {
					content: { firstElementChild: htmlNode("") },
					set innerHTML(html: string) {
						this.content.firstElementChild = htmlNode(html);
					},
				};
				return template;
			}
			return { click: () => {} };
		},
		createDocumentFragment: () => ({
			children: [] as Array<{ html: string }>,
			appendChild(node: { html: string }) {
				this.children.push(node);
			},
		}),
		body: { appendChild: () => {}, removeChild: () => {} },
	};
	const api = runInNewContext(
		`${source.slice(0, source.indexOf("      // INITIALIZATION"))}
		function safeMarkedParse(text) { return escapeHtml(text); }
		renderTree = () => {};
		${source.slice(source.indexOf("      // Toggle states"), source.indexOf("      const isEditableTarget"))}
		return { getPath, renderEntry, renderToolCall, renderHeader, getTreeNodeDisplayHtml, getScrollTargetElementId, navigateTo, download: window.downloadSessionJson };
		})();`,
		{
			document,
			window: { location: { search: "", href: "https://example.invalid" } },
			atob,
			TextDecoder,
			URLSearchParams,
			Blob,
			URL: {
				createObjectURL: (blob: Blob) => {
					downloaded = blob;
					return "blob:test";
				},
				revokeObjectURL: () => {},
			},
			setTimeout: () => {},
		},
	) as {
		getPath(id: string): SessionEntry[];
		renderEntry(entry: SessionEntry): string;
		renderToolCall(call: ToolCall): string;
		renderHeader(): string;
		getTreeNodeDisplayHtml(entry: SessionEntry): string;
		getScrollTargetElementId(id: string): string;
		navigateTo(id: string, scrollMode?: string, scrollToEntryId?: string): void;
		download(): void;
	};
	return { ...api, html: () => nodes.map((node) => node.html).join(""), downloaded: () => downloaded };
}

const rawCall: ToolCall = {
	type: "toolCall",
	id: "lookup",
	name: "records_read",
	namespace: "records",
	arguments: { query: "record query" },
};

function assistant(id: string, parentId: string | null, content: AssistantMessage["content"]): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-22T00:00:00Z",
		message: fauxAssistantMessage(content),
	};
}

function result(id: string, parentId: string, toolCallId = "lookup"): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-22T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "records_read",
			content: [{ type: "text", text: id }],
			isError: false,
			timestamp: 1,
		},
	};
}

describe("HTML export tools and branches", () => {
	it("uses tool names for rendering and escapes fallback names, arguments and nested calls", () => {
		const bare: ToolCall = { type: "toolCall", id: "bare", name: "read", arguments: { path: "builtin.txt" } };
		const fallback: ToolCall = { ...rawCall, id: "fallback", name: '<records>"', arguments: { query: "<script>" } };
		const nested = result("nested", "r", "fallback");
		if (nested.type !== "message" || nested.message.role !== "toolResult") throw new Error("expected result");
		nested.message.nestedCalls = {
			complete: false,
			calls: [
				{
					id: "nested-error",
					name: '<nested>"',
					arguments: { text: "<script>" },
					status: "error",
					error: "<failed>\nsecond line",
					durationMs: 12,
				},
				{ id: "nested-unfinished", name: "omitted", argumentsBytes: 2048, status: "unfinished" },
			],
		};
		const entries = [assistant("a", null, [bare, rawCall, fallback]), result("r", "a"), nested];
		const template = loadTemplate({
			entries,
			leafId: "nested",
			tools: [{ name: "read" }, { name: fallback.name, namespace: { name: "records" } }],
			renderedTools: {
				lookup: {
					calls: { [JSON.stringify(rawCall.arguments)]: "records custom call" },
					results: { r: { expanded: "records custom result" } },
				},
				fallback: { results: { nested: { expanded: "custom result without call renderer" } } },
			},
		});
		expect(template.renderToolCall(bare)).toContain("builtin.txt");
		expect(template.renderToolCall(rawCall)).toContain("records custom call");
		expect(template.renderToolCall(rawCall)).toContain("records custom result");
		const html = template.renderToolCall(fallback);
		for (const text of [
			"&lt;records&gt;&quot;",
			"&lt;script&gt;",
			"custom result without call renderer",
			"Nested calls: 2 (incomplete record)",
			"&lt;nested&gt;&quot;",
			"&lt;failed&gt;",
			"12ms",
			"[arguments omitted, 2048 bytes]",
		]) {
			expect(html).toContain(text);
		}
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("tool-path");
		expect(template.renderToolCall({ ...fallback, id: "no-renderer" })).toContain("&lt;script&gt;");
		expect(template.getTreeNodeDisplayHtml(entries[1])).toContain("records_read");
		expect(template.getTreeNodeDisplayHtml(entries[1])).toContain("record query");
		expect(template.renderHeader()).toContain("&lt;records&gt;&quot;");
		expect(template.renderHeader()).toContain(">read</span>");
		const unmatched = result("unmatched", "a", "missing");
		if (unmatched.type === "message" && unmatched.message.role === "toolResult")
			unmatched.message.toolName = '<unmatched>"';
		expect(template.getTreeNodeDisplayHtml(unmatched)).toContain("&lt;unmatched&gt;&quot;");
	});

	it("selects branch-local results on repeated navigation and leaves the raw download intact", async () => {
		const entries = [
			assistant("first", null, [rawCall]),
			result("result-a", "first"),
			assistant("final-a", "result-a", [{ type: "text", text: "Final answer A" }]),
			result("result-b", "first"),
			assistant("final-b", "result-b", [{ type: "text", text: "Final answer B" }]),
		];
		const before = JSON.stringify(entries);
		const header = { type: "session", id: "journal" };
		const template = loadTemplate({ header, entries, leafId: "final-a" });
		for (const [leaf, answer, output, excluded] of [
			["final-a", "Final answer A", "result-a", "result-b"],
			["final-b", "Final answer B", "result-b", "result-a"],
			["first", "", "", "result-a"],
			["final-a", "Final answer A", "result-a", "result-b"],
		]) {
			template.navigateTo(leaf);
			const html = template.html();
			expect(html.match(/id="tool-call-lookup"/g)).toHaveLength(1);
			expect(html).toContain(answer);
			expect(html).toContain(output);
			expect(html).not.toContain(excluded);
			expect(template.getPath(leaf).map((entry) => entry.id)).toEqual(
				leaf === "first" ? ["first"] : ["first", output, leaf],
			);
			if (output) expect(html).toContain(`id="${template.getScrollTargetElementId(output)}"`);
		}
		template.download();
		expect(await template.downloaded()?.text()).toBe(
			[JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n"),
		);
		expect(JSON.stringify(entries)).toBe(before);
	});

	it("pre-renders named tools with branch-local arguments without changing journal bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-html-export-"));
		try {
			initTheme("dark", false);
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			const custom = defineTool({
				name: "records_read",
				namespace: { name: "records", description: "Record operations" },
				label: "Records",
				description: "Read records",
				parameters: Type.Object({ query: Type.String() }),
				execute: async () => ({ content: [], details: {} }),
				renderCall: (args) => new Text(`records call ${args.query}`, 0, 0),
				renderResult: (result, _options, _theme, context) =>
					new Text(`records result ${JSON.stringify(result.content)} ${JSON.stringify(context.args)}`, 0, 0),
			});
			const lookup = vi.fn((name: string) => (name === custom.name ? custom : undefined));
			const renderer = createToolHtmlRenderer({ getToolDefinition: lookup, theme, cwd: dir });
			const root = manager.appendMessage({ role: "user", content: "lookup", timestamp: 1 });
			const bare: ToolCall = { type: "toolCall", id: "bare", name: "read", arguments: { path: "builtin.txt" } };
			const branches: Array<[string, string, string]> = [];
			for (const query of ["branch A", "branch B"]) {
				manager.branch(root);
				manager.appendMessage(fauxAssistantMessage([bare, { ...rawCall, arguments: { query } }]));
				const toolResult = result(`result ${query}`, "unused");
				if (toolResult.type !== "message" || toolResult.message.role !== "toolResult")
					throw new Error("expected result");
				const leaf = manager.appendMessage(toolResult.message);
				branches.push([leaf, query, `result ${query}`]);
			}
			const before = readFileSync(manager.getSessionFile()!, "utf8");
			const entriesBefore = JSON.stringify(manager.getEntries());
			const state = new Agent({
				initialState: {
					tools: [
						{
							name: custom.name,
							label: custom.label,
							description: custom.description,
							parameters: custom.parameters,
							execute: async () => ({ content: [], details: {} }),
						},
					],
				},
				streamFn: () => {
					throw new Error("Export must not call a provider");
				},
			}).state;
			const output = await exportSessionToHtml(manager, state, {
				outputPath: join(dir, "export.html"),
				toolRenderer: renderer,
			});
			const html = readFileSync(output, "utf8");
			const encoded = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
			expect(encoded).toBeDefined();
			const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as ExportData;
			expect(data.tools).toMatchObject([{ name: "records_read" }]);
			expect(lookup).toHaveBeenCalledWith("records_read");
			expect(lookup.mock.calls.every(([name]) => name === "records_read")).toBe(true);
			const template = loadTemplate(data);
			for (const [leaf, query, output] of [...branches, branches[0]]) {
				template.navigateTo(leaf);
				expect(template.html()).toContain(`records call ${query}`);
				expect(template.html()).toContain("builtin.txt");
				expect(template.html()).toContain("records result");
				expect(template.html()).toContain(output);
				expect(template.html()).toContain(`&quot;query&quot;:&quot;${query}&quot;`);
				expect(template.html()).not.toContain(query === "branch A" ? "branch B" : "branch A");
			}
			expect(JSON.stringify(data.entries)).toBe(entriesBefore);
			expect(JSON.stringify(manager.getEntries())).toBe(entriesBefore);
			expect(readFileSync(manager.getSessionFile()!, "utf8")).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
