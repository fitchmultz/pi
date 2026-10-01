import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { BACKGROUND_COMMAND_NOTICE } from "../src/extensions/background-command/index.ts";
import {
	backgroundCommandDirectory,
	cancelBackgroundCommand,
	startBackgroundCommand,
} from "../src/extensions/background-command/jobs.ts";
import { getShellEnv } from "../src/utils/shell.ts";

it("delivers once across two processes sharing a session and another process resume", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-process-")));
	const owner = SessionManager.create(root, join(root, "sessions"));
	owner.appendMessage({ role: "user", content: "Saved session", timestamp: Date.now() });
	const release = join(root, "release");
	const command = `while [ ! -f '${release}' ]; do sleep 0.02; done; printf finished`;
	const jobs = backgroundCommandDirectory(owner);
	const job = await startBackgroundCommand(jobs, command, { command, cwd: root, env: getShellEnv() });
	const fixture = fileURLToPath(new URL("./fixtures/background-command-resume.ts", import.meta.url));
	const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
	const children: ReturnType<typeof spawn>[] = [];
	function resume() {
		const child = spawn(process.execPath, ["--import", resolver, fixture, owner.getSessionFile()!], {
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
			ready: Promise.race([
				ready,
				done.then(() => {
					throw new Error("Exited before ready");
				}),
			]),
			done,
		};
	}
	try {
		const first = resume();
		const second = resume();
		await Promise.all([first.ready, second.ready]);
		writeFileSync(release, "go");
		const calls = await Promise.all([first.done, second.done]);
		expect(calls.reduce((sum, count) => sum + count, 0)).toBe(1);
		const restored = SessionManager.open(owner.getSessionFile()!);
		const notices = restored
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_COMMAND_NOTICE);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ details: { jobIds: [job.id] } });
		expect(await resume().done).toBe(0);
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		await cancelBackgroundCommand(jobs, job.id);
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);
