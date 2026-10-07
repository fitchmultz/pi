import { constants } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	createReadStream,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { superviseCli } from "../../src/cli/launcher.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import {
	openWorkingSession,
	readWorkingSession,
	resolveWorkingSession,
	writeWorkingSession,
} from "../../src/core/working-session.ts";
import { createHarness } from "./harness.ts";

describe("Native working-session files", () => {
	it("retains JSON keys, numeric values, Unicode and escaping across file chunks", async () => {
		const h = await createHarness();
		try {
			const data: Record<string, unknown> = JSON.parse(
				'{"__proto__":{"kept":true},"constructor":[false,null,1.25e100],"duplicate":2}',
			);
			data["\uFEFF"] = ["\uFEFF", "before\uFEFFafter", "\uFEFFprefix", "suffix\uFEFF"];
			data.text = `${"x".repeat(65535)}\uFEFF\u{10000}${"界\uFEFF\u{10000}".repeat(14000)}\ud800\\"\n\t\udfff`;
			h.sessionManager.appendCustomEntry("opaque", data);
			h.session.bindWorkingSessionHost({
				kind: "host",
				readiness: () => {},
				capture: () => ({ data, negativeZero: -0 }),
				restore: () => {},
			});
			const hold = await h.session.acquireWorkingSession();
			await hold.release();
			const path = join(realpathSync(h.tempDir), "state.json");
			writeWorkingSession(path, hold.state);
			const expected = `${JSON.stringify(hold.state)}\n`;
			expect(readFileSync(path, "utf8")).toBe(expected);
			const duplicateKeys = expected
				.replace('"duplicate":2', '"duplicate":1,"duplicate":2')
				.replace("before\uFEFFafter", "before\\uFEFFafter");
			writeFileSync(path, `\uFEFF${duplicateKeys}`);
			const restored = readWorkingSession(path);
			expect(restored).toEqual(JSON.parse(duplicateKeys));
			const opaque = restored.entries[0];
			if (opaque?.type !== "custom") throw new Error("Missing opaque state");
			expect(Object.hasOwn(opaque.data as object, "__proto__")).toBe(true);
			expect(Object.getPrototypeOf(opaque.data)).toBe(Object.prototype);
			expect((opaque.data as Record<string, unknown>).constructor).toEqual([false, null, 1.25e100]);
		} finally {
			h.cleanup();
		}
	});

	it("fails closed on malformed or non-finite artifacts without changing the file", async () => {
		const h = await createHarness();
		try {
			const hold = await h.session.acquireWorkingSession();
			await hold.release();
			const valid = JSON.stringify(hold.state);
			const path = join(realpathSync(h.tempDir), "invalid.json");
			writeFileSync(path, `\uFEFF${valid}`);
			expect(readWorkingSession(path)).toEqual(JSON.parse(valid));
			for (const input of [
				Buffer.from(""),
				Buffer.from("\uFEFF"),
				Buffer.from(`\uFEFF\uFEFF${valid}`),
				Buffer.from(` \uFEFF${valid}`),
				Buffer.from(`{\uFEFF${valid.slice(1)}`),
				Buffer.from(valid.slice(0, -1)),
				Buffer.from(`${valid} {}`),
				Buffer.from(valid.replace('"entries":[]', '"entries":[null]')),
				Buffer.from(valid.replace('"settings":{}', '"settings":{"value":1e999}')),
				Buffer.from(valid.replace('"settings":{}', '"settings":{"value":"\\\uFEFF"}')),
				Buffer.concat([Buffer.from(valid.slice(0, -1)), Buffer.from([0xff]), Buffer.from("}")]),
			]) {
				writeFileSync(path, input);
				expect(() => readWorkingSession(path)).toThrow();
				expect(readFileSync(path)).toEqual(input);
			}
		} finally {
			h.cleanup();
		}
	});

	it("reads escaped structured history within a constrained heap", async () => {
		const h = await createHarness();
		try {
			const line = 'alpha\\path "quoted"\t界\uFEFF\ud800\n';
			const payload = line.repeat(64);
			for (let index = 0; index < 4096; index++)
				h.sessionManager.appendCustomEntry("escaped-history", { index, payload });
			const hold = await h.session.acquireWorkingSession();
			await hold.release();
			const artifact = join(h.tempDir, "escaped-history.json");
			writeFileSync(artifact, JSON.stringify(hold.state));
			const reader = join(h.tempDir, "reader.mjs");
			const ownerUrl = pathToFileURL(resolve(import.meta.dirname, "../../src/core/working-session.ts")).href;
			writeFileSync(
				reader,
				`
import assert from "node:assert/strict";
import { readWorkingSession } from ${JSON.stringify(ownerUrl)};
const state = readWorkingSession(process.argv[2]);
assert.equal(state.entries.length, 4096);
const expected = ${JSON.stringify(line)}.repeat(64);
for (const [index, entry] of state.entries.entries()) {
	assert.equal(entry.type, "custom");
	assert.equal(entry.customType, "escaped-history");
	assert.equal(entry.data.index, index);
	assert.equal(entry.data.payload, expected);
}
`,
			);
			const resolverUrl = pathToFileURL(
				resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts"),
			).href;
			const result = spawnSync(
				process.execPath,
				["--max-old-space-size=64", "--import", resolverUrl, reader, artifact],
				{ encoding: "utf8", timeout: 30000 },
			);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.signal).toBeNull();
		} finally {
			h.cleanup();
		}
	}, 60000);

	it("preserves strict journal comparison, including order, invalid lines and unterminated final lines", async () => {
		const h = await createHarness();
		try {
			h.sessionManager.appendCustomEntry("opaque", {
				first: 1,
				second: 2,
				zero: -0,
				overflow: null,
				nested: [false, null, { text: `${"x".repeat(65535)}界\uFEFF\ud800\n` }],
			});
			const hold = await h.session.acquireWorkingSession();
			await hold.release();
			const saved = { ...hold.state, sessionFile: join(realpathSync(h.tempDir), "journal.jsonl") };
			const header = JSON.stringify(saved.header);
			const entry = JSON.stringify(saved.entries[0]);
			const valid = `\n${header}\n  \n${entry}`;
			writeFileSync(saved.sessionFile, valid);
			expect(resolveWorkingSession(saved)?.leafId).toBe(saved.leafId);
			expect(readFileSync(saved.sessionFile, "utf8")).toBe(valid);
			const equivalent = `${header}\n${entry.replace('"zero":0', '"zero":-0').replace('"overflow":null', '"overflow":1e999')}`;
			writeFileSync(saved.sessionFile, equivalent);
			expect(resolveWorkingSession(saved)?.leafId).toBe(saved.leafId);
			expect(readFileSync(saved.sessionFile, "utf8")).toBe(equivalent);
			for (const input of [
				`${header}\n${entry.replace('"first":1,"second":2', '"second":2,"first":1')}\n`,
				`${header}\n${entry.replace('"nested":[false,null,', '"nested":[null,false,')}\n`,
				`${header}\nnot JSON\n${entry}\n`,
				`${header}\n`,
				`${valid}\n${entry}\n`,
				`${header}\n${entry.slice(0, -1)}\n}\n`,
			]) {
				writeFileSync(saved.sessionFile, input);
				expect(() => resolveWorkingSession(saved)).toThrow();
				expect(readFileSync(saved.sessionFile, "utf8")).toBe(input);
			}
		} finally {
			h.cleanup();
		}
	});

	it("captures, writes, validates, opens, restores and attests complete histories above Node's string limit", async () => {
		const h = await createHarness({ allowedToolNames: ["read", "bash"], excludedToolNames: ["bash"] });
		try {
			const root = realpathSync(h.tempDir);
			const manager = h.sessionManager;
			const selected = manager.appendMessage({ role: "user", content: "selected", timestamp: 1 });
			const abandoned = manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
			const payload = "x".repeat(1024 * 1024);
			for (let index = 0; index < 513; index++) manager.appendCustomEntry("large-history", { index, payload });
			manager.branch(selected);
			h.session.refreshContext();
			h.session.setActiveToolsByName(["read"]);
			h.settingsManager.applyOverrides({ shellCommandPrefix: "saved setting" });
			const steering = { role: "user" as const, content: "accepted steering", timestamp: 3 };
			const followUp = { role: "user" as const, content: "accepted follow-up", timestamp: 4 };
			h.session.agent.steer(steering);
			h.session.agent.followUp(followUp);
			const mode = { draft: "unsent", queued: ["accepted native input"] };
			h.session.bindWorkingSessionHost({
				kind: "host",
				readiness: () => {},
				capture: () => mode,
				restore: () => {},
			});
			const hold = await h.session.acquireWorkingSession();
			const artifact = join(root, "working-session.json");
			try {
				writeWorkingSession(artifact, hold.state);
				hold.assertHeld();
			} finally {
				await hold.release();
			}
			expect(statSync(artifact).size).toBeGreaterThan(constants.MAX_STRING_LENGTH);
			if (process.platform !== "win32") expect(statSync(artifact).mode & 0o777).toBe(0o600);
			const saved = readWorkingSession(artifact);
			const assertHistory = (entries: SessionEntry[]) => {
				expect(entries.map((entry) => entry.id)).toEqual(manager.getEntries().map((entry) => entry.id));
				const large = entries.filter((entry) => entry.type === "custom" && entry.customType === "large-history");
				expect(large).toHaveLength(513);
				for (const [index, entry] of large.entries()) {
					if (entry.type !== "custom") throw new Error("Missing custom entry");
					const data = entry.data as { index: number; payload: string };
					expect(data.index).toBe(index);
					expect(data.payload === payload, `Full payload ${index}`).toBe(true);
				}
			};
			assertHistory(saved.entries);
			expect(saved.leafId).toBe(selected);
			expect(saved.steering).toEqual([steering]);
			expect(saved.followUp).toEqual([followUp]);
			expect(saved.mode).toEqual({ kind: "host", data: mode });
			// A missing live journal must be materialized exactly, not replaced by a branch export.
			saved.sessionFile = join(root, "restored.jsonl");
			saved.sessionDir = root;
			const materialized = openWorkingSession(saved);
			expect(statSync(saved.sessionFile).size).toBeGreaterThan(constants.MAX_STRING_LENGTH);
			expect(materialized.getHeader()).toEqual(saved.header);
			expect(materialized.getLeafId()).toBe(selected);
			const journalBefore = statSync(saved.sessionFile);
			assertHistory(SessionManager.open(saved.sessionFile).getEntries());
			const { session } = await createAgentSession({
				workingSession: saved,
				modelRuntime: h.session.modelRuntime,
				resourceLoader: h.session.resourceLoader,
			});
			try {
				assertHistory(session.sessionManager.getEntries());
				expect(session.sessionManager.getEntry(abandoned)).toMatchObject({ message: { content: "abandoned" } });
				expect(session.messages).toEqual([{ role: "user", content: "selected", timestamp: 1 }]);
				expect(session.sessionManager.getLeafId()).toBe(selected);
				expect(session.agent.getQueuedMessages()).toEqual({ steering: [steering], followUp: [followUp] });
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(session.settingsManager.getShellCommandPrefix()).toBe("saved setting");
				let restoredMode: unknown;
				session.bindWorkingSessionHost({
					kind: "host",
					readiness: () => {},
					capture: () => restoredMode,
					restore: (value) => {
						restoredMode = value;
					},
				});
				expect(restoredMode).toEqual(mode);
				expect(h.faux.state.callCount).toBe(0);
			} finally {
				session.dispose();
			}
			expect(statSync(saved.sessionFile).mtimeMs).toBe(journalBefore.mtimeMs);
			appendFileSync(
				saved.sessionFile,
				`${JSON.stringify({ type: "custom", id: "newer", parentId: selected, timestamp: "later", customType: "newer" })}\n`,
			);
			const newer = statSync(saved.sessionFile);
			expect(() => resolveWorkingSession(saved)).toThrow("differs");
			expect(statSync(saved.sessionFile).size).toBe(newer.size);
			expect(statSync(saved.sessionFile).mtimeMs).toBe(newer.mtimeMs);

			// The launcher independently re-reads the same large native artifact before publishing a receipt.
			const hash = createHash("sha256");
			for await (const bytes of createReadStream(artifact)) hash.update(bytes);
			const digest = hash.digest("hex");
			const exitPath = join(root, "completed.json");
			const statePath = `${exitPath}.state`;
			copyFileSync(artifact, statePath);
			const worker = join(root, "worker.mjs");
			writeFileSync(
				worker,
				`
await new Promise(resolve => process.send({type: 'pi:ready'}, resolve));
await new Promise(resolve => process.send({type: 'pi:completed', completed: {
 path: ${JSON.stringify(statePath)}, digest: ${JSON.stringify(digest)}, sessionId: ${JSON.stringify(saved.header.id)},
 pid: process.pid, worker: process.env.PI_WORKING_SESSION_WORKER, launch: process.env.PI_WORKING_SESSION_LAUNCH
}}, resolve));
`,
			);
			expect(
				await superviseCli(worker, [], {
					execArgv: [],
					env: { ...process.env, PI_WORKING_SESSION_EXIT_PATH: exitPath },
				}),
			).toBe(0);
			expect(JSON.parse(readFileSync(exitPath, "utf8"))).toMatchObject({
				digest,
				sessionId: saved.header.id,
				path: statePath,
			});
		} finally {
			h.cleanup();
		}
	}, 120000);
});
