// Closing an archived session's terminals (`TerminalService.closeSession`): no host is started when none runs, and a
// host running older code, which does not know `closeSession`, has them closed with the viewer protocol (list, then
// attach and force-close each). A viewer's socket gets what its view's host connection sent before the socket was
// bound (an older host's notice), never what an ended connection sent. The hosts here are fakes speaking the protocol.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import {
	connectRunningTerminalHost,
	terminalHostAddress,
	terminalHostVersion,
} from "../../plugins/terminals/detached.ts";
import {
	encodeFrame,
	readFrames,
	type TerminalEvent,
	type TerminalInfo,
	type TerminalRequest,
} from "../../plugins/terminals/protocol.ts";
import { TerminalService, type TerminalView } from "../../plugins/terminals/service.ts";
import { APP, poll } from "./helpers.ts";

const terminal = (id: string, sessionId: string): TerminalInfo => ({
	id,
	sessionId,
	index: 0,
	cwd: "/",
	env: null,
	title: "",
	createdAt: 0,
	cols: 80,
	rows: 24,
});

test("closing a session starts no host, and closes an outdated host's terminals as the panel does", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-terminal-service-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const service = new TerminalService(directory, APP);
	t.after(() => service.close());

	// No host runs: nothing to close, and none is started.
	await service.closeSession("s1");
	assert.equal(await connectRunningTerminalHost(directory), undefined);

	// A host running older code: it only knows the viewer requests.
	const terminals = [terminal("a", "s1"), terminal("b", "s1"), terminal("c", "s2")];
	const requests: TerminalRequest[] = [];
	const host = createServer((socket: Socket) => {
		let attached: string | undefined;
		socket.write(encodeFrame({ type: "hello", version: "older", running: terminals.length, pid: 1 }));
		readFrames(socket, (frame) => {
			const request = frame as TerminalRequest;
			requests.push(request);
			if (request.type === "list")
				socket.write(
					encodeFrame({
						type: "list",
						terminals: terminals.filter((each) => each.sessionId === request.sessionId),
					}),
				);
			else if (request.type === "attach") attached = request.terminalId;
			else if (request.type === "close" && request.force && attached) {
				terminals.splice(
					terminals.findIndex((each) => each.id === attached),
					1,
				);
				socket.write(encodeFrame({ type: "closed", terminalId: attached }));
				attached = undefined;
			} else socket.write(encodeFrame({ type: "error", message: "Unknown request" }));
		});
	});
	const address = await terminalHostAddress(directory);
	await new Promise<void>((resolve) => host.listen(address, resolve));
	t.after(() => new Promise<void>((resolve) => host.close(() => resolve())));
	await service.closeSession("s1");
	assert.deepEqual(requests, [
		{ type: "list", sessionId: "s1" },
		{ type: "attach", terminalId: "a" },
		{ type: "close", force: true },
		{ type: "attach", terminalId: "b" },
		{ type: "close", force: true },
	]);
	assert.deepEqual(
		terminals.map((each) => each.id),
		["c"],
	);
	// A session without terminals: one listing, nothing closed.
	requests.length = 0;
	await service.closeSession("s3");
	assert.deepEqual(requests, [{ type: "list", sessionId: "s3" }]);
});

test("a viewer gets what its host connection sent before the socket was bound, nothing of an ended one", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-terminal-view-"));
	// The host runs older code until it restarts: then it has dropped every connection and runs this code.
	let hostVersion = "older";
	const connections: Socket[] = [];
	const host = createServer((socket: Socket) => {
		connections.push(socket);
		socket.write(encodeFrame({ type: "hello", version: hostVersion, running: 1, pid: 1 }));
		readFrames(socket, (frame) => {
			if ((frame as TerminalRequest).type === "list") socket.write(encodeFrame({ type: "list", terminals: [] }));
		});
	});
	const address = await terminalHostAddress(directory);
	await new Promise<void>((resolve) => host.listen(address, resolve));
	const service = new TerminalService(directory, APP);
	const web = createHttpServer().on("upgrade", (request, socket, head) => service.upgrade(request, socket, head));
	await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const socket of sockets) socket.terminate();
		await service.close();
		await new Promise<void>((resolve) => web.close(() => resolve()));
		await new Promise<void>((resolve) => host.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	/** A byte channel to `view` as the web terminal opens one: its events (pings left out) and its close code. */
	const viewer = async (view: TerminalView) => {
		const { token } = await service.channel(view);
		const { port } = web.address() as AddressInfo;
		const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?${new URLSearchParams({ token })}`);
		sockets.push(socket);
		const events: TerminalEvent[] = [];
		socket.on("message", (data, binary) => {
			const event = binary ? undefined : (JSON.parse(String(data)) as TerminalEvent | { type: "ping" });
			if (event && event.type !== "ping") events.push(event);
		});
		const closed = new Promise<number>((resolve) => socket.once("close", resolve));
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		return { events, closed };
	};

	// The older host's notice arrived before the socket was bound: the socket gets it.
	const shown = await service.open("s1");
	const first = await viewer(shown);
	await poll(() => first.events.length > 0);
	assert.deepEqual(first.events, [{ type: "outdated", running: 1 }]);

	// Another view holds the notice for its socket, but the host restarts first (Restart in another tab).
	const connecting = await service.open("s2");
	hostVersion = await terminalHostVersion(APP);
	for (const connection of connections.splice(0)) connection.destroy();
	// A bound viewer is told, so that it reconnects.
	assert.equal(await first.closed, 1011);
	// Once the view noticed, it connects to the restarted host.
	await poll(async () => {
		await connecting.ready().catch(() => {});
		return connections.length > 0;
	});
	const second = await viewer(connecting);
	await connecting.command({ type: "list", sessionId: "s2" });
	await poll(() => second.events.some((event) => event.type === "list"));
	// Only the restarted host's answer: the ended connection's notice ended with it.
	assert.deepEqual(second.events, [{ type: "list", terminals: [] }]);
});
