import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backgroundCommandFinished,
	backgroundCommandOutputTail,
	cancelBackgroundCommand,
	listBackgroundCommands,
	readBackgroundCommand,
	startBackgroundCommand,
} from "../src/core/background-command.ts";
import { createBackgroundCommandTool } from "../src/core/tools/background-command.ts";
import { getShellEnv } from "../src/utils/shell.ts";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
async function until(condition: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (condition()) return;
		await delay(25);
	}
	throw new Error("Timed out waiting for background worker");
}

describe("native background shell worker", () => {
	let root: string;
	let jobs: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-")));
		jobs = join(root, "jobs");
	});
	afterEach(async () => {
		for (const job of listBackgroundCommands(jobs)) {
			if (!backgroundCommandFinished(job)) await cancelBackgroundCommand(jobs, job.id);
		}
		rmSync(root, { recursive: true, force: true });
	});
	const start = (command: string, options?: { timeout?: number; signal?: AbortSignal }) =>
		startBackgroundCommand(jobs, command, { command, cwd: root, env: getShellEnv() }, options);

	it("returns while running and preserves both pipes and the real exit status", async () => {
		const release = join(root, "release");
		const job = await start(
			`while [ ! -f ${quote(release)} ]; do sleep 0.02; done; printf 'stdout\\n'; printf 'stderr\\n' >&2; exit 7`,
		);
		expect(job.status).toBe("running");
		writeFileSync(release, "go");
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const done = readBackgroundCommand(jobs, job.id);
		expect(done).toMatchObject({ status: "failed", exitCode: 7, pid: job.pid });
		expect(readFileSync(done.logFile, "utf8")).toContain("stdout\n");
		expect(backgroundCommandOutputTail(done)).toContain("stderr\n");
	});

	it.each(["cancel", "timeout"])("%s stops native shell descendants and retains output", async (kind) => {
		const pidFile = join(root, "child.pid");
		const job = await start(
			`printf 'before stop\\n'; sleep 600 & child=$!; printf '%s' "$child" > ${quote(pidFile)}; wait "$child"; printf 'should not run\\n'`,
			kind === "timeout" ? { timeout: 0.5 } : {},
		);
		await until(() => existsSync(pidFile));
		if (kind === "cancel") await cancelBackgroundCommand(jobs, job.id);
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const done = readBackgroundCommand(jobs, job.id);
		expect(done.status).toBe(kind === "cancel" ? "cancelled" : "timed_out");
		if (kind === "timeout") expect(done.error).toBe("Command timed out after 0.5 seconds");
		expect(backgroundCommandOutputTail(done)).toContain("before stop");
		expect(backgroundCommandOutputTail(done)).not.toContain("should not run");
		const pid = Number(readFileSync(pidFile, "utf8"));
		await until(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		});
	});

	it("honors cancellation during worker startup", async () => {
		const controller = new AbortController();
		const launching = start("sleep 600", { signal: controller.signal });
		controller.abort();
		const job = await launching;
		await until(() => readBackgroundCommand(jobs, job.id).status === "cancelled");
	});

	it("keeps bounded readable UTF-8 tails and unchanged raw logs", async () => {
		const output = `\u001b[32m${"😀".repeat(5000)}\u001b[0m\n`;
		const job = await start(
			`${quote(process.execPath)} -e ${quote(`process.stdout.write(${JSON.stringify(output)})`)}`,
		);
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const done = readBackgroundCommand(jobs, job.id);
		expect(done.status).toBe("succeeded");
		expect(readFileSync(done.logFile)).toEqual(Buffer.from(output));
		expect(backgroundCommandOutputTail(done)).toBe(`${"😀".repeat(4094)}\n`);
		writeFileSync(done.logFile, "line\n".repeat(200));
		expect(backgroundCommandOutputTail(done).split("\n").length).toBeLessThanOrEqual(100);
	});

	it("holds split UTF-8 until EOF and preserves BOMs", async () => {
		const job = await start("sleep 600");
		writeFileSync(job.logFile, Buffer.concat([Buffer.from("\uFEFFprefix: "), Buffer.from([0xf0, 0x9f])]));
		expect(backgroundCommandOutputTail(job)).toBe("\uFEFFprefix: ");
		expect(backgroundCommandOutputTail({ ...job, status: "succeeded" })).toBe("\uFEFFprefix: \uFFFD");
	});

	it("survives the launching process exiting and never replays the command", async () => {
		const command = `printf 'once\\n' >> ${quote(join(root, "count"))}; while [ ! -f ${quote(join(root, "release"))} ]; do sleep 0.02; done; printf 'survived\\n'`;
		const worker = fileURLToPath(new URL("./fixtures/background-command-launch.ts", import.meta.url));
		const loader = createRequire(import.meta.url).resolve("tsx/esm");
		const output = execFileSync(process.execPath, ["--import", loader, worker, jobs, root, command], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
			timeout: 10000,
		});
		const id = output.trim();
		const job = readBackgroundCommand(jobs, id);
		expect(job.status).toBe("running");
		writeFileSync(join(root, "release"), "go");
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, id)));
		expect(readBackgroundCommand(jobs, id)).toMatchObject({ status: "succeeded", pid: job.pid });
		expect(listBackgroundCommands(jobs)).toHaveLength(1);
		expect(readFileSync(join(root, "count"), "utf8")).toBe("once\n");
	});

	it("reports a missing worker outcome as unknown without replay", async () => {
		const job = await start("printf 'once'");
		await until(() => {
			try {
				process.kill(job.pid!, 0);
				return false;
			} catch {
				return true;
			}
		});
		// Reproduce a worker that exited without publishing its terminal state.
		rmSync(join(dirname(job.logFile), "state.json"));
		for (let i = 0; i < 2; i++) {
			expect(readBackgroundCommand(jobs, job.id)).toMatchObject({
				status: "unknown",
				error: expect.stringContaining("not restarted"),
			});
		}
		expect(listBackgroundCommands(jobs)).toHaveLength(1);
		expect(readFileSync(job.logFile, "utf8")).toBe("once");
	});

	it("requires explicit factory ownership and applies native spawn hooks before relative cwd", async () => {
		await expect(createBackgroundCommandTool(root).execute("call", { action: "status" })).rejects.toThrow(
			"requires a sessionManager",
		);
		mkdirSync(join(root, "selected", "child"), { recursive: true });
		const tool = createBackgroundCommandTool(root, {
			sessionManager: { getSessionId: () => "test-owner", getSessionDir: () => root },
			commandPrefix: "export BACKGROUND_PREFIX=effective",
			spawnHook: (context) => ({
				...context,
				cwd: join(root, "selected"),
				env: { ...context.env, BACKGROUND_ENV: "native" },
			}),
		});
		const result = await tool.execute("call", {
			action: "start",
			command: 'pwd; printf \'%s %s\' "$BACKGROUND_PREFIX" "$BACKGROUND_ENV"',
			cwd: "child",
		});
		const job = result.details as { id: string; cwd: string; logFile: string };
		expect(job.cwd).toBe(join(root, "selected", "child"));
		const ownerJobs = dirname(dirname(job.logFile));
		await until(() => backgroundCommandFinished(readBackgroundCommand(ownerJobs, job.id)));
		expect(readFileSync(job.logFile, "utf8")).toBe(`${job.cwd}\neffective native`);
	});
});
