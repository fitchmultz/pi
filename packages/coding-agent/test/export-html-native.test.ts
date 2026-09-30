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

async function loadTemplate(
	data: ExportData,
	options: {
		indexes?: object[];
		readRecord?: (index: number) => NonNullable<ExportData["records"]>[number];
	} = {},
) {
	let indexes = options.indexes;
	if (!indexes) {
		const directory = mkdtempSync(join(tmpdir(), "pi-viewer-index-"));
		try {
			const journal = join(directory, "session.jsonl");
			const fd = openSync(journal, "wx", 0o600);
			try {
				writeFileSync(
					fd,
					`${JSON.stringify({
						type: "session",
						version: CURRENT_SESSION_VERSION,
						id: randomUUID(),
						timestamp: "2026-09-22T00:00:00Z",
						cwd: directory,
					})}\n`,
				);
				for (const entry of data.entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			} finally {
				closeSync(fd);
			}
			const html = await exportSessionToHtml(SessionManager.open(journal), undefined, {
				outputPath: join(directory, "history.html"),
			});
			indexes = [
				...readFileSync(html, "utf8").matchAll(/<script id="session-index-\d+"[^>]*>([^<]+)<\/script>/g),
			].map((match) => JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as object);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	const source = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");
	const base64 = Buffer.from(JSON.stringify({ header: data.header, leafId: data.leafId, tools: data.tools })).toString(
		"base64",
	);
	const records = options.readRecord
		? undefined
		: (data.records ?? data.entries.map((entry) => ({ entry, renderedTools: data.renderedTools })));
	let downloaded: Blob | undefined;
	const decoded: number[] = [];
	class Element {
		tag: string;
		children: Element[] = [];
		className = "";
		textContent = "";
		dataset: Record<string, string> = {};
		style: Record<string, string> = {};
		content = { firstElementChild: undefined as Element | undefined };
		private markup = "";
		private events = new Map<string, (event: { stopPropagation(): void }) => void>();

		constructor(tag: string) {
			this.tag = tag;
		}
		get innerHTML(): string {
			return this.markup + this.textContent + this.children.map((child) => child.innerHTML).join("");
		}
		set innerHTML(html: string) {
			this.markup = html;
			this.children = [];
			if (this.tag === "template") {
				const child = new Element("rendered");
				child.innerHTML = html;
				this.content.firstElementChild = child;
			}
		}
		get classList() {
			return {
				add: (name: string) => this.classList.toggle(name, true),
				remove: (name: string) => this.classList.toggle(name, false),
				toggle: (name: string, enabled?: boolean) => {
					const classes = new Set(this.className.split(/\s+/).filter(Boolean));
					if (enabled ?? !classes.has(name)) classes.add(name);
					else classes.delete(name);
					this.className = [...classes].join(" ");
				},
			};
		}
		appendChild(child: Element) {
			if (child.tag === "fragment") this.children.push(...child.children);
			else this.children.push(child);
		}
		querySelectorAll(selector: string): Element[] {
			const classes = selector.split(".").filter(Boolean);
			const matches: Element[] = [];
			const stack = [...this.children].reverse();
			while (stack.length) {
				const child = stack.pop()!;
				if (classes.every((name) => child.className.split(/\s+/).includes(name))) matches.push(child);
				stack.push(...[...child.children].reverse());
			}
			return matches;
		}
		querySelector(selector: string): Element | null {
			return this.querySelectorAll(selector)[0] ?? null;
		}
		addEventListener(event: string, callback: (event: { stopPropagation(): void }) => void) {
			this.events.set(event, callback);
		}
		click() {
			this.events.get("click")?.({ stopPropagation() {} });
		}
	}
	const elements = new Map<string, Element>();
	const element = (id: string) => {
		if (!elements.has(id)) elements.set(id, new Element("div"));
		return elements.get(id)!;
	};
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
			return element(id);
		},
		querySelector: () => null,
		querySelectorAll: (selector: string) =>
			selector === ".session-index"
				? indexes.map((entry) => ({ textContent: Buffer.from(JSON.stringify(entry)).toString("base64") }))
				: [],
		createElement: (tag: string) => new Element(tag),
		createDocumentFragment: () => new Element("fragment"),
		addEventListener() {},
		body: { classList: new Element("body").classList, appendChild() {}, removeChild() {} },
	};
	const api = runInNewContext(
		`${readFileSync(new URL("../src/core/export-html/vendor/marked.min.js", import.meta.url), "utf8")}
		${readFileSync(new URL("../src/core/export-html/vendor/highlight.min.js", import.meta.url), "utf8")}
		${source.slice(0, source.lastIndexOf("    })();"))}
		return { getPath, renderEntry, renderToolCall, renderHeader, getScrollTargetElementId, navigateTo, download: window.downloadSessionJson,
			search: (query, mode = 'default') => {
				searchQuery = query; filterMode = mode;
				forceTreeRerender();
				return document.getElementById('tree-container').querySelectorAll('.tree-node').map(node => node.dataset.id);
			}
		};
		})();`,
		{
			document,
			window: {
				location: { search: "", href: "https://example.invalid" },
				matchMedia: () => ({ matches: false }),
				getSelection: () => ({ toString: () => "" }),
				addEventListener() {},
			},
			localStorage: { getItem: () => null },
			atob,
			TextDecoder,
			URLSearchParams,
			Blob,
			URL: {
				createObjectURL: (blob: Blob) => {
					downloaded = blob;
					return "blob:test";
				},
				revokeObjectURL() {},
			},
			setTimeout() {},
		},
	) as {
		getPath(id: string): SessionEntry[];
		renderEntry(entry: SessionEntry): string;
		renderToolCall(call: ToolCall): string;
		renderHeader(): string;
		getScrollTargetElementId(id: string): string;
		navigateTo(id: string, scrollMode?: string, scrollToEntryId?: string): void;
		download(): void;
		search(query: string, mode?: string): string[];
	};
	return {
		...api,
		html: () => element("messages").innerHTML,
		treeNodes: () => element("tree-container").querySelectorAll(".tree-node"),
		treeHtml: (id: string) => element("tree-container").children.find((node) => node.dataset.id === id)?.innerHTML,
		downloaded: () => downloaded,
		decoded,
		get buttons() {
			return element("messages").children.filter((child) => child.tag === "button");
		},
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
		const stageReceipt = (phase: string) =>
			console.log(
				"LARGE_STAGE",
				JSON.stringify({ phase, heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss }),
			);
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
		stageReceipt("journal-written");
		async function digest(path: string): Promise<string> {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			return hash.digest("hex");
		}
		const h = await createHarness({ sessionManager: SessionManager.open(journal) });
		stageReceipt("harness-ready");
		const provider = h.session.modelRuntime.getProvider(h.getModel().provider)!;
		let restored: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		try {
			h.session.agent.selectedModel = undefined;
			h.sessionManager.branch("last");
			const originalJournal = await digest(journal);
			expect(statSync(journal).size).toBeGreaterThan(512 * 1024 * 1024);
			const path = join(directory, "checkpoint.json");
			const hold = await h.session.acquireCheckpointFile(path, { quiesce: () => () => {} });
			stageReceipt("checkpoint-captured");
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
			stageReceipt("cold-runtime-ready");
			restored = await createAgentSession({
				checkpointFile: path,
				modelRuntime,
				resourceLoader: createTestResourceLoader(),
				settingsManager: SettingsManager.inMemory(),
			});
			stageReceipt("cold-restored");
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
			stageReceipt("jsonl-exported");
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
			stageReceipt("html-exported");
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
			stageReceipt("html-indexed");
			expect(indexes).toHaveLength(count + 3);
			expect(bodies.size).toBe(count + 3);
			expect(metadata).toMatchObject({ header: { id: header.id }, leafId: "last" });
			expect(metadata).not.toHaveProperty("entries");
			const input = openSync(html, "r");
			let decodedRecords = 0;
			let initialDecodedRecords = 0;
			try {
				const viewer = await loadTemplate(
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
				stageReceipt("viewer-ready");
				expect(viewer.treeNodes().map((node) => node.dataset.id)).toEqual(["first", "last", "alternate"]);
				expect(new Set(viewer.decoded)).toEqual(new Set([0]));
				initialDecodedRecords = new Set(viewer.decoded).size;
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
				decodedRecords = new Set(viewer.decoded).size;
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
					decodedRecords,
					initialDecodedRecords,
					productionTree: true,
					uploadedBytes,
					largestUploadChunk,
					heapLimit: getHeapStatistics().heap_size_limit,
					heapUsed: process.memoryUsage().heapUsed,
					rss: process.memoryUsage().rss,
					maxRssKiB: process.resourceUsage().maxRSS,
				}),
			);
		} finally {
			restored?.session.dispose();
			h.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 240_000);

	it("pages first and last history, keeps alternate branches searchable, and never decodes hidden custom state", async () => {
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
			entries.push(
				assistant(`message-${index}`, entries.at(-1)!.id, [
					{ type: "text", text: `history ${index}` },
					...(index === 124 ? [{ ...rawCall, id: "last-call", arguments: { query: "last query" } }] : []),
				]),
			);
		}
		entries.push(
			assistant("alternate", "message-0", [{ type: "text", text: `${"prefix ".repeat(50)}deep alternate needle` }]),
		);
		const template = await loadTemplate({ entries, leafId: "message-124" });
		console.log(
			"HTML_TREE_RECEIPT",
			JSON.stringify({ historyMessages: 125, initialDecoded: new Set(template.decoded).size }),
		);
		expect(new Set(template.decoded)).toEqual(new Set(Array.from({ length: 49 }, (_, index) => index + 1)));
		expect(template.treeNodes()).toHaveLength(126);
		expect(template.treeHtml("message-0")).toContain("history 0");
		expect(template.treeHtml("message-124")).toContain("history 124");
		expect(template.treeHtml("alternate")).not.toContain("deep alternate needle");
		template.decoded.length = 0;
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
		template
			.treeNodes()
			.find((node) => node.dataset.id === "alternate")!
			.click();
		expect(template.html()).toContain("deep alternate needle");
		expect(template.html()).not.toContain("history 124");
		template.navigateTo("message-124");
		expect(template.search("deep alternate needle")).toEqual(["message-124", "alternate"]);
		expect(template.search("not in history", "all")).toEqual(["message-124"]);
		expect(template.decoded).not.toContain(0);
	});

	it.each([500, 17_728])("renders and navigates a %i-entry tree without decoding hidden state", async (count) => {
		const entries: SessionEntry[] = Array.from({ length: count }, (_, index) => ({
			type: "custom",
			id: `state-${index}`,
			parentId: index ? `state-${index - 1}` : null,
			timestamp: "2026-09-22T00:00:00Z",
			customType: "hidden-state",
			data: { untouched: `body ${index}` },
		}));
		const template = await loadTemplate({ entries, leafId: `state-${count - 1}` });
		expect(template.decoded).toEqual([]);
		expect(template.search("", "all")).toEqual(Array.from({ length: count }, (_, index) => `state-${index}`));
		expect(template.treeNodes()).toHaveLength(count);
		expect(template.treeHtml("state-0")).toContain("[custom]");
		template.treeNodes()[0].click();
		expect(template.treeNodes()[0].className).toContain("active");
		expect(template.getPath(`state-${count - 1}`)).toHaveLength(count);
		expect(template.decoded).toEqual([]);
	});

	it("keeps tree previews and branch-local tool facts without loading bodies, then exposes requested full content", async () => {
		const timestamp = "2026-09-22T00:00:00Z";
		const entries: SessionEntry[] = [
			{ type: "custom", id: "state", parentId: null, timestamp, customType: "state", data: { private: "retained" } },
			{
				type: "message",
				id: "skill",
				parentId: "state",
				timestamp,
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: '<skill name="deploy" location="/skills/deploy.md">\n# Skill-only needle\n</skill>\n\nship\t<release>',
						},
						{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					],
					timestamp: 1,
				},
			},
			{ type: "label", id: "label", parentId: "skill", timestamp, targetId: "skill", label: "ship <bookmark>" },
			{
				type: "message",
				id: "aborted",
				parentId: "state",
				timestamp,
				message: { ...fauxAssistantMessage([]), stopReason: "aborted" },
			},
			{
				type: "message",
				id: "error",
				parentId: "state",
				timestamp,
				message: { ...fauxAssistantMessage([]), stopReason: "error", errorMessage: "<failure>\nsecond line" },
			},
			{
				type: "message",
				id: "bash",
				parentId: "state",
				timestamp,
				message: {
					role: "bashExecution",
					command: "printf\t<value>\nnext",
					output: "complete bash output",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "custom",
				parentId: "state",
				timestamp,
				customType: "notice",
				content: `${"c".repeat(120)} custom-tail-needle`,
				display: false,
			},
			{
				type: "branch_summary",
				id: "summary",
				parentId: "state",
				timestamp,
				fromId: "skill",
				summary: `${"s".repeat(120)} summary-tail-needle`,
			},
			assistant("call-a", "state", [{ ...rawCall, arguments: { query: "branch A" } }]),
			result("result-a", "call-a"),
			assistant("call-b", "state", [{ ...rawCall, arguments: { query: "branch B" } }]),
			result("result-b", "call-b"),
			assistant("read-call", "state", [
				{
					type: "toolCall",
					id: "read",
					name: "read",
					arguments: { path: "/home/user/file.ts", offset: 2, limit: 3, json: { path: "/items" } },
				},
			]),
			result("read-result", "read-call", "read"),
		];
		const header = { type: "session", id: "tree-facts" };
		const template = await loadTemplate({ header, entries, leafId: "state" });
		expect(template.decoded).toEqual([]);
		for (const [id, text] of [
			["skill", "[ship &lt;bookmark&gt;]"],
			["skill", "deploy"],
			["skill", "ship &lt;release&gt;"],
			["aborted", "(aborted)"],
			["error", "&lt;failure&gt;\nsecond line"],
			["bash", "printf &lt;value&gt; next"],
			["custom", `${"c".repeat(100)}...`],
			["summary", `${"s".repeat(100)}...`],
			["result-a", "{&quot;query&quot;:&quot;branch A&quot;}"],
			["result-b", "{&quot;query&quot;:&quot;branch B&quot;}"],
			["read-result", "[read: ~/file.ts json={&quot;path&quot;:&quot;/items&quot;}:2-4]"],
		]) {
			expect(template.treeHtml(id)).toContain(text);
		}
		expect(template.treeHtml("custom")).not.toContain("custom-tail-needle");
		expect(template.treeHtml("summary")).not.toContain("summary-tail-needle");
		expect(template.decoded).toEqual([]);
		template
			.treeNodes()
			.find((node) => node.dataset.id === "result-a")!
			.click();
		expect(template.html()).toContain("branch A");
		expect(template.html()).not.toContain("branch B");
		expect(new Set(template.decoded)).toEqual(new Set([8, 9]));
		template
			.treeNodes()
			.find((node) => node.dataset.id === "skill")!
			.click();
		expect(template.html()).toContain("Skill-only needle");
		expect(template.html()).toContain("data:image/png;base64,aW1hZ2U=");
		expect(template.search("custom-tail-needle")).toContain("custom");
		expect(template.search("summary-tail-needle")).toContain("summary");
		template.navigateTo("custom");
		expect(template.html()).toContain("custom-tail-needle");
		template.navigateTo("summary");
		expect(template.html()).toContain("summary-tail-needle");
		template.download();
		expect(await template.downloaded()?.text()).toBe(
			[JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n"),
		);
	});

	it("uses tool names for rendering and escapes fallback names, arguments and nested calls", async () => {
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
		const unmatched = result("unmatched", "a", "missing");
		if (unmatched.type === "message" && unmatched.message.role === "toolResult")
			unmatched.message.toolName = '<unmatched>"';
		const entries = [assistant("a", null, [bare, rawCall, fallback]), result("r", "a"), nested, unmatched];
		const template = await loadTemplate({
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
		expect(template.treeHtml("r")).toContain("records_read");
		expect(template.treeHtml("r")).toContain("record query");
		expect(template.renderHeader()).toContain("&lt;records&gt;&quot;");
		expect(template.renderHeader()).toContain(">read</span>");
		expect(template.treeHtml("unmatched")).toContain("&lt;unmatched&gt;&quot;");
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
		const template = await loadTemplate({ header, entries, leafId: "final-a" });
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
			const template = await loadTemplate(data);
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
