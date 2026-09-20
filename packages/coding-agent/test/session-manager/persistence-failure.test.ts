import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	};
});

let directory: string;
beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), "pi-journal-failure-"));
});
afterEach(() => {
	vi.mocked(fs.appendFileSync).mockRestore();
	vi.mocked(fs.writeFileSync).mockRestore();
	vi.mocked(fs.closeSync).mockRestore();
	fs.rmSync(directory, { recursive: true, force: true });
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

it.each(["initial", "append", "close"] as const)(
	"repairs a failed %s write without duplicate records",
	async (kind) => {
		const actual = await vi.importActual<typeof fs>("node:fs");
		const sm = SessionManager.create(directory, directory);
		sm.appendMessage({ role: "user", content: "retained user", timestamp: 1 });
		if (kind !== "initial") sm.appendMessage(fauxAssistantMessage("first response"));
		const failure = Object.assign(new Error("controlled write failure"), { code: "ENOSPC" });
		if (kind === "initial") {
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
		expect(() => sm.appendMessage(fauxAssistantMessage("retained failed response"))).toThrow(failure);
		const entries = sm.getEntries();
		const revision = sm.getEntriesRevision();
		if (kind === "close") {
			vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
				actual.closeSync(fd);
				throw failure;
			});
			expect(() => sm.flush()).toThrow(failure);
		}
		sm.flush();
		expect(sm.getEntriesRevision()).toBe(revision);
		expect(sm.getEntries()).toEqual(entries);
		expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual(entries);
		sm.appendCustomEntry("normal-append", {});
		expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual(sm.getEntries());
	},
);

it("does not overwrite a collided initial journal on retry", () => {
	const sm = SessionManager.create(directory, directory);
	const file = sm.getSessionFile()!;
	fs.writeFileSync(file, "unrelated file\n");
	expect(() => sm.appendMessage(fauxAssistantMessage("retained response"))).toThrow(/EEXIST/);
	expect(() => sm.flush()).toThrow(/EEXIST/);
	expect(() => sm.appendCustomEntry("later", {})).toThrow(/EEXIST/);
	expect(fs.readFileSync(file, "utf8")).toBe("unrelated file\n");
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
		sm.appendCustomEntry("deferred", {});
		sm.flush();
		expect(sm.getSessionFile() && fs.existsSync(sm.getSessionFile()!)).toBeFalsy();
		sm.appendMessage(fauxAssistantMessage("first response"));
		sm.flush();
		if (sm.isPersisted()) expect(SessionManager.open(sm.getSessionFile()!).getEntries()).toEqual(sm.getEntries());
		else expect(sm.getSessionFile()).toBeUndefined();
	}
});
