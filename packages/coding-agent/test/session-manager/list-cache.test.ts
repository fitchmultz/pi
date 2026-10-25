import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../../src/modes/interactive/components/session-selector.ts";
import { filterAndSortSessions } from "../../src/modes/interactive/components/session-selector-search.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const processFixture = fileURLToPath(new URL("../fixtures/session-list-cache-process.ts", import.meta.url));
const mmapFixture = fileURLToPath(new URL("../fixtures/session-list-cache-mmap.py", import.meta.url));
const nativeMmapAvailable =
	process.platform === "linux" && existsSync("/dev/shm") && spawnSync("python3", ["-c", "import mmap"]).status === 0;

// pi#251: the resume picker must reuse complete metadata without changing listing/search semantics.
describe("session listing cache", () => {
	let temp: string;
	let dir: string;
	let cwd: string;

	beforeEach(() => {
		temp = mkdtempSync(join(tmpdir(), "pi-list-cache-"));
		dir = join(temp, "flat");
		cwd = join(temp, "project");
		mkdirSync(dir);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(temp, "agent"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(temp, { recursive: true, force: true });
	});

	function create() {
		const manager = SessionManager.create(cwd, dir, { id: "listing-test" });
		const first = manager.appendMessage(userMsg("first λ😀 question"));
		manager.appendMessage(assistantMsg("off branch searchable"));
		manager.branch(first);
		manager.appendMessage(userMsg("second branch\n full text"));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tool",
			toolName: "read",
			content: [{ type: "text", text: "not searchable" }],
			isError: false,
			timestamp: 1,
		});
		manager.appendSessionInfo(" old name ");
		manager.branch(first);
		manager.appendSessionInfo(" final name ");
		return manager;
	}

	function fromProcess(mode = "", api: "list" | "listAll" = "listAll", sessionDir = dir) {
		return JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--import",
					join(root, "packages/coding-agent/src/experimental/source-resolver.ts"),
					processFixture,
					sessionDir,
					mode,
					api,
					cwd,
				],
				{ cwd: root, env: process.env, encoding: "utf8" },
			),
		) as {
			sessions: {
				path: string;
				parentSessionPath?: string;
				name?: string;
				created: string;
				modified: string;
				messageCount: number;
				allMessagesText: string;
			}[];
			journalReads: number;
			journalBytes: number;
			journalParses: number;
			journalScans: number;
			streamEndRewrites: number;
			aborted: boolean;
		};
	}

	it.each(["list", "listAll"] as const)(
		"reuses exact %s results across processes with one raw read per file and no JSONL parsing",
		(api) => {
			const manager = create();
			const parent = manager.getSessionFile()!;
			const fork = SessionManager.forkFrom(parent, cwd, dir, { id: "listing-fork" }).getSessionFile()!;
			const cold = fromProcess("", api);
			const warm = fromProcess("", api);
			expect(cold.sessions.find((session) => session.path === fork)?.parentSessionPath).toBe(parent);
			expect(cold.journalReads).toBe(2);
			expect(cold.journalBytes).toBe(statSync(parent).size + statSync(fork).size);
			expect(warm.sessions).toEqual(cold.sessions);
			expect(warm.journalReads).toBe(2);
			expect(warm.journalBytes).toBe(cold.journalBytes);
			expect(cold.journalParses).toBeGreaterThan(0);
			expect(cold.journalScans).toBe(2);
			expect(warm.journalParses).toBe(0);
			expect(warm.journalScans).toBe(0);
		},
	);

	function writeRevisionJournal(sessionDir = dir) {
		const path = join(sessionDir, "revision.jsonl");
		writeFileSync(
			path,
			`${[
				{ type: "session", version: 3, id: "revision", timestamp: "2026-10-24T12:00:00Z", cwd },
				{
					type: "message",
					id: "first",
					parentId: null,
					timestamp: "2026-10-24T12:00:00Z",
					message: { role: "user", content: "old text", timestamp: 1 },
				},
				{ type: "session_info", id: "name", parentId: "first", name: "old name" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return path;
	}

	it.skipIf(!nativeMmapAvailable).each(["list", "listAll"] as const)(
		"detects a native metadata-preserving mmap rewrite in a separate %s reader",
		async (api) => {
			const nativeDir = mkdtempSync("/dev/shm/pi-list-cache-");
			const path = writeRevisionJournal(nativeDir);
			const writer = spawn("python3", ["-u", mmapFixture, path]);
			const exited = once(writer, "exit");
			const lines = createInterface({ input: writer.stdout })[Symbol.asyncIterator]();
			const revision = () => {
				const stats = statSync(path, { bigint: true });
				return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map(String);
			};
			try {
				expect((await lines.next()).value).toBe("ready");
				const before = revision();
				const cold = fromProcess("", api, nativeDir);
				expect(cold.sessions[0]).toMatchObject({ name: "old name", allMessagesText: "old text" });
				writer.stdin.end("\n");
				const hashes = JSON.parse((await lines.next()).value!) as { before: string; after: string };
				expect((await exited)[0]).toBe(0);
				// Establish native equal-stat/different-byte proof before testing cache behavior.
				expect(revision()).toEqual(before);
				expect(hashes.before).not.toBe(hashes.after);
				const changed = fromProcess("", api, nativeDir);
				expect(changed.sessions[0]).toMatchObject({ name: "new name", allMessagesText: "new text" });
				expect(changed.journalScans).toBe(1);
				expect(changed.journalReads).toBe(2);
				const warm = fromProcess("", api, nativeDir);
				expect(warm.sessions).toEqual(changed.sessions);
				expect(warm.journalReads).toBe(1);
				expect(warm.journalBytes).toBe(statSync(path).size);
				expect(warm.journalParses).toBe(0);
				expect(warm.journalScans).toBe(0);
			} finally {
				writer.stdin.end();
				writer.kill();
				await exited;
				rmSync(nativeDir, { recursive: true, force: true });
			}
		},
	);

	it.each(["list", "listAll"] as const)("hashes malformed UTF-8 as raw bytes in %s", (api) => {
		const path = writeRevisionJournal();
		const before = Buffer.from(readFileSync(path, "utf8").replace("old text", "bad \u0080 text"));
		// Two distinct invalid single-byte UTF-8 sequences both decode as U+FFFD.
		const marker = before.indexOf(Buffer.from("\u0080"));
		const first = Buffer.concat([before.subarray(0, marker), Buffer.from([0x80]), before.subarray(marker + 2)]);
		writeFileSync(path, first);
		const cold = fromProcess("freeze-revision", api);
		const second = Buffer.from(first);
		second[marker] = 0x81;
		expect(first.equals(second)).toBe(false);
		expect(first.toString("utf8")).toBe(second.toString("utf8"));
		writeFileSync(path, second);
		const changed = fromProcess("freeze-revision", api);
		expect(changed.sessions).toEqual(cold.sessions);
		expect(changed.journalScans).toBe(1);
		expect(changed.journalReads).toBe(2);
		expect(changed.journalParses).toBeGreaterThan(0);
		expect(fromProcess("freeze-revision", api).journalParses).toBe(0);
	});

	it.each(["list", "listAll"] as const)("binds the %s cold digest to parsed bytes, not a postscan reread", (api) => {
		writeRevisionJournal();
		const first = fromProcess("rewrite-at-stream-end", api);
		expect(first.streamEndRewrites).toBe(1);
		expect(first.sessions[0]).toMatchObject({ name: "old name", allMessagesText: "old text" });
		expect(first.journalReads).toBe(1);
		const changed = fromProcess("freeze-revision", api);
		expect(changed.sessions[0]).toMatchObject({ name: "new name", allMessagesText: "new text" });
		expect(changed.journalScans).toBe(1);
		expect(fromProcess("freeze-revision", api).journalParses).toBe(0);
	});

	it.each(["list", "listAll"] as const)("propagates cancellation during %s warm digest validation", (api) => {
		const path = writeRevisionJournal();
		fromProcess("", api);
		const cache = join(dir, ".session-list-cache-v1");
		const record = join(cache, readdirSync(cache)[0]);
		const before = readFileSync(record, "utf8");
		const aborted = fromProcess("abort-during-read", api);
		expect(aborted.aborted).toBe(true);
		expect(aborted.journalReads).toBe(1);
		expect(aborted.journalBytes).toBe(statSync(path).size);
		expect(aborted.journalParses).toBe(0);
		expect(aborted.journalScans).toBe(0);
		expect(readFileSync(record, "utf8")).toBe(before);
		expect(fromProcess("", api).journalParses).toBe(0);
	});

	it("reparses timezone-sensitive dates when the listing process changes timezone", () => {
		writeFileSync(
			join(dir, "timezone.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "timezone", timestamp: "2026-10-24T12:00:00", cwd })}\n`,
		);
		vi.stubEnv("TZ", "UTC");
		const utc = fromProcess();
		expect(utc.sessions[0].created).toBe("2026-10-24T12:00:00.000Z");
		vi.stubEnv("TZ", "America/Los_Angeles");
		const local = fromProcess();
		expect(local.journalReads).toBe(1);
		expect(local.journalScans).toBe(1);
		expect(local.sessions[0].created).toBe("2026-10-24T19:00:00.000Z");
		expect(local.sessions[0].modified).toBe("2026-10-24T19:00:00.000Z");
		expect(fromProcess().journalParses).toBe(0);
	});

	it("falls back to the source when date context is unavailable", () => {
		const manager = create();
		const expected = fromProcess();
		const fallback = fromProcess("unavailable-date-context");
		expect(fallback.sessions).toEqual(expected.sessions);
		expect(fallback.journalReads).toBe(1);
		expect(fallback.journalBytes).toBe(statSync(manager.getSessionFile()!).size);
		expect(fallback.journalScans).toBe(1);
		expect(fallback.journalParses).toBeGreaterThan(0);
	});

	it("recovers from unavailable date context within one listing without a formatter or TZ change", () => {
		for (const id of ["a", "b"]) {
			writeFileSync(
				join(dir, `${id}.jsonl`),
				`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-24T12:00:00", cwd })}\n`,
			);
		}
		const expected = fromProcess();
		const recovered = fromProcess("transient-date-context");
		expect(recovered.sessions).toEqual(expected.sessions);
		expect(recovered.journalScans).toBe(1);
		expect(recovered.journalParses).toBe(1);
		expect(fromProcess().journalParses).toBe(0);
	});

	it("rechecks date context after asynchronous warm digest validation", () => {
		writeFileSync(
			join(dir, "timezone.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "timezone", timestamp: "2026-10-24T12:00:00", cwd })}\n`,
		);
		vi.stubEnv("TZ", "UTC");
		fromProcess();
		const changed = fromProcess("timezone-at-stream-end");
		expect(changed.sessions[0].created).toBe("2026-10-24T19:00:00.000Z");
		expect(changed.journalScans).toBe(1);
		vi.stubEnv("TZ", "America/Los_Angeles");
		const warm = fromProcess();
		expect(warm.sessions).toEqual(changed.sessions);
		expect(warm.journalParses).toBe(0);
	});

	it("does not publish dates parsed under an intermediate timezone when TZ changes back before publication", () => {
		const path = writeRevisionJournal();
		const entries = readFileSync(path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const entry of entries) entry.timestamp = "2026-10-24T12:00:00";
		delete entries[1].message.timestamp;
		entries.push({ ...entries[1], id: "second" });
		writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		vi.stubEnv("TZ", "UTC");
		const changed = fromProcess("timezone-during-scan");
		expect(changed.sessions[0].created).toBe("2026-10-24T12:00:00.000Z");
		expect(changed.sessions[0].modified).toBe("2026-10-24T19:00:00.000Z");
		const stable = fromProcess();
		expect(stable.sessions[0].modified).toBe("2026-10-24T12:00:00.000Z");
		expect(stable.journalScans).toBe(1);
		expect(fromProcess().journalParses).toBe(0);
	});

	it("revalidates date context when timezone changes during a listing", () => {
		for (const id of ["a", "b"]) {
			writeFileSync(
				join(dir, `${id}.jsonl`),
				`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-24T12:00:00", cwd })}\n`,
			);
		}
		vi.stubEnv("TZ", "UTC");
		fromProcess();
		const changed = fromProcess("timezone-during-list");
		expect(changed.sessions.find((session) => session.path === join(dir, "b.jsonl"))?.created).toBe(
			"2026-10-24T12:00:00.000Z",
		);
		expect(changed.sessions.find((session) => session.path === join(dir, "a.jsonl"))?.created).toBe(
			"2026-10-24T19:00:00.000Z",
		);
		expect(changed.journalReads).toBe(2);
		expect(changed.journalBytes).toBe(statSync(join(dir, "a.jsonl")).size + statSync(join(dir, "b.jsonl")).size);
		expect(changed.journalScans).toBe(1);
		vi.stubEnv("TZ", "America/Los_Angeles");
		const local = fromProcess();
		expect(local.journalReads).toBe(2);
		expect(local.journalBytes).toBe(statSync(join(dir, "a.jsonl")).size + statSync(join(dir, "b.jsonl")).size);
		expect(local.journalScans).toBe(1);
		expect(local.sessions.every((session) => session.created === "2026-10-24T19:00:00.000Z")).toBe(true);
		const warm = fromProcess();
		expect(warm.sessions).toEqual(local.sessions);
		expect(warm.journalReads).toBe(2);
		expect(warm.journalBytes).toBe(local.journalBytes);
		expect(warm.journalParses).toBe(0);
		expect(warm.journalScans).toBe(0);
	});

	it("keeps all branches, exact counts, names, dates and search text on cold and warm paths", async () => {
		create();
		for (let run = 0; run < 2; run++) {
			const sessions = await SessionManager.list(cwd, dir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				name: "final name",
				messageCount: 4,
				firstMessage: "first λ😀 question",
				allMessagesText: "first λ😀 question off branch searchable second branch\n full text",
			});
			expect(sessions[0].created).toBeInstanceOf(Date);
			expect(sessions[0].modified).toBeInstanceOf(Date);
			for (const query of [
				'"off branch searchable"',
				'"second branch full text"',
				"re:second branch\\n full text",
				"frst qstn",
			]) {
				expect(filterAndSortSessions(sessions, query, "recent")).toEqual(sessions);
			}
			expect(filterAndSortSessions(sessions, '"not searchable"', "recent")).toEqual([]);
		}
	});

	it("invalidates external append, name clear, truncation, same-size rewrite and atomic replacement", async () => {
		const manager = create();
		const path = manager.getSessionFile()!;
		await SessionManager.listAll(dir);
		manager.appendMessage(userMsg("appended content"));
		manager.appendSessionInfo(" ");
		let info = (await SessionManager.listAll(dir))[0];
		expect(info.messageCount).toBe(5);
		expect(info.name).toBeUndefined();
		expect(info.allMessagesText).toContain("appended content");
		const header = readFileSync(path, "utf8").split("\n")[0];
		writeFileSync(path, `${header}\n`);
		info = (await SessionManager.listAll(dir))[0];
		expect(info.messageCount).toBe(0);
		expect(info.firstMessage).toBe("(no messages)");
		const before = statSync(path);
		writeFileSync(path, readFileSync(path, "utf8").replace("listing-test", "changed-test"));
		utimesSync(path, before.atime, before.mtime);
		expect((await SessionManager.listAll(dir))[0].id).toBe("changed-test");
		const replacement = join(temp, "replacement");
		writeFileSync(replacement, `${header}\n`);
		utimesSync(replacement, before.atime, before.mtime);
		renameSync(replacement, path);
		expect((await SessionManager.listAll(dir))[0].id).toBe("listing-test");
	});

	it("does not return deleted paths and preserves renamed and symlinked paths", async () => {
		const manager = create();
		const path = manager.getSessionFile()!;
		await SessionManager.listAll(dir);
		const renamed = join(dir, "renamed.jsonl");
		renameSync(path, renamed);
		expect((await SessionManager.listAll(dir)).map((info) => info.path)).toEqual([renamed]);
		const alias = join(temp, "alias");
		symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
		expect((await SessionManager.listAll(alias))[0].path).toBe(join(alias, "renamed.jsonl"));
		unlinkSync(renamed);
		expect(await SessionManager.listAll(dir)).toEqual([]);
		expect(await SessionManager.listAll(alias)).toEqual([]);
	});

	it("does not cache an excluded cwd as a missing session or share mutable results", async () => {
		create();
		expect(await SessionManager.list(join(temp, "other"), dir)).toEqual([]);
		const first = await SessionManager.listAll(dir);
		const modified = first[0].modified.getTime();
		first[0].name = "mutated result";
		first[0].modified.setTime(0);
		first[0].allMessagesText = "mutated result";
		const next = await SessionManager.listAll(dir);
		expect(next[0].name).toBe("final name");
		expect(next[0].modified.getTime()).toBe(modified);
		expect(next[0].allMessagesText).toContain("off branch searchable");
	});

	it("rescans unterminated records and completed malformed tails without repairing the journal", async () => {
		const manager = create();
		const path = manager.getSessionFile()!;
		const original = readFileSync(path, "utf8").trimEnd();
		writeFileSync(path, original);
		expect((await SessionManager.listAll(dir))[0].messageCount).toBe(4);
		expect(readFileSync(path, "utf8")).toBe(original);
		appendFileSync(path, '\n{"type":"session_info","name":');
		expect((await SessionManager.listAll(dir))[0].name).toBe("final name");
		appendFileSync(path, '"completed"}\n');
		expect((await SessionManager.listAll(dir))[0].name).toBe("completed");
		expect(readFileSync(path, "utf8")).toBe(`${original}\n{"type":"session_info","name":"completed"}\n`);
	});

	it("does not reuse a scan when a writer changes the source before it completes", () => {
		create();
		const first = fromProcess('\n{"type":"session_info","name":"concurrent name"}\n');
		expect(first.journalReads).toBe(1);
		const second = fromProcess();
		expect(second.sessions[0].name).toBe("concurrent name");
		expect(second.journalReads).toBe(1);
		expect(fromProcess().journalParses).toBe(0);
	});

	it("rechecks the source revision after a matching warm digest", () => {
		create();
		fromProcess();
		const changed = fromProcess('\n{"type":"session_info","name":"warm concurrent name"}\n');
		expect(changed.sessions[0].name).toBe("warm concurrent name");
		expect(changed.journalReads).toBe(2);
		expect(changed.journalScans).toBe(1);
		expect(fromProcess().sessions[0].name).toBe("warm concurrent name");
	});

	it("keeps valid sessions when cache storage is corrupt or unavailable", async () => {
		create();
		const expected = await SessionManager.listAll(dir);
		const cache = join(dir, ".session-list-cache-v1");
		for (const file of readdirSync(cache)) writeFileSync(join(cache, file), "{broken cache");
		expect(await SessionManager.listAll(dir)).toEqual(expected);
		rmSync(cache, { recursive: true });
		writeFileSync(cache, "not a directory");
		expect(await SessionManager.listAll(dir)).toEqual(expected);
	});

	it("removes orphaned search text after an external journal deletion", async () => {
		const manager = create();
		await SessionManager.listAll(dir);
		const cache = join(dir, ".session-list-cache-v1");
		expect(
			readdirSync(cache).some((file) => readFileSync(join(cache, file), "utf8").includes("off branch searchable")),
		).toBe(true);
		unlinkSync(manager.getSessionFile()!);
		expect(await SessionManager.listAll(dir)).toEqual([]);
		expect(readdirSync(cache)).toEqual([]);
	});

	it.each(["empty", "non-session", "directory"])(
		"removes cached transcripts when the source becomes %s",
		async (kind) => {
			const manager = create();
			await SessionManager.listAll(dir);
			const cache = join(dir, ".session-list-cache-v1");
			const record = join(cache, readdirSync(cache)[0]);
			const transcript = readFileSync(record, "utf8");
			expect(transcript).toContain("off branch searchable");
			writeFileSync(`${record}.00000000-0000-4000-8000-000000000000.tmp`, transcript, { mode: 0o600 });
			const path = manager.getSessionFile()!;
			if (kind === "directory") {
				unlinkSync(path);
				mkdirSync(path);
			} else {
				writeFileSync(path, kind === "empty" ? "" : '{"type":"not-session"}\n');
			}
			expect(await SessionManager.listAll(dir)).toEqual([]);
			expect(readdirSync(cache)).toEqual([]);
		},
	);

	it("discards superseded text when the replacement journal cannot be cached", async () => {
		const manager = create();
		await SessionManager.listAll(dir);
		const cache = join(dir, ".session-list-cache-v1");
		writeFileSync(
			manager.getSessionFile()!,
			`${JSON.stringify({ ...manager.getHeader(), timestamp: "not-a-date" })}\n`,
		);
		const sessions = await SessionManager.listAll(dir);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].allMessagesText).toBe("");
		expect(Number.isNaN(sessions[0].created.getTime())).toBe(true);
		expect(readdirSync(cache)).toEqual([]);
	});

	it.each(["supported", "legacy", "missing-digest", "invalid-digest"] as const)(
		"discards superseded %s cache text after an equal-revision replacement that cannot be cached",
		(kind) => {
			const path = writeRevisionJournal();
			fromProcess("freeze-revision");
			const cache = join(dir, ".session-list-cache-v1");
			const recordPath = join(cache, readdirSync(cache)[0]);
			const record = JSON.parse(readFileSync(recordPath, "utf8"));
			expect(record.info.allMessagesText).toBe("old text");
			if (kind === "legacy") record.version = 1;
			if (kind === "missing-digest" || kind === "legacy") delete record.digest;
			if (kind === "invalid-digest") record.digest = "not-sha256";
			writeFileSync(recordPath, JSON.stringify(record));
			const before = readFileSync(path, "utf8");
			const after = before.replace("2026-10-24T12:00:00Z", "not-a-date".padEnd("2026-10-24T12:00:00Z".length));
			expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
			writeFileSync(path, after);
			const changed = fromProcess("freeze-revision");
			expect(changed.sessions).toHaveLength(1);
			expect(changed.sessions[0].created).toBeNull();
			expect(changed.journalScans).toBe(1);
			expect(readdirSync(cache)).toEqual([]);
		},
	);

	it("removes cached search text through the picker deletion boundary", async () => {
		const manager = create();
		const sessions = await SessionManager.listAll(dir);
		initTheme("dark");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await selector.getSessionList().onDeleteSession!(manager.getSessionFile()!);
		expect(() => statSync(manager.getSessionFile()!)).toThrow();
		expect(readdirSync(join(dir, ".session-list-cache-v1"))).toEqual([]);
		selector.handleInput("\u001b");
	});

	it("does not retain search text when a journal is deleted during cache publication", () => {
		const manager = create();
		const result = fromProcess("delete-on-cache-publish");
		expect(result.journalReads).toBe(1);
		expect(() => statSync(manager.getSessionFile()!)).toThrow();
		expect(readdirSync(join(dir, ".session-list-cache-v1"))).toEqual([]);
		expect(fromProcess().sessions).toEqual([]);
	});

	it("removes cached text for a dangling journal-file symlink", async () => {
		const manager = create();
		symlinkSync(manager.getSessionFile()!, join(dir, "alias.jsonl"));
		expect(await SessionManager.listAll(dir)).toHaveLength(2);
		unlinkSync(manager.getSessionFile()!);
		expect(await SessionManager.listAll(dir)).toEqual([]);
		expect(readdirSync(join(dir, ".session-list-cache-v1"))).toEqual([]);
	});

	it("removes plaintext left by a crashed cache writer after source deletion", async () => {
		const manager = create();
		expect(() => fromProcess("crash-before-cache-publish")).toThrow();
		const cache = join(dir, ".session-list-cache-v1");
		const abandoned = readdirSync(cache);
		expect(abandoned).toHaveLength(1);
		expect(abandoned[0]).toMatch(/\.tmp$/);
		expect(readFileSync(join(cache, abandoned[0]), "utf8")).toContain("off branch searchable");
		unlinkSync(manager.getSessionFile()!);
		expect(await SessionManager.listAll(dir)).toEqual([]);
		expect(readdirSync(cache)).toEqual([]);
	});

	it("never follows a cache destination symlink or writes into a linked cache directory", async () => {
		create();
		await SessionManager.listAll(dir);
		const cache = join(dir, ".session-list-cache-v1");
		const record = join(cache, readdirSync(cache)[0]);
		const sentinel = join(temp, "sentinel");
		writeFileSync(sentinel, "must survive");
		unlinkSync(record);
		symlinkSync(sentinel, record);
		await SessionManager.listAll(dir);
		expect(readFileSync(sentinel, "utf8")).toBe("must survive");
		if (process.platform !== "win32") {
			expect(statSync(cache).mode & 0o777).toBe(0o700);
			expect(statSync(record).mode & 0o777).toBe(0o600);
		}
		rmSync(cache, { recursive: true });
		const target = join(temp, "linked-cache");
		mkdirSync(target);
		symlinkSync(target, cache, process.platform === "win32" ? "junction" : "dir");
		expect(await SessionManager.listAll(dir)).toHaveLength(1);
		expect(readdirSync(target)).toEqual([]);
	});

	it("allows concurrent in-process listings and cache writers", async () => {
		create();
		const results = await Promise.all(Array.from({ length: 8 }, () => SessionManager.listAll(dir)));
		for (const result of results) expect(result).toEqual(results[0]);
		expect(await SessionManager.listAll(dir)).toEqual(results[0]);
	});

	it.each([false, true])(
		"rejects cancellation from final progress in flat and default trees (warm=%s)",
		async (warm) => {
			const manager = create();
			const defaultDir = getDefaultSessionDir(cwd);
			renameSync(manager.getSessionFile()!, join(defaultDir, "default.jsonl"));
			for (const customDir of [defaultDir, undefined]) {
				if (warm) await SessionManager.listAll(customDir);
				const controller = new AbortController();
				const progress = (loaded: number, total: number) => {
					if (loaded === total) controller.abort();
				};
				await expect(SessionManager.listAll(customDir, progress, controller.signal)).rejects.toMatchObject({
					name: "AbortError",
				});
				await expect(SessionManager.listAll(customDir, undefined, controller.signal)).rejects.toMatchObject({
					name: "AbortError",
				});
			}
		},
	);
});
