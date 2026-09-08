import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";

const cliPath = resolve(__dirname, "../dist/cli.js");
const extensionPath = resolve(__dirname, "fixtures/rpc-shutdown-extension.ts");
const cleanups: Array<() => Promise<void>> = [];

async function startRpc(args: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "pi-rpc-shutdown-"));
	for (const dir of ["home", "agent", "sessions", "tmp"]) {
		mkdirSync(join(root, dir));
	}
	const child = spawn(
		process.execPath,
		[
			cliPath,
			"--mode",
			"rpc",
			"--offline",
			"--model",
			"openai/gpt-4o",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"-e",
			extensionPath,
			...args,
		],
		{
			cwd: root,
			env: {
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				HOME: join(root, "home"),
				PI_CODING_AGENT_DIR: join(root, "agent"),
				PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
				TMPDIR: join(root, "tmp"),
				PI_OFFLINE: "1",
				PI_NO_LOCAL_LLM: "1",
				AWS_EC2_METADATA_DISABLED: "true",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	child.stdin.on("error", (error) => {
		stderr += error.message;
	});
	const lines: string[] = [];
	const detach = attachJsonlLineReader(child.stdout, (line) => lines.push(line));
	const records = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line));
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
	void closed.then(() => clearTimeout(timeout));
	cleanups.push(async () => {
		detach();
		child.stdout.resume();
		writeFileSync(join(root, "release-shutdown"), "");
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGHUP");
		await closed;
		rmSync(root, { recursive: true, force: true });
	});
	const waitFor = async (predicate: (record: Record<string, unknown>) => boolean) => {
		await vi.waitFor(
			() => {
				expect(
					records().find(predicate),
					`RPC exited ${child.exitCode}/${child.signalCode}: ${stderr}`,
				).toBeDefined();
			},
			{ timeout: 10_000 },
		);
		return records().find(predicate)!;
	};
	const send = (command: RpcCommand) => child.stdin.write(serializeJsonLine(command));
	let nextId = 0;
	const request = async (command: RpcCommand) => {
		const id = `req-${++nextId}`;
		send({ ...command, id });
		const response = await waitFor((record) => record.type === "response" && record.id === id);
		expect(response).toMatchObject({ command: command.type, success: true });
		return response.data;
	};
	const startTool = async () => {
		send({
			id: "tool",
			type: "bash",
			command: "printf '%s' \"$$\" > tool.pid; printf 'tool-ready\\n'; exec sleep 60",
		});
		await waitFor((record) => record.type === "bash_execution_update" && record.id === "tool");
		return Number(readFileSync(join(root, "tool.pid"), "utf8"));
	};
	await request({ type: "get_state" });
	return { child, root, closed, records, waitFor, send, request, startTool };
}

async function repeatedSigterm(child: ChildProcess) {
	for (let i = 0; i < 3; i++) {
		expect(child.kill("SIGTERM")).toBe(true);
		await delay(50);
		expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: null, signal: null });
	}
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe.skipIf(process.platform === "win32")("RPC shutdown signals", () => {
	test.each([
		{ signal: "SIGTERM", args: [], code: 143 },
		{ signal: "SIGHUP", args: [], code: 129 },
		{ signal: "SIGHUP", args: ["--rpc-ignore-sigterm"], code: 129 },
	] as const)("$signal with $args performs native cleanup and exits $code", async ({ signal, args, code }) => {
		const rpc = await startRpc([...args]);
		const toolPid = await rpc.startTool();
		const start = performance.now();
		expect(rpc.child.kill(signal)).toBe(true);
		expect(await rpc.closed).toEqual({ code, signal: null });
		expect(performance.now() - start).toBeLessThan(5_000);
		await vi.waitFor(() => expect(() => process.kill(toolPid, 0)).toThrow());
		expect(readFileSync(join(rpc.root, "shutdown-finished"), "utf8")).toBe("quit");
	});

	test("opt-in SIGTERM keeps RPC, pending input, queues, tools, and entries until EOF", async () => {
		const rpc = await startRpc(["--rpc-ignore-sigterm"]);
		await rpc.request({ type: "set_session_name", name: "supervised" });
		await rpc.request({ type: "steer", message: "steering stays queued" });
		await rpc.request({ type: "follow_up", message: "follow-up stays queued" });
		rpc.send({ id: "question", type: "prompt", message: "/wait-for-answer" });
		await rpc.waitFor((record) => record.type === "extension_ui_request" && record.method === "input");
		const toolPid = await rpc.startTool();
		const entries = await rpc.request({ type: "get_entries" });
		const state = await rpc.request({ type: "get_state" });

		expect(rpc.child.kill("SIGTERM")).toBe(true);
		await delay(100);
		expect(await rpc.request({ type: "get_entries" })).toEqual(entries);
		expect(await rpc.request({ type: "get_state" })).toEqual(state);
		expect(() => process.kill(toolPid, 0)).not.toThrow();
		expect(existsSync(join(rpc.root, "shutdown-finished"))).toBe(false);
		expect(rpc.records().filter((record) => record.type === "response" && record.id === "question")).toEqual([]);
		expect(rpc.records().filter((record) => record.type === "response" && record.id === "tool")).toEqual([]);

		expect(await rpc.request({ type: "clear_queue" })).toEqual({
			steering: ["steering stays queued"],
			followUp: ["follow-up stays queued"],
		});
		await rpc.request({ type: "abort_bash" });
		expect(await rpc.waitFor((record) => record.type === "response" && record.id === "tool")).toMatchObject({
			success: true,
			data: { cancelled: true },
		});
		await vi.waitFor(() => expect(() => process.kill(toolPid, 0)).toThrow());
		await rpc.request({ type: "abort" });
		rpc.child.stdin.end();
		expect(await rpc.closed).toEqual({ code: 0, signal: null });
		expect(readFileSync(join(rpc.root, "shutdown-finished"), "utf8")).toBe("quit");
	});

	test("opt-in ignores repeated SIGTERM throughout EOF disposal", async () => {
		const rpc = await startRpc(["--rpc-ignore-sigterm"]);
		writeFileSync(join(rpc.root, "hold-shutdown"), "");
		rpc.child.stdin.end();
		await vi.waitFor(() => expect(existsSync(join(rpc.root, "shutdown-started"))).toBe(true));
		expect(existsSync(join(rpc.root, "shutdown-finished"))).toBe(false);

		await repeatedSigterm(rpc.child);
		writeFileSync(join(rpc.root, "release-shutdown"), "");
		expect(await rpc.closed).toEqual({ code: 0, signal: null });
		expect(readFileSync(join(rpc.root, "shutdown-finished"), "utf8")).toBe("quit");
	});

	test("opt-in ignores repeated SIGTERM while EOF stdout is draining", async () => {
		const rpc = await startRpc(["--rpc-ignore-sigterm"]);
		writeFileSync(join(rpc.root, "drain-output"), "");
		rpc.child.stdout.pause();
		rpc.child.stdin.end();
		await vi.waitFor(() => expect(existsSync(join(rpc.root, "shutdown-finished"))).toBe(true));

		await repeatedSigterm(rpc.child);
		rpc.child.stdout.resume();
		expect(await rpc.closed).toEqual({ code: 0, signal: null });
		expect(rpc.records().find((record) => record.method === "notify")).toMatchObject({
			message: "x".repeat(4 * 1024 * 1024),
		});
	});

	test("SIGKILL still bounds a held opt-in shutdown", async () => {
		const rpc = await startRpc(["--rpc-ignore-sigterm"]);
		writeFileSync(join(rpc.root, "hold-shutdown"), "");
		rpc.child.stdin.end();
		await vi.waitFor(() => expect(existsSync(join(rpc.root, "shutdown-started"))).toBe(true));
		const start = performance.now();
		expect(rpc.child.kill("SIGKILL")).toBe(true);
		expect(await rpc.closed).toEqual({ code: null, signal: "SIGKILL" });
		expect(performance.now() - start).toBeLessThan(5_000);
		expect(existsSync(join(rpc.root, "shutdown-finished"))).toBe(false);
	});
});
