import { execFile, execFileSync } from "node:child_process";
import fs, {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSessionConversionNotRequired, convertSessionFile } from "../src/core/session-conversion.ts";
import { buildSessionContext, type SessionEntry } from "../src/core/session-manager.ts";

type Entry = Record<string, unknown>;
const timestamp = "2026-09-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "archive", cwd: "/tmp", timestamp };
const usage = {
	input: 5,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 7,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function entry(id: string, parentId: string | null, fields: Entry): Entry {
	return { id, parentId, timestamp, ...fields };
}
function assistant(content: unknown[], extra: Entry = {}): Entry {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		responseId: "response",
		stopReason: "toolUse",
		usage,
		timestamp: 0,
		...extra,
	};
}
const call = {
	type: "toolCall",
	id: "call",
	name: "lookup",
	namespace: "docs",
	arguments: { query: "example" },
	async: true,
	executionStarted: true,
};
function settled(): Entry[] {
	return [
		entry("system", null, {
			type: "message",
			message: {
				role: "system",
				content: "instructions",
				timestamp: 0,
				nativeHead: true,
				toolsAdded: [
					{
						name: "lookup",
						namespace: "docs",
						async: true,
						description: "Find facts",
						parameters: { type: "object" },
					},
				],
			},
		}),
		entry("snapshot", "system", {
			type: "message",
			checkpoint: true,
			message: assistant([call], { stopReason: "pending" }),
		}),
		entry("result", "snapshot", {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "lookup",
				namespace: "docs",
				content: [{ type: "text", text: "final result" }],
				isError: false,
				timestamp: 1,
			},
		}),
		entry("final", "result", {
			type: "message",
			message: assistant([call, { type: "text", text: "completed response" }], {
				diagnostics: [{ type: "test", message: "safe diagnostic" }],
			}),
		}),
	];
}
const directories: string[] = [];
function fixture(entries: Entry[]) {
	const directory = mkdtempSync(join(tmpdir(), "pi-conversion-"));
	directories.push(directory);
	const source = join(directory, "original.jsonl");
	const output = join(directory, "converted.jsonl");
	const bytes = `${[header, ...entries].map((item) => JSON.stringify(item)).join("\n")}\n`;
	writeFileSync(source, bytes);
	return { directory, source, output, bytes };
}
function convertedEntries(path: string): SessionEntry[] {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line) as SessionEntry);
}
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("one-time session conversion", () => {
	it("preserves the archive and completed results while collapsing execution snapshots into upstream context", () => {
		const { source, output, bytes } = fixture(settled());
		convertSessionFile(source, output);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		const entries = convertedEntries(output);
		expect(() => assertSessionConversionNotRequired(entries)).not.toThrow();
		const context = buildSessionContext(entries);
		expect(context.messages.map((message) => message.role)).toEqual(["system", "assistant", "toolResult"]);
		expect(context.messages[0]).toMatchObject({ toolsAdded: [{ name: "lookup" }] });
		expect(context.messages[1]).toMatchObject({
			content: [
				{ type: "toolCall", id: "call", name: "lookup" },
				{ type: "text", text: "completed response" },
			],
			usage,
			diagnostics: [{ type: "test", message: "safe diagnostic" }],
		});
		expect(context.messages[2]).toMatchObject({ content: [{ type: "text", text: "final result" }] });
		expect(JSON.stringify(context.messages)).not.toContain('"executionStarted"');
		expect(JSON.stringify(context.messages)).not.toContain('"namespace"');
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "legacy-conversion-metadata",
				data: { sourceEntryId: "system", system: { nativeHead: true } },
			}),
		);
	});

	it("reads the blank separators written by the fork append path without changing the original", () => {
		const { source, output, bytes } = fixture(settled());
		// Fork SessionManager._persist appends `\n${JSON.stringify(entry)}\n`.
		const framed = bytes.replaceAll("\n{", "\n\n{");
		writeFileSync(source, framed);
		convertSessionFile(source, output);
		expect(readFileSync(source, "utf8")).toBe(framed);
		expect(buildSessionContext(convertedEntries(output)).messages.map((message) => message.role)).toEqual([
			"system",
			"assistant",
			"toolResult",
		]);
	});

	it.each(["toString", "constructor", "__proto__"])(
		"preserves web-search metadata and own %s fields on entries and messages",
		(key) => {
			const input = settled();
			const webSearch = { calls: [], citations: [] };
			const extra = { [key]: { exact: [false, null, 0] } };
			input[1] = { ...input[1], ...extra };
			input[3].message = { ...(input[3].message as Entry), webSearch, ...extra };
			const { source, output, bytes } = fixture(input);
			convertSessionFile(source, output);
			const entries = convertedEntries(output);
			const copied = entries.find((entry) => entry.id === "snapshot")!;
			const message = buildSessionContext(entries).messages[1];
			expect(Object.hasOwn(copied, key)).toBe(true);
			expect(copied).toMatchObject(extra);
			expect(Object.hasOwn(message, key)).toBe(true);
			expect(message).toMatchObject({ webSearch, ...extra });
			expect(readFileSync(source, "utf8")).toBe(bytes);
		},
	);

	it("normalizes legacy string tool removals into upstream references", () => {
		const input = settled();
		(input[0].message as Entry).toolsRemoved = ["retired"];
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		expect(buildSessionContext(convertedEntries(output)).messages[0]).toMatchObject({
			toolsRemoved: [{ name: "retired" }],
		});
	});

	it("accepts root branch-summary references and checks every branch", () => {
		const input = settled();
		input.push(entry("root-summary", null, { type: "branch_summary", fromId: "root", summary: "fresh start" }));
		input.push(
			entry("root-user", "root-summary", {
				type: "message",
				message: { role: "user", content: "new", timestamp: 4 },
			}),
		);
		const { source, output, bytes } = fixture(input);
		convertSessionFile(source, output);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(
			buildSessionContext(convertedEntries(output), "root-user").messages.map((message) => message.role),
		).toEqual(["branchSummary", "user"]);
	});

	it.each(["before", "after"])(
		"carries receipts completed %s a fresh window without old prose or double billing",
		(arrival) => {
			const input = settled();
			(input[3].message as Entry).content = [
				{ type: "thinking", thinking: "private reasoning", thinkingSignature: "signed-block" },
				call,
				{ type: "text", text: "completed response" },
			];
			if (arrival === "before")
				input.push(
					entry("window", "final", {
						type: "context_window",
						tokensBefore: 20,
						handoff: "continue with the receipt",
						retainedToolResultIds: ["result"],
					}),
				);
			else {
				input.splice(
					2,
					0,
					entry("window", "snapshot", {
						type: "context_window",
						tokensBefore: 20,
						handoff: "continue with the receipt",
					}),
				);
				input[3].parentId = "window";
			}
			const { source, output } = fixture(input);
			convertSessionFile(source, output);
			const entries = convertedEntries(output);
			const context = buildSessionContext(entries);
			expect(context.messages.map((message) => message.role)).toEqual([
				"compactionSummary",
				"assistant",
				"toolResult",
			]);
			expect(context.messages[1]).toMatchObject({
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: "signed-block" },
					{ type: "toolCall", id: "call", name: "lookup", arguments: { query: "example" } },
				],
			});
			expect(context.messages[2]).toMatchObject({ content: [{ type: "text", text: "final result" }] });
			expect(JSON.stringify(context.messages)).not.toContain("completed response");
			const total = entries.reduce(
				(sum, item) =>
					sum +
					(item.type === "message" && item.message.role === "assistant" ? item.message.usage.totalTokens : 0),
				0,
			);
			expect(total).toBe(7);
			expect(() => assertSessionConversionNotRequired(entries)).not.toThrow();
		},
	);

	it("retains coalesced calls and receipts when a compaction anchors its final snapshot", () => {
		const input = settled();
		input.push(
			entry("compact", "final", {
				type: "compaction",
				summary: "earlier summary",
				tokensBefore: 20,
				firstKeptEntryId: "final",
			}),
		);
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		const context = buildSessionContext(convertedEntries(output));
		expect(context.messages.map((message) => message.role)).toEqual(["compactionSummary", "assistant", "toolResult"]);
		expect(context.messages[2]).toMatchObject({ content: [{ type: "text", text: "final result" }] });
	});

	it("converts windows on both branches without reviving old conversation and retains handoff and prompt", () => {
		const input = settled();
		for (const branch of ["a", "b"]) {
			input.push(
				entry(branch, "final", {
					type: "context_window",
					handoff: `continue ${branch}`,
					tokensBefore: null,
					systemMessage: {
						role: "system",
						content: `prompt ${branch}`,
						timestamp: 2,
						replace: true,
						nativeHead: true,
					},
				}),
			);
			input.push(
				entry(`${branch}-user`, branch, {
					type: "message",
					message: { role: "user", content: `new ${branch}`, timestamp: 3 },
				}),
			);
		}
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		const entries = convertedEntries(output);
		for (const branch of ["a", "b"]) {
			const context = buildSessionContext(entries, `${branch}-user`);
			expect(context.messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user"]);
			expect(context.messages[0]).toMatchObject({ content: `prompt ${branch}` });
			expect(context.messages[1]).toMatchObject({ summary: expect.stringContaining(`continue ${branch}`) });
			expect(JSON.stringify(context.messages)).not.toContain("completed response");
		}
	});

	it("accepts settled steering status transitions without delivering their input again", () => {
		const input = settled();
		const message = { role: "user", content: "already delivered", timestamp: 2 };
		input.push(
			entry("queued", "final", {
				type: "custom",
				customType: "response-steering",
				data: { steeringId: "steer", status: "accepted", message },
			}),
		);
		input.push(
			entry("applied", "queued", {
				type: "custom",
				customType: "response-steering",
				data: { steeringId: "steer", status: "applied", message },
			}),
		);
		input.push(entry("delivered", "applied", { type: "message", message }));
		const { source, output } = fixture(input);
		convertSessionFile(source, output);
		expect(buildSessionContext(convertedEntries(output)).messages.filter((item) => item.role === "user")).toEqual([
			message,
		]);
	});

	it.each([
		"same path",
		"existing file",
		"symlink",
		"dangling symlink",
		"directory",
		...(process.platform === "android" ? [] : ["hard link"]),
	])("never overwrites %s", (collision) => {
		const { source, output, bytes } = fixture(settled());
		if (collision === "existing file") writeFileSync(output, "keep me");
		if (collision === "symlink") symlinkSync(source, output);
		if (collision === "dangling symlink") symlinkSync("missing", output);
		if (collision === "directory") mkdirSync(output);
		if (collision === "hard link") linkSync(source, output);
		const before = lstatSync(collision === "same path" ? source : output);
		expect(() => convertSessionFile(source, collision === "same path" ? source : output)).toThrow();
		const after = lstatSync(collision === "same path" ? source : output);
		expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		if (collision === "existing file") expect(readFileSync(output, "utf8")).toBe("keep me");
	});

	it("publishes exactly one complete journal when conversions race for the same output", async () => {
		const { directory, source, output, bytes } = fixture(settled());
		const script = join(directory, "race.mjs");
		writeFileSync(
			script,
			`import { convertSessionFile } from ${JSON.stringify(new URL("../src/core/session-conversion.ts", import.meta.url).href)};\nconvertSessionFile(process.argv[2], process.argv[3]);\n`,
		);
		const run = promisify(execFile);
		const results = await Promise.allSettled(
			[0, 1].map(() =>
				run(
					process.execPath,
					[
						"--import",
						new URL("../src/experimental/source-resolver.ts", import.meta.url).href,
						script,
						source,
						output,
					],
					{ timeout: 30_000 },
				),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(buildSessionContext(convertedEntries(output)).messages.map((message) => message.role)).toEqual([
			"system",
			"assistant",
			"toolResult",
		]);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(readdirSync(directory).sort()).toEqual(["converted.jsonl", "original.jsonl", "race.mjs"]);
	});

	it.each([
		[
			"unfinished side branch",
			(input: Entry[]) => input.push(entry("unsafe", "snapshot", { type: "session_info", name: "unfinished" })),
		],
		[
			"missing receipt",
			(input: Entry[]) => {
				input[2] = entry("result", "snapshot", { type: "session_info" });
			},
		],
		[
			"dangling reference",
			(input: Entry[]) => input.push(entry("label", "final", { type: "label", targetId: "missing", label: "bad" })),
		],
		["duplicate entry", (input: Entry[]) => input.push(input[0])],
		[
			"malformed system checkpoint",
			(input: Entry[]) =>
				input.push(
					entry("window", "final", {
						type: "context_window",
						tokensBefore: 20,
						systemMessage: { role: "system", timestamp: 1 },
					}),
				),
		],
		[
			"applied steering missing its durable input",
			(input: Entry[]) =>
				input.push(
					entry("steer", "final", {
						type: "custom",
						customType: "response-steering",
						data: {
							steeringId: "s",
							status: "applied",
							message: { role: "user", content: "lost", timestamp: 2 },
						},
					}),
				),
		],
		[
			"call straddling an unsupported compaction cut",
			(input: Entry[]) => {
				input.splice(
					2,
					0,
					entry("window", "snapshot", {
						type: "compaction",
						summary: "cut",
						firstKeptEntryId: "window",
						tokensBefore: 1,
					}),
				);
				input[3].parentId = "window";
			},
		],
		[
			"edit of a coalesced snapshot",
			(input: Entry[]) =>
				input.push(entry("edit", "final", { type: "context_edit", targetId: "final", replacement: null })),
		],
		[
			"malformed message",
			(input: Entry[]) => {
				input[2].message = null;
			},
		],
		[
			"cycle",
			(input: Entry[]) => {
				input[0].parentId = "final";
			},
		],
		[
			"namespace collision",
			(input: Entry[]) =>
				input.push(
					entry("collision", "final", {
						type: "message",
						message: {
							role: "system",
							content: "",
							timestamp: 4,
							toolsAdded: [
								{ name: "lookup", namespace: "other", description: "different tool", parameters: {} },
							],
						},
					}),
				),
		],
		[
			"unsettled steering",
			(input: Entry[]) =>
				input.push(
					entry("steering", "final", {
						type: "custom",
						customType: "response-steering",
						data: { steeringId: "steer", status: "unknown" },
					}),
				),
		],
		[
			"invalid retained receipt",
			(input: Entry[]) =>
				input.push(
					entry("window", "final", { type: "context_window", tokensBefore: 1, retainedToolResultIds: ["final"] }),
				),
		],
	] as const)("refuses %s before publication, including inactive branches", (_name, change) => {
		const input = settled();
		change(input);
		const { source, output, bytes, directory } = fixture(input);
		expect(() => convertSessionFile(source, output)).toThrow(/conversion refused/);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(existsSync(output)).toBe(false);
		expect(readdirSync(directory)).toEqual(["original.jsonl"]);
	});

	it("refuses truncated JSON without creating an output", () => {
		const { source, output } = fixture(settled());
		writeFileSync(source, `${readFileSync(source, "utf8")}{"type":`);
		expect(() => convertSessionFile(source, output)).toThrow(/invalid JSONL/);
		expect(existsSync(output)).toBe(false);
	});

	it("refuses a changed source after staging without publishing or undoing the other writer's bytes", () => {
		const { source, output, bytes, directory } = fixture(settled());
		const changed = `${bytes}\n`;
		const fsync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			fsync(fd);
			writeFileSync(source, changed);
		});
		syncBuiltinESMExports();
		expect(() => convertSessionFile(source, output)).toThrow("source changed during conversion");
		expect(readFileSync(source, "utf8")).toBe(changed);
		expect(existsSync(output)).toBe(false);
		expect(readdirSync(directory)).toEqual(["original.jsonl"]);
	});

	it.each([null, { content: [{ type: "text", text: "redacted" }] }, { content: [] }])(
		"refuses edits that could restore an omitted async receipt after compaction: %j",
		(replacement) => {
			const input = [
				entry("call", null, { type: "message", message: assistant([call]) }),
				entry("result", "call", { type: "message", message: settled()[2].message }),
				entry("edit", "result", { type: "context_edit", targetId: "call", replacement }),
				entry("compact", "edit", {
					type: "compaction",
					firstKeptEntryId: "call",
					summary: "summary",
					tokensBefore: 1,
				}),
			];
			const { source, output, bytes } = fixture(input);
			expect(() => convertSessionFile(source, output)).toThrow("changes legacy execution history");
			expect(readFileSync(source, "utf8")).toBe(bytes);
			expect(existsSync(output)).toBe(false);
		},
	);

	it("converts a long linear journal within a bounded process heap", () => {
		const input = Array.from({ length: 10_000 }, (_, index) =>
			entry(String(index), index === 0 ? null : String(index - 1), { type: "session_info", name: `entry ${index}` }),
		);
		const { directory, source, output, bytes } = fixture(input);
		const script = join(directory, "convert.mjs");
		writeFileSync(
			script,
			`import { convertSessionFile } from ${JSON.stringify(new URL("../src/core/session-conversion.ts", import.meta.url).href)};\nconvertSessionFile(process.argv[2], process.argv[3]);\n`,
		);
		execFileSync(
			process.execPath,
			[
				"--max-old-space-size=128",
				"--import",
				new URL("../src/experimental/source-resolver.ts", import.meta.url).href,
				script,
				source,
				output,
			],
			{ timeout: 30_000 },
		);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(convertedEntries(output)).toEqual(input);
	});

	it("startup distinguishes retired mechanisms from ordinary upstream and unrelated extension data", () => {
		expect(() =>
			assertSessionConversionNotRequired([
				header,
				entry("system", null, {
					type: "message",
					message: { role: "system", content: "", timestamp: 0, toolsRemoved: ["old", { name: "other" }] },
				}),
				entry("user", null, { type: "message", message: { role: "user", content: "hello", timestamp: 0 } }),
				entry("data", "user", {
					type: "custom",
					customType: "extension",
					data: { async: true, context_window: "not runtime" },
				}),
				entry("assistant", "data", {
					type: "message",
					message: assistant([
						{ type: "toolCall", id: "call", name: "lookup", namespace: "provider-native", arguments: {} },
					]),
				}),
				entry("edit", "assistant", {
					type: "context_edit",
					targetId: "assistant",
					replacement: { arbitrary: true },
				}),
				entry("other-edit", "edit", { type: "context_edit", targetId: "assistant", replacement: [] }),
			]),
		).not.toThrow();
		expect(() => assertSessionConversionNotRequired(settled())).toThrow(/one-time conversion/);
		expect(() => assertSessionConversionNotRequired(settled())).toThrow(/pi convert-session SOURCE NEW_PATH/);
		expect(() =>
			assertSessionConversionNotRequired([
				entry("edit", null, {
					type: "context_edit",
					targetId: "call",
					replacement: { content: [{ type: "toolCall", async: true }] },
				}),
			]),
		).toThrow(/one-time conversion/);
		expect(() => assertSessionConversionNotRequired([null])).toThrow();
	});
});
