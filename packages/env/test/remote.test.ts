import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type FileChange, getOrThrow, type ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Connection, nodePlatform } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const context = BACKGROUND_CONTEXT;
const connections: Connection[] = [];
const dirs: string[] = [];
// Deleting the large listing and watch-overflow trees takes longer than the default hook timeout on Windows.
afterAll(() => {
	for (const connection of connections) connection.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 60_000);

function environment(): { env: RemoteExecutionEnv; connection: Connection } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-env-remote-"));
	dirs.push(cwd);
	const connection = new Connection({ command: [daemon] });
	connections.push(connection);
	return { env: new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd }), connection };
}

describe("RemoteExecutionEnv", () => {
	it("continues a full text read past the opening size when the file grew, like Node", async () => {
		const { env, connection } = environment();
		writeFileSync(join(env.cwd, "growing.txt"), "a".repeat(512 * 1024 + 1));
		const content = `\ufeff${"é".repeat(512 * 1024)}end`;
		const request = connection.request.bind(connection);
		const spy = vi.spyOn(connection, "request").mockImplementation(async (...args) => {
			const reply = await request(...args);
			if (args[0] === "open") writeFileSync(join(env.cwd, "growing.txt"), content);
			return reply;
		});
		try {
			expect(getOrThrow(await env.readTextFile("growing.txt", context))).toBe(content);
		} finally {
			spy.mockRestore();
		}
	});

	it("retries an aborted long-line read without losing buffered text or split UTF-8", async () => {
		const { env, connection } = environment();
		const first = `${"a".repeat(65_532)}é${"x".repeat(131_072)}\r`;
		const final = "é".repeat(65_536);
		getOrThrow(
			await env.writeFile(
				"lines.txt",
				Buffer.concat([Buffer.from(`\ufeff${first}\n\n${final}`), Buffer.from([0xe2, 0x82])]),
				context,
			),
		);
		const reader = getOrThrow(await env.openTextLineReader("lines.txt", context));
		const controller = new AbortController();
		const request = connection.request.bind(connection);
		let reads = 0;
		const spy = vi.spyOn(connection, "request").mockImplementation(async (...args) => {
			const reply = await request(...args);
			if (args[0] === "pread" && ++reads === 2) controller.abort();
			return reply;
		});
		try {
			expect(await reader.readLine(withAbortSignal(controller.signal, context))).toMatchObject({
				ok: false,
				error: { code: "aborted" },
			});
			expect(getOrThrow(await reader.readLine(context))).toEqual({ text: first, terminated: true });
			expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "", terminated: true });
			expect(getOrThrow(await reader.readLine(context))).toEqual({ text: `${final}\ufffd`, terminated: false });
			expect(getOrThrow(await reader.readLine(context))).toBeUndefined();
		} finally {
			spy.mockRestore();
			await reader.close(context);
		}
	});

	// https://github.com/earendil-works/pi/issues/10516
	it("reports overflow for an oversized watch change without losing the connection or watcher", async () => {
		const { env: base, connection } = environment();
		const env = new RemoteExecutionEnv({
			connection,
			id: base.id,
			cwd: base.cwd,
			watch: { mode: "polling", pollIntervalMs: 200 },
		});
		const watched = join(env.cwd, "watched");
		const staged = join(env.cwd, "staged");
		const windows = process.platform === "win32";
		const directory = "d".repeat(windows ? 10 : 180);
		const leaf = join(staged, directory, directory);
		mkdirSync(watched);
		mkdirSync(leaf, { recursive: true });
		// On POSIX, escaping makes the JSON exceed the budget even though the raw paths fit.
		// On Windows, multibyte names exceed the frame budget without crossing legacy path-length limits.
		const suffix = windows
			? "漢".repeat(Math.min(180, 240 - join(watched, directory, directory, "000000").length))
			: `${"\x01".repeat(220)}é`;
		const sample = join(watched, directory, directory, `000000${suffix}`);
		const frameLimit = 16 * 1024 * 1024;
		const count = Math.ceil(frameLimit / (Buffer.byteLength(JSON.stringify(sample)) + 1)) + 100;
		const paths: string[] = [];
		for (let index = 0; index < count; index++) {
			const name = `${index}`.padStart(6, "0") + suffix;
			writeFileSync(join(leaf, name), "");
			paths.push(join(watched, directory, directory, name));
		}
		expect(Buffer.byteLength(JSON.stringify({ kind: "change", paths }))).toBeGreaterThan(frameLimit);
		if (!windows) {
			expect(paths.reduce((bytes, path) => bytes + Buffer.byteLength(path), 0)).toBeLessThan(frameLimit);
		}
		const changes: FileChange[] = [];
		const watcher = getOrThrow(
			await env.watch([{ path: watched, recursive: true }], (change) => changes.push(change), context),
		);
		const { pid } = await connection.info();
		try {
			renameSync(join(staged, directory), join(watched, directory));
			getOrThrow(await env.fileInfo(sample, withAbortSignal(AbortSignal.timeout(5000), context)));
			await expect.poll(() => changes.some((change) => change.kind === "overflow"), { timeout: 15_000 }).toBe(true);
			expect(watcher.mode).toBe("polling");
			getOrThrow(await env.fileInfo(watched, withAbortSignal(AbortSignal.timeout(5000), context)));
			expect((await connection.info()).pid).toBe(pid);
			const followup = join(watched, "followup.txt");
			writeFileSync(followup, "still watching");
			await expect
				.poll(() => changes.some((change) => change.kind === "paths" && change.paths.includes(followup)), {
					timeout: 15_000,
				})
				.toBe(true);
		} finally {
			// Closing the transport also releases a stalled pre-fix watch request.
			connection.close();
			await watcher.stop(context);
		}
	}, 60_000);

	it("transfers only about a window of output a caller keeps, with exact counts", async () => {
		const { env } = environment();
		const total = 5_000_000;
		let delivered = 0;
		let skipped = 0;
		let tail = "";
		const result = await env.exec(
			["sh", "-c", `yes 0123456789abcdef | head -c ${total}`],
			{
				window: { maxBytes: 1000, maxLines: 20, minIntervalMs: 20, bytesPerSecond: 1_000_000 },
				onOutput: (text: string, _context, info: ShellOutputInfo) => {
					delivered += Buffer.byteLength(text);
					if (info.skipped) {
						skipped += info.skipped.bytes;
						tail = "";
					}
					tail += text;
				},
			},
			context,
		);
		expect(getOrThrow(result).exitCode).toBe(0);
		expect(delivered + skipped).toBe(total);
		expect(skipped).toBeGreaterThan(0);
		expect(delivered).toBeLessThan(total / 10);
		// After the last skip comes everything to the end, more than the window.
		const full = "0123456789abcdef\n".repeat(Math.ceil(total / 17)).slice(0, total);
		expect(full.endsWith(tail)).toBe(true);
		expect(tail.length > 1000 || tail.split("\n").length - 1 > 20).toBe(true);
	}, 60_000);

	it("aborts commands cancelled right after they are sent", async () => {
		const { env } = environment();
		const started = Date.now();
		for (let attempt = 0; attempt < 20; attempt++) {
			const controller = new AbortController();
			const running = env.exec(["sleep", "5"], undefined, withAbortSignal(controller.signal, context));
			if (attempt % 2 === 0) controller.abort();
			else setTimeout(() => controller.abort(), attempt % 5);
			const result = await running;
			expect(result.ok ? "ok" : result.error.code).toBe("aborted");
		}
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 30_000);

	it("reports the remote system in Node's names", async () => {
		const { connection } = environment();
		const { platform, arch } = nodePlatform(await connection.info());
		expect(platform).toBe(process.platform);
		// CI runs the darwin-x64 release daemon on arm64 macOS through Rosetta, so it reports x64 to arm64 Node.
		const rosetta = process.platform === "darwin" && process.arch === "arm64" && arch === "x64";
		if (!rosetta) expect(arch).toBe(process.arch);
		expect(nodePlatform({ os: "windows", arch: "aarch64" })).toEqual({ platform: "win32", arch: "arm64" });
		expect(nodePlatform({ os: "macos", arch: "x86_64" })).toEqual({ platform: "darwin", arch: "x64" });
	});

	it("reports listFiles as not supported by daemons released before it", async () => {
		const { env } = environment();
		expect((await env.connection.info()).features).toContain("listFiles");
		const connection = new Connection({ command: [process.execPath, join(import.meta.dirname, "old-daemon.ts")] });
		connections.push(connection);
		const old = new RemoteExecutionEnv({ connection, id: "pi-env:old", cwd: env.cwd });
		const listed = await old.listFiles(".", undefined, context);
		expect(listed.ok ? "ok" : listed.error.code).toBe("not_supported");
	});

	it("cancels a listing in the daemon", async () => {
		const { env, connection } = environment();
		for (let dir = 0; dir < 100; dir++) {
			mkdirSync(join(env.cwd, `d${dir}`));
			for (let file = 0; file < 100; file++) writeFileSync(join(env.cwd, `d${dir}`, `f${file}`), "");
		}
		// The cancel follows the request at once, bypassing the client's own abort check, so the daemon stops the walk.
		const controller = new AbortController();
		controller.abort();
		const cancelled = connection.request("listFiles", { path: env.cwd }, { signal: controller.signal });
		await expect(cancelled).rejects.toMatchObject({ code: "aborted" });
		const listed = getOrThrow(await env.listFiles(".", undefined, context));
		expect([listed.entries.length, listed.truncated]).toEqual([10_100, false]);
		const bounded = getOrThrow(await env.listFiles(".", { maxEntries: 5000 }, context));
		expect([bounded.entries.length, bounded.truncated]).toEqual([5000, true]);
		// Creating 10,000 files takes several seconds on Windows CI.
	}, 30_000);

	it("times out a command that produces no output", async () => {
		const { env } = environment();
		const started = Date.now();
		const result = await env.exec(["sleep", "5"], { timeout: 0.3 }, context);
		expect(result.ok ? "ok" : result.error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	// The daemon used to die on Connection.close()'s SIGTERM before killing its commands.
	it.skipIf(process.platform === "win32")("kills running commands when the connection closes", async () => {
		const { env, connection } = environment();
		const pid = Promise.withResolvers<number>();
		const running = env.exec(
			["sh", "-c", "echo $$; exec sleep 30"],
			{ onOutput: (text: string) => pid.resolve(Number.parseInt(text, 10)) },
			context,
		);
		const command = await pid.promise;
		connection.close();
		await running;
		const alive = () => {
			try {
				process.kill(command, 0);
				return true;
			} catch {
				return false;
			}
		};
		const deadline = Date.now() + 5000;
		while (alive() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
		expect(alive()).toBe(false);
	});

	it("fails requests on handles of a lost connection instead of reaching the new daemon", async () => {
		const { env, connection } = environment();
		getOrThrow(await env.writeFile("a.txt", "AAA", context));
		getOrThrow(await env.writeFile("b.txt", "BBB", context));
		const a = getOrThrow(await env.openBinaryReader("a.txt", undefined, context));
		const { pid } = await connection.info();
		process.kill(pid, "SIGKILL");
		await new Promise((done) => setTimeout(done, 300));
		// The new daemon numbers its handles from 1 again.
		const b = getOrThrow(await env.openBinaryReader("b.txt", undefined, context));
		expect((await connection.info()).pid).not.toBe(pid);
		const stale = await a.read(0, 3, context);
		expect(stale.ok ? new TextDecoder().decode(stale.value) : stale.error.code).toBe("unknown");
		expect(new TextDecoder().decode(getOrThrow(await b.read(0, 3, context)))).toBe("BBB");
		await a.close(context);
		await b.close(context);
	});

	it("computes the command at each start and retries a start that failed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-env-remote-"));
		dirs.push(cwd);
		let starts = 0;
		const connection = new Connection({
			command: async () => {
				starts++;
				if (starts === 1) throw new Error("ssh gpu-box failed: Network is unreachable");
				return [daemon];
			},
		});
		connections.push(connection);
		const env = new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd });
		const offline = await env.readTextFile("missing.txt", context);
		expect(offline.ok ? "ok" : [offline.error.code, offline.error.message]).toEqual([
			"unknown",
			"ssh gpu-box failed: Network is unreachable",
		]);
		const command = await env.exec(["sh", "-c", "exit 0"], undefined, context);
		expect(command.ok ? command.value.exitCode : command.error.code).toBe(0);
		expect(starts).toBe(2);
	});

	it("writes and reads files larger than one transfer chunk in order", async () => {
		const { env } = environment();
		const content = new Uint8Array(3_500_017);
		for (let index = 0; index < content.length; index++) content[index] = (index * 7919) % 251;
		getOrThrow(await env.writeFile("big.bin", content, context));
		getOrThrow(await env.appendFile("big.bin", content, context));
		const read = getOrThrow(await env.readBinaryFile("big.bin", context));
		expect(read.length).toBe(content.length * 2);
		expect(Buffer.compare(Buffer.from(read.subarray(0, content.length)), Buffer.from(content))).toBe(0);
		expect(Buffer.compare(Buffer.from(read.subarray(content.length)), Buffer.from(content))).toBe(0);
		const reader = getOrThrow(await env.openBinaryReader("big.bin", undefined, context));
		const range = getOrThrow(await reader.read(1_000_003, 2_000_000, context));
		await reader.close(context);
		expect(Buffer.compare(Buffer.from(range), Buffer.from(read.subarray(1_000_003, 3_000_003)))).toBe(0);
	}, 60_000);
});
