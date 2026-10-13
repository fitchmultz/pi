import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

const createWriteStream = fs.createWriteStream;
let directory: string;
const spills: fs.WriteStream[] = [];

function quote(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

function producer(source: string): string {
	return `${quote(process.execPath)} -e ${quote(source)}`;
}

function spillSink(delay: number, fail = false): () => number {
	let maximumQueued = 0;
	vi.spyOn(fs, "createWriteStream").mockImplementation((path, options) => {
		const stream = createWriteStream(path, options);
		spills.push(stream);
		const write = stream._write.bind(stream);
		const writev = stream._writev!.bind(stream);
		vi.spyOn(stream, "_write").mockImplementation((chunk, encoding, callback) => {
			setTimeout(() => {
				maximumQueued = Math.max(maximumQueued, stream.writableLength);
				if (fail) callback(new Error("spill ENOSPC fixture"));
				else write(chunk, encoding, callback);
			}, delay);
		});
		vi.spyOn(stream, "_writev").mockImplementation((chunks, callback) => {
			setTimeout(() => {
				maximumQueued = Math.max(maximumQueued, stream.writableLength);
				if (fail) callback(new Error("spill ENOSPC fixture"));
				else writev(chunks, callback);
			}, delay);
		});
		return stream;
	});
	syncBuiltinESMExports();
	return () => maximumQueued;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), "pi-native-spill-test-"));
});

afterEach(async () => {
	for (const stream of spills.splice(0)) {
		if (!stream.closed) {
			const completed = finished(stream, { cleanup: true });
			stream.end();
			await completed.catch(() => {});
		}
		fs.rmSync(String(stream.path), { force: true });
	}
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe("native Bash spill backpressure", () => {
	it.each(["tool", "executor"] as const)(
		"preserves all %s bytes with bounded slow-file queuing and a closed result",
		async (owner) => {
			const maximumQueued = spillSink(10);
			const rows = Array.from({ length: 65536 }, (_, index) => `${String(index).padStart(6, "0")}abcdefghij\n`);
			const expected = `BEGIN\n${rows.join("")}END\n`;
			const input = join(directory, "input");
			fs.writeFileSync(input, expected);
			const command = producer(`require('fs').createReadStream(${JSON.stringify(input)}).pipe(process.stdout)`);
			let path: string;
			if (owner === "tool") {
				const result = await createBashTool(directory).execute("spill", { command });
				path = result.details!.fullOutputPath!;
				expect(result.structuredContent).toMatchObject({
					exit_code: 0,
					truncated: true,
					full_output_path: path,
					output: `${expected.slice(0, 524288)}\n\n[... 65546 bytes omitted ...]\n\n${expected.slice(-524288)}`,
				});
				expect(result.details!.truncation).toMatchObject({
					totalBytes: 1114122,
					totalLines: 65538,
					outputLines: 2000,
				});
			} else {
				const result = await executeBashWithOperations(command, directory, createLocalBashOperations());
				path = result.fullOutputPath!;
				expect(result).toMatchObject({ exitCode: 0, cancelled: false, truncated: true });
				expect(result.output).toBe(`${rows.slice(-1999).join("")}END`);
			}
			expect(fs.readFileSync(path, "utf8")).toBe(expected);
			// The budget is independent of total output size and allows two OS pipe chunks at spill creation.
			expect(maximumQueued()).toBeLessThanOrEqual(262144);
			expect(spills.every((stream) => stream.closed && stream.writableFinished)).toBe(true);
		},
	);

	it("preserves each pipe's byte order when stdout and stderr share a slow spill", async () => {
		const maximumQueued = spillSink(10);
		const stdout = Array.from({ length: 32768 }, (_, index) => String(index).padStart(6, "0")).join("");
		const stderr = stdout.replace(/\d/g, (digit) => String.fromCharCode(65 + Number(digit)));
		const stdoutPath = join(directory, "stdout");
		const stderrPath = join(directory, "stderr");
		fs.writeFileSync(stdoutPath, stdout);
		fs.writeFileSync(stderrPath, stderr);
		const result = await createBashTool(directory).execute("both-pipes", {
			command: producer(
				`require('fs').createReadStream(${JSON.stringify(stdoutPath)}).pipe(process.stdout);require('fs').createReadStream(${JSON.stringify(stderrPath)}).pipe(process.stderr)`,
			),
		});
		const combined = fs.readFileSync(result.details!.fullOutputPath!, "utf8");
		expect(combined.replace(/[A-J]/g, "")).toBe(stdout);
		expect(combined.replace(/\d/g, "")).toBe(stderr);
		expect(maximumQueued()).toBeLessThanOrEqual(262144);
	});

	it("drains a slow final spill after the child exits without invoking the orphan-stdio cutoff", async () => {
		spillSink(150);
		const expected = `${"last chunk\n".repeat(20000)}END\n`;
		const input = join(directory, "input");
		fs.writeFileSync(input, expected);
		const result = await createBashTool(directory).execute("final-drain", {
			command: producer(`require('fs').createReadStream(${JSON.stringify(input)}).pipe(process.stdout)`),
		});
		expect(fs.readFileSync(result.details!.fullOutputPath!, "utf8")).toBe(expected);
		expect(result.structuredContent).toMatchObject({ output: expected, exit_code: 0, truncated: false });
	});

	it("retains literal raw binary bytes while decoding the structured result", async () => {
		spillSink(5);
		const input = join(directory, "binary");
		const expected = Buffer.concat([
			Buffer.from("row\n".repeat(20000)),
			Buffer.from([0xff, 0, 0xe2, 0x82, 0xac, 10]),
		]);
		fs.writeFileSync(input, expected);
		const result = await createBashTool(directory).execute("binary", {
			command: producer(
				`require('fs').createReadStream(${JSON.stringify(input)}, {highWaterMark:8191}).pipe(process.stdout)`,
			),
		});
		expect(fs.readFileSync(result.details!.fullOutputPath!)).toEqual(expected);
		expect(result.structuredContent).toMatchObject({ output: `${"row\n".repeat(20000)}�\0€\n`, truncated: false });
	});

	it.each(["tool", "executor"] as const)(
		"reaps an aborted %s producer, closes its partial spill and permits recovery",
		async (owner) => {
			spillSink(10);
			const controller = new AbortController();
			let collectedBytes = 0;
			const pidPath = join(directory, "producer.pid");
			const input = join(directory, "input");
			const expected = "cancel row\n".repeat(200000);
			fs.writeFileSync(input, expected);
			const command = producer(
				`require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));require('fs').createReadStream(${JSON.stringify(input)}).pipe(process.stdout);setInterval(()=>{},1000);`,
			);
			const abortOnSpill = () => {
				if (spills.length > 0) controller.abort();
			};
			const timer = setInterval(abortOnSpill, 1);
			try {
				if (owner === "tool") {
					await expect(
						createBashTool(directory).execute("cancel", { command }, controller.signal, (update) => {
							collectedBytes = update.details?.truncation?.totalBytes ?? collectedBytes;
						}),
					).rejects.toThrow("Command aborted");
				} else {
					const result = await executeBashWithOperations(command, directory, createLocalBashOperations(), {
						signal: controller.signal,
						onChunk: (chunk) => {
							collectedBytes += Buffer.byteLength(chunk);
						},
					});
					expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
				}
			} finally {
				clearInterval(timer);
				controller.abort();
			}
			const pid = Number(fs.readFileSync(pidPath, "utf8"));
			await expect.poll(() => processExists(pid)).toBe(false);
			const path = String(spills[0].path);
			const partial = fs.readFileSync(path);
			expect(partial.length).toBe(collectedBytes);
			expect(partial.length).toBeGreaterThan(0);
			expect(partial.length).toBeLessThan(Buffer.byteLength(expected));
			expect(partial).toEqual(Buffer.from(expected).subarray(0, partial.length));
			expect(spills[0].closed).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(fs.statSync(path).size).toBe(partial.length);
			const recovery = await createBashTool(directory).execute("recovery", { command: "printf recovered" });
			expect(recovery.structuredContent).toMatchObject({ output: "recovered", exit_code: 0 });
		},
	);

	it.each(["tool", "executor"] as const)("fails a %s spill truthfully and reaps its producer", async (owner) => {
		spillSink(5, true);
		const controller = new AbortController();
		const pidPath = join(directory, "producer.pid");
		const command = producer(
			`require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdout.write('failed row\\n'.repeat(5000));setInterval(()=>{},1000);`,
		);
		const result =
			owner === "tool"
				? createBashTool(directory).execute("fail", { command }, controller.signal)
				: executeBashWithOperations(command, directory, createLocalBashOperations(), { signal: controller.signal });
		// Bound a broken fixture without letting cancellation masquerade as autonomous sink-error cleanup.
		const guard = setTimeout(() => controller.abort(), 1000);
		try {
			await expect(result).rejects.toThrow("spill ENOSPC fixture");
			expect(controller.signal.aborted).toBe(false);
		} finally {
			clearTimeout(guard);
			controller.abort();
		}
		await expect.poll(() => processExists(Number(fs.readFileSync(pidPath, "utf8")))).toBe(false);
		expect(spills.every((stream) => stream.closed && !stream.writableFinished)).toBe(true);
	});

	it.skipIf(process.platform === "win32").each(["symlink", "hardlink"] as const)(
		"never overwrites a spill-path %s alias",
		async (alias) => {
			const target = join(directory, "private-existing");
			fs.writeFileSync(target, "DO NOT OVERWRITE\n", { mode: 0o600 });
			vi.spyOn(fs, "createWriteStream").mockImplementation((path, options) => {
				if (alias === "symlink") fs.symlinkSync(target, String(path));
				else fs.linkSync(target, String(path));
				const stream = createWriteStream(path, options);
				spills.push(stream);
				return stream;
			});
			syncBuiltinESMExports();
			await expect(
				createBashTool(directory).execute("alias", {
					command: producer("process.stdout.write('private row\\n'.repeat(10000))"),
				}),
			).rejects.toThrow(/EEXIST/);
			expect(fs.readFileSync(target, "utf8")).toBe("DO NOT OVERWRITE\n");
			expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		},
	);
});
