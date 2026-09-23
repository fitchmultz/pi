import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openSessionCheckpoint, readSessionCheckpoint, writeSessionCheckpoint } from "../../src/core/checkpoint.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// chmod must actually deny writes: Windows and uid 0 do not provide this POSIX control.
const permissionTest = it.skipIf(process.platform === "win32" || process.getuid?.() === 0);

permissionTest.each(["held", "shutdown"] as const)(
	"rejects %s capture while the journal is unwritable, then restores every accepted entry on retry",
	async (kind) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-journal-"));
		directories.push(directory);
		const h = await createHarness({
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("accepted native response")]);
		await h.session.prompt("synthetic request");
		const sm = h.sessionManager;
		const file = sm.getSessionFile()!;
		const previous = await h.session.acquireCheckpoint({ quiesce: () => () => {} });
		const artifact = join(directory, "checkpoint.json");
		writeSessionCheckpoint(artifact, previous.checkpoint);
		previous.release();
		const previousBytes = readFileSync(artifact, "utf8");
		const journalBytes = readFileSync(file, "utf8");
		const selected = sm.getLeafId()!;
		await h.session.steer("accepted pending input");
		chmodSync(file, 0o400);
		try {
			await expect(
				h.session.sendCustomMessage({ customType: "failed-save", content: "retain this work", display: true }),
			).rejects.toMatchObject({ code: "EACCES" });
			expect(sm.getLeafEntry()).toMatchObject({ type: "custom_message", content: "retain this work" });
			expect(h.session.messages.at(-1)).toMatchObject({ role: "custom", content: "retain this work" });
			expect(readFileSync(file, "utf8")).toBe(journalBytes);
			sm.branch(selected);
			const accepted = sm.getEntries();
			const revision = sm.getEntriesRevision();
			const releaseInput = vi.fn();
			if (kind === "shutdown") h.session.beginShutdown();
			const capture = () =>
				kind === "held"
					? h.session.acquireCheckpoint({ quiesce: () => releaseInput })
					: h.session.captureShutdownCheckpoint();
			await expect(capture()).rejects.toMatchObject({ code: "EACCES" });
			expect(h.session.isCheckpointHeld).toBe(false);
			if (kind === "held") expect(releaseInput).toHaveBeenCalledOnce();
			expect(readFileSync(artifact, "utf8")).toBe(previousBytes);
			expect(sm.getEntries()).toEqual(accepted);
			expect(h.session.getSteeringMessages()).toEqual(["accepted pending input"]);
			chmodSync(file, 0o600);
			const eventsBeforeRetry = h.events.slice();
			const repaired = await capture();
			try {
				if ("sleepReady" in repaired) expect(repaired.sleepReady).toBe(true);
				expect(sm.getEntriesRevision()).toBe(revision);
				expect(sm.getLeafId()).toBe(selected);
				expect(h.events).toEqual(eventsBeforeRetry);
				writeSessionCheckpoint(artifact, repaired.checkpoint);
				const saved = readSessionCheckpoint(artifact);
				expect(saved.entries).toEqual(JSON.parse(JSON.stringify(accepted)));
				const { session } = await createAgentSession({
					checkpoint: saved,
					modelRuntime: h.session.modelRuntime,
					resourceLoader: h.session.resourceLoader,
					settingsManager: h.settingsManager,
				});
				try {
					expect(session.sessionManager.getEntries()).toEqual(saved.entries);
					expect(session.sessionManager.getLeafId()).toBe(selected);
					expect(session.messages).toEqual(sm.buildSessionContext().messages);
					expect(session.getSteeringMessages()).toEqual(["accepted pending input"]);
				} finally {
					session.dispose();
				}
			} finally {
				repaired.release();
			}
		} finally {
			chmodSync(file, 0o600);
		}
	},
);

permissionTest("retains a native assistant response and emits it only once when its journal append fails", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-assistant-"));
	directories.push(directory);
	const sm = SessionManager.create(directory, directory);
	let denyWrite = false;
	const h = await createHarness({
		sessionManager: sm,
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("message_end", (event) => {
					if (denyWrite && event.message.role === "assistant") chmodSync(sm.getSessionFile()!, 0o400);
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("keep this completed response")]);
	await h.session.prompt("first request");
	denyWrite = true;
	try {
		await expect(h.session.prompt("second request")).rejects.toMatchObject({ code: "EACCES" });
		const response = h.session.messages.find(
			(message) =>
				message.role === "assistant" && JSON.stringify(message.content).includes("keep this completed response"),
		);
		expect(response).toBeDefined();
		expect(sm.getEntries().filter((entry) => entry.type === "message" && entry.message === response)).toHaveLength(1);
		await expect(h.session.acquireCheckpoint({ quiesce: () => () => {} })).rejects.toMatchObject({ code: "EACCES" });
		chmodSync(sm.getSessionFile()!, 0o600);
		const events = h.events.slice();
		const hold = await h.session.acquireCheckpoint({ quiesce: () => () => {} });
		try {
			expect(hold.sleepReady).toBe(true);
			expect(openSessionCheckpoint(hold.checkpoint).getEntries()).toEqual(sm.getEntries());
			expect(h.events).toEqual(events);
			expect(h.eventsOfType("message_end").filter((event) => event.message === response)).toHaveLength(1);
		} finally {
			hold.release();
		}
	} finally {
		chmodSync(sm.getSessionFile()!, 0o600);
	}
});

it("keeps in-memory capture unsupported and pre-assistant journals deferred", async () => {
	const memory = await createHarness();
	harnesses.push(memory);
	memory.sessionManager.appendCustomEntry("memory", { retained: true });
	await expect(memory.session.acquireCheckpoint()).rejects.toThrow("persistent session");
	expect(memory.sessionManager.getSessionFile()).toBeUndefined();

	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-deferred-"));
	directories.push(directory);
	const h = await createHarness({ sessionManager: SessionManager.create(directory, directory) });
	harnesses.push(h);
	h.sessionManager.appendSessionInfo("before-assistant");
	const file = h.session.sessionFile!;
	const hold = await h.session.acquireCheckpoint({ quiesce: () => () => {} });
	try {
		expect(hold.sleepReady).toBe(true);
		expect(existsSync(file)).toBe(false);
		const artifact = join(directory, "checkpoint.json");
		writeSessionCheckpoint(artifact, hold.checkpoint);
		const restored = openSessionCheckpoint(readSessionCheckpoint(artifact));
		expect(restored.getEntries()).toEqual(hold.checkpoint.entries);
		expect(restored.getLeafId()).toBe(hold.checkpoint.selection.leafId);
	} finally {
		hold.release();
	}
});
