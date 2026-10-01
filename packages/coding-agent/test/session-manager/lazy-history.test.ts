import { execFileSync } from "node:child_process";
import fs, {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { closeJournalSource, readJournalRecord, scanJournal } from "../../src/core/session-journal.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(): { directory: string; source: string; manager: SessionManager; id: string } {
	const directory = mkdtempSync(join(tmpdir(), "pi-lazy-history-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	const id = manager.appendCustomEntry("small", { exact: [false, null, 0] });
	return { directory, source: manager.getSessionFile()!, manager, id };
}

it("inspects and copies >512 MiB history under a 96 MiB heap without hydrating ignored values", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-large-history-"));
	directories.push(directory);
	const output = execFileSync(
		process.execPath,
		[
			"--max-old-space-size=96",
			"--expose-gc",
			"--import",
			new URL("../../src/experimental/source-resolver.ts", import.meta.url).href,
			new URL("../fixtures/session-large-history.ts", import.meta.url).pathname,
			directory,
		],
		{ timeout: 180000, encoding: "utf8" },
	);
	const receipt = JSON.parse(output) as {
		bytes: number;
		entries: number;
		retainedHeap: number;
		copiesVerified: boolean;
	};
	expect(receipt).toMatchObject({ entries: 136, copiesVerified: true });
	expect(receipt.bytes).toBeGreaterThan(512 * 1024 * 1024);
	expect(receipt.retainedHeap).toBeLessThan(96 * 1024 * 1024);
}, 200000);

it("reuses active journal bodies without exposing SDK mutations or concealing source changes", () => {
	const { source, manager } = fixture();
	manager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("original response"));
	const first = manager.buildSessionProjection();
	const read = vi.spyOn(fs, "readSync");
	syncBuiltinESMExports();
	const user = first.messages.find((message) => message.role === "user")!;
	user.content = "SDK mutation";
	const second = manager.buildSessionProjection();
	expect(second.messages.find((message) => message.role === "user")?.content).toBe("original request");
	expect(read).not.toHaveBeenCalled();
	manager.appendMessage({ role: "user", content: "next request", timestamp: 2 });
	read.mockClear();
	expect(
		manager
			.buildSessionContext()
			.messages.filter((message) => message.role === "user")
			.map((message) => message.content),
	).toEqual(["original request", "next request"]);
	// Only the newly persisted body needs reading, not the saved prefix.
	expect(read).toHaveBeenCalledTimes(1);
	const saved = readFileSync(source, "utf8");
	writeFileSync(source, saved.replace("original request", "modified request"));
	expect(() => manager.buildSessionProjection()).toThrow("Journal source generation changed");
	writeFileSync(source, saved);
	manager.buildSessionProjection();
	truncateSync(source, 10);
	unlinkSync(source);
	expect(() => manager.buildSessionProjection()).toThrow("Journal source generation changed");
});

it.each([
	{ raw: "-0", expected: -0 },
	{ raw: "1e400", expected: Number.POSITIVE_INFINITY },
])("preserves native JSON numeric values in warm projections ($raw)", ({ raw, expected }) => {
	const { source, manager } = fixture();
	writeFileSync(
		source,
		`${JSON.stringify(manager.getHeader())}\n{"type":"message","id":"result","parentId":null,"timestamp":"2026-09-30T00:00:00.000Z","message":{"role":"toolResult","toolCallId":"call","toolName":"read","content":[],"details":{"value":${raw}},"isError":false,"timestamp":0}}\n`,
	);
	const reopened = SessionManager.open(source);
	for (let i = 0; i < 2; i++) {
		const result = reopened.buildSessionContext().messages.find((message) => message.role === "toolResult")!;
		const details = result.details as { value: number };
		expect(Object.is(details.value, expected)).toBe(true);
		details.value = 123;
	}
});

it.each(["toString", "constructor", "__proto__"])("preserves an own %s field when branching", (key) => {
	const { directory, source, manager, id } = fixture();
	const expected = {
		...JSON.parse(JSON.stringify(manager.getEntry(id))),
		[key]: { exact: [false, null, 0] },
	};
	writeFileSync(source, `${JSON.stringify(manager.getHeader())}\n${JSON.stringify(expected)}\n`);
	const before = readFileSync(source);
	const reopened = SessionManager.open(source);
	const branch = reopened.createBranchedSession(id)!;
	expect(reopened.getSessionFile()).toBe(branch);
	expect(reopened.getSessionId()).not.toBe(manager.getSessionId());
	const copied = JSON.parse(JSON.stringify(reopened.getEntry(id)));
	expect(Object.hasOwn(copied, key)).toBe(true);
	expect(copied).toEqual(expected);
	expect(readFileSync(source)).toEqual(before);
	expect(SessionManager.open(branch, directory).getEntry(id)).toEqual(expected);
});

it("keeps branch payloads independent of the original journal after publication", () => {
	const { directory, source, manager, id } = fixture();
	const branch = manager.createBranchedSession(id)!;
	const replacement = join(directory, "replacement.jsonl");
	writeFileSync(replacement, "a different source generation\n");
	renameSync(replacement, source);
	expect(manager.getSessionFile()).toBe(branch);
	expect(JSON.parse(JSON.stringify(manager.getEntry(id)))).toMatchObject({ data: { exact: [false, null, 0] } });
});

it("refreshes an appended or replaced identical generation read-only and rejects changed or truncated history", () => {
	const { directory, source, manager, id } = fixture();
	const added = {
		type: "session_info",
		id: "external",
		parentId: id,
		timestamp: new Date(0).toISOString(),
		name: "appended",
	};
	appendFileSync(source, `${JSON.stringify(added)}\n`);
	const appended = readFileSync(source);
	expect(manager.getEntryMetadata("external")).toMatchObject({ name: "appended" });
	expect(manager.getLeafId()).toBe(id);
	const replacement = join(directory, "replacement.jsonl");
	writeFileSync(replacement, appended);
	renameSync(replacement, source);
	expect(manager.getEntry(id)).toMatchObject({ data: { exact: [false, null, 0] } });
	expect(readFileSync(source)).toEqual(appended);
	writeFileSync(source, appended.toString().replace('"small"', '"other"'));
	expect(() => manager.getEntryMetadata(id)).toThrow("Journal source generation changed");
	writeFileSync(source, appended);
	truncateSync(source, 10);
	expect(() => manager.getEntry(id)).toThrow("Journal source generation changed");
	expect(readFileSync(source)).toHaveLength(10);
});

it("waits for LF before refreshing a valid external tail while retaining tolerant native history", () => {
	const { source, manager, id } = fixture();
	const revision = manager.getEntriesRevision();
	const added = {
		type: "session_info",
		id: "external-tail",
		parentId: id,
		timestamp: new Date(0).toISOString(),
		name: "published after LF",
	};
	appendFileSync(
		source,
		Buffer.concat([
			Buffer.from('not JSON\n{"type":"custom","id":"native-utf8","parentId":null,"customType":"native","data":"'),
			Buffer.from([0xff]),
			Buffer.from(`"}\n${JSON.stringify(added)}`),
		]),
	);
	const pending = readFileSync(source);
	expect(manager.getEntryMetadata(added.id)).toBeUndefined();
	expect(manager.getEntries().map((entry) => entry.id)).toEqual([id, "native-utf8"]);
	expect(manager.getEntry("native-utf8")).toMatchObject({ data: "\uFFFD" });
	expect(manager.getLeafId()).toBe(id);
	expect(manager.getEntriesRevision()).toBe(revision + 1);
	expect(readFileSync(source)).toEqual(pending);
	appendFileSync(source, "\n");
	expect(manager.getEntryMetadata(added.id)).toMatchObject({ name: added.name });
	expect(manager.getEntries().map((entry) => entry.id)).toEqual([id, "native-utf8", added.id]);
	expect(manager.getEntry(id)).toMatchObject({ data: { exact: [false, null, 0] } });
	expect(manager.getLeafId()).toBe(id);
	expect(manager.getEntriesRevision()).toBe(revision + 2);
	expect(readFileSync(source)).toEqual(Buffer.concat([pending, Buffer.from("\n")]));
});

it("uses byte framing and JSON.parse duplicate-key semantics without repairing sealed or live input", () => {
	const { source } = fixture();
	const bytes = Buffer.from(
		'\uFEFF{"type":"session","id":"owner"}\r\n\n{"type":"custom","id":"snow","parentId":"old","parentId":null,"data":{"lost":1},"data":{"note":"雪 🦄","__proto__":{"exact":true}}}',
	);
	writeFileSync(source, bytes);
	const select = (path: readonly (string | number)[]) =>
		path.length === 0
			? ("descend" as const)
			: ["type", "id", "parentId"].includes(String(path[0]))
				? ("keep" as const)
				: ("skip" as const);
	const sealed = scanJournal(source, { policy: "strict", allowLeadingBom: true, chunkSize: 1, select });
	const live = scanJournal(source, { policy: "live", allowLeadingBom: true, chunkSize: 1, select });
	try {
		expect(sealed.records.map((record) => record.value)).toEqual([
			{ type: "session", id: "owner" },
			{ type: "custom", id: "snow", parentId: null },
		]);
		expect(sealed.records[1]!.start).toBe(bytes.indexOf(Buffer.from('{"type":"custom"')));
		expect(live.records).toHaveLength(1);
		expect(live.committedEnd).toBe(sealed.records[1]!.start);
		const body = readJournalRecord(sealed.source, sealed.records[1]!);
		expect(body).toEqual(JSON.parse(bytes.subarray(sealed.records[1]!.start).toString()));
		expect(Object.hasOwn(body.data as object, "__proto__")).toBe(true);
		expect(readFileSync(source)).toEqual(bytes);
	} finally {
		closeJournalSource(sealed.source);
		closeJournalSource(live.source);
	}
});

it("rejects malformed ignored values and strict invalid UTF-8 while preserving tolerant native policy", () => {
	const { source } = fixture();
	const select = (path: readonly (string | number)[]) =>
		path.length === 0 ? ("descend" as const) : path[0] === "type" ? ("keep" as const) : ("skip" as const);
	const malformed = '{"type":"custom","data":{"ignored":]}}\n';
	writeFileSync(source, malformed);
	expect(() => scanJournal(source, { policy: "strict", select })).toThrow("Invalid JSONL");
	const tolerant = scanJournal(source, { policy: "tolerant", select });
	try {
		expect(tolerant.records).toEqual([]);
	} finally {
		closeJournalSource(tolerant.source);
	}
	expect(readFileSync(source, "utf8")).toBe(malformed);
	const invalidUtf8 = Buffer.concat([
		Buffer.from('{"type":"custom","data":"'),
		Buffer.from([0xff]),
		Buffer.from('"}\n'),
	]);
	writeFileSync(source, invalidUtf8);
	expect(() => scanJournal(source, { policy: "strict", select })).toThrow("Invalid JSONL");
	const native = scanJournal(source, { policy: "tolerant" });
	try {
		expect(native.records[0]!.value).toEqual({ type: "custom", data: "\uFFFD" });
	} finally {
		closeJournalSource(native.source);
	}
	expect(readFileSync(source)).toEqual(invalidUtf8);
});
