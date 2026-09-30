import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";

function makeSession(
	overrides: Partial<SessionInfo> & { id: string; modified: Date; allMessagesText: string },
): SessionInfo {
	return {
		path: `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified,
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: overrides.allMessagesText,
	};
}

describe("session selector search", () => {
	it("lists and renders large conversation history under a bounded heap before any search", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-list-"));
		try {
			const output = execFileSync(
				process.execPath,
				[
					"--max-old-space-size=96",
					"--expose-gc",
					"--import",
					new URL("../src/experimental/source-resolver.ts", import.meta.url).href,
					new URL("./fixtures/session-large-list.ts", import.meta.url).pathname,
					directory,
				],
				{ timeout: 60_000, encoding: "utf8" },
			);
			const receipt = JSON.parse(output) as { bytes: number; entries: number; retainedHeap: number };
			expect(receipt.bytes).toBeGreaterThan(128 * 1024 * 1024);
			expect(receipt.entries).toBe(65);
			expect(receipt.retainedHeap).toBeLessThan(96 * 1024 * 1024);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 70_000);

	it("retains complete explicit values and cross-message picker search beyond list previews", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-search-"));
		try {
			const manager = SessionManager.create(directory, directory);
			const first = `${"prefix ".repeat(60)}alpha`;
			const second = "beta reachable-needle";
			manager.appendMessage({ role: "user", content: first, timestamp: 1 });
			manager.appendMessage(fauxAssistantMessage(second));
			const source = manager.getSessionFile()!;
			const before = readFileSync(source);
			const sessions = await SessionManager.list(directory, directory);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]!.firstMessagePreview).toBe(first.slice(0, 256));
			expect(sessions[0]!.firstMessage).toBe(first);
			expect(sessions[0]!.allMessagesText).toBe(`${first} ${second}`);
			for (const query of ["reachable-needle", '"alpha beta"', "re:alpha\\s+beta"]) {
				expect(filterAndSortSessions(sessions, query, "recent").map((session) => session.id)).toEqual([
					manager.getSessionId(),
				]);
			}
			expect(readFileSync(source)).toEqual(before);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("filters by quoted phrase with whitespace normalization", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "node\n\n   cve was discussed",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "node something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"node cve"', "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("filters by regex (re:) and is case-insensitive", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "Brave is great",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "bravery is not the same",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:\\bbrave\\b", "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("recent sort preserves input order", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "nomatch",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				allMessagesText: "something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"brave"', "recent");
		expect(result.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("relevance sort orders by score and tie-breaks by modified desc", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "late",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "xxxx brave",
			}),
			makeSession({
				id: "early",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave xxxx",
			}),
		];

		const result1 = filterAndSortSessions(sessions, '"brave"', "relevance");
		expect(result1.map((s) => s.id)).toEqual(["early", "late"]);

		const tieSessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
		];

		const result2 = filterAndSortSessions(tieSessions, '"brave"', "relevance");
		expect(result2.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("returns empty list for invalid regex", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:(", "recent");
		expect(result).toEqual([]);
	});

	describe("name filter", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "named1",
				name: "My Project",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "named2",
				name: "Another Named",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "other1",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "other2",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
		];

		it("returns all sessions when nameFilter is 'all'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "all");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2", "other1", "other2"]);
		});

		it("returns only named sessions when nameFilter is 'named'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("applies name filter before search query", () => {
			const result = filterAndSortSessions(sessions, "blueberry", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("excludes whitespace-only names from named filter", () => {
			const sessionsWithWhitespace: SessionInfo[] = [
				makeSession({
					id: "whitespace",
					name: "   ",
					modified: new Date("2026-01-01T00:00:00.000Z"),
					allMessagesText: "test",
				}),
				makeSession({
					id: "empty",
					name: "",
					modified: new Date("2026-01-02T00:00:00.000Z"),
					allMessagesText: "test",
				}),
				makeSession({
					id: "named",
					name: "Real Name",
					modified: new Date("2026-01-03T00:00:00.000Z"),
					allMessagesText: "test",
				}),
			];

			const result = filterAndSortSessions(sessionsWithWhitespace, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named"]);
		});
	});
});
