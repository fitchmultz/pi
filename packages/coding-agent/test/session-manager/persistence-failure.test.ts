import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

// Retain real filesystem writes, with deterministic partial-write/close error controls.
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		appendFileSync: vi.fn(actual.appendFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
		closeSync: vi.fn(actual.closeSync),
		renameSync: vi.fn(actual.renameSync),
	};
});
vi.mock("crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof crypto>();
	return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

let directory: string;
beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), "pi-journal-failure-"));
});
afterEach(() => {
	vi.mocked(fs.appendFileSync).mockRestore();
	vi.mocked(fs.writeFileSync).mockRestore();
	vi.mocked(fs.closeSync).mockRestore();
	vi.mocked(fs.renameSync).mockRestore();
	vi.mocked(crypto.randomUUID).mockRestore();
	fs.rmSync(directory, { recursive: true, force: true });
});

const usage = {
	input: 10,
	output: 20,
	cacheRead: 30,
	cacheWrite: 40,
	totalTokens: 100,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

it("persists usage before any assistant response and retains it across a new session", () => {
	const sm = SessionManager.create(directory, directory);
	const file = sm.getSessionFile()!;
	sm.appendCustomEntry("before-usage", { kept: true });
	expect(fs.existsSync(file)).toBe(false);
	const entry = sm.appendUsage("child_work", "test-provider", "test-model", usage, "slash command");
	expect(fs.existsSync(file)).toBe(true);
	const entries = sm.getEntries();
	const reopened = SessionManager.open(file);
	expect(reopened.getEntry(entry.id)).toEqual(entry);
	expect(reopened.getEntries()).toEqual(entries);
	expect(reopened.buildSessionContext().messages).toEqual([]);
	const bytes = fs.readFileSync(file, "utf8");
	sm.flush();
	expect(fs.readFileSync(file, "utf8")).toBe(bytes);
	sm.newSession();
	expect(fs.existsSync(sm.getSessionFile()!)).toBe(false);
	expect(SessionManager.open(file).getEntries()).toEqual(entries);
});

it.each(["branch", "fork"] as const)("persists copied %s usage without an assistant response", (kind) => {
	const sm = SessionManager.create(directory, directory);
	const entry = sm.appendUsage("child_work", "test-provider", "test-model", usage);
	const source = sm.getSessionFile()!;
	const sourceBytes = fs.readFileSync(source, "utf8");
	const copy =
		kind === "branch"
			? sm.createBranchedSession(entry.id)!
			: SessionManager.forkFrom(source, directory, directory).getSessionFile()!;
	expect(copy).not.toBe(source);
	expect(fs.existsSync(copy)).toBe(true);
	const reopened = SessionManager.open(copy);
	expect(reopened.getEntries()).toEqual([entry]);
	expect(reopened.getHeader()?.parentSession).toBe(source);
	reopened.appendCustomEntry("after-usage", { kept: true });
	expect(SessionManager.open(copy).getEntries()).toEqual(reopened.getEntries());
	expect(fs.readFileSync(source, "utf8")).toBe(sourceBytes);
});

it("retries failed branch publication without exposing a partial usage journal", async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	const sm = SessionManager.create(directory, directory);
	const entry = sm.appendUsage("child_work", "test-provider", "test-model", usage);
	const source = sm.getSessionFile()!;
	const files = fs.readdirSync(directory);
	const failure = new Error("controlled branch write failure");
	vi.mocked(fs.writeFileSync).mockImplementationOnce((fd, data) => {
		actual.writeFileSync(fd, String(data).slice(0, 20));
		throw failure;
	});
	expect(() => sm.createBranchedSession(entry.id)).toThrow(failure);
	expect(sm.getSessionFile()).not.toBe(source);
	expect(fs.existsSync(sm.getSessionFile()!)).toBe(false);
	expect(fs.readdirSync(directory)).toEqual(files);
	expect(SessionManager.open(source).getEntries()).toEqual([entry]);
	sm.flush();
	expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual([entry]);
});

const permissionTest = it.skipIf(process.platform === "win32" || process.getuid?.() === 0);

permissionTest.each([false, true])(
	"repairs failed appends and label indexes on the next append (assistant: %s)",
	(assistant) => {
		const file = join(directory, "journal.jsonl");
		fs.writeFileSync(file, "");
		const sm = SessionManager.open(file);
		const selected = sm.appendMessage({ role: "user", content: "accepted", timestamp: 1 });
		if (assistant) sm.appendMessage(fauxAssistantMessage("accepted response"));
		const before = fs.readFileSync(file, "utf8");
		const revision = sm.getEntriesRevision();
		fs.chmodSync(file, 0o400);
		try {
			expect(() => sm.appendLabelChange(selected, "retained label")).toThrow(/EACCES/);
			expect(sm.getLabel(selected)).toBe("retained label");
			expect(sm.getEntriesRevision()).toBe(revision + 1);
			expect(sm.getEntry(sm.getLeafId()!)).toMatchObject({ type: "label", label: "retained label" });
			expect(() => sm.appendLabelChange(selected, undefined)).toThrow(/EACCES/);
			expect(sm.getLabel(selected)).toBeUndefined();
			expect(fs.readFileSync(file, "utf8")).toBe(before);
		} finally {
			fs.chmodSync(file, 0o600);
		}
		sm.branch(selected);
		const later = sm.appendCustomEntry("later", { repaired: true });
		expect(sm.getEntry(later)?.parentId).toBe(selected);
		const restored = SessionManager.open(file);
		expect(restored.getEntries()).toEqual(sm.getEntries());
		expect(restored.getTree()).toEqual(sm.getTree());
		expect(restored.getLeafId()).toBe(later);
		expect(restored.getLabel(selected)).toBeUndefined();
		const repairedBytes = fs.readFileSync(file, "utf8");
		const repairedRevision = sm.getEntriesRevision();
		sm.branch(selected);
		sm.flush();
		expect(fs.readFileSync(file, "utf8")).toBe(repairedBytes);
		expect(sm.getEntriesRevision()).toBe(repairedRevision);
		expect(sm.getLeafId()).toBe(selected);
	},
);

permissionTest.each(["relative", "absolute"] as const)(
	"repairs through an existing %s journal symlink without replacing the alias",
	async (kind) => {
		const actual = await vi.importActual<typeof fs>("node:fs");
		const targetDir = join(directory, "target");
		const seed = SessionManager.create(directory, targetDir);
		const selected = seed.appendMessage(fauxAssistantMessage("persisted response"));
		const target = seed.getSessionFile()!;
		const alias = join(directory, "alias.jsonl");
		const link = kind === "relative" ? relative(directory, target) : target;
		fs.symlinkSync(link, alias);
		const sm = SessionManager.open(alias);
		const before = fs.readFileSync(target);
		const files = fs.readdirSync(targetDir);
		fs.chmodSync(target, 0o400);
		try {
			expect(() => sm.appendLabelChange(selected, "retained label")).toThrow(/EACCES/);
			expect(() => sm.flush()).toThrow(/EACCES/);
			expect(fs.readFileSync(target)).toEqual(before);
		} finally {
			fs.chmodSync(target, 0o640);
		}
		sm.branch(selected);
		const entries = sm.getEntries();
		const revision = sm.getEntriesRevision();
		const failure = new Error("controlled partial repair failure");
		vi.mocked(fs.writeFileSync).mockImplementationOnce((fd, data) => {
			actual.writeFileSync(fd, String(data).slice(0, 20));
			throw failure;
		});
		expect(() => sm.flush()).toThrow(failure);
		expect(fs.readFileSync(target)).toEqual(before);
		expect(fs.readlinkSync(alias)).toBe(link);
		expect(fs.readdirSync(targetDir)).toEqual(files);
		const previousUmask = process.umask(0o077);
		try {
			sm.flush();
		} finally {
			process.umask(previousUmask);
		}
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(alias)).toBe(link);
		expect(fs.statSync(target).mode & 0o777).toBe(0o640);
		expect(fs.readdirSync(targetDir)).toEqual(files);
		expect(fs.readdirSync(directory).sort()).toEqual(["alias.jsonl", "target"]);
		expect(sm.getSessionFile()).toBe(alias);
		expect(sm.getSessionId()).toBe(seed.getSessionId());
		expect(sm.getEntries()).toEqual(entries);
		expect(sm.getEntriesRevision()).toBe(revision);
		expect(sm.getLeafId()).toBe(selected);
		expect(sm.getLabel(selected)).toBe("retained label");
		for (const file of [alias, target]) {
			const reopened = SessionManager.open(file);
			expect(reopened.getEntries()).toEqual(entries);
			expect(reopened.getSessionId()).toBe(sm.getSessionId());
			expect(reopened.getLabel(selected)).toBe("retained label");
		}
		sm.appendCustomEntry("normal-append", {});
		expect(SessionManager.open(target).getEntries()).toEqual(sm.getEntries());
	},
);

permissionTest.each([false, true])("does not own an initial symlink collision (dangling: %s)", (dangling) => {
	const sm = SessionManager.create(directory, directory);
	const file = sm.getSessionFile()!;
	const target = join(directory, "unowned.jsonl");
	if (!dangling) fs.writeFileSync(target, "unrelated file\n");
	fs.symlinkSync(target, file);
	expect(() => sm.appendMessage(fauxAssistantMessage("retained response"))).toThrow(/EEXIST/);
	expect(() => sm.flush()).toThrow(/EEXIST/);
	expect(() => sm.appendCustomEntry("later", {})).toThrow(/EEXIST/);
	expect(fs.readlinkSync(file)).toBe(target);
	if (dangling) expect(fs.existsSync(target)).toBe(false);
	else expect(fs.readFileSync(target, "utf8")).toBe("unrelated file\n");
});

permissionTest("retries initial creation after a real directory permission failure", () => {
	const sm = SessionManager.create(directory, directory);
	sm.appendCustomEntry("before-assistant", { kept: true });
	fs.chmodSync(directory, 0o500);
	try {
		expect(() => sm.appendMessage(fauxAssistantMessage("first response"))).toThrow(/EACCES/);
		expect(() => sm.flush()).toThrow(/EACCES/);
		expect(fs.existsSync(sm.getSessionFile()!)).toBe(false);
	} finally {
		fs.chmodSync(directory, 0o700);
	}
	sm.flush();
	expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual(sm.getEntries());
});

it.each(["initial", "usage", "append", "close"] as const)(
	"repairs a failed %s write without duplicate records",
	async (kind) => {
		const actual = await vi.importActual<typeof fs>("node:fs");
		const sm = SessionManager.create(directory, directory);
		sm.appendMessage({ role: "user", content: "retained user", timestamp: 1 });
		if (kind !== "initial" && kind !== "usage") sm.appendMessage(fauxAssistantMessage("first response"));
		const failure = Object.assign(new Error("controlled write failure"), { code: "ENOSPC" });
		if (kind === "initial" || kind === "usage") {
			vi.mocked(fs.writeFileSync).mockImplementationOnce((file, data) => {
				actual.writeFileSync(file, String(data).slice(0, 20));
				throw failure;
			});
		} else if (kind === "append") {
			vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
				actual.appendFileSync(file, String(data).slice(0, 20));
				throw failure;
			});
		} else {
			// First make the journal dirty; the retry below will fail after writing all bytes.
			vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
				throw failure;
			});
		}
		expect(() =>
			kind === "usage"
				? sm.appendUsage("child_work", "test-provider", "test-model", usage)
				: sm.appendMessage(fauxAssistantMessage("retained failed response")),
		).toThrow(failure);
		const entries = sm.getEntries();
		const revision = sm.getEntriesRevision();
		const file = sm.getSessionFile()!;
		const priorBytes = fs.readFileSync(file);
		const priorFiles = fs.readdirSync(directory);
		// PR68: a failed repair must not truncate even a partially written journal.
		vi.mocked(fs.writeFileSync).mockImplementationOnce((fd, data) => {
			actual.writeFileSync(fd, String(data).slice(0, 20));
			throw failure;
		});
		expect(() => sm.flush()).toThrow(failure);
		expect(fs.readFileSync(file)).toEqual(priorBytes);
		expect(fs.readdirSync(directory)).toEqual(priorFiles);
		if (kind === "close") {
			vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
				actual.closeSync(fd);
				throw failure;
			});
			expect(() => sm.flush()).toThrow(failure);
			expect(fs.readFileSync(file)).toEqual(priorBytes);
			expect(fs.readdirSync(directory)).toEqual(priorFiles);
		}
		sm.flush();
		expect(fs.readdirSync(directory)).toEqual(priorFiles);
		expect(sm.getEntriesRevision()).toBe(revision);
		expect(sm.getEntries()).toEqual(entries);
		expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual(entries);
		sm.appendCustomEntry("normal-append", {});
		expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual(sm.getEntries());
	},
);

it.each(["assistant", "usage"] as const)("does not overwrite a collided initial %s journal on retry", (kind) => {
	const sm = SessionManager.create(directory, directory);
	const file = sm.getSessionFile()!;
	fs.writeFileSync(file, "unrelated file\n");
	expect(() =>
		kind === "usage"
			? sm.appendUsage("child_work", "test-provider", "test-model", usage)
			: sm.appendMessage(fauxAssistantMessage("retained response")),
	).toThrow(/EEXIST/);
	expect(() => sm.flush()).toThrow(/EEXIST/);
	expect(() => sm.appendCustomEntry("later", {})).toThrow(/EEXIST/);
	expect(fs.readFileSync(file, "utf8")).toBe("unrelated file\n");
	expect(fs.readdirSync(directory)).toEqual([file.slice(directory.length + 1)]);
});

it.each(["collision", "rename"] as const)("preserves the journal on temporary-file %s failure", (kind) => {
	const sm = SessionManager.create(directory, directory);
	sm.appendMessage(fauxAssistantMessage("persisted response"));
	const file = sm.getSessionFile()!;
	const before = fs.readFileSync(file);
	const failure = new Error("controlled persistence failure");
	vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
		throw failure;
	});
	expect(() => sm.appendCustomEntry("retained", {})).toThrow(failure);
	const uuid = "00000000-0000-4000-8000-000000000000";
	const temporary = `${file}.${uuid}.tmp`;
	vi.mocked(crypto.randomUUID).mockReturnValueOnce(uuid);
	if (kind === "collision") fs.writeFileSync(temporary, "unrelated temporary file\n");
	else {
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw failure;
		});
	}
	const files = fs.readdirSync(directory);
	expect(() => sm.flush()).toThrow(kind === "collision" ? /EEXIST/ : failure);
	expect(fs.readFileSync(file)).toEqual(before);
	expect(fs.readdirSync(directory)).toEqual(files);
	if (kind === "collision") {
		expect(fs.readFileSync(temporary, "utf8")).toBe("unrelated temporary file\n");
		fs.unlinkSync(temporary);
	}
	sm.flush();
	expect(SessionManager.open(file).getEntries()).toEqual(sm.getEntries());
	expect(fs.readdirSync(directory)).toEqual([file.slice(directory.length + 1)]);
});

permissionTest.each([0o600, 0o640])("preserves journal mode %s through repair", (mode) => {
	const sm = SessionManager.create(directory, directory);
	sm.appendMessage(fauxAssistantMessage("persisted response"));
	const file = sm.getSessionFile()!;
	fs.chmodSync(file, 0o400);
	expect(() => sm.appendCustomEntry("retained", {})).toThrow(/EACCES/);
	fs.chmodSync(file, mode);
	const previousUmask = process.umask(0o077);
	try {
		sm.flush();
	} finally {
		process.umask(previousUmask);
	}
	expect(fs.statSync(file).mode & 0o777).toBe(mode);
	expect(SessionManager.open(file).getEntries()).toEqual(sm.getEntries());
});

permissionTest.each(["new", "switch", "branch"] as const)(
	"does not forget dirty entries during %s replacement",
	(kind) => {
		const sm = SessionManager.create(directory, directory);
		const selected = sm.appendMessage(fauxAssistantMessage("retained response"));
		const file = sm.getSessionFile()!;
		fs.chmodSync(file, 0o400);
		const replace = () => {
			if (kind === "new") sm.newSession();
			else if (kind === "switch") sm.setSessionFile(join(directory, "other.jsonl"));
			else sm.createBranchedSession(selected);
		};
		try {
			expect(() => sm.appendCustomEntry("failed-save", {})).toThrow(/EACCES/);
			const accepted = sm.getEntries();
			expect(replace).toThrow(/EACCES/);
			expect(sm.getSessionFile()).toBe(file);
			expect(sm.getEntries()).toEqual(accepted);
			fs.chmodSync(file, 0o600);
			replace();
			expect(SessionManager.open(file).getEntries()).toEqual(accepted);
		} finally {
			fs.chmodSync(file, 0o600);
		}
	},
);

it("flush leaves ordinary deferred and in-memory entries alone", () => {
	for (const sm of [SessionManager.create(directory, directory), SessionManager.inMemory(directory)]) {
		sm.flush();
		expect(sm.getSessionFile() && fs.existsSync(sm.getSessionFile()!)).toBeFalsy();
		sm.appendCustomEntry("deferred", {});
		sm.flush();
		expect(sm.getSessionFile() && fs.existsSync(sm.getSessionFile()!)).toBeFalsy();
		const user = sm.appendMessage({ role: "user", content: "deferred user", timestamp: 1 });
		sm.flush();
		expect(sm.getSessionFile() && fs.existsSync(sm.getSessionFile()!)).toBeFalsy();
		sm.createBranchedSession(user);
		sm.flush();
		expect(sm.getSessionFile() && fs.existsSync(sm.getSessionFile()!)).toBeFalsy();
		sm.appendUsage("child_work", "test-provider", "test-model", usage);
		sm.flush();
		if (sm.isPersisted()) expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual(sm.getEntries());
		else expect(sm.getSessionFile()).toBeUndefined();
	}
});
