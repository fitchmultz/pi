import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { AgentSession } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { type WorkingSessionHold, writeWorkingSession } from "../core/working-session.ts";
import { assertPrivateFilePath, atomicWriteFileSync } from "../utils/atomic-file.ts";
import {
	type CompletedWorkingSession,
	WORKING_SESSION_LAUNCH_ENV,
	WORKING_SESSION_WORKER_ENV,
} from "./restart-protocol.ts";

/** Local same-user capability transport. The workspace owns freezing, archives and sleep policy. */
export async function startWorkingSessionControl(
	runtime: AgentSessionRuntime,
	onFinalization?: (session: AgentSession) => Promise<boolean>,
): Promise<(() => Promise<void>) | undefined> {
	const path = process.env.PI_WORKING_SESSION_SOCKET;
	const exitPath = process.env.PI_WORKING_SESSION_EXIT_PATH;
	if (!path && !exitPath) {
		if (onFinalization)
			runtime.setFinalization(async (session) => {
				await onFinalization(session);
			});
		return;
	}
	if (process.platform === "win32") throw new Error("Native working-session control requires Unix sockets");
	const launch = process.env[WORKING_SESSION_LAUNCH_ENV];
	const worker = process.env[WORKING_SESSION_WORKER_ENV] ?? randomUUID();
	const sockets = new Map<Socket, () => Promise<void>>();
	const guardPath = path ? `${path}.guard` : undefined;
	let cleanup = async () => {};
	let finalized = false;
	const save = (file: string, hold: WorkingSessionHold) => {
		hold.assertHeld();
		writeWorkingSession(file, hold.state);
		hold.assertHeld();
	};
	if (exitPath) assertPrivateFilePath(exitPath);
	runtime.setFinalization(async (session: AgentSession) => {
		if (finalized) return;
		finalized = true;
		try {
			const restarting = await onFinalization?.(session);
			if (!exitPath || restarting) return;
			// Quit callers are already joined by the runtime; independent activity cannot be certified.
			if (!session.isIdle || session.isSettling || session.workingSessionGate.busy) return;
			const hold = await session.acquireWorkingSession();
			try {
				if (!hold.sleepReady) return;
				const statePath = `${exitPath}.state`;
				save(statePath, hold);
				await cleanup();
				if (!launch || !process.send || !process.connected)
					throw new Error("Native finalization requires the current CLI launcher");
				const completed: CompletedWorkingSession = {
					path: statePath,
					digest: createHash("sha256").update(readFileSync(statePath)).digest("hex"),
					sessionId: session.sessionId,
					pid: process.pid,
					worker,
					launch,
				};
				await new Promise<void>((done, reject) =>
					process.send!({ type: "pi:completed", completed }, (error) => (error ? reject(error) : done())),
				);
			} finally {
				await hold.release();
			}
		} finally {
			await cleanup();
		}
	});
	if (!path) return cleanup;
	assertPrivateFilePath(guardPath!);
	// Never remove an existing socket belonging to another live launch.
	if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("Native working-session socket already exists");
	assertPrivateFilePath(path);
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		let text = "";
		let acquiring = false;
		let hold: WorkingSessionHold | undefined;
		let token: string | undefined;
		let guardPublished = false;
		let released = false;
		const controller = new AbortController();
		const reply = (value: object) => socket.write(`${JSON.stringify(value)}\n`);
		const mark = (valid: boolean, reason?: string) => {
			atomicWriteFileSync(
				guardPath!,
				`${JSON.stringify({ version: 1, token, pid: process.pid, worker, launch, valid, reason })}\n`,
			);
			guardPublished = true;
		};
		const release = async () => {
			if (released) return;
			released = true;
			try {
				if (guardPublished) mark(false, "released");
			} finally {
				controller.abort();
				await hold?.release();
				hold = undefined;
			}
		};
		sockets.set(socket, release);
		socket.on("error", () => {});
		socket.on("close", () => {
			sockets.delete(socket);
			void release().catch((error: unknown) =>
				console.error(`Native working-session release failed: ${String(error)}`),
			);
		});
		socket.on("data", (chunk: string) => {
			text += chunk;
			if (Buffer.byteLength(text) > 64 * 1024) {
				socket.destroy();
				return;
			}
			while (true) {
				const end = text.indexOf("\n");
				if (end === -1) break;
				const line = text.slice(0, end);
				text = text.slice(end + 1);
				try {
					const value: unknown = JSON.parse(line);
					if (!value || typeof value !== "object" || !("action" in value))
						throw new Error("Invalid native working-session request");
					if (value.action === "release") {
						if (!hold || !("token" in value) || value.token !== token)
							throw new Error("Working-session token mismatch");
						void release()
							.then(() => socket.end(`${JSON.stringify({ ok: true })}\n`))
							.catch((error: unknown) => socket.destroy(new Error(String(error))));
					} else if (value.action === "acquire") {
						if (acquiring) throw new Error("Only one acquisition is allowed per connection");
						if (
							!("path" in value) ||
							typeof value.path !== "string" ||
							!("boundary" in value) ||
							(value.boundary !== "turn" && value.boundary !== "settled")
						)
							throw new Error("Invalid native working-session path or boundary");
						assertPrivateFilePath(value.path);
						acquiring = true;
						token = randomUUID();
						const statePath = value.path;
						void runtime.session
							.acquireWorkingSession({
								boundary: value.boundary,
								signal: controller.signal,
								onInvalidate: (reason) => mark(false, reason),
							})
							.then(async (acquired) => {
								hold = acquired;
								try {
									save(statePath, acquired);
									mark(true);
									acquired.invalidated.addEventListener(
										"abort",
										() => reply({ invalidated: true, token, reason: String(acquired.invalidated.reason) }),
										{ once: true },
									);
									reply({
										ok: true,
										path: statePath,
										boundary: acquired.boundary,
										token,
										pid: process.pid,
										worker,
										launch,
										guardPath,
										sleepReady: acquired.sleepReady,
										blockers: acquired.blockers,
									});
								} catch (error) {
									await release();
									throw error;
								}
							})
							.catch((error: unknown) => {
								if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
							});
					} else throw new Error("Unknown native working-session action");
				} catch (error) {
					reply({ ok: false, error: String(error) });
				}
			}
		});
	});
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(path, done);
	});
	chmodSync(path, 0o600);
	server.unref();
	let closed = false;
	cleanup = async () => {
		if (closed) return;
		closed = true;
		for (const [socket, release] of sockets) {
			await release();
			socket.destroy();
		}
		await new Promise<void>((done) => server.close(() => done()));
		rmSync(path, { force: true });
		rmSync(guardPath!, { force: true });
	};
	return cleanup;
}
