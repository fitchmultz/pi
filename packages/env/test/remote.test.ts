import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type ShellOutputInfo, type WatchChange } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const context = BACKGROUND_CONTEXT;
const connections: Connection[] = [];
const dirs: string[] = [];
afterAll(() => {
	for (const connection of connections) connection.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

function environment(): { env: RemoteExecutionEnv; connection: Connection } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-env-remote-"));
	dirs.push(cwd);
	const connection = new Connection({ command: [daemon] });
	connections.push(connection);
	return { env: new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd }), connection };
}

describe("RemoteExecutionEnv", () => {
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
		const changes: WatchChange[] = [];
		const watcher = getOrThrow(
			await env.watch([{ path: watched, recursive: true }], (change) => changes.push(change), context),
		);
		const { pid } = await connection.info();
		try {
			renameSync(join(staged, directory), join(watched, directory));
			getOrThrow(await env.fileInfo(sample, withAbortSignal(AbortSignal.timeout(5000), context)));
			await expect
				.poll(() => changes.some((change) => "overflow" in change && change.overflow), { timeout: 15_000 })
				.toBe(true);
			expect(watcher.mode).toBe("polling");
			getOrThrow(await env.fileInfo(watched, withAbortSignal(AbortSignal.timeout(5000), context)));
			expect((await connection.info()).pid).toBe(pid);
			const followup = join(watched, "followup.txt");
			writeFileSync(followup, "still watching");
			await expect
				.poll(() => changes.some((change) => "paths" in change && change.paths.includes(followup)), {
					timeout: 15_000,
				})
				.toBe(true);
		} finally {
			// Closing the transport also releases a stalled pre-fix watch request.
			connection.close();
			await watcher.close(context);
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

	it("times out a command that produces no output", async () => {
		const { env } = environment();
		const started = Date.now();
		const result = await env.exec(["sleep", "5"], { timeout: 0.3 }, context);
		expect(result.ok ? "ok" : result.error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(3000);
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
