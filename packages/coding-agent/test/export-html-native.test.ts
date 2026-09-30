import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	createReadStream,
	fstatSync,
	mkdtempSync,
	openSync,
	ReadStream,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getHeapStatistics } from "node:v8";
import { runInNewContext } from "node:vm";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type * as Undici from "undici";
import { fetch, Response } from "undici";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { readSessionCheckpointState } from "../src/core/checkpoint.ts";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { defineTool, type ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { exportSessionToJsonl } from "../src/core/session-export.ts";
import { closeJournalSource, scanJournal } from "../src/core/session-journal.ts";
import { CURRENT_SESSION_VERSION, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("undici", async (importOriginal) => ({
	...(await importOriginal<typeof Undici>()),
	fetch: vi.fn(),
}));

type ExportData = {
	header?: object;
	entries: SessionEntry[];
	leafId?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "namespace">>;
	renderedTools?: Record<string, { calls?: Record<string, string>; results?: Record<string, { expanded?: string }> }>;
	records?: Array<{ entry: SessionEntry; renderedTools?: ExportData["renderedTools"] }>;
};

function loadTemplate(
	data: ExportData,
	options: {
		indexes?: object[];
		readRecord?: (index: number) => NonNullable<ExportData["records"]>[number];
	} = {},
) {
	const source = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");
	const base64 = Buffer.from(JSON.stringify({ header: data.header, leafId: data.leafId, tools: data.tools })).toString(
		"base64",
	);
	const records = options.readRecord
		? undefined
		: (data.records ?? data.entries.map((entry) => ({ entry, renderedTools: data.renderedTools })));
	const indexes =
		options.indexes ??
		data.entries.map((entry, record) => {
			const index: Record<string, unknown> = {
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				type: entry.type,
				record,
			};
			if (entry.type === "message") {
				index.message = {
					role: entry.message.role,
					...(entry.message.role === "toolResult"
						? { toolCallId: entry.message.toolCallId, toolName: entry.message.toolName }
						: {}),
					...(entry.message.role === "assistant"
						? {
								model: entry.message.model,
								usage: entry.message.usage,
								stopReason: entry.message.stopReason,
								hasText: entry.message.content.some((part) => part.type === "text" && part.text.trim()),
								toolCalls: entry.message.content.filter((part) => part.type === "toolCall").length,
							}
						: {}),
				};
			} else if (entry.type === "custom") index.customType = entry.customType;
			return index;
		});
	let downloaded: Blob | undefined;
	const decoded: number[] = [];
	const buttons: Array<{ textContent: string; click: () => void }> = [];
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
			if (id.startsWith("session-entry-")) {
				const record = Number(id.slice("session-entry-".length));
				return {
					get textContent() {
						decoded.push(record);
						return Buffer.from(JSON.stringify(options.readRecord?.(record) ?? records![record])).toString(
							"base64",
						);
					},
				};
			}
			if (id === "messages") return messages;
			return { innerHTML: "" };
		},
		querySelector: () => null,
		querySelectorAll: (selector: string) =>
			selector === ".session-index"
				? indexes.map((entry) => ({ textContent: Buffer.from(JSON.stringify(entry)).toString("base64") }))
				: [],
		createElement: (tag: string) => {
			if (tag === "button") {
				const button = {
					textContent: "",
					click: () => {},
					addEventListener: (_event: string, callback: () => void) => {
						button.click = callback;
					},
				};
				buttons.push(button);
				return button;
			}
			if (tag === "template") {
				const template = {
					content: { firstElementChild: htmlNode("") },
					set innerHTML(html: string) {
						this.content.firstElementChild = htmlNode(html);
					},
				};
				return template;
			}
			return { click: () => {}, addEventListener: () => {} };
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
		return { getPath, renderEntry, renderToolCall, renderHeader, getTreeNodeDisplayHtml, getScrollTargetElementId, navigateTo, download: window.downloadSessionJson,
			search: (query, mode = 'default') => {
				searchQuery = query; filterMode = mode;
				return filterNodes(flattenTree(buildTree(), buildActivePathIds(currentLeafId)), currentLeafId).map(node => node.node.entry.id);
			}
		};
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
		search(query: string, mode?: string): string[];
	};
	return {
		...api,
		html: () => nodes.map((node) => node.html ?? "").join(""),
		downloaded: () => downloaded,
		decoded,
		buttons,
	};
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
	it("captures, cold-restores and exports more than 512MiB without an aggregate history string", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-large-file-flows-"));
		const journal = join(directory, "session.jsonl");
		const timestamp = "2026-09-22T00:00:00Z";
		const header = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp, cwd: directory };
		const count = 520;
		const payload = "x".repeat(1024 * 1024);
		const fd = openSync(journal, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(header)}\n`);
			writeFileSync(fd, `${JSON.stringify(assistant("first", null, [{ type: "text", text: "first history" }]))}\n`);
			for (let index = 0; index < count; index++) {
				writeFileSync(
					fd,
					`${JSON.stringify({
						type: "custom",
						id: `state-${index}`,
						parentId: index ? `state-${index - 1}` : "first",
						timestamp,
						customType: "historical-state",
						data: { payload, index },
					})}\n`,
				);
			}
			writeFileSync(
				fd,
				`${JSON.stringify(assistant("last", `state-${count - 1}`, [{ type: "text", text: "last history" }]))}\n`,
			);
			writeFileSync(
				fd,
				`${JSON.stringify(assistant("alternate", "first", [{ type: "text", text: "alternate history" }]))}\n`,
			);
		} finally {
			closeSync(fd);
		}
		async function digest(path: string): Promise<string> {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			return hash.digest("hex");
		}
		const h = await createHarness({ sessionManager: SessionManager.open(journal) });
		const provider = h.session.modelRuntime.getProvider(h.getModel().provider)!;
		let restored: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		try {
			h.session.agent.selectedModel = undefined;
			h.sessionManager.branch("last");
			const originalJournal = await digest(journal);
			expect(statSync(journal).size).toBeGreaterThan(512 * 1024 * 1024);
			const path = join(directory, "checkpoint.json");
			const hold = await h.session.acquireCheckpointFile(path, { quiesce: () => () => {} });
			expect(hold.checkpoint.selection.leafId).toBe("last");
			expect(hold.checkpoint).not.toHaveProperty("entries");
			hold.release();
			// The pre-fix cold reader used this whole-file string boundary.
			expect(() => readFileSync(path, "utf8")).toThrow("Cannot create a string longer");
			const captured = await digest(path);
			h.sessionManager.appendCustomEntry("after-release", { newer: true });
			h.cleanup();
			rmSync(journal);
			expect(await digest(path)).toBe(captured);
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				refreshOnCreate: false,
			});
			restored = await createAgentSession({
				checkpointFile: path,
				modelRuntime,
				resourceLoader: createTestResourceLoader(),
				settingsManager: SettingsManager.inMemory(),
			});
			const manager = restored.session.sessionManager;
			expect(manager.getLeafId()).toBe("last");
			expect(manager.getEntryCount()).toBe(count + 3);
			expect(await digest(journal)).toBe(originalJournal);
			expect(manager.getEntry("alternate")).toMatchObject({ parentId: "first" });
			for (const index of [0, count - 1]) {
				expect(manager.getEntry(`state-${index}`)).toMatchObject({ data: { payload, index } });
			}
			expect(readSessionCheckpointState(path).selection.sessionId).toBe(header.id);
			expect(await digest(path)).toBe(captured);
			const jsonl = exportSessionToJsonl(manager, join(directory, "branch.jsonl"));
			expect(statSync(jsonl).size).toBeGreaterThan(512 * 1024 * 1024);
			const exported = scanJournal(jsonl, {
				policy: "strict",
				select: (path) =>
					path.length === 0 ? "descend" : ["type", "id", "parentId"].includes(String(path[0])) ? "keep" : "skip",
			});
			expect(exported.records.slice(1).map((record) => record.value.id)).toEqual([
				"first",
				...Array.from({ length: count }, (_, index) => `state-${index}`),
				"last",
			]);
			expect(exported.records.at(-1)?.value.parentId).toBe(`state-${count - 1}`);
			closeJournalSource(exported.source);
			const html = await exportSessionToHtml(manager, undefined, { outputPath: join(directory, "history.html") });
			expect(statSync(html).size).toBeGreaterThan(512 * 1024 * 1024);
			const indexes: object[] = [];
			const bodies = new Map<number, { start: number; length: number }>();
			let metadata: Omit<ExportData, "entries"> | undefined;
			let offset = 0;
			for await (const line of createInterface({ input: createReadStream(html), crlfDelay: Infinity })) {
				const data = /^\s*<script id="session-data"[^>]*>([^<]+)<\/script>$/.exec(line);
				if (data) metadata = JSON.parse(Buffer.from(data[1], "base64").toString("utf8"));
				const index = /^<script id="session-index-\d+"[^>]*>([^<]+)<\/script>$/.exec(line);
				if (index) indexes.push(JSON.parse(Buffer.from(index[1], "base64").toString("utf8")));
				const body = /^(<script id="session-entry-(\d+)"[^>]*>)([^<]+)<\/script>$/.exec(line);
				if (body)
					bodies.set(Number(body[2]), { start: offset + Buffer.byteLength(body[1]), length: body[3].length });
				offset += Buffer.byteLength(line) + 1;
			}
			expect(indexes).toHaveLength(count + 3);
			expect(bodies.size).toBe(count + 3);
			expect(metadata).toMatchObject({ header: { id: header.id }, leafId: "last" });
			expect(metadata).not.toHaveProperty("entries");
			const input = openSync(html, "r");
			try {
				const viewer = loadTemplate(
					{ ...metadata, entries: [] },
					{
						indexes,
						readRecord: (record) => {
							const body = bodies.get(record)!;
							const buffer = Buffer.alloc(body.length);
							let position = 0;
							while (position < buffer.length)
								position += readSync(input, buffer, position, buffer.length - position, body.start + position);
							return JSON.parse(Buffer.from(buffer.toString("ascii"), "base64").toString("utf8"));
						},
					},
				);
				for (const [id, text] of [
					["first", "first history"],
					["last", "last history"],
					["alternate", "alternate history"],
				]) {
					viewer.navigateTo(id);
					expect(viewer.html()).toContain(text);
				}
				expect(viewer.search("alternate history")).toContain("alternate");
				expect(new Set(viewer.decoded)).toEqual(new Set([0, count + 1, count + 2]));
			} finally {
				closeSync(input);
			}
			initTheme("dark", false);
			const auth = vi.spyOn(modelRuntime, "getAuth").mockResolvedValue({ auth: { apiKey: "fake-share-token" } });
			const providers = vi.spyOn(modelRuntime, "getProvider").mockReturnValue(provider);
			let uploadedBytes = 0;
			let largestUploadChunk = 0;
			const errors: string[] = [];
			const statuses: string[] = [];
			vi.mocked(fetch).mockImplementation(async (_url, options) => {
				if (!(options?.body instanceof ReadStream)) throw new Error("Expected completed file stream");
				const descriptor: unknown = Reflect.get(options.body, "fd");
				if (typeof descriptor !== "number") throw new Error("Expected captured file descriptor");
				const size = fstatSync(descriptor).size;
				const hash = createHash("sha256");
				for await (const chunk of options.body) {
					const bytes = Buffer.from(chunk);
					hash.update(bytes);
					uploadedBytes += bytes.length;
					largestUploadChunk = Math.max(largestUploadChunk, bytes.length);
				}
				expect(Number((options.headers as Record<string, string>)["Content-Length"])).toBe(uploadedBytes);
				expect(uploadedBytes).toBe(size);
				const expected = createHash("sha256");
				const buffer = Buffer.alloc(64 * 1024);
				let position = 0;
				while (position < size) {
					const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position);
					expected.update(buffer.subarray(0, count));
					position += count;
				}
				expect(hash.digest("hex")).toBe(expected.digest("hex"));
				return new Response('{"artifact":{"canonical_url":"https://example.invalid/large-share"}}');
			});
			try {
				await shareSession({
					session: restored.session,
					ui: { setFocus() {}, requestRender() {} },
					editorContainer: { clear() {}, addChild() {} },
					editor: {},
					showError: (error: string) => errors.push(error),
					showStatus: (status: string) => statuses.push(status),
				} as never);
				expect(errors).toEqual([]);
				expect(statuses.join(" ")).toContain("https://example.invalid/large-share");
				expect(uploadedBytes).toBeGreaterThan(512 * 1024 * 1024);
				expect(largestUploadChunk).toBeLessThanOrEqual(64 * 1024);
			} finally {
				auth.mockRestore();
				providers.mockRestore();
			}
			console.log(
				"LARGE_FILE_RECEIPT",
				JSON.stringify({
					checkpointBytes: statSync(path).size,
					jsonlBytes: statSync(jsonl).size,
					htmlBytes: statSync(html).size,
					entries: count + 3,
					decodedRecords: 3,
					uploadedBytes,
					largestUploadChunk,
					heapLimit: getHeapStatistics().heap_size_limit,
					heapUsed: process.memoryUsage().heapUsed,
				}),
			);
		} finally {
			restored?.session.dispose();
			h.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 240_000);

	it("pages first and last history, keeps alternate branches searchable, and never decodes hidden custom state", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom",
				id: "state",
				parentId: null,
				timestamp: "2026-09-22T00:00:00Z",
				customType: "state",
				data: { payload: "unused".repeat(200_000) },
			},
		];
		for (let index = 0; index < 125; index++) {
			entries.push(assistant(`message-${index}`, entries.at(-1)!.id, [{ type: "text", text: `history ${index}` }]));
		}
		entries.push(
			assistant("alternate", "message-0", [{ type: "text", text: `${"prefix ".repeat(50)}deep alternate needle` }]),
		);
		const template = loadTemplate({ entries, leafId: "message-124" });
		expect(template.decoded).toEqual([]);
		template.navigateTo("message-124");
		expect(template.html()).toContain("history 124");
		expect(template.html()).not.toContain("history 0<");
		expect(new Set(template.decoded).size).toBeLessThanOrEqual(50);
		template.buttons.findLast((button) => button.textContent === "Earlier messages")!.click();
		template.buttons.findLast((button) => button.textContent === "Earlier messages")!.click();
		expect(template.html()).toContain("history 0");
		expect(template.html()).not.toContain("history 124");
		template.buttons.findLast((button) => button.textContent === "Later messages")!.click();
		expect(template.html()).toContain("history 49");
		template.navigateTo("alternate");
		expect(template.html()).toContain("deep alternate needle");
		expect(template.html()).not.toContain("history 124");
		template.navigateTo("message-124");
		expect(template.search("deep alternate needle")).toEqual(["message-124", "alternate"]);
		expect(template.search("not in history", "all")).toEqual(["message-124"]);
		expect(template.decoded).not.toContain(0);
	});

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
			const metadata = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as Omit<ExportData, "entries">;
			const records = [
				...html.matchAll(/<script id="session-entry-\d+" type="application\/json">([\s\S]*?)<\/script>/g),
			].map(
				(match) =>
					JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as NonNullable<
						ExportData["records"]
					>[number],
			);
			const data: ExportData = { ...metadata, records, entries: records.map((record) => record.entry) };
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
			for (const failure of ["renderer", "cancellation"] as const) {
				const controller = new AbortController();
				const renderResult = vi.fn(() => {
					if (failure === "renderer") throw new Error("renderer failed");
					setImmediate(() => controller.abort());
					return { expanded: "partial result" };
				});
				await expect(
					exportSessionToHtml(manager, state, {
						outputPath: output,
						signal: controller.signal,
						toolRenderer: { ...renderer, renderResult },
					}),
				).rejects.toThrow(failure === "renderer" ? "renderer failed" : "aborted");
				expect(renderResult).toHaveBeenCalled();
				expect(readFileSync(output, "utf8")).toBe(html);
				expect(readFileSync(manager.getSessionFile()!, "utf8")).toBe(before);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
