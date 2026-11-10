import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { BACKGROUND_COMMAND_NOTICE } from "../src/extensions/background-command/index.ts";
import {
	backgroundCommandDirectory,
	cancelBackgroundCommand,
	startBackgroundCommand,
} from "../src/extensions/background-command/jobs.ts";
import { getShellEnv } from "../src/utils/shell.ts";

// Four Node processes start from TypeScript source: a worker and three sessions. The test takes 5 s on
// an idle machine and 86 s on one starved enough to reproduce the CI timeouts. The limit is three times
// that, rounded up to a minute.
it("delivers once across two processes sharing a session and another process resume", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-process-")));
	const owner = SessionManager.create(root, join(root, "sessions"));
	owner.appendMessage({ role: "user", content: "Saved session", timestamp: Date.now() });
	const release = join(root, "release");
	const stopConcurrent = join(root, "stop-concurrent");
	const stopResumed = join(root, "stop-resumed");
	const command = `while [ ! -f '${release}' ]; do sleep 0.02; done; printf finished`;
	const jobs = backgroundCommandDirectory(owner);
	const job = await startBackgroundCommand(jobs, command, { command, cwd: root, env: getShellEnv() });
	const fixture = fileURLToPath(new URL("./fixtures/background-command-resume.ts", import.meta.url));
	const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
	const children: ReturnType<typeof spawn>[] = [];
	function resume(stopFile: string) {
		const child = spawn(process.execPath, ["--import", resolver, fixture, owner.getSessionFile()!, stopFile], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_OFFLINE: "1" },
		});
		children.push(child);
		let stdout = "";
		let stderr = "";
		let markReady: () => void;
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
			if (stdout.includes("ready\n")) markReady();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const done = new Promise<number>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => {
				if (code !== 0) reject(new Error(`Resume failed (${code}): ${stderr}\n${stdout}`));
				else resolve((JSON.parse(stdout.trim().split("\n").at(-1)!) as { calls: number }).calls);
			});
		});
		return {
			child,
			ready: Promise.race([
				ready,
				done.then(() => {
					throw new Error("Exited before ready");
				}),
			]),
			done,
		};
	}
	const notices = () =>
		SessionManager.open(owner.getSessionFile()!)
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_COMMAND_NOTICE);
	// Runs after a timeout as well, where the test body is still waiting and a `finally` would never run.
	onTestFinished(async () => {
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		await cancelBackgroundCommand(jobs, job.id);
		rmSync(root, { recursive: true, force: true });
	});
	const first = resume(stopConcurrent);
	const second = resume(stopConcurrent);
	await Promise.all([first.ready, second.ready]);
	writeFileSync(release, "go");
	do {
		// Both processes compete for the completion; one that exited would leave the other unopposed.
		expect([first.child.exitCode, second.child.exitCode]).toEqual([null, null]);
		await delay(50);
	} while (notices().length === 0);
	expect([first.child.exitCode, second.child.exitCode]).toEqual([null, null]);
	// Each process answers the stop request after one more monitor pass over the finished job. The
	// process without the delivery lease gets that pass by taking the lease over from the one that
	// exits first, so it must find the notice in the journal instead of sending a second one.
	writeFileSync(stopConcurrent, "stop");
	const calls = await Promise.all([first.done, second.done]);
	expect(calls.reduce((sum, count) => sum + count, 0)).toBe(1);
	expect(notices()).toMatchObject([{ details: { jobIds: [job.id] } }]);
	const third = resume(stopResumed);
	await third.ready;
	writeFileSync(stopResumed, "stop");
	expect(await third.done).toBe(0);
}, 300_000);
