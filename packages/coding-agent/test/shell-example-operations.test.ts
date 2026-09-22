import { EventEmitter, getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import type { ExecOptions } from "@earendil-works/gondolin";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as GondolinExec from "../../../node_modules/@earendil-works/gondolin/dist/src/exec.d.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

const require = createRequire(import.meta.url);
const { applyOutputChunk, createExecSession, ExecProcess, finishExecSession, rejectExecSession } = require(
	join(dirname(require.resolve("@earendil-works/gondolin/package.json")), "dist/src/exec.js"),
) as typeof GondolinExec;

// Execute the exact example factories without starting SSH, an OS sandbox, or a VM.
function loadFactory<T>(file: string, name: string, bindings: Record<string, unknown>): T {
	const source = readFileSync(new URL(`../examples/extensions/${file}`, import.meta.url), "utf8");
	const start = source.indexOf(`function ${name}(`);
	const end = source.indexOf("\nexport default", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const { outputText } = ts.transpileModule(`${source.slice(start, end)}\n${name};`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	});
	return runInNewContext(outputText, { AbortController, setTimeout, clearTimeout, ...bindings }) as T;
}

function callbacks() {
	return { onData: vi.fn(), onEnd: vi.fn() };
}

afterEach(() => vi.useRealTimers());

for (const example of ["ssh", "sandbox"] as const) {
	describe(`${example} shell operations`, () => {
		function setup() {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				pid: 123,
				kill: vi.fn(),
			});
			const kill = vi.fn();
			const spawn = vi.fn(() => child);
			const bindings = {
				spawn,
				process: { kill },
				existsSync: () => true,
				SandboxManager: { wrapWithSandbox: async (command: string) => command },
			};
			const ops =
				example === "ssh"
					? loadFactory<(remote: string, remoteCwd: string, localCwd: string) => BashOperations>(
							"ssh.ts",
							"createRemoteBashOps",
							bindings,
						)("fixture", "/remote", "/local")
					: loadFactory<() => BashOperations>("sandbox/index.ts", "createSandboxedBashOps", bindings)();
			return { ops, child, kill, spawn };
		}

		it("preserves pipe bytes, reports EOF once, and stops callbacks after close", async () => {
			const { ops, child } = setup();
			const received = callbacks();
			const controller = new AbortController();
			const result = ops.exec("fixture", "/local", { ...received, signal: controller.signal });
			await setImmediate();
			const first = Buffer.from([0xe2]);
			const rest = Buffer.from([0x82, 0xac]);
			child.stdout.emit("data", first);
			child.stderr.emit("data", Buffer.from("WARN\n"));
			child.stderr.emit("end");
			expect(received.onEnd.mock.calls).toEqual([["stderr"]]);
			child.stdout.emit("data", rest);
			child.stdout.emit("end");
			child.emit("close", 0);
			await expect(result).resolves.toEqual({ exitCode: 0 });
			expect(received.onData.mock.calls).toEqual([
				[first, "stdout"],
				[Buffer.from("WARN\n"), "stderr"],
				[rest, "stdout"],
			]);
			expect(received.onData.mock.calls[0][0]).toBe(first);
			expect(received.onEnd.mock.calls).toEqual([["stderr"], ["stdout"]]);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			child.stdout.emit("data", Buffer.from("late"));
			child.stderr.emit("end");
			expect(received.onData).toHaveBeenCalledTimes(3);
			expect(received.onEnd).toHaveBeenCalledTimes(2);
		});

		it("keeps split Unicode intact through the built-in bash tool", async () => {
			const { ops, child } = setup();
			const result = createBashTool("/local", { operations: ops }).execute("fixture", { command: "fixture" });
			await setImmediate();
			child.stdout.emit("data", Buffer.from([0xe2]));
			child.stderr.emit("data", Buffer.from("WARN\n"));
			child.stderr.emit("end");
			child.stdout.emit("data", Buffer.from([0x82, 0xac, 0xf0]));
			child.stdout.emit("end");
			child.emit("close", 0);
			expect((await result).content).toEqual([{ type: "text", text: "WARN\n€�" }]);
		});

		it.each(["spawn", "stdout", "stderr"] as const)("cleans up a %s error before rejecting", async (source) => {
			vi.useFakeTimers();
			const { ops, child, kill } = setup();
			const received = callbacks();
			const controller = new AbortController();
			const result = ops.exec("fixture", "/local", { ...received, signal: controller.signal, timeout: 1 });
			const rejected = expect(result).rejects.toThrow("transport failed");
			await setImmediate();
			child.stdout.emit("data", Buffer.from([0xe2]));
			(source === "spawn" ? child : child[source]).emit("error", new Error("transport failed"));
			await rejected;
			expect(received.onEnd.mock.calls).toEqual([["stdout"], ["stderr"]]);
			expect(child.stdout.destroyed).toBe(true);
			expect(child.stderr.destroyed).toBe(true);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(example === "ssh" ? child.kill : kill).toHaveBeenCalledTimes(1);
			child.stderr.emit("data", Buffer.from("late"));
			child.stdout.emit("end");
			child.emit("close", 1);
			controller.abort();
			expect(received.onData).toHaveBeenCalledTimes(1);
			expect(received.onEnd).toHaveBeenCalledTimes(2);
			expect(example === "ssh" ? child.kill : kill).toHaveBeenCalledTimes(1);
		});

		it.each(["abort", "timeout"] as const)("keeps output live until close after %s", async (reason) => {
			vi.useFakeTimers();
			const { ops, child } = setup();
			const received = callbacks();
			const controller = new AbortController();
			const result = ops.exec("fixture", "/local", { ...received, signal: controller.signal, timeout: 1 });
			const rejected = expect(result).rejects.toThrow(reason === "abort" ? "aborted" : "timeout:1");
			await setImmediate();
			if (reason === "abort") controller.abort();
			else vi.advanceTimersByTime(1000);
			expect(received.onEnd).not.toHaveBeenCalled();
			child.stdout.emit("data", Buffer.from("last"));
			child.emit("close", null);
			await rejected;
			expect(received.onData.mock.calls).toEqual([[Buffer.from("last"), "stdout"]]);
			expect(received.onEnd.mock.calls).toEqual([["stdout"], ["stderr"]]);
			expect(vi.getTimerCount()).toBe(0);
		});
	});
}

describe("Gondolin shell operations", () => {
	function setup() {
		const session = createExecSession(1, {
			stdinEnabled: false,
			stdout: { mode: "pipe" },
			stderr: { mode: "pipe" },
		});
		const proc = new ExecProcess(session, { sendStdin() {}, sendStdinEof() {}, cleanup() {} });
		const vm = { exec: vi.fn((_command: string[], _options: ExecOptions) => proc) };
		const factory = loadFactory<(guest: typeof vm, cwd: string, shell: string) => BashOperations>(
			"gondolin/index.ts",
			"createGondolinBashOps",
			{ toGuestPath: (_cwd: string, path: string) => path, sanitizeEnv: (env: unknown) => env },
		);
		return { session, proc, vm, ops: factory(vm, "/local", "/bin/sh") };
	}

	it("preserves vendor output source and ends both pipes after the iterator drains", async () => {
		const { ops, session } = setup();
		const received = callbacks();
		const result = ops.exec("fixture", "/local", received);
		applyOutputChunk(session, "stdout", Buffer.from([0xe2]));
		await setImmediate();
		applyOutputChunk(session, "stderr", Buffer.from("WARN\n"));
		await setImmediate();
		expect(received.onEnd).not.toHaveBeenCalled();
		applyOutputChunk(session, "stdout", Buffer.from([0x82, 0xac]));
		finishExecSession(session, 0);
		await expect(result).resolves.toEqual({ exitCode: 0 });
		expect(received.onData.mock.calls).toEqual([
			[Buffer.from([0xe2]), "stdout"],
			[Buffer.from("WARN\n"), "stderr"],
			[Buffer.from([0x82, 0xac]), "stdout"],
		]);
		expect(received.onEnd.mock.calls).toEqual([["stdout"], ["stderr"]]);
	});

	it("keeps split Unicode intact through the built-in bash tool", async () => {
		const { ops, session } = setup();
		const result = createBashTool("/local", { operations: ops }).execute("fixture", { command: "fixture" });
		applyOutputChunk(session, "stdout", Buffer.from([0xe2]));
		await setImmediate();
		applyOutputChunk(session, "stderr", Buffer.from("WARN\n"));
		await setImmediate();
		applyOutputChunk(session, "stdout", Buffer.from([0x82, 0xac, 0xf0]));
		finishExecSession(session, 0);
		expect((await result).content).toEqual([{ type: "text", text: "WARN\n€�" }]);
	});

	it("drains buffered bytes on vendor rejection and removes cancellation listeners", async () => {
		const { ops, session } = setup();
		const received = callbacks();
		const controller = new AbortController();
		const result = ops.exec("fixture", "/local", { ...received, signal: controller.signal });
		const rejected = expect(result).rejects.toThrow("transport failed");
		applyOutputChunk(session, "stderr", Buffer.from([0xe2]));
		rejectExecSession(session, new Error("transport failed"));
		await rejected;
		expect(received.onData.mock.calls).toEqual([[Buffer.from([0xe2]), "stderr"]]);
		expect(received.onEnd.mock.calls).toEqual([["stdout"], ["stderr"]]);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("aborts the vendor process on a read error and ends callbacks before settling", async () => {
		const { ops, session, vm } = setup();
		const received = callbacks();
		const result = ops.exec("fixture", "/local", received);
		const rejected = expect(result).rejects.toThrow("read failed");
		const signal = vm.exec.mock.calls[0][1].signal!;
		signal.addEventListener("abort", () => rejectExecSession(session, new Error("aborted")), { once: true });
		session.stdoutPipe!.destroy(new Error("read failed"));
		await rejected;
		expect(signal.aborted).toBe(true);
		expect(received.onEnd.mock.calls).toEqual([["stdout"], ["stderr"]]);
		await setImmediate();
		expect(received.onData).not.toHaveBeenCalled();
		expect(received.onEnd).toHaveBeenCalledTimes(2);
	});
});
