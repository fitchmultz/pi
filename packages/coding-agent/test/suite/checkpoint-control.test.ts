import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { startCheckpointControl } from "../../src/cli/checkpoint-control.ts";
import { getRestartArgs } from "../../src/cli/restart-worker.ts";
import { readSessionCheckpoint } from "../../src/core/checkpoint.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const sockets: Socket[] = [];
const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const close of closers.splice(0)) close();
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-ckpt-"));
	directories.push(directory);
	chmodSync(directory, 0o700);
	const h = await createHarness({ sessionManager: SessionManager.create(directory, join(directory, "sessions")) });
	harnesses.push(h);
	const releaseInput = vi.fn();
	const socketPath = join(directory, "s");
	closers.push(
		await startCheckpointControl({ path: socketPath, getSession: () => h.session, quiesce: () => releaseInput }),
	);
	const socket = connect(socketPath);
	sockets.push(socket);
	socket.setEncoding("utf8");
	let buffer = "";
	const lines: Array<Record<string, unknown>> = [];
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop()!;
		for (const part of parts) lines.push(JSON.parse(part) as Record<string, unknown>);
	});
	const next = async () => {
		await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
		return lines.shift()!;
	};
	return {
		h,
		directory,
		releaseInput,
		socket,
		socketPath,
		next,
		send: (request: object) => socket.write(`${JSON.stringify(request)}\n`),
	};
}

describe.skipIf(process.platform === "win32")("native checkpoint local control", () => {
	it("parses cold restore without a prompt and removes it from later managed restarts", () => {
		const args = ["--checkpoint", "/private/checkpoint.json", "-ne"];
		expect(parseArgs(args)).toMatchObject({ checkpoint: "/private/checkpoint.json", messages: [], diagnostics: [] });
		expect(parseArgs(["--checkpoint"]).diagnostics).toHaveLength(1);
		expect(getRestartArgs(args)).toEqual(["-ne"]);
	});

	it("keeps a qualified settled hold until explicit release", async () => {
		const f = await setup();
		await f.h.session.steer("accepted queue");
		f.send({ action: "acquire", path: join(f.directory, "checkpoint.json"), boundary: "settled" });
		const receipt = await f.next();
		expect(receipt).toMatchObject({
			ok: true,
			pid: process.pid,
			boundary: "settled",
			settled: true,
			sleepReady: true,
			sleepBlockers: [],
		});
		expect(f.h.session.isCheckpointHeld).toBe(true);
		expect(f.releaseInput).not.toHaveBeenCalled();
		expect(readSessionCheckpoint(join(f.directory, "checkpoint.json")).queues.steering).toHaveLength(1);
		expect(statSync(join(f.directory, "checkpoint.json")).mode & 0o777).toBe(0o600);
		expect(statSync(f.socketPath).mode & 0o777).toBe(0o600);
		f.send({ action: "release", token: "wrong" });
		expect(await f.next()).toMatchObject({ ok: false });
		expect(f.h.session.isCheckpointHeld).toBe(true);
		f.send({ action: "release", token: receipt.token });
		expect(await f.next()).toMatchObject({ ok: true, released: true });
		expect(f.releaseInput).toHaveBeenCalledOnce();
		expect(f.h.session.getSteeringMessages()).toEqual(["accepted queue"]);
	});

	it("failed writes release the process; disconnect releases a later successful capture", async () => {
		const f = await setup();
		await f.h.session.followUp("retained");
		f.send({ action: "acquire", path: join(f.directory, "missing", "checkpoint.json") });
		expect(await f.next()).toMatchObject({ ok: false });
		expect(f.h.session.isCheckpointHeld).toBe(false);
		expect(f.releaseInput).toHaveBeenCalledOnce();
		f.send({ action: "acquire", path: join(f.directory, "checkpoint.json") });
		expect(await f.next()).toMatchObject({ ok: true });
		f.socket.destroy();
		await vi.waitFor(() => expect(f.h.session.isCheckpointHeld).toBe(false));
		expect(f.releaseInput).toHaveBeenCalledTimes(2);
		expect(f.h.session.getFollowUpMessages()).toEqual(["retained"]);
	});

	it("reports invalidation when session disposal interrupts an acquired hold", async () => {
		const f = await setup();
		f.send({ action: "acquire", path: join(f.directory, "checkpoint.json") });
		expect(await f.next()).toMatchObject({ ok: true });
		f.h.session.dispose();
		expect(await f.next()).toMatchObject({ ok: false, invalidated: true });
		expect(f.releaseInput).toHaveBeenCalledOnce();
	});
});
