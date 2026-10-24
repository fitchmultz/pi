import { execFileSync } from "node:child_process";
import {
	appendFileSync,
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

	function fromProcess(appendAtEnd?: string) {
		return JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--import",
					join(root, "packages/coding-agent/src/experimental/source-resolver.ts"),
					processFixture,
					dir,
					...(appendAtEnd ? [appendAtEnd] : []),
				],
				{ cwd: root, env: process.env, encoding: "utf8" },
			),
		) as {
			sessions: {
				name?: string;
				created: string;
				modified: string;
				messageCount: number;
				allMessagesText: string;
			}[];
			journalReads: number;
			journalBytes: number;
		};
	}

	it("reuses exact results across processes without reading journal bodies", () => {
		const manager = create();
		const cold = fromProcess();
		const warm = fromProcess();
		expect(cold.journalReads).toBe(1);
		expect(cold.journalBytes).toBe(statSync(manager.getSessionFile()!).size);
		expect(warm.sessions).toEqual(cold.sessions);
		expect(warm.journalReads).toBe(0);
		expect(warm.journalBytes).toBe(0);
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
		expect(local.sessions[0].created).toBe("2026-10-24T19:00:00.000Z");
		expect(local.sessions[0].modified).toBe("2026-10-24T19:00:00.000Z");
		expect(fromProcess().journalReads).toBe(0);
	});

	it("falls back to the source when date context is unavailable", async () => {
		create();
		const expected = await SessionManager.listAll(dir);
		const context = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
			throw new Error("unavailable date context");
		});
		try {
			expect(await SessionManager.listAll(dir)).toEqual(expected);
		} finally {
			context.mockRestore();
		}
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
		expect(fromProcess().journalReads).toBe(0);
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

	it("allows concurrent listings and independent cache writers", async () => {
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
