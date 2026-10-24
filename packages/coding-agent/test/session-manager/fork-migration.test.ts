import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const timestamp = "2025-01-01T00:00:00.000Z";
const first = { role: "user" as const, content: "first request", timestamp: 1735689601000 };
const second = { role: "user" as const, content: "second request", timestamp: 1735689602000 };

// #256: replacing a legacy header must not skip migration of the fork's history.
describe("SessionManager.forkFrom legacy migration", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-fork-migration-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([undefined, 1])(
		"retains both v1 messages with header version %s and leaves the source independent",
		(version) => {
			const sourcePath = join(dir, "source.jsonl");
			const original = `${[
				{ type: "session", id: "legacy", version, timestamp, cwd: dir },
				{ type: "message", timestamp, message: first },
				{ type: "message", timestamp, message: second },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`;
			writeFileSync(sourcePath, original);
			const target = join(dir, "target");
			const fork = SessionManager.forkFrom(sourcePath, target, target, { id: "forked" });

			expect(fork.buildSessionContext().messages).toEqual([first, second]);
			expect(fork.getEntryCount()).toBe(2);
			const entries = fork.getEntries();
			expect(entries.map((entry) => entry.id)).toEqual([expect.any(String), expect.any(String)]);
			expect(entries[0].id).not.toBe(entries[1].id);
			expect(entries.map((entry) => entry.parentId)).toEqual([null, entries[0].id]);
			expect(fork.getLeafId()).toBe(entries[1].id);
			for (const entry of entries) expect(fork.getEntry(entry.id)).toEqual(entry);
			expect(fork.getHeader()).toMatchObject({ version: 3, id: "forked", cwd: target, parentSession: sourcePath });
			expect(readFileSync(sourcePath, "utf8")).toBe(original);

			const forkPath = fork.getSessionFile()!;
			const reopened = SessionManager.open(forkPath);
			expect(reopened.getEntries()).toEqual(entries);
			expect(reopened.buildSessionContext().messages).toEqual([first, second]);
			fork.appendMessage({ ...first, content: "fork only" });
			expect(readFileSync(sourcePath, "utf8")).toBe(original);
			const forkBytes = readFileSync(forkPath, "utf8");
			const source = SessionManager.open(sourcePath);
			expect(source.buildSessionContext().messages).toEqual([first, second]);
			source.appendMessage({ ...second, content: "source only" });
			expect(readFileSync(forkPath, "utf8")).toBe(forkBytes);
			expect(SessionManager.open(forkPath).buildSessionContext().messages).toEqual([
				first,
				second,
				{ ...first, content: "fork only" },
			]);
		},
	);

	it("migrates v1 compaction indices to the retained message IDs", () => {
		const sourcePath = join(dir, "compacted.jsonl");
		const original = `${[
			{ type: "session", id: "legacy", timestamp, cwd: dir },
			{ type: "model_change", timestamp, provider: "anthropic", modelId: "source-model" },
			{ type: "thinking_level_change", timestamp, thinkingLevel: "high" },
			{ type: "message", timestamp, message: first },
			{ type: "message", timestamp, message: second },
			{ type: "compaction", timestamp, summary: "earlier work", firstKeptEntryIndex: 4, tokensBefore: 1000 },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(sourcePath, original);
		const fork = SessionManager.forkFrom(sourcePath, dir, dir);
		const entries = fork.getEntries();
		expect(fork.getEntryCount()).toBe(5);
		expect(entries.map((entry) => entry.parentId)).toEqual([null, ...entries.slice(0, -1).map((entry) => entry.id)]);
		expect(entries[4]).toMatchObject({ type: "compaction", firstKeptEntryId: entries[3].id, tokensBefore: 1000 });
		expect(entries[4]).not.toHaveProperty("firstKeptEntryIndex");
		expect(fork.buildSessionContext()).toMatchObject({
			model: { provider: "anthropic", modelId: "source-model" },
			thinkingLevel: "high",
			messages: [{ role: "compactionSummary", summary: "earlier work", tokensBefore: 1000 }, second],
		});
		fork.branch(entries[2].id);
		expect(fork.buildSessionContext().messages).toEqual([first]);
		expect(SessionManager.open(fork.getSessionFile()!).getEntries()).toEqual(entries);
		expect(readFileSync(sourcePath, "utf8")).toBe(original);
	});

	it.each([2, 3])("preserves v%s branches, IDs, references and custom messages", (version) => {
		const source = SessionManager.create(dir, dir);
		const root = source.appendMessage(first);
		const abandoned = source.appendMessage({ ...second, content: "other branch" });
		source.branch(root);
		const kept = source.appendMessage(second);
		source.appendCompaction("earlier work", kept, 1000);
		source.appendMessage({ role: "custom", customType: "legacy-note", content: "note", display: true, timestamp: 1 });
		source.appendLabelChange(abandoned, "other");
		const expectedEntries = structuredClone(source.getEntries());
		const sourcePath = source.getSessionFile()!;
		const records = readFileSync(sourcePath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		records[0].version = version;
		if (version === 2) records.find((entry) => entry.message?.role === "custom").message.role = "hookMessage";
		const original = `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(sourcePath, original);

		const fork = SessionManager.forkFrom(sourcePath, dir, dir);
		const forkPath = fork.getSessionFile()!;
		for (const manager of [fork, SessionManager.open(forkPath)]) {
			expect(manager.getEntries()).toEqual(expectedEntries);
			expect(manager.getLabel(abandoned)).toBe("other");
			expect(manager.getChildren(root).map((entry) => entry.id)).toEqual([abandoned, kept]);
			expect(manager.buildSessionContext().messages).toMatchObject([
				{ role: "compactionSummary", summary: "earlier work" },
				second,
				{ role: "custom", customType: "legacy-note", content: "note" },
			]);
			manager.branch(abandoned);
			expect(manager.buildSessionContext().messages).toEqual([first, { ...second, content: "other branch" }]);
		}
		expect(readFileSync(sourcePath, "utf8")).toBe(original);
	});
});
