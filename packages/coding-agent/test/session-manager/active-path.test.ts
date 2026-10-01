import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type FileEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-active-path-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])("bounds warm leaf-path and append work to the active window (persisted: %s)", (persisted) => {
	const visits: number[] = [];
	for (const count of [80, 40_000]) {
		let reads = 0;
		const entries: SessionEntry[] = Array.from({ length: count }, (_, index) => ({
			type: "custom",
			id: `archive-${index}`,
			parentId: index ? `archive-${index - 1}` : null,
			timestamp: "2026-10-01T00:00:00.000Z",
			customType: "archived",
		}));
		const fileEntries: FileEntry[] = [
			{ type: "session", version: 3, id: "scaling", cwd: directory, timestamp: "2026-10-01T00:00:00.000Z" },
			...entries,
		];
		// Observe the ordinary in-memory input too: indexOf/find can scan it without reading entry properties.
		const observed = new Proxy(fileEntries, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads++;
				return Reflect.get(target, key, receiver);
			},
		});
		const file = join(directory, `${count}.jsonl`);
		if (persisted) writeFileSync(file, `${fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const manager = persisted ? SessionManager.open(file) : SessionManager.inMemory(directory, undefined, observed);
		for (const entry of manager.getEntries()) {
			for (const key of ["type", "parentId"] as const) {
				const value = entry[key];
				Object.defineProperty(entry, key, {
					get: () => {
						reads++;
						return value;
					},
				});
			}
		}
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		const compaction = manager.appendCompaction("summary", kept, 100);
		manager.appendMessage({ role: "user", content: "current", timestamp: 2 });
		manager.buildSessionProjection();
		reads = 0;
		expect(manager.getBranch()).toHaveLength(count + 3);
		expect(manager.getBranch(kept)).toHaveLength(count + 1);
		for (const _entry of manager.iterateEntryMetadata({ branchFrom: manager.getLeafId() })) break;
		expect([
			...manager.iterateEntryMetadata({ branchFrom: manager.getLeafId(), reverse: true, limit: 2 }),
		]).toHaveLength(2);
		expect(manager.getBranchState().contextStartId).toBe(compaction);
		expect(manager.buildContextEntries()).toHaveLength(3);
		expect(manager.buildSessionProjection().messages).toMatchObject([
			{ role: "compactionSummary", summary: "summary" },
			{ role: "user", content: "kept" },
			{ role: "user", content: "current" },
		]);
		const usage = fauxAssistantMessage("answer").usage;
		const contribution = manager.appendUsage("test", "test", "test", usage, undefined, "contribution");
		expect(manager.appendUsage("test", "test", "test", usage, undefined, "contribution").id).toBe(contribution.id);
		expect(manager.getEntryMetadata(contribution.id)?.sequence).toBe(count + 3);
		manager.appendMessage({ role: "user", content: "next", timestamp: 3 });
		expect(manager.buildSessionProjection().messages.at(-1)).toMatchObject({ content: "next" });
		expect(manager.getBranch()).toHaveLength(count + 5);
		visits.push(reads);
	}
	expect(visits[1]).toBe(visits[0]);
	expect(visits[1]).toBeLessThan(100);
});

it.each([false, true])(
	"updates branch state across navigation, compaction, off-path append, and forks (persisted: %s)",
	(persisted) => {
		const manager = persisted ? SessionManager.create(directory, directory) : SessionManager.inMemory(directory);
		const model = manager.appendModelChange("catalog", "initial");
		const thinking = manager.appendThinkingLevelChange("high");
		const root = manager.appendMessage({ role: "user", content: "old", timestamp: 0 });
		expect(manager.getBranchState()).toEqual({
			contextStartId: model,
			modelEntryId: model,
			thinkingLevelEntryId: thinking,
		});
		const assistant = manager.appendMessage(fauxAssistantMessage("response"));
		expect(manager.getBranchState().modelEntryId).toBe(assistant);
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		const compaction = manager.appendCompaction("summary", kept, 100);
		expect(manager.getBranchState()).toEqual({
			contextStartId: compaction,
			modelEntryId: assistant,
			thinkingLevelEntryId: thinking,
		});
		expect(manager.buildContextEntries().map((entry) => entry.id)).toEqual([compaction, kept]);
		const edited = manager.appendContextEdit(kept, { content: "edited" });
		expect(
			[...manager.iterateEntryMetadata({ branchFrom: edited, reverse: true, limit: 2 })].map((entry) => entry.id),
		).toEqual([edited, compaction]);
		expect(manager.buildSessionContext().messages).toMatchObject([
			{ role: "compactionSummary" },
			{ content: "edited" },
		]);
		const child = manager.forkBranch(edited);
		expect(child.getBranchState()).toEqual(manager.getBranchState());
		child.appendModelChange("catalog", "child");
		expect(child.buildSessionContext().model).toEqual({ provider: "catalog", modelId: "child" });
		expect(manager.getLeafId()).toBe(edited);
		expect(manager.getBranchState().modelEntryId).toBe(assistant);

		// No intermediate query: the next append must not extend the former leaf's cached path.
		const summary = manager.branchWithSummary(root, "sibling summary");
		expect(manager.getBranch().map((entry) => entry.id)).toEqual([model, thinking, root, summary]);
		expect(manager.getBranchState()).toEqual({
			contextStartId: model,
			modelEntryId: model,
			thinkingLevelEntryId: thinking,
		});
		manager.branch(edited);
		expect(manager.buildSessionContext().messages).toMatchObject([
			{ role: "compactionSummary" },
			{ content: "edited" },
		]);
		const reset = manager.appendCompaction("", null, 10);
		expect(manager.getBranchState().contextStartId).toBe(reset);
		expect(manager.buildContextEntries().map((entry) => entry.id)).toEqual([reset]);
		expect(manager.buildSessionContext().thinkingLevel).toBe("high");
		manager.resetLeaf();
		expect(manager.getBranchState()).toEqual({
			contextStartId: null,
			modelEntryId: null,
			thinkingLevelEntryId: null,
		});
		expect(manager.buildSessionContext()).toEqual({ messages: [], thinkingLevel: "off", model: null });
		const newRoot = manager.appendModelChange("catalog", "new-root");
		expect(manager.getBranch().map((entry) => entry.id)).toEqual([newRoot]);
		manager.newSession();
		expect(manager.getBranch()).toEqual([]);
		expect(manager.getBranchState().modelEntryId).toBeNull();
	},
);

it("bounds metadata queries in either order on the active path, ancestors, siblings, and the journal", () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendCustomEntry("root");
	const first = manager.appendCustomEntry("first");
	const abandoned = manager.appendCustomEntry("abandoned");
	manager.branch(first);
	const leaf = manager.appendCustomEntry("leaf");
	const ids = (query: Parameters<SessionManager["iterateEntryMetadata"]>[0]) =>
		[...manager.iterateEntryMetadata(query)].map((entry) => entry.id);
	expect(ids({ branchFrom: leaf })).toEqual([root, first, leaf]);
	expect(ids({ branchFrom: leaf, reverse: true, limit: 2 })).toEqual([leaf, first]);
	expect(ids({ branchFrom: first, reverse: true })).toEqual([first, root]);
	expect(ids({ branchFrom: abandoned, reverse: true, limit: 2 })).toEqual([abandoned, first]);
	expect(ids({ branchFrom: abandoned, limit: 2 })).toEqual([root, first]);
	expect(ids({ reverse: true, limit: 3 })).toEqual([leaf, abandoned, first]);
	expect(ids({ limit: 2 })).toEqual([root, first]);
	expect(ids({ branchFrom: null })).toEqual([]);
	expect(ids({ branchFrom: "missing", reverse: true })).toEqual([]);
	expect(ids({ branchFrom: "missing" })).toEqual([]);
	expect(ids({ limit: 0 })).toEqual([]);
	for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		expect(() => ids({ limit })).toThrow("non-negative safe integer");
	}
	const branch = manager.getBranch();
	branch.length = 0;
	expect(manager.getBranch()).toHaveLength(3);
	const iterator = manager.iterateEntryMetadata({ branchFrom: leaf, reverse: true });
	for (const entry of iterator) {
		expect(entry.id).toBe(leaf);
		break;
	}
	expect(manager.getEntryMetadata(leaf)?.sequence).toBe(3);
});

it("reconciles external entries, preserves the selected leaf, and rebuilds after replacement and reload", () => {
	const manager = SessionManager.create(directory, directory);
	const root = manager.appendMessage({ role: "user", content: "root", timestamp: 0 });
	const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
	const compaction = manager.appendCompaction("summary", kept, 100);
	const source = manager.getSessionFile()!;
	manager.buildSessionProjection();
	const external = SessionManager.open(source);
	external.branch(root);
	const model = external.appendModelChange("catalog", "external");
	const usage = fauxAssistantMessage("answer").usage;
	const contribution = external.appendUsage("test", "test", "test", usage, undefined, "external-contribution");
	expect(manager.appendUsage("test", "test", "test", usage, undefined, "external-contribution").id).toBe(
		contribution.id,
	);
	expect(manager.getBranchState().contextStartId).toBe(compaction);
	expect(manager.getLeafId()).toBe(compaction);
	manager.branch(contribution.id);
	expect(manager.getBranch().map((entry) => entry.id)).toEqual([root, model, contribution.id]);
	expect(manager.getBranchState()).toMatchObject({ contextStartId: root, modelEntryId: model });
	const replacement = join(directory, "replacement.jsonl");
	writeFileSync(replacement, readFileSync(source));
	renameSync(replacement, source);
	expect(manager.buildSessionContext().messages).toMatchObject([{ content: "root" }]);
	manager.branch(compaction);
	manager.setSessionFile(source);
	expect(manager.getLeafId()).toBe(contribution.id);
	expect(manager.getBranchState().modelEntryId).toBe(model);
	appendFileSync(
		source,
		`${JSON.stringify({ type: "thinking_level_change", id: "published", parentId: contribution.id, timestamp: "2026-10-01T00:00:00.000Z", thinkingLevel: "low" })}\n`,
	);
	expect(manager.getEntryMetadata("published")).toMatchObject({ thinkingLevel: "low" });
	manager.branch("published");
	expect(manager.getBranchState().thinkingLevelEntryId).toBe("published");
	expect(manager.buildSessionContext().thinkingLevel).toBe("low");
});
