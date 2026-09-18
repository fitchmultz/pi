import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { AgentSession } from "../core/agent-session.ts";
import { type CheckpointHold, writeSessionCheckpoint } from "../core/checkpoint.ts";

export const CHECKPOINT_SOCKET_ENV = "PI_CHECKPOINT_SOCKET";

/** Optional local native control, independent of restart supervision and model/auth transport. */
export async function startCheckpointControl(options: {
	path: string;
	getSession: () => AgentSession;
	quiesce: () => () => void;
}): Promise<() => void> {
	if (process.platform === "win32" || !isAbsolute(options.path))
		throw new Error("Checkpoint control requires an absolute Unix socket path");
	const directory = statSync(dirname(options.path));
	if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) {
		throw new Error("Checkpoint socket directory must be owner-private (0700)");
	}
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		const controller = new AbortController();
		let hold: CheckpointHold | undefined;
		let pending = false;
		let token: string | undefined;
		let input = "";
		const reply = (value: object) => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
		};
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("close", () => {
			controller.abort();
			hold?.release();
			sockets.delete(socket);
		});
		const handle = async (line: string) => {
			try {
				const request: unknown = JSON.parse(line);
				if (!request || typeof request !== "object" || !("action" in request))
					throw new Error("Invalid checkpoint request");
				if (request.action === "release") {
					if (!hold || !("token" in request) || request.token !== token)
						throw new Error("Invalid checkpoint token");
					const released = hold;
					hold = undefined;
					released.release();
					reply({ ok: true, released: true });
					return;
				}
				if (
					request.action !== "acquire" ||
					!("path" in request) ||
					typeof request.path !== "string" ||
					!isAbsolute(request.path)
				)
					throw new Error("Acquire requires an absolute artifact path");
				if (pending || hold) throw new Error("Checkpoint already requested on this connection");
				const boundary = "boundary" in request ? request.boundary : "settled";
				if (boundary !== "turn" && boundary !== "settled") throw new Error("Invalid checkpoint boundary");
				pending = true;
				try {
					hold = await options
						.getSession()
						.acquireCheckpoint({ boundary, signal: controller.signal, quiesce: options.quiesce });
					if (socket.destroyed) {
						hold.release();
						hold = undefined;
						return;
					}
					writeSessionCheckpoint(request.path, hold.checkpoint);
					token = randomUUID();
					const acquired = hold;
					acquired.signal.addEventListener(
						"abort",
						() => {
							if (hold !== acquired) return;
							hold = undefined;
							reply({
								ok: false,
								token,
								invalidated: true,
								message: "Checkpoint hold released; do not stop compute",
							});
						},
						{ once: true },
					);
					reply({
						ok: true,
						token,
						path: request.path,
						boundary: hold.checkpoint.boundary,
						settled: hold.checkpoint.settled,
						sleepReady: false,
						selection: hold.checkpoint.selection,
					});
				} catch (error) {
					hold?.release();
					hold = undefined;
					throw error;
				} finally {
					pending = false;
				}
			} catch (error) {
				reply({ ok: false, message: error instanceof Error ? error.message : String(error) });
			}
		};
		socket.on("data", (chunk: string) => {
			input += chunk;
			if (Buffer.byteLength(input) > 64 * 1024) {
				socket.destroy();
				return;
			}
			let index = input.indexOf("\n");
			while (index >= 0) {
				const line = input.slice(0, index);
				input = input.slice(index + 1);
				void handle(line);
				index = input.indexOf("\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.path, () => resolve());
	});
	chmodSync(options.path, 0o600);
	const endpoint = statSync(options.path);
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		process.removeListener("exit", close);
		for (const socket of sockets) socket.destroy();
		server.close();
		// Interactive shutdown calls process.exit(), so main's finally is not guaranteed.
		// Remove only this endpoint, never a socket installed by another process.
		try {
			const current = statSync(options.path);
			if (current.ino === endpoint.ino && current.dev === endpoint.dev) rmSync(options.path);
		} catch {
			/* Already closed/unlinked. */
		}
	};
	process.once("exit", close);
	return close;
}
