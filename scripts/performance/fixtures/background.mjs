import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "/pi-performance-source/packages/coding-agent/src/core/session-manager.ts";
import backgroundCommand, {
	BACKGROUND_COMMAND_NOTICE,
} from "/pi-performance-source/packages/coding-agent/src/extensions/background-command/index.ts";
import { backgroundCommandDirectory } from "/pi-performance-source/packages/coding-agent/src/extensions/background-command/jobs.ts";
import { createHarness } from "/pi-performance-source/packages/coding-agent/test/suite/harness.ts";
import { witness } from "../proof.mjs";

const count = Number(process.argv[2] ?? 1000);
const samples = Number(process.argv[3] ?? 9);
const warmups = Number(process.argv[4] ?? 2);
for (const value of [count, samples, warmups]) assert.ok(Number.isSafeInteger(value) && value >= 0);
assert.ok(samples > 0);
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-monitor-bench-")));
const owner = SessionManager.create(fixture, join(fixture, "sessions"));
const root = backgroundCommandDirectory(owner);
owner.appendMessage({ role: "user", content: "Saved monitor benchmark", timestamp: 0 });
const ids = [];
for (let i = 0; i < count; i++) {
	const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
	const directory = join(root, id);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "job.json"),
		JSON.stringify({
			job: {
				id,
				command: `job ${i}`,
				cwd: fixture,
				createdAt: new Date(i * 1000).toISOString(),
				logFile: join(directory, "output.log"),
				status: "running",
				pid: process.pid,
			},
		}),
	);
	writeFileSync(join(directory, "state.json"), JSON.stringify({ status: "succeeded", exitCode: 0 }));
	ids.push(id);
}
for (let i = 0; i < ids.length; i += 20) {
	owner.appendCustomMessageEntry(BACKGROUND_COMMAND_NOTICE, "Acknowledged completed jobs", true, {
		jobIds: ids.slice(i, i + 20),
	});
}
const h = await createHarness({
	sessionManager: owner,
	extensionFactories: [backgroundCommand],
	settings: { compaction: { enabled: false }, retry: { enabled: false } },
});
const errors = [];
h.session.extensionRunner.onError((error) => errors.push(error.error));
const scan = async () => {
	const result = await h.session.extensionRunner.emitBoundary(
		{ type: "agent_before_settle", outcome: "completed" },
		() => ({
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: true,
		}),
	);
	assert.equal(result.valid, true);
	assert.deepEqual(result.entries, []);
	assert.equal(result.continue, false);
	assert.deepEqual(errors, []);
};
try {
	await h.session.bindExtensions({ mode: "rpc" });
	// Keep the foreground run active so the periodic idle timer cannot race these boundary samples.
	h.setResponses([
		async () => {
			await scan(); // Acquire the delivery lease, recover durable receipts, and learn terminal IDs.
			for (let i = 0; i < warmups; i++) await scan();
			for (let i = 0; i < samples; i++) {
				globalThis.gc?.();
				const start = performance.now();
				await scan();
				console.log(JSON.stringify({ sample: i, count, elapsedMs: performance.now() - start }));
			}
			// Count real job/state reads separately, outside timed samples.
			const original = fs.readFileSync;
			let recordReads = 0;
			fs.readFileSync = function (path, ...args) {
				if (String(path).startsWith(`${root}/`) && /\/(?:job|state)\.json$/.test(String(path))) recordReads++;
				return original.call(this, path, ...args);
			};
			syncBuiltinESMExports();
			try {
				await scan();
			} finally {
				fs.readFileSync = original;
				syncBuiltinESMExports();
			}
			console.log(
				JSON.stringify({
					recordReads,
					count,
					receiptEntries: Math.ceil(count / 20),
					boundary: "agent_before_settle",
					phase: "acknowledged-steady-state",
				}),
			);
			return fauxAssistantMessage("Benchmark complete");
		},
	]);
	await h.session.prompt("Measure acknowledged terminal monitor scans");
	assert.deepEqual(errors, []);
	witness(
		"monitor",
		{ count, samples, warmups, ids },
		owner
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_COMMAND_NOTICE)
			.map((entry) => entry.details),
	);
	assert.equal(
		owner
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_COMMAND_NOTICE).length,
		Math.ceil(count / 20),
	);
} finally {
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	rmSync(fixture, { recursive: true, force: true });
}
