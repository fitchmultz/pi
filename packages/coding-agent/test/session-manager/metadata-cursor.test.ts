import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getLatestCustomEntry, SessionMetadataCursor } from "../../src/core/session-metadata-cursor.ts";

it("replays after navigation and reload, but returns only appended metadata during ordinary work", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-metadata-cursor-"));
	try {
		const manager = SessionManager.create(directory, directory);
		const root = manager.appendCustomEntry("state", "root");
		const journal = new SessionMetadataCursor();
		const branch = new SessionMetadataCursor();
		expect(journal.read(manager)).toMatchObject({ reset: true, entries: [{ id: root }] });
		expect(branch.read(manager, true)).toMatchObject({ reset: true, entries: [{ id: root }] });
		const first = manager.appendCustomEntry("state", "first");
		expect(journal.read(manager)).toMatchObject({ reset: false, entries: [{ id: first }] });
		expect(branch.read(manager, true)).toMatchObject({ reset: false, entries: [{ id: first }] });
		expect(branch.read(manager, true)).toEqual({ reset: false, entries: [] });
		expect(getLatestCustomEntry(manager, "state")).toMatchObject({ data: "first" });
		manager.branch(root);
		expect(branch.read(manager, true)).toMatchObject({ reset: true, entries: [{ id: root }] });
		expect(journal.read(manager)).toEqual({ reset: false, entries: [] });
		expect(getLatestCustomEntry(manager, "state")).toMatchObject({ data: "root" });
		const sibling = manager.appendCustomEntry("state", "sibling");
		expect(branch.read(manager, true)).toMatchObject({ reset: false, entries: [{ id: sibling }] });
		manager.setSessionFile(manager.getSessionFile()!);
		expect(branch.read(manager, true)).toMatchObject({ reset: true, entries: [{ id: root }, { id: sibling }] });
		expect(journal.read(manager)).toMatchObject({
			reset: true,
			entries: [{ id: root }, { id: first }, { id: sibling }],
		});
		expect(getLatestCustomEntry(manager, "state")).toMatchObject({ data: "sibling" });
		manager.newSession();
		expect(journal.read(manager)).toEqual({ reset: true, entries: [] });
		expect(getLatestCustomEntry(manager, "state")).toBeUndefined();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("invalidates physical-order accumulators when validated reconciliation reorders old entries", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-metadata-reconcile-"));
	try {
		const manager = SessionManager.create(directory, directory);
		manager.appendSessionInfo("first");
		manager.appendSessionInfo("second");
		manager.appendCustomEntry("tail");
		const cursor = new SessionMetadataCursor();
		expect(cursor.read(manager).reset).toBe(true);
		const file = manager.getSessionFile()!;
		const records = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
		[records[1], records[2]] = [records[2], records[1]];
		writeFileSync(file, `${records.join("\n")}\n`);
		const replay = cursor.read(manager);
		expect(replay.reset).toBe(true);
		expect(replay.entries.filter((entry) => entry.type === "session_info").map((entry) => entry.name)).toEqual([
			"second",
			"first",
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
