// The server process's start: a start that fails exits with its error even while a launcher's /health poll and a
// page's reconnect wait for it, and a signal while it starts closes it once started, so its exit hooks free the data
// directory's lock for the next start. Real server processes on loopback ports; disposable data, fake provider.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { poll } from "./helpers.ts";

it("a start that fails exits with its error while a readiness poll and a reconnect wait for it", async (t) => {
	const port = await freePort();
	const dataDir = mkdtempSync(join(tmpdir(), "p2-failed-start-"));
	const server = spawn(process.execPath, ["--import", SOURCE, "--input-type=module", "--eval", FAILING_START], {
		env: { ...process.env, PORT: String(port), P2_DATA_DIR: dataDir },
		stdio: ["ignore", "ignore", "pipe"],
	});
	// One hook, as a hook that fails skips the later ones: the server has exited before its data directory goes.
	t.after(async () => {
		await stopped(server);
		rmSync(dataDir, { recursive: true, force: true });
	});
	let stderr = "";
	server.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exited = once(server, "exit");
	// Both accepted while the plugins load.
	const readiness = await accepted(port, "/health", {});
	t.after(() => readiness.destroy());
	const reconnect = await accepted(port, "/chord", {
		Connection: "Upgrade",
		Upgrade: "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key": randomBytes(16).toString("base64"),
	});
	t.after(() => reconnect.destroy());
	const waited = delay(10_000, ["still running while its clients wait"], { ref: false });
	const [code] = await Promise.race([exited, waited]);
	assert.equal(code, 1, `exit: ${code}\n${stderr}`);
	assert.match(stderr, /"Not An Npm Name" is not a valid plugin name/);
});

it("a signal while the server starts closes it once started, and the next start takes its data directory", async (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "p2-signalled-start-"));
	const servers: ChildProcess[] = [];
	// One hook, as a hook that fails skips the later ones: the servers have exited before their data directory goes.
	t.after(async () => {
		for (const server of servers) await stopped(server);
		rmSync(dataDir, { recursive: true, force: true });
	});
	const first = serve(await freePort(), dataDir);
	servers.push(first.process);
	const exited = once(first.process, "exit");
	// The port accepts before the plugins load: the start is still running.
	(await accepted(first.port, "/health", {})).destroy();
	assert.equal(first.started(), false, "the start finished before the signal");
	first.process.kill("SIGTERM");
	const [code, signal] = await exited;
	assert.deepEqual({ code, signal, started: first.started() }, { code: 0, signal: null, started: true }, first.log());
	const next = serve(await freePort(), dataDir);
	servers.push(next.process);
	await poll(() => next.started() || next.process.exitCode !== null, 30_000, "the next start");
	assert.ok(next.started(), next.log());
	const closed = once(next.process, "exit");
	next.process.kill("SIGTERM");
	assert.deepEqual(await closed, [0, null]);
});

const SOURCE = new URL("../../src/source.ts", import.meta.url).href;

/**
 * A server on `PORT` with `P2_DATA_DIR` whose load fails after it listens: a core facet's name is no npm name, which
 * fails the load as a required plugin that fails does.
 */
const FAILING_START = `
import { startServer } from ${JSON.stringify(new URL("../../src/hosts/server.ts", import.meta.url).href)};
import { defineFacet } from ${JSON.stringify(new URL("../../src/runtime/chord.ts", import.meta.url).href)};
await startServer({
	port: Number(process.env.PORT),
	dataDir: process.env.P2_DATA_DIR,
	fake: true,
	web: false,
	plugins: [],
	facets: [{ name: "Not An Npm Name", facet: defineFacet(() => {}) }],
});
`;

/** The server entry as `npm start` runs it (every plugin), on `port` with `dataDir`. */
function serve(port: number, dataDir: string) {
	const entry = fileURLToPath(new URL("../../src/hosts/server.ts", import.meta.url));
	const server = spawn(process.execPath, ["--import", SOURCE, entry], {
		env: { ...process.env, PORT: String(port), P2_DATA_DIR: dataDir, P2_FAKE: "1", P2_RADIUS: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	const append = (chunk: Buffer) => {
		log += chunk.toString();
	};
	server.stdout.on("data", append);
	server.stderr.on("data", append);
	return { process: server, port, started: () => log.includes(`p2: http://127.0.0.1:${port} `), log: () => log };
}

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}

/** Kills `child` unless it has exited, and waits until it has. */
async function stopped(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

/** A GET of `path`, sent once `port` accepts connections, still waiting for its answer. */
async function accepted(port: number, path: string, headers: Record<string, string>) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const attempt = request({ host: "127.0.0.1", port, path, headers });
		const connected = await new Promise<boolean>((resolve) => {
			attempt.on("socket", (socket) => socket.once("connect", () => resolve(true)));
			attempt.on("error", () => resolve(false));
			attempt.end();
		});
		if (connected) return attempt;
		await delay(10);
	}
	throw new Error(`nothing accepted connections on port ${port}`);
}
