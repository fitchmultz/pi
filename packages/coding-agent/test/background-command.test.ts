import childProcess, { ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";
import {
	backgroundCommandDirectory,
	backgroundCommandFinished,
	backgroundCommandOutputTail,
	cancelBackgroundCommand,
	listBackgroundCommands,
	readBackgroundCommand,
	startBackgroundCommand,
} from "../src/core/background-command.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBackgroundCommandTool } from "../src/core/tools/background-command.ts";
import { createSessionManager } from "../src/main.ts";
import { getShellEnv, killProcessTree } from "../src/utils/shell.ts";

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
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		vi.unstubAllEnvs();
		for (const job of listBackgroundCommands(jobs)) {
			if (!backgroundCommandFinished(job)) await cancelBackgroundCommand(jobs, job.id);
		}
		rmSync(root, { recursive: true, force: true });
	});
	const start = (command: string, options?: { timeout?: number; signal?: AbortSignal }) =>
		startBackgroundCommand(jobs, command, { command, cwd: root, env: getShellEnv() }, options);

	it.each([0, 7, undefined])("preserves exit %s when exit arrives before the IPC ready message", async (exitCode) => {
		vi.spyOn(childProcess, "spawn").mockImplementation((_command, args) => {
			const directory = (args as string[]).at(-1)!;
			const child = new ChildProcess();
			// No OS process is launched in this deterministic event-order reproduction.
			Object.defineProperty(child, "pid", { value: 2_147_483_647 });
			queueMicrotask(() => {
				if (exitCode !== undefined) {
					writeFileSync(
						join(directory, "state.json"),
						JSON.stringify({
							status: exitCode === 0 ? "succeeded" : "failed",
							exitCode,
							finishedAt: new Date().toISOString(),
						}),
					);
				} else {
					writeFileSync(join(directory, "state.json"), JSON.stringify({ status: "running" }));
				}
				child.emit("exit", exitCode ?? 1, null);
				queueMicrotask(() => child.emit("message", "ready"));
			});
			return child;
		});
		syncBuiltinESMExports();
		const job = await start("possibly executed");
		if (exitCode === undefined) {
			expect(job).toMatchObject({ status: "unknown", error: expect.stringContaining("not restarted") });
		} else {
			expect(job).toMatchObject({ status: exitCode === 0 ? "succeeded" : "failed", exitCode });
			expect(JSON.parse(readFileSync(join(dirname(job.logFile), "state.json"), "utf8")).exitCode).toBe(exitCode);
		}
	});

	it.each([0, 7])("retains real fast-command output and exit %s", async (exitCode) => {
		const job = await start(`printf 'fast result'; exit ${exitCode}`);
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const result = readBackgroundCommand(jobs, job.id);
		expect(result).toMatchObject({ status: exitCode === 0 ? "succeeded" : "failed", exitCode });
		expect(backgroundCommandOutputTail(result)).toBe("fast result");
	});

	it.each(["agent", "session", "relative", "cli"] as const)(
		"launches and cancels with a real %s-root session owner using absolute durable paths",
		async (kind) => {
			vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
			vi.stubEnv(ENV_SESSION_DIR, kind === "session" ? join(root, "sessions") : "");
			const owner =
				kind === "relative"
					? SessionManager.create(root, relative(process.cwd(), join(root, "sessions")))
					: kind === "cli"
						? await createSessionManager(
								parseArgs(["--no-session"]),
								root,
								join(root, "cli-sessions"),
								SettingsManager.inMemory(),
							)
						: SessionManager.inMemory(root);
			owner.appendCustomEntry("test-owner", {});
			jobs = backgroundCommandDirectory(owner);
			expect(isAbsolute(jobs)).toBe(true);
			expect(jobs.startsWith(root)).toBe(true);
			if (kind === "cli") expect(jobs.startsWith(join(root, "cli-sessions"))).toBe(true);
			const tool = createBackgroundCommandTool(root, { sessionManager: owner });
			const result = await tool.execute("launch", { action: "start", command: "sleep 600" });
			const job = result.details as { id: string; logFile: string };
			expect(isAbsolute(job.logFile)).toBe(true);
			if (kind === "relative") {
				expect(isAbsolute(owner.getSessionDir())).toBe(true);
				vi.spyOn(process, "cwd").mockReturnValue(root);
			}
			const restored = kind === "relative" ? SessionManager.open(owner.getSessionFile()!) : owner;
			const resumed = createBackgroundCommandTool(root, { sessionManager: restored });
			expect((await resumed.execute("status", { action: "status", id: job.id })).details).toMatchObject({
				id: job.id,
				status: "running",
			});
			expect((await resumed.execute("cancel", { action: "cancel", id: job.id })).details).toMatchObject({
				status: "cancelled",
			});
			if (kind !== "relative") expect(owner.getSessionFile()).toBeUndefined();
		},
	);

	it("launches the running source worker despite an inherited package asset override", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/background-command-launch.ts", import.meta.url));
		const loader = createRequire(import.meta.url).resolve("tsx/esm");
		const output = execFileSync(process.execPath, ["--import", loader, fixture, jobs, root, "printf native"], {
			env: { ...process.env, PI_PACKAGE_DIR: root },
			encoding: "utf8",
			timeout: 10000,
		});
		const id = output.trim();
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, id)));
		expect(readBackgroundCommand(jobs, id).status).toBe("succeeded");
		expect(backgroundCommandOutputTail(readBackgroundCommand(jobs, id))).toBe("native");
	});

	it("reports inaccessible workers as unknown without signalling them or hiding healthy jobs", async () => {
		const job = await start("printf healthy");
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const staleId = "00000000-0000-4000-8000-000000000001";
		mkdirSync(join(jobs, staleId));
		writeFileSync(
			join(jobs, staleId, "job.json"),
			JSON.stringify({ job: { ...job, id: staleId, pid: 123456, status: "running" }, launcherPid: 123456 }),
		);
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("inaccessible"), { code: "EPERM" });
		});
		expect(await cancelBackgroundCommand(jobs, staleId)).toMatchObject({
			status: "unknown",
			error: expect.stringContaining("inaccessible"),
		});
		expect(existsSync(join(jobs, staleId, "cancel"))).toBe(false);
		expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
		expect(listBackgroundCommands(jobs)).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: job.id, status: "succeeded" })]),
		);
	});

	it.each(["missing", "invalid", "shape"])("isolates a %s job record with a bounded diagnostic", async (kind) => {
		const job = await start("printf healthy");
		await until(() => backgroundCommandFinished(readBackgroundCommand(jobs, job.id)));
		const broken = "00000000-0000-4000-8000-000000000002";
		mkdirSync(join(jobs, broken));
		if (kind !== "missing") writeFileSync(join(jobs, broken, "job.json"), kind === "shape" ? "{}" : "{");
		const records = listBackgroundCommands(jobs);
		expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ id: job.id, status: "succeeded" })]));
		const diagnostic = records.find((record) => record.id === broken)!;
		expect(diagnostic).toMatchObject({ status: "unknown", error: expect.stringContaining("Cannot read") });
		expect(diagnostic.error!.length).toBeLessThan(1024);
		expect(backgroundCommandOutputTail(diagnostic)).toBe("");
	});

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

	it.skipIf(process.platform === "win32")("freezes the shell process group before killing it", () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		killProcessTree(4321);
		expect(kill.mock.calls).toEqual([
			[-4321, "SIGSTOP"],
			[-4321, "SIGKILL"],
		]);
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
