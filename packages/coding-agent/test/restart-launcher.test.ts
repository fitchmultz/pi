import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCliWorkerPath, superviseCli } from "../src/cli/launcher.ts";
import { parseRestartCommand, parseRestartRequest, type RestartCheckpoint } from "../src/cli/restart-protocol.ts";
import { getRestartArgs } from "../src/cli/restart-worker.ts";

const directories: string[] = [];
const children: ChildProcess[] = [];
const workerPids: number[] = [];
afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const pid of workerPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(candidateBody: string, fallbackBody = "process.send({ type: 'pi:ready' }, () => process.exit(0));") {
	const root = mkdtempSync(join(tmpdir(), "pi-supervisor-test-"));
	directories.push(root);
	const trace = join(root, "trace.jsonl");
	const runtime = join(root, "candidate");
	mkdirSync(join(runtime, "dist", "bundle"), { recursive: true });
	const checkpoint: RestartCheckpoint = {
		sessionFile: join(root, "session.jsonl"),
		sessionId: "same-session",
		cwd: root,
		leafId: "saved-leaf",
		model: { provider: "faux", id: "faux-1" },
		thinkingLevel: "off",
		activeTools: ["bash"],
		knownTools: ["bash", "read"],
	};
	const log = (name: string) => `
import { appendFileSync } from 'node:fs';
const handoff = process.env.PI_RESTART_HANDOFF ? JSON.parse(process.env.PI_RESTART_HANDOFF) : undefined;
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)}, pid:process.pid, args:process.argv.slice(2), handoff, socket:process.env.PI_RESTART_SOCKET}) + '\\n');
`;
	const worker = join(root, "working.mjs");
	const restart = {
		type: "pi:restart",
		request: { runtime, extensions: [join(root, "v2.ts")], message: "Check the new capability" },
		checkpoint,
		args: ["-ne", "--custom-flag", "keep this value"],
		extensions: [join(root, "v1.ts")],
	};
	writeFileSync(
		worker,
		`${log("working")}
if (!handoff) {
	process.send({type:'pi:ready'}, () => process.send(${JSON.stringify(restart)}, () => process.exit(0)));
} else { ${fallbackBody} }
`,
	);
	writeFileSync(join(runtime, "dist", "bundle", "cli-worker.js"), `${log("candidate")}\n${candidateBody}`);
	return {
		worker,
		checkpoint,
		read: () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							name: string;
							pid: number;
							args: string[];
							socket?: string;
							handoff?: {
								checkpoint: RestartCheckpoint;
								message?: string;
								failure?: string;
								extensions?: string[];
							};
						},
				),
	};
}

const cleanEnv = {
	PATH: process.env.PATH,
	SystemRoot: process.env.SystemRoot,
	PI_RESTART_SOCKET: "outer-session-endpoint",
};

describe("restart arguments and validation", () => {
	it("captures only persistent options with the real CLI parser", () => {
		expect(
			getRestartArgs([
				"-ne",
				"-ns",
				"-np",
				"-nc",
				"-e",
				"./old.ts",
				"--session",
				"old.jsonl",
				"--session-dir",
				"/custom/sessions",
				"--name",
				"old name",
				"--model",
				"old/model",
				"--thinking",
				"high",
				"--fork",
				"another.jsonl",
				"-a",
				"--custom-flag",
				"an extension value",
				"--toggle",
				"--inline=value",
				"@old-file.md",
				"original task",
				"--",
				"--not-a-flag",
				"@another.md",
			]),
		).toEqual([
			"-ne",
			"-ns",
			"-np",
			"-nc",
			"--session-dir",
			"/custom/sessions",
			"-a",
			"--custom-flag",
			"an extension value",
			"--toggle",
			"--inline=value",
		]);
	});

	it("does not forward a CLI API key unless its original provider is still selected", () => {
		const args = ["--model", "provider/model", "--api-key", "test-only-key", "-ne"];
		expect(getRestartArgs(args)).toEqual(["-ne"]);
		expect(getRestartArgs(args, true)).toEqual(["--api-key", "test-only-key", "-ne"]);
		expect(getRestartArgs(["--no-approve", "-ne"])).toEqual(["--no-approve", "-ne"]);
	});

	it("resolves staged resources without executing shell text", () => {
		const cwd = process.cwd();
		expect(
			parseRestartCommand(
				["--message", "continue; $(not-a-command)", "--runtime", "next", "-e", "tools.ts", "-e", "other.ts"],
				cwd,
			),
		).toEqual({
			message: "continue; $(not-a-command)",
			runtime: join(cwd, "next"),
			extensions: [join(cwd, "tools.ts"), join(cwd, "other.ts")],
		});
		expect(parseRestartCommand([], cwd)).toEqual({});
		expect(() => parseRestartCommand(["--message"], cwd)).toThrow("Missing value");
		expect(() => parseRestartCommand(["--bogus", "yes"], cwd)).toThrow("Unknown restart option");
	});

	it.each([
		null,
		[],
		{ runtime: "relative" },
		{ message: 42 },
		{ message: "x".repeat(8193) },
		{ extensions: ["relative"] },
		{ extensions: [42] },
		{ unexpected: true },
	])("rejects invalid local control messages: %j", (input) => {
		expect(() => parseRestartRequest(input)).toThrow();
	});

	it("locates bundled, unbundled and source workers", () => {
		const root = join(process.cwd(), "package");
		expect(getCliWorkerPath(join(root, "dist", "bundle", "cli.js"))).toBe(
			join(root, "dist", "bundle", "cli-worker.js"),
		);
		expect(getCliWorkerPath(join(root, "dist", "cli-launcher.js"))).toBe(join(root, "dist", "cli.js"));
		expect(getCliWorkerPath(join(root, "src", "cli-launcher.ts"))).toBe(join(root, "src", "cli.ts"));
	});
});

describe("real-process restart supervisor", () => {
	it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGKILL"] as const)(
		"does not leave a worker or restart after launcher %s",
		async (signal) => {
			const root = mkdtempSync(join(tmpdir(), "pi-supervisor-signal-"));
			directories.push(root);
			const pidFile = join(root, "worker-pid");
			const cleaned = join(root, "worker-cleaned");
			const worker = join(root, "worker.mjs");
			const parent = join(root, "parent.mjs");
			const workerModule = pathToFileURL(resolve(__dirname, "../src/cli/restart-worker.ts")).href;
			const launcherModule = pathToFileURL(resolve(__dirname, "../src/cli/launcher.ts")).href;
			writeFileSync(
				worker,
				`
import {writeFileSync} from 'node:fs';
import {createManagedRestart} from ${JSON.stringify(workerModule)};
createManagedRestart([]);
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(cleaned)}, 'cleaned'); process.exit(0); });
process.send({type:'pi:ready'});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
			);
			writeFileSync(
				parent,
				`import {superviseCli} from ${JSON.stringify(launcherModule)}; process.exitCode = await superviseCli(${JSON.stringify(worker)}, [], {execArgv:[]});`,
			);
			const child = spawn(process.execPath, [parent], { env: cleanEnv, stdio: "ignore" });
			children.push(child);
			const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
				child.once("error", reject);
				child.once("exit", (code, exitSignal) => resolveResult({ code, signal: exitSignal }));
			});
			await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
			const workerPid = Number(readFileSync(pidFile, "utf8"));
			workerPids.push(workerPid);
			child.kill(signal);
			const result = await exited;
			if (signal === "SIGTERM") expect(result.code).toBe(143);
			else expect(result.signal).toBe("SIGKILL");
			await vi.waitFor(() => expect(existsSync(cleaned)).toBe(true));
			await vi.waitFor(() => expect(() => process.kill(workerPid, 0)).toThrow());
		},
	);
	it("changes workers and explicit extensions, preserving the exact checkpoint without replaying startup input", async () => {
		const f = fixture("process.send({ type: 'pi:ready' }, () => process.exit(0));");
		expect(await superviseCli(f.worker, ["original task", "@original.md"], { env: cleanEnv, execArgv: [] })).toBe(0);
		const trace = f.read();
		expect(trace.map((entry) => entry.name)).toEqual(["working", "candidate"]);
		expect(trace[0].pid).not.toBe(trace[1].pid);
		expect(trace[1].handoff?.checkpoint).toEqual(f.checkpoint);
		expect(trace[1].handoff?.message).toBe("Check the new capability");
		expect(trace[1].args).toContain(f.checkpoint.sessionFile);
		expect(trace[1].args).toContain("faux/faux-1");
		expect(trace[1].args).not.toContain("--approve");
		expect(trace[1].args).not.toContain("--no-approve");
		expect(trace[1].args).not.toContain("original task");
		expect(trace[1].args).not.toContain("@original.md");
		expect(trace[1].args.at(-1)).toMatch(/v2\.ts$/);
		expect(trace.every((entry) => entry.socket === undefined)).toBe(true);
	});

	it("rolls back failed startup to the prior runtime and extension list, with no lost continuation", async () => {
		const f = fixture("process.exit(17);");
		expect(await superviseCli(f.worker, ["original task"], { env: cleanEnv, execArgv: [] })).toBe(0);
		const trace = f.read();
		expect(trace.map((entry) => entry.name)).toEqual(["working", "candidate", "working"]);
		expect(trace[2].handoff).toMatchObject({
			checkpoint: f.checkpoint,
			message: "Check the new capability",
			failure: "Updated Pi failed during startup.",
		});
		expect(trace[2].args.at(-1)).toMatch(/v1\.ts$/);
		expect(trace[2].args).not.toContain("original task");
	});

	it("bounds rollback when the previous runtime also fails", async () => {
		const f = fixture("process.exit(17);", "process.exit(23);");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [] })).toBe(23);
		expect(f.read().map((entry) => entry.name)).toEqual(["working", "candidate", "working"]);
	});

	it("recovers from a startup hang", async () => {
		const f = fixture("setInterval(() => {}, 1000);");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [], startupTimeoutMs: 500 })).toBe(0);
		expect(f.read().at(-1)?.handoff?.failure).toContain("startup deadline");
	});

	it("does not treat normal quit before readiness as a failed update", async () => {
		const f = fixture("process.exit(0);");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [] })).toBe(0);
		expect(f.read()).toHaveLength(2);
	});

	it("does not replay work after a ready worker later crashes", async () => {
		const f = fixture("process.send({ type: 'pi:ready' }, () => process.exit(17));");
		expect(await superviseCli(f.worker, [], { env: cleanEnv, execArgv: [] })).toBe(17);
		expect(f.read()).toHaveLength(2);
	});
});
