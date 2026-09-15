import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { parseServiceCall } from "@earendil-works/chord";
import { ClientMessageDecoder, encodeServerMessage, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "../src/index.ts";
import { createUnixTransportFactory } from "../src/unix.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const tempDirectories = new Set<string>();
const servers = new Set<Server>();
const sockets = new Set<Socket>();

async function makeSocketPath(): Promise<string> {
	const directory = await mkdtemp(join("/tmp", "pi-client-transport-"));
	tempDirectories.add(directory);
	return join(directory, "pi.sock");
}

async function listen(server: Server, path: string): Promise<void> {
	servers.add(server);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(
		[...servers].map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

test("rejects invalid Unix transport options", () => {
	expect(() => createUnixTransportFactory({ path: "" })).toThrow(/must not be empty/);
	expect(() => createUnixTransportFactory({ path: "/tmp/pi.sock", maxPendingBytes: 0 })).toThrow(/positive/);
});

describe.runIf(process.platform !== "win32")("createUnixTransportFactory", () => {
	test("carries a complete Client handshake and request over a real Unix socket", async () => {
		const path = await makeSocketPath();
		const receivedMembers: string[] = [];
		const server = createServer((socket) => {
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						const frame = encodeServerMessage({
							type: "hello",
							version: PROTOCOL_VERSION,
							serverId,
						});
						for (const byte of frame) socket.write(Uint8Array.of(byte));
						continue;
					}
					if (message.type === "cancel") continue;
					const call = parseServiceCall(message.call);
					receivedMembers.push(`${call.serviceId}.${call.member}`);
					const frame = encodeServerMessage({
						type: "response",
						id: message.id,
						ok: true,
						result: [],
					});
					const split = Math.floor(frame.byteLength / 2);
					socket.write(frame.subarray(0, split));
					socket.write(frame.subarray(split));
				}
			});
		});
		await listen(server, path);
		const client = new Client({ serverId, transportFactory: createUnixTransportFactory({ path }) });

		try {
			await expect(client.connect()).resolves.toMatchObject({ serverId });
			await expect(
				client.request({ serverId }, { serviceId: "test.server", member: "list", args: [] }),
			).resolves.toEqual([]);
			expect(receivedMembers).toEqual(["test.server.list"]);
		} finally {
			await client.dispose();
		}
	});

	test("reports truncated final frames through Client", async () => {
		const path = await makeSocketPath();
		const server = createServer((socket) => {
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						socket.write(
							encodeServerMessage({
								type: "hello",
								version: PROTOCOL_VERSION,
								serverId,
							}),
						);
					} else {
						socket.end(new Uint8Array([0, 0, 0, 2, 1]));
					}
				}
			});
		});
		await listen(server, path);
		const client = new Client({ serverId, transportFactory: createUnixTransportFactory({ path }) });

		try {
			await client.connect();
			await expect(
				client.request({ serverId }, { serviceId: "test.server", member: "list", args: [] }),
			).rejects.toMatchObject({
				name: "ProtocolValidationError",
				message: expect.stringMatching(/truncated/i),
			});
			expect(client.connectionState).toBe("disconnected");
		} finally {
			await client.dispose();
		}
	});

	test("flushes copied queued bytes in order under real backpressure and releases the pending limit", async () => {
		const path = await makeSocketPath();
		const received: Buffer[] = [];
		let receivedBytes = 0;
		const size = 8 * 1024 * 1024;
		let peer!: Socket;
		let complete!: () => void;
		const delivered = new Promise<void>((resolve) => {
			complete = resolve;
		});
		await listen(
			createServer((socket) => {
				peer = socket;
				socket.pause();
				socket.on("data", (chunk) => {
					received.push(chunk);
					receivedBytes += chunk.length;
					if (receivedBytes === size * 2 + 1) complete();
				});
			}),
			path,
		);
		const transport = await createUnixTransportFactory({ path, maxPendingBytes: size * 2 })({
			onData: () => {},
			onClose: () => {},
			onError: () => {},
		});
		const writes = vi.spyOn(Socket.prototype, "write");
		try {
			const first = new Uint8Array(size).fill(1);
			let flushed = false;
			const pending = Promise.all([transport.send(first), transport.send(new Uint8Array(size).fill(2))]).then(() => {
				flushed = true;
			});
			first.fill(9);
			await expect(transport.send(Uint8Array.of(3))).rejects.toThrow(/pending byte limit/);
			await setImmediate();
			const writeIndex = writes.mock.calls.findIndex(
				([chunk]) => chunk instanceof Uint8Array && chunk.byteLength === size,
			);
			expect(writeIndex).toBeGreaterThanOrEqual(0);
			expect(writes.mock.results[writeIndex]).toMatchObject({ type: "return", value: false });
			expect(flushed).toBe(false);
			peer.resume();
			await pending;
			await transport.send(Uint8Array.of(3));
			await delivered;
			expect(
				Buffer.concat(received).equals(
					Buffer.concat([Buffer.alloc(size, 1), Buffer.alloc(size, 2), Buffer.from([3])]),
				),
			).toBe(true);
		} finally {
			transport.close();
		}
	});

	test.each(["local", "remote"])(
		"rejects active and queued writes when the %s socket closes under backpressure",
		async (side) => {
			const path = await makeSocketPath();
			let peer!: Socket;
			await listen(
				createServer((socket) => {
					peer = socket;
					socket.pause();
				}),
				path,
			);
			const transport = await createUnixTransportFactory({ path })({
				onData: () => {},
				onClose: () => {},
				onError: () => {},
			});
			const writes = vi.spyOn(Socket.prototype, "write");
			try {
				const size = 8 * 1024 * 1024;
				const pending = Promise.allSettled([
					transport.send(new Uint8Array(size)),
					transport.send(Uint8Array.of(1)),
				]);
				await setImmediate();
				const writeIndex = writes.mock.calls.findIndex(
					([chunk]) => chunk instanceof Uint8Array && chunk.byteLength === size,
				);
				expect(writeIndex).toBeGreaterThanOrEqual(0);
				expect(writes.mock.results[writeIndex]).toMatchObject({ type: "return", value: false });
				if (side === "local") transport.close();
				else peer.destroy();
				const results = await pending;
				expect(results).toEqual([
					{ status: "rejected", reason: expect.any(Error) },
					{ status: "rejected", reason: expect.any(Error) },
				]);
				await expect(transport.send(Uint8Array.of(2))).rejects.toThrow(/closed/);
			} finally {
				transport.close();
			}
		},
	);

	test("rejects connection attempts to missing sockets", async () => {
		const path = await makeSocketPath();
		await expect(
			createUnixTransportFactory({ path })({
				onData: () => {},
				onClose: () => {},
				onError: () => {},
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
