import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRestartArgs, getRestartRuntimeWorker, runCliLauncher, superviseCli } from "../src/cli/launcher.ts";
import { parseRestartCommand, parseRestartRequest } from "../src/cli/restart-protocol.ts";
import { createHarness } from "./suite/harness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Receipt {
	runtime: string;
	args: string[];
	handoff?: { sessionId: string; message?: string; failure?: string };
}

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-launcher-")));
	roots.push(root);
	const log = join(root, "launches.jsonl");
	const selector = join(root, "pi");
	const request = { message: "Continue once", extensions: [join(root, "v2.ts")] };
	const session = { sessionId: "same-session", sessionFile: join(root, "session.jsonl") };
	return {
		root,
		selector,
		request,
		release(name: string, body: string) {
			const runtime = join(root, name);
			const bundle = join(runtime, "dist", "bundle");
			mkdirSync(bundle, { recursive: true });
			writeFileSync(join(bundle, "cli.js"), "");
			writeFileSync(
				join(bundle, "cli-worker.js"),
				`
import { appendFileSync, existsSync, unlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const handoff = process.env.PI_RESTART_HANDOFF ? JSON.parse(process.env.PI_RESTART_HANDOFF) : undefined;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ runtime: ${JSON.stringify(name)}, args: process.argv.slice(2), handoff }) + '\\n');
const select = (name) => { if (existsSync(${JSON.stringify(selector)})) unlinkSync(${JSON.stringify(selector)}); symlinkSync(${JSON.stringify(root)} + '/' + name + '/dist/bundle/cli.js', ${JSON.stringify(selector)}); };
const restart = (request = ${JSON.stringify(request)}) => process.send({ type: 'pi:ready' }, () => process.send({ type: 'pi:restart', request, session: ${JSON.stringify(session)} }, () => process.exit(0)));
const ready = () => process.send({ type: 'pi:ready' }, () => process.exit(0));
${body}
`,
			);
			return runtime;
		},
		select(runtime: string) {
			if (readable(selector)) unlinkSync(selector);
			symlinkSync(join(runtime, "dist", "bundle", "cli.js"), selector);
		},
		read(): Receipt[] {
			return readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Receipt);
		},
		async run(runtime: string, startupTimeoutMs = 3000) {
			return superviseCli(
				getRestartRuntimeWorker(runtime),
				["--continue", "--offline", "-e", join(root, "v1.ts"), "completed startup prompt", "@completed.txt"],
				{ invocationPath: selector, startupTimeoutMs, execArgv: [] },
			);
		},
	};
}
function readable(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

describe("managed restart launcher", () => {
	it.each(["complete", "metadata", "crash", "stale-worker", "missing", "replaced", "corrupt"])(
		"attests only the current, ready, fully finalized last worker: %s",
		async (scenario) => {
			const h = await createHarness();
			const hold = await h.session.acquireWorkingSession();
			const state = JSON.stringify(hold.state);
			await hold.release();
			h.cleanup();
			const f = fixture();
			const exitPath = join(f.root, "exit.json");
			writeFileSync(exitPath, "stale previous launch", { mode: 0o600 });
			const complete = `
const statePath = process.env.PI_WORKING_SESSION_EXIT_PATH + '.state';
writeFileSync(statePath, ${JSON.stringify(state)}, {mode:0o600});
const receipt = {path:statePath,digest:${scenario === "corrupt" ? "'0'.repeat(64)" : `createHash('sha256').update(${JSON.stringify(state)}).digest('hex')`},sessionId:${JSON.stringify(h.session.sessionId)},pid:process.pid,worker:${scenario === "stale-worker" ? "'previous-worker'" : "process.env.PI_WORKING_SESSION_WORKER"},launch:process.env.PI_WORKING_SESSION_LAUNCH};
await new Promise(resolve => process.send({type:'pi:completed',completed:receipt}, resolve));
`;
			const body =
				scenario === "missing"
					? "ready();"
					: `
${scenario === "metadata" ? "" : "await new Promise(resolve => process.send({type:'pi:ready'}, resolve));"}
${complete}
${scenario === "replaced" ? "select('B'); restart();" : `process.exit(${scenario === "crash" ? 17 : 0});`}
`;
			const a = f.release("A", body);
			if (scenario === "replaced") f.release("B", "ready();");
			f.select(a);
			const result = superviseCli(getRestartRuntimeWorker(a), [], {
				invocationPath: f.selector,
				execArgv: [],
				env: { ...process.env, PI_WORKING_SESSION_EXIT_PATH: exitPath },
			});
			if (scenario === "corrupt") await expect(result).rejects.toThrow("artifact mismatch");
			else expect(await result).toBe(scenario === "crash" ? 17 : 0);
			expect(existsSync(exitPath)).toBe(scenario === "complete");
			if (scenario === "complete") {
				const receipt = JSON.parse(readFileSync(exitPath, "utf8"));
				expect(receipt).toMatchObject({
					version: 1,
					path: `${exitPath}.state`,
					sessionId: h.session.sessionId,
					launcherPid: process.pid,
				});
				expect(receipt.worker).toBeTypeOf("string");
				expect(receipt.launcher).toBe(receipt.launch);
			}
		},
	);

	it.skipIf(process.platform === "win32").each(["SIGINT", "SIGHUP", "SIGTERM"] as const)(
		"allows a worker to close gracefully after %s without duplicate delivery",
		async (signal) => {
			const f = fixture();
			const runtime = f.release(
				"A",
				`
process.once(${JSON.stringify(signal)}, () => {
 console.log('Signal handled once');
 setTimeout(() => { console.log('Graceful close done'); process.exit(0); }, 150);
});
process.send({type:'pi:ready'}, () => console.log('Worker ready'));
setInterval(() => {}, 1000);
`,
			);
			const parent = join(f.root, "parent.mjs");
			writeFileSync(
				parent,
				`
import { superviseCli } from ${JSON.stringify(new URL("../src/cli/launcher.ts", import.meta.url).href)};
process.exitCode = await superviseCli(${JSON.stringify(getRestartRuntimeWorker(runtime))}, [], {execArgv:[]});
`,
			);
			const child = spawn(process.execPath, [parent], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const exited = new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve(code));
			});
			try {
				await expect.poll(() => output, { timeout: 5000 }).toContain("Worker ready");
				process.kill(signal === "SIGTERM" ? child.pid! : -child.pid!, signal);
				expect(await exited).toBe(0);
				expect(output).toContain("Graceful close done");
				expect(output.split("Signal handled once")).toHaveLength(2);
				expect(f.read()).toHaveLength(1);
			} finally {
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
				}
			}
		},
	);
	it("retains parsed options without replaying startup text, session selection, or the launch model", () => {
		expect(
			getRestartArgs(
				[
					"--session",
					"old",
					"--session-id",
					"id",
					"--fork",
					"file",
					"-n",
					"name",
					"--model",
					"faux/faux-1",
					"--provider",
					"faux",
					"--thinking",
					"high",
					"--custom",
					"flag value",
					"-e",
					"old.ts",
					"@file",
					"prompt",
					"--",
					"--not-an-option",
				],
				["/new.ts"],
			),
		).toEqual(["--custom", "flag value", "-e", "/new.ts"]);
		// A runtime API key applies to the launch model, so that model is kept.
		expect(getRestartArgs(["--api-key", "key", "--model", "faux/faux-1", "--thinking", "high"])).toEqual([
			"--api-key",
			"key",
			"--model",
			"faux/faux-1",
		]);
	});
	it("validates requests and resolves local paths, preserving builtin extension names", () => {
		expect(
			parseRestartCommand(
				["--message", "continue", "-e", "v2.ts", "-e", "builtin:mcp", "--runtime", "candidate"],
				"/work",
			),
		).toEqual({ message: "continue", extensions: ["/work/v2.ts", "builtin:mcp"], runtime: "/work/candidate" });
		for (const value of [
			{ runtime: "relative" },
			{ extensions: [1] },
			{ checkpointTransform: "/script" },
			{ message: "x".repeat(8193) },
		])
			expect(() => parseRestartRequest(value)).toThrow();
		expect(() => parseRestartCommand(["--message"], "/work")).toThrow("Missing value");
	});
	it("rejects client requests outside a managed session", async () => {
		const previous = process.env.PI_RESTART_SOCKET;
		delete process.env.PI_RESTART_SOCKET;
		try {
			await expect(runCliLauncher(["restart"], "unused")).rejects.toThrow("managed interactive Pi");
		} finally {
			if (previous) process.env.PI_RESTART_SOCKET = previous;
		}
	});
	it("re-resolves a moved invocation symlink and replaces -e without replay", async () => {
		const f = fixture();
		const a = f.release("A", 'if (!handoff) { select("B"); restart(); } else ready();');
		f.release("B", "ready();");
		f.select(a);
		expect(await f.run(a)).toBe(0);
		const receipts = f.read();
		expect(receipts.map((r) => r.runtime)).toEqual(["A", "B"]);
		expect(receipts[1].handoff).toMatchObject({ sessionId: "same-session", message: "Continue once" });
		expect(receipts[1].args).toEqual([
			"--offline",
			"-e",
			f.request.extensions[0],
			"--session",
			join(f.root, "session.jsonl"),
		]);
	});
	it("pins an explicit runtime across subsequent ordinary restarts", async () => {
		const f = fixture();
		const b = f.release(
			"B",
			`if (!existsSync(${JSON.stringify(join(f.root, "once"))})) { writeFileSync(${JSON.stringify(join(f.root, "once"))}, ''); select('C'); restart({}); } else ready();`,
		);
		const a = f.release("A", `if (!handoff) restart({ runtime: ${JSON.stringify(b)} }); else ready();`);
		f.release("C", "ready();");
		f.select(a);
		expect(await f.run(a)).toBe(0);
		expect(f.read().map((r) => r.runtime)).toEqual(["A", "B", "B"]);
		expect(f.read()[2].args).toContain(join(f.root, "v1.ts"));
	});
	it.each([
		"process.exit(17);",
		"process.exit(0);",
		"setInterval(() => {}, 1000);",
		"process.on('SIGTERM', () => process.send({type:'pi:ready'}, () => process.exit(17))); setInterval(() => {}, 1000);",
	])("rolls back unready candidate once: %s", async (body) => {
		const f = fixture();
		const a = f.release("A", 'if (!handoff) { select("B"); restart(); } else ready();');
		f.release("B", body);
		f.select(a);
		expect(await f.run(a, 200)).toBe(0);
		const receipts = f.read();
		expect(receipts.map((r) => r.runtime)).toEqual(["A", "B", "A"]);
		expect(receipts[2].args).toContain(join(f.root, "v1.ts"));
		expect(receipts[2].args).not.toContain(f.request.extensions[0]);
		expect(receipts[2].handoff).toMatchObject({
			sessionId: "same-session",
			message: "Continue once",
			failure: expect.any(String),
		});
		if (body.includes("setInterval")) expect(receipts[2].handoff?.failure).toContain("within 0.2 seconds");
	});
	it("stops if the exact previous worker also fails", async () => {
		const f = fixture();
		const a = f.release("A", 'if (!handoff) { select("B"); restart(); } else process.exit(23);');
		f.release("B", "process.exit(17);");
		f.select(a);
		expect(await f.run(a)).toBe(23);
		expect(f.read().map((r) => r.runtime)).toEqual(["A", "B", "A"]);
	});
	it("does not roll back or replay after readiness", async () => {
		const f = fixture();
		const a = f.release("A", 'if (!handoff) { select("B"); restart(); } else ready();');
		f.release("B", "process.send({type:'pi:ready'}, () => process.exit(17));");
		f.select(a);
		expect(await f.run(a)).toBe(17);
		expect(f.read().map((r) => r.runtime)).toEqual(["A", "B"]);
	});
	it("normal exit never replaces a worker, with or without readiness", async () => {
		for (const body of ["ready();", "process.exit(0);"]) {
			const f = fixture();
			const a = f.release("A", body);
			f.select(a);
			expect(await f.run(a)).toBe(0);
			expect(f.read()).toHaveLength(1);
		}
	});
});
