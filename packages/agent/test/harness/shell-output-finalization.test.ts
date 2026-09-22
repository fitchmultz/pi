import type * as childProcess from "node:child_process";
import { ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { getOrThrow, type ShellExecOptions, type ShellOutputView } from "../../src/harness/types.ts";
import { applyShellOutputUpdate, OutputCapture } from "../../src/harness/utils/output-capture.ts";
import { createTempDir } from "./session-test-utils.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof childProcess>();
	return { ...original, spawn: vi.fn(original.spawn) };
});

class SpillEnv extends NodeExecutionEnv {
	readonly spillContexts: Context[] = [];

	override async createTempFile(_options: Parameters<NodeExecutionEnv["createTempFile"]>[0], context: Context) {
		this.spillContexts.push(context);
		const path = join(this.cwd, "spill.log");
		await writeFile(path, "");
		return { ok: true as const, value: path };
	}
}

async function collect(
	env: NodeExecutionEnv,
	command: string,
	options?: ShellExecOptions,
	context = BACKGROUND_CONTEXT,
) {
	let output: ShellOutputView | undefined;
	let updates = 0;
	const result = await env.exec(
		command,
		{
			...options,
			onUpdate: (update, context) => {
				updates++;
				output = applyShellOutputUpdate(output, update);
				options?.onUpdate?.(update, context);
			},
		},
		context,
	);
	return {
		result,
		output,
		get updates() {
			return updates;
		},
	};
}

function mockProcess(run: (child: ChildProcess, stdout: PassThrough, stderr: PassThrough) => void) {
	const child = new ChildProcess();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	child.stdout = stdout;
	child.stderr = stderr;
	vi.mocked(spawn).mockImplementationOnce(() => {
		setImmediate(() => run(child, stdout, stderr));
		return child;
	});
	return { child, stdout, stderr };
}

const captureOptions = { limits: { maxBytes: 1, maxLines: 10 }, spill: true };

afterEach(() => {
	vi.clearAllMocks();
});

describe("shell output finalization", () => {
	it("rejects input after finish", () => {
		const capture = new OutputCapture(undefined, BACKGROUND_CONTEXT, {
			onError: (error) => {
				throw error;
			},
		});
		capture.push("text");
		capture.finish();
		capture.finish();
		capture.push("late");
		expect(capture.snapshot().text).toBe("text");
		capture.dispose();
	});

	it("combines completed pipe text while preserving raw arrival order", async () => {
		const env = new SpillEnv({ cwd: createTempDir(), shellPath: process.execPath });
		mockProcess((child, stdout, stderr) => {
			stdout.emit("data", Buffer.from([0xe2]));
			stderr.emit("data", Buffer.from("WARN\n"));
			stdout.emit("data", Buffer.from([0x82, 0xac]));
			stderr.emit("end");
			stdout.emit("end");
			child.emit("exit", 0, null);
		});
		const collected = await collect(env, "ignored", {
			capture: { ...captureOptions, limits: { maxBytes: 100, maxLines: 1 } },
		});
		expect(getOrThrow(collected.result).exitCode).toBe(0);
		expect(collected.output?.text).toBe("€");
		expect(collected.output?.truncation.totalBytes).toBe(8);
		expect(await readFile(join(env.cwd, "spill.log"))).toEqual(
			Buffer.from([0xe2, ...Buffer.from("WARN\n"), 0x82, 0xac]),
		);
	});

	it.each(["success", "abort", "stream error", "spawn error"])(
		"archives EOF-only truncation before settling %s",
		async (mode) => {
			const env = new SpillEnv({ cwd: createTempDir(), shellPath: process.execPath });
			const controller = new AbortController();
			const streams = mockProcess((child, stdout, stderr) => {
				stdout.emit("data", Buffer.from([0xe2]));
				if (mode === "abort") controller.abort();
				if (mode === "stream error") stdout.destroy(new Error("read failed"));
				else if (mode === "spawn error") child.emit("error", new Error("spawn failed"));
				else {
					stdout.end();
					stderr.end();
					child.emit("exit", 0, null);
				}
			});
			const collected = await collect(
				env,
				"ignored",
				{ capture: captureOptions },
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			if (mode === "success") expect(getOrThrow(collected.result).exitCode).toBe(0);
			else
				expect(collected.result).toMatchObject({
					ok: false,
					error: { code: mode === "abort" ? "aborted" : "spawn_error" },
				});
			expect(collected.output?.truncation).toMatchObject({ totalBytes: 3, truncated: true });
			expect(collected.output?.spillPath).toBe(join(env.cwd, "spill.log"));
			expect(await readFile(join(env.cwd, "spill.log"))).toEqual(Buffer.from([0xe2]));
			expect(env.spillContexts).toHaveLength(1);
			expect(env.spillContexts[0]?.abortSignal?.aborted).not.toBe(true);
			const updates = collected.updates;
			streams.stdout.emit("data", Buffer.from("late"));
			streams.stderr.emit("end");
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(collected.updates).toBe(updates);
			expect(await readFile(join(env.cwd, "spill.log"))).toEqual(Buffer.from([0xe2]));
			expect(streams.stdout.destroyed).toBe(true);
			expect(streams.stderr.destroyed).toBe(true);
		},
	);

	it("preserves the chunk whose update callback fails", async () => {
		const env = new SpillEnv({ cwd: createTempDir(), shellPath: process.execPath });
		mockProcess((child, stdout, stderr) => {
			stdout.emit("data", Buffer.from("output"));
			stdout.emit("end");
			stderr.emit("end");
			child.emit("exit", 0, null);
		});
		const collected = await collect(env, "ignored", {
			capture: captureOptions,
			onUpdate: () => {
				throw new Error("consumer failed");
			},
		});
		expect(collected.result).toMatchObject({
			ok: false,
			error: { code: "callback_error", message: "consumer failed" },
		});
		expect(await readFile(join(env.cwd, "spill.log"), "utf8")).toBe("output");
	});

	it("drains paused output when cancellation arrives during spill creation", async () => {
		const env = new SpillEnv({ cwd: createTempDir(), shellPath: process.execPath });
		const controller = new AbortController();
		const createTempFile = env.createTempFile.bind(env);
		vi.spyOn(env, "createTempFile").mockImplementationOnce(async (options, context) => {
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 20));
			return createTempFile(options, context);
		});
		mockProcess((child, stdout, stderr) => {
			stdout.write("first");
			stdout.end("remaining");
			stderr.end();
			child.emit("exit", 0, null);
		});
		const collected = await collect(
			env,
			"ignored",
			{ capture: captureOptions },
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		);
		expect(collected.result).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(await readFile(join(env.cwd, "spill.log"), "utf8")).toBe("firstremaining");
	});

	it("handles simultaneous pipe errors without a second uncaught error", async () => {
		const env = new SpillEnv({ cwd: createTempDir(), shellPath: process.execPath });
		mockProcess((_child, stdout, stderr) => {
			stdout.destroy(new Error("stdout failed"));
			stderr.destroy(new Error("stderr failed"));
		});
		const collected = await collect(env, "ignored");
		expect(collected.result).toMatchObject({
			ok: false,
			error: { code: "spawn_error", message: "stdout failed" },
		});
	});

	it("publishes source EOF text before later output from the other pipe", async () => {
		const env = new SpillEnv({ cwd: createTempDir(), shellPath: process.execPath });
		mockProcess((child, stdout, stderr) => {
			stdout.emit("data", Buffer.from([0xe2]));
			stdout.emit("end");
			stderr.emit("data", Buffer.from("last"));
			stderr.emit("end");
			child.emit("exit", 0, null);
		});
		const collected = await collect(env, "ignored");
		expect(getOrThrow(collected.result).exitCode).toBe(0);
		expect(collected.output?.text).toBe("�last");
	});

	it("flushes pending text at the existing idle-descendant cutoff", async () => {
		const env = new SpillEnv({ cwd: createTempDir(), shellPath: process.execPath });
		const streams = mockProcess((child, stdout) => {
			stdout.emit("data", Buffer.from([0xe2]));
			child.emit("exit", 0, null);
		});
		const collected = await collect(env, "ignored", { capture: captureOptions });
		expect(getOrThrow(collected.result).truncation.totalBytes).toBe(3);
		expect(await readFile(join(env.cwd, "spill.log"))).toEqual(Buffer.from([0xe2]));
		expect(streams.stdout.destroyed).toBe(true);
		expect(streams.stderr.destroyed).toBe(true);
	});

	it.skipIf(process.platform === "win32")("preserves interleaved UTF-8 from a real child", async () => {
		const env = new SpillEnv({ cwd: createTempDir() });
		const collected = await collect(
			env,
			"printf '\\342'; sleep 0.05; printf 'WARN\\n' >&2; sleep 0.05; printf '\\202\\254'",
		);
		expect(getOrThrow(collected.result).exitCode).toBe(0);
		expect(collected.output?.text).toBe("WARN\n€");
	});

	it.skipIf(process.platform === "win32")(
		"continues reading active descendants beyond the idle grace period",
		async () => {
			const env = new SpillEnv({ cwd: createTempDir() });
			const script = join(env.cwd, "descendant.cjs");
			await writeFile(
				script,
				`const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', "process.stdout.write(Buffer.from([0xe2])); let n=0; const timer=setInterval(()=>{process.stderr.write('x'); if(++n===5){clearInterval(timer); process.stdout.write(Buffer.from([0x82,0xac]));}},40);"], {stdio:'inherit'}); child.unref();`,
			);
			const collected = await collect(env, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`);
			expect(getOrThrow(collected.result).exitCode).toBe(0);
			expect(collected.output?.text).toBe("xxxxx€");
		},
	);
});
