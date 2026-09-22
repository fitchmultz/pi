import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type ToolCall, type ToolReference } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { defineTool } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

type ExportData = {
	header?: object;
	entries: SessionEntry[];
	leafId?: string;
	tools?: ToolReference[];
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
		const attachHeaderHandlers = () => {};
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
	name: "read",
	namespace: "records",
	arguments: { query: "wire query" },
	responsesItem: {
		type: "function_call",
		id: "wire-item",
		call_id: "lookup",
		name: "read",
		namespace: "records",
		arguments: '{"query":"wire query"}',
	},
};

function assistant(
	id: string,
	parentId: string | null,
	content: AssistantMessage["content"],
	checkpoint = false,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-22T00:00:00Z",
		...(checkpoint ? { checkpoint: true } : {}),
		message: {
			...fauxAssistantMessage(content),
			responseId: "response",
			stopReason: checkpoint ? "pending" : "stop",
		},
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
			toolName: "read",
			namespace: "records",
			content: [{ type: "text", text: id }],
			isError: false,
			timestamp: 1,
		},
	};
}

describe("native HTML export", () => {
	it("keeps same-leaf builtin/custom identities, admitted arguments, and namespace escaping", () => {
		const admitted = { ...rawCall, executionStarted: true, executionArguments: { query: "admitted query" } };
		const bare: ToolCall = { type: "toolCall", id: "bare", name: "read", arguments: { path: "builtin.txt" } };
		const fallback: ToolCall = { ...admitted, id: "fallback", namespace: '<records>"' };
		const entries = [
			assistant("a", null, [bare, admitted, fallback]),
			result("r", "a"),
			result("fallback-result", "r", "fallback"),
		];
		const template = loadTemplate({
			entries,
			leafId: "fallback-result",
			tools: [bare, admitted, fallback],
			renderedTools: {
				lookup: {
					calls: { [JSON.stringify(admitted.executionArguments)]: "records custom call" },
					results: { r: { expanded: "records custom result" } },
				},
				fallback: { results: { "fallback-result": { expanded: "custom result without call renderer" } } },
			},
		});
		expect(template.renderToolCall(bare)).toContain("builtin.txt");
		expect(template.renderToolCall(admitted)).toContain("records custom call");
		expect(template.renderToolCall(admitted)).toContain("records custom result");
		const fallbackHtml = template.renderToolCall(fallback);
		expect(fallbackHtml).toContain("&lt;records&gt;&quot;.read");
		expect(fallbackHtml).toContain("admitted query");
		expect(fallbackHtml).not.toContain("wire query");
		expect(fallbackHtml).not.toContain("tool-path");
		expect(fallbackHtml).toContain("custom result without call renderer");
		const noRendererHtml = template.renderToolCall({ ...fallback, id: "no-renderer", namespace: "" });
		expect(noRendererHtml).toContain(">.read</span>");
		expect(noRendererHtml).toContain("admitted query");
		expect(noRendererHtml).not.toContain("tool-path");
		expect(template.renderToolCall({ ...bare, executionArguments: { path: "admitted.txt" } })).toContain(
			"admitted.txt",
		);
		expect(template.getTreeNodeDisplayHtml(entries[1])).toContain("records.read");
		expect(template.getTreeNodeDisplayHtml(entries[1])).toContain("admitted query");
		expect(template.renderHeader()).toContain("&lt;records&gt;&quot;.read");
		expect(template.renderHeader()).toContain(">read</span>");
		const unmatched = result("unmatched", "a", "missing");
		if (unmatched.type === "message" && unmatched.message.role === "toolResult")
			unmatched.message.namespace = '<unmatched>"';
		expect(template.getTreeNodeDisplayHtml(unmatched)).toContain("&lt;unmatched&gt;&quot;.read");
	});

	it("coalesces selected-branch snapshots, preserves late metadata and siblings, and leaves the raw download intact", async () => {
		const sibling: ToolCall = { type: "toolCall", id: "sibling", name: "read", arguments: { path: "sibling.txt" } };
		const entries = [
			assistant("first", null, [rawCall], true),
			result("result-a", "first"),
			assistant("final-a", "result-a", [{ type: "text", text: "Final answer A" }, rawCall, sibling]),
			assistant(
				"late-a",
				"final-a",
				[{ ...rawCall, executionStarted: true, executionArguments: { query: "admitted A" } }],
				true,
			),
			result("result-b", "first"),
			assistant("final-b", "result-b", [{ type: "text", text: "Final answer B" }, rawCall]),
		];
		const before = JSON.stringify(entries);
		const header = { type: "session", id: "journal" };
		const template = loadTemplate({ header, entries, leafId: "late-a" });
		const path = template.getPath("late-a");
		const assistants = path.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]).toMatchObject({
			message: {
				content: [
					{ type: "text", text: "Final answer A" },
					{ ...rawCall, executionStarted: true, executionArguments: { query: "admitted A" } },
					sibling,
				],
			},
		});
		for (const [leaf, answer, output] of [
			["late-a", "Final answer A", "result-a"],
			["final-b", "Final answer B", "result-b"],
			["first", "", ""],
			["late-a", "Final answer A", "result-a"],
		]) {
			template.navigateTo(leaf);
			const html = template.html();
			expect(html.match(/id="tool-call-lookup"/g)).toHaveLength(1);
			expect(html.match(/class="assistant-message"/g)).toHaveLength(1);
			expect(template.getTreeNodeDisplayHtml(entries[1])).toContain("admitted A");
			expect(template.getTreeNodeDisplayHtml(entries[4])).not.toContain("admitted A");
			expect(html).toContain(answer);
			expect(html).toContain(output);
			if (leaf !== "late-a") expect(html).not.toContain("admitted A");
			if (leaf === "first") expect(html).not.toContain("result-a");
			for (const id of leaf === "late-a" ? ["first", "final-a", "late-a", "result-a"] : [leaf]) {
				expect(html).toContain(`id="${template.getScrollTargetElementId(id)}"`);
			}
		}
		template.download();
		expect(await template.downloaded()?.text()).toBe(
			[JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n"),
		);
		expect(JSON.stringify(entries)).toBe(before);
	});

	it("passes exact tool references and admitted args through real export pre-rendering without changing journal bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-html-native-"));
		try {
			initTheme("dark", false);
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			const calls: unknown[] = [];
			const custom = defineTool({
				name: "read",
				namespace: "records",
				label: "Records",
				description: "Read records",
				parameters: Type.Object({ query: Type.String() }),
				execute: async () => ({ content: [], details: {} }),
				renderCall: (args) => {
					calls.push(args);
					return new Text(`records call ${args.query}`, 0, 0);
				},
				renderResult: (result, _options, _theme, context) =>
					new Text(`records result ${JSON.stringify(result.content)} ${JSON.stringify(context.args)}`, 0, 0),
			});
			const lookup = vi.fn((reference: ToolReference) =>
				reference.name === "read" && reference.namespace === "records" ? custom : undefined,
			);
			const renderer = createToolHtmlRenderer({ getToolDefinition: lookup, theme, cwd: dir });
			const admitted = { ...rawCall, executionStarted: true, executionArguments: { query: "admitted query" } };
			const bare: ToolCall = { type: "toolCall", id: "bare", name: "read", arguments: { path: "builtin.txt" } };
			const firstId = manager.appendMessage(
				{ ...fauxAssistantMessage([bare, rawCall]), responseId: "export", stopReason: "pending" },
				true,
			);
			manager.appendMessage(
				{ ...fauxAssistantMessage([admitted]), responseId: "export", stopReason: "pending" },
				true,
			);
			manager.appendMessage({ ...fauxAssistantMessage([bare, rawCall]), responseId: "export" });
			const toolResult = result("result A", "a");
			if (toolResult.type === "message" && toolResult.message.role === "toolResult")
				manager.appendMessage(toolResult.message);
			const branchA = manager.appendMessage(
				{ ...fauxAssistantMessage([admitted]), responseId: "export", stopReason: "pending" },
				true,
			);
			manager.branch(firstId);
			const admittedB = { ...admitted, executionArguments: { query: "admitted B" } };
			manager.appendMessage(
				{ ...fauxAssistantMessage([admittedB]), responseId: "export", stopReason: "pending" },
				true,
			);
			manager.appendMessage({ ...fauxAssistantMessage([bare, rawCall]), responseId: "export" });
			const toolResultB = result("result B", "a");
			if (toolResultB.type === "message" && toolResultB.message.role === "toolResult")
				manager.appendMessage(toolResultB.message);
			const before = readFileSync(manager.getSessionFile()!, "utf8");
			const entriesBefore = JSON.stringify(manager.getEntries());
			const state = new Agent({
				initialState: {
					tools: [
						{
							name: custom.name,
							namespace: custom.namespace,
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
			expect(data.tools).toMatchObject([{ name: "read", namespace: "records" }]);
			expect(lookup).toHaveBeenCalledWith({ name: "read", namespace: "records" });
			expect(lookup.mock.calls.every(([reference]) => reference.namespace === "records")).toBe(true);
			expect(calls.length).toBeGreaterThan(0);
			expect(calls).toContainEqual(admitted.executionArguments);
			const template = loadTemplate(data);
			for (const [leaf, query, output] of [
				[branchA, "admitted query", "result A"],
				[manager.getLeafId()!, "admitted B", "result B"],
				[firstId, "wire query", ""],
			]) {
				template.navigateTo(leaf);
				expect(template.html()).toContain(`records call ${query}`);
				expect(template.html()).toContain("builtin.txt");
				if (output) {
					expect(template.html()).toContain(`records result`);
					expect(template.html()).toContain(output);
					expect(template.html()).toContain(`&quot;query&quot;:&quot;${query}&quot;`);
				} else {
					expect(template.html()).not.toContain("records result");
				}
			}
			expect(JSON.stringify(data.entries)).toBe(entriesBefore);
			expect(JSON.stringify(manager.getEntries())).toBe(entriesBefore);
			expect(readFileSync(manager.getSessionFile()!, "utf8")).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
