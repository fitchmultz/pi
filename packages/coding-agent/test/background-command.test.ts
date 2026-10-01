import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../src/extensions/background-command/jobs.ts";
import { getShellEnv } from "../src/utils/shell.ts";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
async function until(condition: () => boolean) {
	for (let i = 0; i < 240; i++) {
		if (condition()) return;
		await delay(25);
	}
	throw new Error("Timed out waiting for background worker");
}

describe("detached background commands", () => {
	let root: string;
	let jobs: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-")));
		jobs = join(root, "jobs");
	});
	afterEach(async () => {
		for (const job of listBackgroundCommands(jobs))
			if (!backgroundCommandFinished(job)) await cancelBackgroundCommand(jobs, job.id);
		rmSync(root, { recursive: true, force: true });
	});
	const start = (command: string, options?: { timeout?: number; signal?: AbortSignal }) =>
		startBackgroundCommand(jobs, command, { command, cwd: root, env: getShellEnv() }, options);

	it.each([0, 7])("keeps both pipes and exit %s", async (exitCode) => {
		const release = join(root, "release");
		const job = await start(
			`while [ ! -f ${quote(release)} ]; do sleep 0.02; done; printf 'stdout\\n'; printf 'stderr\\n' >&2; exit ${exitCode}`,
		);
		expect(job.status).toBe("running");
		writeFileSync(release, "go");
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const done = readBackgroundCommand(jobs, job.id);
		expect(done).toMatchObject({ status: exitCode === 0 ? "succeeded" : "failed", exitCode, pid: job.pid });
		expect(readFileSync(done.logFile, "utf8")).toContain("stdout\n");
		expect(backgroundCommandOutputTail(done)).toContain("stderr\n");
	});
	it.each(["cancel", "timeout"])("%s stops descendants and preserves partial output", async (kind) => {
		const childPid = join(root, "child.pid");
		const job = await start(
			`printf 'before stop\\n'; sleep 600 & child=$!; printf '%s' "$child" > ${quote(childPid)}; wait "$child"; printf 'should not run\\n'`,
			kind === "timeout" ? { timeout: 0.5 } : {},
		);
		await until(() => existsSync(childPid));
		if (kind === "cancel") await cancelBackgroundCommand(jobs, job.id);
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const done = readBackgroundCommand(jobs, job.id);
		expect(done.status).toBe(kind === "cancel" ? "cancelled" : "timed_out");
		expect(backgroundCommandOutputTail(done)).toContain("before stop");
		expect(backgroundCommandOutputTail(done)).not.toContain("should not run");
		const pid = Number(readFileSync(childPid, "utf8"));
		await until(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		});
	});
	it("honors cancellation during startup and rejects invalid timeouts without launching", async () => {
		for (const timeout of [0, -1, Number.POSITIVE_INFINITY, 2_147_484])
			await expect(start("sleep 600", { timeout })).rejects.toThrow("Invalid timeout");
		expect(listBackgroundCommands(jobs)).toEqual([]);
		const controller = new AbortController();
		const launching = start("sleep 600", { signal: controller.signal });
		controller.abort();
		const job = await launching;
		await until(() => readBackgroundCommand(jobs, job.id).status === "cancelled");
	});
	it("caps readable UTF-8 status tails without modifying raw logs", async () => {
		const output = `\u001b[32m${"😀".repeat(5000)}\u001b[0m\n`;
		const job = await start(
			`${quote(process.execPath)} -e ${quote(`process.stdout.write(${JSON.stringify(output)})`)}`,
		);
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const done = readBackgroundCommand(jobs, job.id);
		expect(readFileSync(done.logFile)).toEqual(Buffer.from(output));
		const tail = backgroundCommandOutputTail(done);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(16_384);
		expect(tail).not.toContain("\uFFFD");
		expect(tail).not.toContain("\u001b");
		writeFileSync(done.logFile, "line\n".repeat(200));
		expect(backgroundCommandOutputTail(done).split("\n").length).toBeLessThanOrEqual(100);
		const unavailable = backgroundCommandOutputTail(
			{ ...done, status: "failed", logFile: join(root, "\n".repeat(150)) },
			{ maxLines: 20, maxBytes: 2048 },
		);
		expect(unavailable.split("\n").length).toBeLessThanOrEqual(20);
		expect(Buffer.byteLength(unavailable)).toBeLessThanOrEqual(2048);
	});
	it("survives launcher exit, ignores asset overrides, and never replays", async () => {
		const command = `printf 'once\\n' >> ${quote(join(root, "count"))}; while [ ! -f ${quote(join(root, "release"))} ]; do sleep 0.02; done; printf 'survived\\n'`;
		const fixture = fileURLToPath(new URL("./fixtures/background-command-launch.ts", import.meta.url));
		const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
		const id = execFileSync(process.execPath, ["--import", resolver, fixture, jobs, root, command], {
			env: { ...process.env, PI_PACKAGE_DIR: root },
			encoding: "utf8",
			timeout: 10000,
		}).trim();
		const job = readBackgroundCommand(jobs, id);
		expect(job.status).toBe("running");
		writeFileSync(join(root, "release"), "go");
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, id)));
		expect(readBackgroundCommand(jobs, id)).toMatchObject({ status: "succeeded", pid: job.pid });
		expect(listBackgroundCommands(jobs)).toHaveLength(1);
		expect(readFileSync(join(root, "count"), "utf8")).toBe("once\n");
		expect(backgroundCommandOutputTail(readBackgroundCommand(jobs, id))).toBe("survived\n");
		await until(() => {
			try {
				process.kill(job.pid!, 0);
				return false;
			} catch {
				return true;
			}
		});
		rmSync(join(jobs, id, "state.json"));
		expect(readBackgroundCommand(jobs, id)).toMatchObject({
			status: "unknown",
			error: expect.stringContaining("not restarted"),
		});
		expect(readFileSync(join(root, "count"), "utf8")).toBe("once\n");
	});
});
