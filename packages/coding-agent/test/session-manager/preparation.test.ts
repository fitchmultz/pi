import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		readSync: vi.fn(actual.readSync),
		statSync: vi.fn(actual.statSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		appendFileSync: vi.fn(actual.appendFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
		linkSync: vi.fn(actual.linkSync),
	};
});

let directory: string;
beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), "pi-preparation-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(count = 64): SessionManager {
	const manager = SessionManager.create(directory, directory);
	for (let i = 0; i < count; i++) {
		manager.appendMessage({ role: "user", content: `input-${i}`, timestamp: i });
	}
	return SessionManager.open(manager.getSessionFile()!);
}

it("reuses verified active bodies across repeated projection and ordinary append without sharing mutable messages", () => {
	const manager = fixture();
	const first = manager.buildSessionProjection();
	const expected = structuredClone(first.messages);
	first.messages[0] = { role: "user", content: "corrupted", timestamp: 0 };
	first.entries[1].messages.splice(0);
	first.model = { provider: "corrupted", modelId: "corrupted" };
	const context = manager.buildSessionContext();
	if (context.messages[2].role !== "user") throw new Error("expected user");
	context.messages[2].content = "corrupted";
	vi.mocked(fs.readSync).mockClear();
	vi.mocked(fs.statSync).mockClear();
	for (let i = 0; i < 4; i++) expect(manager.buildSessionProjection().messages).toEqual(expected);
	expect(vi.mocked(fs.readSync).mock.calls.length).toBe(0);
	expect(vi.mocked(fs.statSync).mock.calls.length).toBeLessThanOrEqual(8);
	manager.appendMessage({ role: "user", content: "next", timestamp: 100 });
	vi.mocked(fs.readSync).mockClear();
	expect(manager.buildSessionContext().messages).toEqual([
		...expected,
		{ role: "user", content: "next", timestamp: 100 },
	]);
	expect(vi.mocked(fs.readSync).mock.calls.length).toBeLessThanOrEqual(2);
});

it("reprojects leaf movement, branch edits, compactions, and source replacement without changing raw provenance", () => {
	const manager = fixture(2);
	const [first, retained] = manager.getEntries();
	const original = manager.buildSessionProjection();
	manager.appendThinkingLevelChange("high");
	manager.appendMessage(fauxAssistantMessage("answer"));
	manager.appendContextEdit(first.id, null);
	const editedContent = `edited ${"x".repeat(150_000)}`;
	manager.appendContextEdit(retained.id, { content: editedContent });
	vi.mocked(fs.readSync).mockClear();
	expect(manager.buildSessionContext().messages).toMatchObject([
		{ role: "user", content: editedContent },
		{ role: "assistant" },
	]);
	const bytesRead = vi
		.mocked(fs.readSync)
		.mock.results.reduce((sum, result) => sum + (result.type === "return" ? Number(result.value) : 0), 0);
	expect(bytesRead).toBeLessThanOrEqual(Buffer.byteLength(editedContent) + 4096);
	manager.appendCompaction("handoff", retained.id, 100);
	const projection = manager.buildSessionProjection();
	expect(projection.messages).toMatchObject([
		{ role: "compactionSummary", summary: "handoff" },
		{ role: "user", content: editedContent },
		{ role: "assistant" },
	]);
	expect(projection.thinkingLevel).toBe("high");
	expect(projection.entries.find((entry) => entry.sourceEntry.id === retained.id)?.sourceEntry).toBe(
		manager.getEntry(retained.id),
	);
	expect(manager.getEntry(retained.id)).toMatchObject({ message: { content: "input-1" } });
	const editedLeaf = manager.getLeafId()!;
	manager.branch(first.id);
	expect(manager.buildSessionContext().messages).toEqual(original.messages.slice(0, 1));
	manager.resetLeaf();
	expect(manager.buildSessionContext().messages).toEqual([]);
	manager.branch(editedLeaf);
	expect(manager.buildSessionProjection().messages).toEqual(projection.messages);
	const source = manager.getSessionFile()!;
	const replacement = join(directory, "replacement.jsonl");
	fs.writeFileSync(replacement, fs.readFileSync(source));
	fs.renameSync(replacement, source);
	expect(manager.buildSessionProjection().messages).toEqual(projection.messages);
	manager.setSessionFile(fixture(1).getSessionFile()!);
	expect(manager.buildSessionContext().messages).toEqual([{ role: "user", content: "input-0", timestamp: 0 }]);
});

it.each([
	{ timing: "none", borrowed: false },
	{ timing: "before", borrowed: false },
	{ timing: "during", borrowed: false },
	{ timing: "none", borrowed: true },
] as const)(
	"rejects edited selected bytes around an own append (edit: $timing, borrowed source: $borrowed)",
	async ({ timing, borrowed }) => {
		const actual = await vi.importActual<typeof fs>("node:fs");
		let manager = borrowed ? SessionManager.create(directory, directory) : fixture(2);
		const source = manager.getSessionFile()!;
		if (borrowed) {
			const selected = manager.appendCustomMessageEntry("setup", "input-0", false);
			manager.appendMessage({ role: "user", content: "persist parent", timestamp: 1 });
			manager = SessionManager.open(source);
			const branch = manager.createBranchedSession(selected)!;
			expect(branch).not.toBe(source);
			expect(fs.existsSync(branch)).toBe(false);
			expect(manager.buildSessionContext().messages).toMatchObject([{ role: "custom", content: "input-0" }]);
		}
		manager.buildSessionProjection();
		const before = fs.statSync(source);
		const edit = () => {
			fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("input-0", "other-0"));
			fs.utimesSync(source, before.atime, before.mtime);
		};
		if (timing === "during")
			vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
				actual.appendFileSync(file, data);
				edit();
			});
		else edit();
		expect(fs.statSync(source).size).toBe(before.size);
		expect(() => {
			if (timing !== "none") manager.appendCustomEntry("metadata", {});
			manager.buildSessionProjection();
		}).toThrow(/Journal (source generation|record) changed/);
	},
);

it("does not reuse cached bodies after unlinking and truncating their captured inode", () => {
	const manager = fixture(2);
	manager.buildSessionProjection();
	const source = manager.getSessionFile()!;
	const fd = fs.openSync(source, "r+");
	try {
		fs.unlinkSync(source);
		fs.ftruncateSync(fd, 0);
	} finally {
		fs.closeSync(fd);
	}
	expect(() => manager.buildSessionProjection()).toThrow("Journal source generation changed");
});

it("retains accepted context after failed append and repairs it without stale cached output", async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	const manager = fixture(2);
	const expected = manager.buildSessionContext().messages;
	vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
		actual.appendFileSync(file, String(data).slice(0, 20));
		throw new Error("controlled append failure");
	});
	expect(() => manager.appendMessage({ role: "user", content: "accepted", timestamp: 3 })).toThrow(
		"controlled append failure",
	);
	const leaf = manager.getLeafId();
	expect(manager.buildSessionContext().messages).toEqual([
		...expected,
		{ role: "user", content: "accepted", timestamp: 3 },
	]);
	manager.flush();
	expect(manager.getLeafId()).toBe(leaf);
	expect(manager.buildSessionContext().messages).toEqual(
		SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages,
	);
});

it.each([false, true])("forks sibling branches without replacing the parent (in memory: %s)", (inMemory) => {
	const manager = inMemory ? SessionManager.inMemory(directory) : fixture(2);
	const root = manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
	const label = manager.appendLabelChange(root, "bookmark");
	manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
	manager.appendCompaction("handoff", label, 100);
	manager.appendContextEdit(root, null);
	const selected = manager.getLeafId()!;
	const expected = manager.buildSessionContext();
	const sourceFile = manager.getSessionFile();
	const sourceId = manager.getSessionId();
	const sourceEntries = manager.getEntries().map((entry) => JSON.parse(JSON.stringify(entry)));
	const children = Array.from({ length: 4 }, () => manager.forkBranch(selected));
	for (const child of children) {
		expect(child.getSessionId()).not.toBe(sourceId);
		expect(child.getLabel(root)).toBe("bookmark");
		expect(child.buildSessionContext()).toEqual(expected);
		child.appendContextEdit(root, { content: "child edit" });
		child.appendMessage({ role: "user", content: "child-only", timestamp: 3 });
		if (!inMemory)
			expect(SessionManager.open(child.getSessionFile()!).buildSessionContext()).toEqual(
				child.buildSessionContext(),
			);
	}
	expect(new Set(children.map((child) => child.getSessionId())).size).toBe(4);
	expect(manager.getSessionFile()).toBe(sourceFile);
	expect(manager.getSessionId()).toBe(sourceId);
	expect(manager.getLeafId()).toBe(selected);
	expect(manager.getEntries().map((entry) => JSON.parse(JSON.stringify(entry)))).toEqual(sourceEntries);
	expect(manager.buildSessionContext()).toEqual(expected);
});

it.each(["write", "fsync"] as const)(
	"keeps the parent and removes staged sibling output after %s failure",
	(failurePoint) => {
		const manager = fixture(2);
		const selected = manager.getLeafId()!;
		const source = manager.getSessionFile()!;
		const bytes = fs.readFileSync(source);
		const files = fs.readdirSync(directory);
		const failure = new Error("controlled branch failure");
		if (failurePoint === "write")
			vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
				throw failure;
			});
		else
			vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
				throw failure;
			});
		expect(() => manager.forkBranch(selected)).toThrow(failure);
		expect(fs.readdirSync(directory)).toEqual(files);
		expect(fs.readFileSync(source)).toEqual(bytes);
		expect(manager.getSessionFile()).toBe(source);
		expect(manager.getLeafId()).toBe(selected);
		const child = manager.forkBranch(selected);
		expect(SessionManager.open(child.getSessionFile()!).buildSessionContext()).toEqual(manager.buildSessionContext());
	},
);

it("refuses a sibling publication collision without replacing the destination or changing the parent", async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	const manager = fixture(2);
	const source = manager.getSessionFile()!;
	const bytes = fs.readFileSync(source);
	const selected = manager.getLeafId()!;
	let collided: fs.PathLike | undefined;
	vi.mocked(fs.linkSync).mockImplementationOnce((temporary, destination) => {
		collided = destination;
		actual.writeFileSync(destination, "unrelated destination\n");
		actual.linkSync(temporary, destination);
	});
	expect(() => manager.forkBranch(selected)).toThrow(/EEXIST/);
	if (!collided) throw new Error("publication did not reach the collision");
	expect(fs.readFileSync(collided, "utf8")).toBe("unrelated destination\n");
	expect(fs.readdirSync(directory).some((file) => file.endsWith(".tmp"))).toBe(false);
	expect(fs.readFileSync(source)).toEqual(bytes);
	expect(manager.getSessionFile()).toBe(source);
	expect(manager.getLeafId()).toBe(selected);
	const child = manager.forkBranch(selected);
	expect(child.getSessionFile()).not.toBe(collided);
	expect(SessionManager.open(child.getSessionFile()!).buildSessionContext()).toEqual(manager.buildSessionContext());
});

it.each(["selected", "whole"] as const)("rejects changed source bytes before publishing %s history", async (kind) => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	const manager = fixture(2);
	const source = manager.getSessionFile()!;
	const selected = manager.getLeafId()!;
	const files = fs.readdirSync(directory);
	vi.mocked(fs.writeFileSync).mockImplementationOnce((fd, data) => {
		actual.writeFileSync(fd, data);
		actual.writeFileSync(source, actual.readFileSync(source, "utf8").replace("input-0", "other-0"));
	});
	expect(() =>
		kind === "selected" ? manager.forkBranch(selected) : SessionManager.forkFrom(source, directory, directory),
	).toThrow("Journal record changed since indexing");
	expect(fs.readdirSync(directory)).toEqual(files);
	expect(manager.getSessionFile()).toBe(source);
	expect(manager.getLeafId()).toBe(selected);
});

it("preserves distinct physical records with repeated IDs when indexing whole-history output", () => {
	const manager = fixture(2);
	const source = manager.getSessionFile()!;
	const entries = manager.getEntries().map((entry) => JSON.parse(JSON.stringify(entry)));
	entries[1].id = entries[0].id;
	fs.writeFileSync(source, `${[manager.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const child = SessionManager.forkFrom(source, directory, directory);
	fs.unlinkSync(source);
	expect(child.getEntries().map((entry) => JSON.parse(JSON.stringify(entry)))).toEqual(entries);
	expect(SessionManager.open(child.getSessionFile()!).getEntries()).toEqual(entries);
});

// PR #163: publication can preserve size and mtime while changing indexed metadata.
it.each([
	{ kind: "selected", change: "metadata" },
	{ kind: "whole", change: "metadata" },
	{ kind: "selected", change: "separator" },
	{ kind: "whole", change: "separator" },
	{ kind: "selected", change: "final LF" },
	{ kind: "whole", change: "final LF" },
] as const)("certifies published $kind $change even when file stats match", async ({ kind, change }) => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	const manager = fixture(2);
	const model = manager.appendModelChange("catalog", "old-model");
	const thinking = manager.appendThinkingLevelChange("high");
	const source = manager.getSessionFile()!;
	vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
		actual.fsyncSync(fd);
		actual.futimesSync(fd, 0, 0);
	});
	vi.mocked(fs.linkSync).mockImplementationOnce((temporary, destination) => {
		actual.linkSync(temporary, destination);
		const staged = actual.statSync(temporary);
		const original = actual.readFileSync(destination, "utf8");
		const edited =
			change === "metadata"
				? original
						.replace('"modelId":"old-model"', '"modelId":"new-model"')
						.replace('"thinkingLevel":"high"', '"thinkingLevel":"low "')
						.replace('"version":3', '"version":4')
				: change === "separator"
					? original.replace('"modelId":"old-model"}\n', '"modelId":"old-model"} ')
					: `${original.slice(0, -1)}x`;
		actual.writeFileSync(destination, edited);
		actual.utimesSync(destination, 0, 0);
		const published = actual.statSync(destination);
		for (const key of ["dev", "ino", "size", "mtimeMs"] as const) expect(published[key]).toBe(staged[key]);
	});
	const child =
		kind === "selected" ? manager.forkBranch(thinking) : SessionManager.forkFrom(source, directory, directory);
	if (change === "metadata") {
		expect(child.getHeader()?.version).toBe(4);
		expect(child.getEntryMetadata(model)).toMatchObject({ modelId: "new-model" });
		expect(child.getEntryMetadata(thinking)).toMatchObject({ thinkingLevel: "low " });
		expect(child.buildSessionContext()).toMatchObject({ model: { modelId: "new-model" }, thinkingLevel: "low " });
	} else {
		expect(child.getEntryMetadata(thinking)).toBeUndefined();
		if (change === "separator") expect(child.getEntryMetadata(model)).toBeUndefined();
	}
	expect(child.buildSessionContext()).toEqual(SessionManager.open(child.getSessionFile()!).buildSessionContext());
	expect(manager.getEntryMetadata(model)).toMatchObject({ modelId: "old-model" });
});

it.each(["identity", "size", "mtime"] as const)(
	"reindexes published whole-history output when its %s no longer matches the stage",
	async (change) => {
		const actual = await vi.importActual<typeof fs>("node:fs");
		const manager = fixture(2);
		const source = manager.getSessionFile()!;
		const expected = manager.buildSessionContext().messages;
		vi.mocked(fs.linkSync).mockImplementationOnce((temporary, destination) => {
			actual.linkSync(temporary, destination);
			const staged = actual.statSync(temporary);
			const edited = actual.readFileSync(destination, "utf8").replace("input-0", "other-0");
			if (change === "identity") {
				const replacement = join(directory, "replacement.jsonl");
				actual.writeFileSync(replacement, edited);
				actual.utimesSync(replacement, staged.atime, staged.mtime);
				actual.renameSync(replacement, destination);
			} else {
				actual.writeFileSync(destination, change === "size" ? `${edited}\n` : edited);
				actual.utimesSync(destination, staged.atime, change === "size" ? staged.mtime : new Date(0));
			}
		});
		const child = SessionManager.forkFrom(source, directory, directory);
		expect(child.buildSessionContext().messages).toEqual([
			{ role: "user", content: "other-0", timestamp: 0 },
			...expected.slice(1),
		]);
		expect(SessionManager.open(child.getSessionFile()!).buildSessionContext()).toEqual(child.buildSessionContext());
		expect(manager.buildSessionContext().messages).toEqual(expected);
		expect(fs.readdirSync(directory).some((file) => file.endsWith(".tmp"))).toBe(false);
	},
);

it.each(["selected", "whole"] as const)(
	"copies %s history with one output verification pass, fsyncs publication, and indexes independently readable bytes",
	(kind) => {
		const manager = fixture();
		const source = manager.getSessionFile()!;
		const selected = manager.getLeafId()!;
		const expected = manager.getEntries().map((entry) => JSON.parse(JSON.stringify(entry)));
		vi.mocked(fs.readSync).mockClear();
		vi.mocked(fs.fsyncSync).mockClear();
		const child = kind === "selected" ? manager : SessionManager.forkFrom(source, directory, directory);
		const branch = kind === "selected" ? manager.createBranchedSession(selected)! : child.getSessionFile()!;
		const bytesRead = vi
			.mocked(fs.readSync)
			.mock.results.reduce((sum, result) => sum + (result.type === "return" ? Number(result.value) : 0), 0);
		expect(bytesRead).toBeLessThan(
			fs.statSync(source).size * (kind === "selected" ? 1 : 2) + fs.statSync(branch).size + 1,
		);
		expect(fs.fsyncSync).toHaveBeenCalledTimes(1);
		fs.writeFileSync(source, "unrelated generation\n");
		expect(child.getEntries().map((entry) => JSON.parse(JSON.stringify(entry)))).toEqual(expected);
		expect(SessionManager.open(branch).getEntries()).toEqual(expected);
	},
);
