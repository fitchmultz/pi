import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openSessionCheckpoint, readSessionCheckpoint, type SessionCheckpoint } from "../src/core/checkpoint.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("refuses legacy resume before repairing the source newline or switching the current session", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-conversion-boundary-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "current session", timestamp: 1 });
	const currentFile = manager.getSessionFile();
	const currentEntries = manager.getEntries();
	const source = join(directory, "legacy.jsonl");
	const bytes = [
		{ ...manager.getHeader(), id: "legacy-session" },
		{ type: "context_window", id: "window", parentId: null, timestamp: new Date(0).toISOString() },
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n\n");
	writeFileSync(source, bytes);

	expect(() => SessionManager.open(source)).toThrow("one-time conversion");
	expect(() => manager.setSessionFile(source)).toThrow("one-time conversion");
	expect(readFileSync(source, "utf8")).toBe(bytes);
	expect(manager.getSessionFile()).toBe(currentFile);
	expect(manager.getEntries()).toEqual(currentEntries);
});

it.each(["tool references", "allowed tool references", "excluded tool references", "journal", "queued message"])(
	"refuses a legacy checkpoint %s before creating its journal",
	(kind) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-conversion-"));
		directories.push(directory);
		const manager = SessionManager.inMemory(directory);
		const checkpoint: SessionCheckpoint = {
			version: 1,
			createdAt: new Date(0).toISOString(),
			selection: {
				sessionId: manager.getSessionId(),
				sessionFile: join(directory, "restored.jsonl"),
				cwd: directory,
				leafId: null,
				thinkingLevel: "off",
				activeTools: [],
				knownTools: [],
			},
			header: manager.getHeader()!,
			entries: [],
			queues: {
				steering: [],
				followUp: [],
				nextTurn: [],
				persistOnCancel: [],
				steeringMode: "all",
				followUpMode: "all",
			},
			boundary: "settled",
			settled: true,
		};
		// A persisted old checkpoint is untyped input at the read/open boundary.
		const raw = JSON.parse(JSON.stringify(checkpoint)) as SessionCheckpoint;
		if (kind === "tool references")
			Object.assign(raw.selection, { activeTools: [{ name: "read", namespace: "functions" }] });
		else if (kind === "allowed tool references")
			Object.assign(raw, { toolConfiguration: { allowedToolNames: [{ name: "read" }] } });
		else if (kind === "excluded tool references")
			Object.assign(raw, { toolConfiguration: { excludedToolNames: [{ name: "bash" }] } });
		else if (kind === "journal")
			Object.assign(raw, { entries: [{ type: "context_window", id: "window", parentId: null }] });
		else Object.assign(raw.queues, { steering: [{ role: "system", content: "old", nativeHead: true }] });
		const artifact = join(directory, "checkpoint.json");
		const bytes = JSON.stringify(raw);
		writeFileSync(artifact, bytes);

		expect(() => readSessionCheckpoint(artifact)).toThrow(
			kind.endsWith("tool references") ? "unsupported tool references" : "one-time conversion",
		);
		expect(() => openSessionCheckpoint(raw)).toThrow();
		expect(existsSync(checkpoint.selection.sessionFile)).toBe(false);
		expect(readFileSync(artifact, "utf8")).toBe(bytes);
	},
);
