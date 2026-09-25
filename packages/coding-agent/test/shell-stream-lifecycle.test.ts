import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { spawn } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashTool, createLocalShellOperations } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

vi.mock("child_process", { spy: true });

afterEach(() => {
	vi.mocked(spawn).mockReset();
	vi.useRealTimers();
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

const interleaved: BashOperations = {
	exec: async (_command, _cwd, { onData }) => {
		onData(Buffer.from([0xe2]), "stdout");
		onData(Buffer.from("WARN\n"), "stderr");
		onData(Buffer.from([0x82, 0xac]), "stdout");
		return { exitCode: 0 };
	},
};

describe("legacy shell stream lifecycle", () => {
	it.each([createBashTool, createPowerShellTool])("keeps split stdout separate from stderr", async (factory) => {
		const tool = factory(process.cwd(), { operations: interleaved });
		expect(text(await tool.execute("split", { command: "unused" }))).toBe("WARN\n€");
	});

	it.each(["success", "failure", "abort"] as const)("publishes the EOF tail before %s settles", async (outcome) => {
		const updates: string[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from([0xe2]), "stdout");
				if (outcome !== "success") throw new Error(outcome === "abort" ? "aborted" : "failed");
				return { exitCode: 0 };
			},
		};
		const pending = createBashTool(process.cwd(), { operations }).execute(
			"eof",
			{ command: "unused" },
			undefined,
			(update) => updates.push(text(update)),
		);
		if (outcome === "success") expect(text(await pending)).toBe("�");
		else await expect(pending).rejects.toThrow(outcome === "abort" ? "Command aborted" : "failed");
		expect(updates.at(-1)).toBe("�");
	});

	it("flushes each source at its EOF without consuming another pipe's pending bytes", async () => {
		const output = new OutputAccumulator();
		output.append(Buffer.from([0xe2]), "stdout");
		output.append(Buffer.from([0xc2]), "stderr");
		output.end("stderr");
		expect(output.snapshot().content).toBe("�");
		output.append(Buffer.from([0x82, 0xac]), "stdout");
		output.end("stdout");
		output.finish();
		output.finish();
		expect(output.snapshot().content).toBe("�€");
		expect(output.snapshot().truncation.totalBytes).toBe(6);
	});

	it("spills the original bytes in callback order even when decoding completes in another order", async () => {
		const output = new OutputAccumulator({ maxBytes: 1 });
		const chunks = [Buffer.from([0xe2]), Buffer.from("W\0"), Buffer.from([0x82, 0xac, 0xff])];
		output.append(chunks[0], "stdout");
		output.append(chunks[1], "stderr");
		output.append(chunks[2], "stdout");
		output.finish();
		const snapshot = output.snapshot();
		await output.closeTempFile();
		try {
			expect(await readFile(snapshot.fullOutputPath!)).toEqual(Buffer.concat(chunks));
			expect(snapshot.truncation.totalBytes).toBe(8);
		} finally {
			await rm(snapshot.fullOutputPath!);
		}
	});

	it("creates a raw spill when only EOF decoding crosses the limit", async () => {
		const output = new OutputAccumulator({ maxBytes: 1 });
		output.append(Buffer.from([0xe2]), "stdout");
		expect(output.snapshot().fullOutputPath).toBeUndefined();
		output.finish();
		await output.closeTempFile();
		const snapshot = output.snapshot();
		try {
			expect(snapshot.truncation.totalBytes).toBe(3);
			expect(await readFile(snapshot.fullOutputPath!)).toEqual(Buffer.from([0xe2]));
		} finally {
			await rm(snapshot.fullOutputPath!);
		}
	});

	it("tags native pipe chunks and reports each source end exactly once", async () => {
		const operations = createLocalShellOperations("node", () => ({ shell: process.execPath, args: ["-e"] }));
		const chunks: Record<string, Buffer[]> = { stdout: [], stderr: [] };
		const ends: string[] = [];
		await operations.exec("process.stdout.write('out');process.stderr.write('err')", process.cwd(), {
			onData: (chunk, source) => chunks[source].push(chunk),
			onEnd: (source) => ends.push(source),
		});
		expect(Buffer.concat(chunks.stdout).toString()).toBe("out");
		expect(Buffer.concat(chunks.stderr).toString()).toBe("err");
		expect(ends.sort()).toEqual(["stderr", "stdout"]);
	});

	it.each(
		(["abort", "timeout"] as const).flatMap((cancellation) =>
			[false, true].map((exited) => ({ cancellation, exited })),
		),
	)(
		"stops inherited output on $cancellation after actual exit (already exited=$exited)",
		async ({ cancellation, exited }) => {
			vi.useFakeTimers();
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
			const operations = createLocalShellOperations("node", () => ({ shell: process.execPath, args: ["-e"] }));
			const controller = new AbortController();
			const ends: string[] = [];
			let settled = false;
			const pending = operations
				.exec("unused", process.cwd(), {
					onData: () => {},
					onEnd: (source) => ends.push(source),
					signal: controller.signal,
					timeout: cancellation === "timeout" ? 0.05 : undefined,
				})
				.catch((error: unknown) => {
					settled = true;
					return error;
				});
			await vi.waitFor(() => expect(child.listenerCount("exit")).toBe(1), { interval: 1 });
			if (exited) child.emit("exit", 0);
			child.stdout.write("inherited output");
			if (cancellation === "abort") controller.abort();
			await vi.advanceTimersByTimeAsync(50);
			if (!exited) {
				expect(settled).toBe(false);
				child.emit("exit", null);
			}
			for (let i = 0; i < 5; i++) {
				child.stderr.emit("data", Buffer.from("late"));
				await vi.advanceTimersByTimeAsync(50);
			}
			expect(settled).toBe(true);
			expect(await pending).toEqual(new Error(cancellation === "abort" ? "aborted" : "timeout:0.05"));
			expect(ends.sort()).toEqual(["stderr", "stdout"]);
			expect(child.stdout.destroyed).toBe(true);
			expect(child.stderr.destroyed).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("handles native read failures, flushes the received tail, and detaches callbacks", async () => {
		const failure = new Error("read failed");
		const operations = createLocalShellOperations("node", () => ({ shell: process.execPath, args: ["-e"] }));
		const updates: string[] = [];
		let child: ReturnType<typeof spawn> | undefined;
		const wrapped: BashOperations = {
			exec: (command, cwd, options) =>
				operations.exec(command, cwd, {
					...options,
					onData: (chunk, source) => {
						options.onData(chunk, source);
						// Windows cleanup also spawns taskkill; retain the execution child before injecting errors.
						child = vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<typeof spawn>;
						child.stdout!.emit("error", failure);
						child.stderr!.emit("error", failure);
					},
				}),
		};
		await expect(
			createBashTool(process.cwd(), { operations: wrapped }).execute(
				"read-error",
				{ command: "process.stdout.write(Buffer.from([0xe2]));setInterval(()=>{},1000)" },
				undefined,
				(update) => updates.push(text(update)),
			),
		).rejects.toBe(failure);
		expect(updates.at(-1)).toBe("�");
		const count = updates.length;
		child!.stdout!.emit("data", Buffer.from("late"));
		expect(updates).toHaveLength(count);
		expect(child!.stdout!.destroyed).toBe(true);
		expect(child!.stderr!.destroyed).toBe(true);
	});

	it.skipIf(process.platform !== "win32")(
		"decodes split native PowerShell pipe output and its incomplete EOF",
		async () => {
			const command =
				"$o=[Console]::OpenStandardOutput();$e=[Console]::OpenStandardError();$o.WriteByte(226);$o.Flush();Start-Sleep -Milliseconds 150;$b=[Text.Encoding]::UTF8.GetBytes('WARN'+[char]10);$e.Write($b,0,$b.Length);$e.Flush();Start-Sleep -Milliseconds 150;$o.WriteByte(130);$o.WriteByte(172);$o.WriteByte(226);$o.Flush()";
			const tool = createPowerShellTool(process.cwd());
			expect(text(await tool.execute("native-powershell", { command }))).toBe("WARN\n€�");
		},
	);
});

describe("interactive, SDK and RPC shell executor", () => {
	it("streams source-aware completed text", async () => {
		const chunks: string[] = [];
		const result = await executeBashWithOperations("unused", process.cwd(), interleaved, {
			onChunk: (chunk) => chunks.push(chunk),
		});
		expect(result.output).toBe("WARN\n€");
		expect(chunks.join("")).toBe(result.output);
	});

	it.each(["success", "failure", "abort"] as const)(
		"flushes EOF and rejects late callbacks after %s",
		async (outcome) => {
			const controller = new AbortController();
			const chunks: string[] = [];
			let saved: Parameters<BashOperations["exec"]>[2] | undefined;
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					saved = options;
					options.onData(Buffer.from([0xe2]), "stdout");
					if (outcome === "abort") controller.abort();
					if (outcome !== "success") throw new Error("execution failed");
					return { exitCode: 0 };
				},
			};
			const pending = executeBashWithOperations("unused", process.cwd(), operations, {
				signal: controller.signal,
				onChunk: (chunk) => chunks.push(chunk),
			});
			if (outcome === "failure") await expect(pending).rejects.toThrow("execution failed");
			else expect(await pending).toMatchObject({ output: "�", cancelled: outcome === "abort" });
			saved!.onData(Buffer.from("late"), "stderr");
			expect(chunks).toEqual(["�"]);
			saved!.onEnd("stdout");
			expect(chunks).toEqual(["�"]);
		},
	);

	it("preserves sanitized full logs and the default BOM policy", async () => {
		const content = `\uFEFF\u001b[31mred\u001b[0m\r\n\0${"x".repeat(52000)}`;
		const result = await executeBashWithOperations("unused", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(content), "stdout");
				onData(Buffer.from([0xe2]), "stdout");
				return { exitCode: 0 };
			},
		});
		try {
			expect(await readFile(result.fullOutputPath!, "utf8")).toBe(`red\n${"x".repeat(52000)}�`);
		} finally {
			await rm(result.fullOutputPath!);
		}
	});
});
