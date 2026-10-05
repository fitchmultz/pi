import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Frame types (docs/protocol.md). */
const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;

const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
/** The daemon pings every five seconds; this much silence means the connection is gone. */
const SILENCE_LIMIT_MS = 30_000;

export type Json = Record<string, unknown>;

/** A failure reported by the daemon, with its Node-style code. */
export class RemoteError extends Error {
	readonly code: string;
	readonly path?: string;
	readonly fields: Json;

	constructor(fields: Json) {
		super(typeof fields.message === "string" ? fields.message : "Remote operation failed");
		this.name = "RemoteError";
		this.code = typeof fields.code === "string" ? fields.code : "unknown";
		if (typeof fields.path === "string") this.path = fields.path;
		this.fields = fields;
	}
}

/** What `hello` reports about the remote machine. */
export interface RemoteInfo {
	protocol: number;
	version: string;
	os: string;
	arch: string;
	home: string;
	tmpdir: string;
	/** Path separator: `/`, or `\\` on Windows. */
	separator: string;
	pid: number;
}

export interface ConnectionOptions {
	/** Command that starts the daemon, before its `serve --token <hex>` arguments, e.g. `["ssh", "-T", "--", "host", "~/.pi/mobile/tools/pi-env"]`. */
	command: readonly string[];
	/** Receives the daemon's and the transport's diagnostic output. */
	onLog?: (text: string) => void;
}

type Pending = {
	resolve: (value: { json: Json; payload: Uint8Array }) => void;
	reject: (error: Error) => void;
	onEvent?: (json: Json, payload: Uint8Array) => void;
};

export interface RequestOptions {
	payload?: Uint8Array;
	/** Aborting sends `cancel`; the request still settles with the daemon's result or error. */
	signal?: AbortSignal;
	/** Progress events of the request, such as `exec` output. */
	onEvent?: (json: Json, payload: Uint8Array) => void;
	/** The request's id, for `kill`. */
	onStart?: (id: number) => void;
}

function frame(type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)): Buffer {
	const body = Buffer.from(JSON.stringify(json), "utf8");
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length + payload.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body, payload]);
}

/**
 * One connection to a pi-env daemon: started lazily on the first request and started again after it is lost. Requests
 * in flight when it is lost fail with code `unknown`; for mutations their outcome is then unknown.
 */
export class Connection {
	readonly #options: ConnectionOptions;
	#child: ChildProcessWithoutNullStreams | undefined;
	#ready: Promise<RemoteInfo> | undefined;
	#pending = new Map<number, Pending>();
	#nextId = 1;
	#buffer: Buffer = Buffer.alloc(0);
	#synced = false;
	#token = "";
	#lastSeen = 0;
	#timer: ReturnType<typeof setInterval> | undefined;
	#closed = false;

	constructor(options: ConnectionOptions) {
		this.#options = options;
	}

	/** Connect if needed and return what the daemon reported about its machine. */
	info(): Promise<RemoteInfo> {
		if (this.#closed) return Promise.reject(new RemoteError({ code: "unknown", message: "Connection closed" }));
		this.#ready ??= this.#start();
		return this.#ready;
	}

	async request(op: string, json: Json, options: RequestOptions = {}): Promise<{ json: Json; payload: Uint8Array }> {
		await this.info();
		return this.#send(op, json, options);
	}

	/** Stop the daemon; it kills everything it started. */
	close(): void {
		this.#closed = true;
		this.#teardown(new RemoteError({ code: "unknown", message: "Connection closed" }));
	}

	/** Kill one `exec` without aborting it. */
	kill(id: number): void {
		this.#write(frame(CANCEL, id, { mode: "kill" }));
	}

	#send(op: string, json: Json, options: RequestOptions): Promise<{ json: Json; payload: Uint8Array }> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => this.#write(frame(CANCEL, id, {}));
			const done = () => options.signal?.removeEventListener("abort", onAbort);
			this.#pending.set(id, {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
				...(options.onEvent ? { onEvent: options.onEvent } : {}),
			});
			options.signal?.addEventListener("abort", onAbort, { once: true });
			options.onStart?.(id);
			this.#write(frame(REQUEST, id, { ...json, op }, options.payload));
			if (options.signal?.aborted) onAbort();
		});
	}

	#write(data: Buffer): void {
		this.#child?.stdin.write(data);
	}

	async #start(): Promise<RemoteInfo> {
		this.#token = randomBytes(16).toString("hex");
		this.#synced = false;
		this.#buffer = Buffer.alloc(0);
		const [program, ...args] = this.#options.command;
		if (program === undefined) throw new RemoteError({ code: "spawn_error", message: "No daemon command" });
		const child = spawn(program, [...args, "serve", "--token", this.#token], { stdio: ["pipe", "pipe", "pipe"] });
		this.#child = child;
		const failed = new Promise<never>((_resolve, reject) => {
			child.once("error", (error) => reject(new RemoteError({ code: "spawn_error", message: error.message })));
			child.once("exit", (code) =>
				reject(
					new RemoteError({ code: "unknown", message: `pi-env exited with code ${code} before it was ready` }),
				),
			);
		});
		failed.catch(() => {});
		child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#options.onLog?.(chunk.toString("utf8")));
		child.on("exit", () => {
			if (this.#child === child)
				this.#teardown(new RemoteError({ code: "unknown", message: "pi-env connection lost" }));
		});
		child.stdin.on("error", () => {});
		this.#lastSeen = Date.now();
		this.#timer = setInterval(() => {
			this.#write(frame(PING, 0, {}));
			if (Date.now() - this.#lastSeen > SILENCE_LIMIT_MS) {
				this.#teardown(new RemoteError({ code: "unknown", message: "pi-env connection timed out" }));
			}
		}, PING_INTERVAL_MS);
		this.#timer.unref();
		const hello = this.#send("hello", { protocol: 1 }, {});
		const { json } = await Promise.race([hello, failed]);
		if (json.protocol !== 1)
			throw new RemoteError({ code: "unknown", message: `Unsupported protocol ${json.protocol}` });
		return json as unknown as RemoteInfo;
	}

	#teardown(error: Error): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		const child = this.#child;
		this.#child = undefined;
		this.#ready = undefined;
		child?.stdin.end();
		child?.kill();
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const request of pending) request.reject(error);
	}

	#onData(chunk: Buffer): void {
		this.#lastSeen = Date.now();
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		if (!this.#synced) {
			// Shell startup files may print before the daemon runs; skip everything before its sync line.
			const marker = Buffer.from(`PI-ENV ${this.#token}\n`, "utf8");
			const index = this.#buffer.indexOf(marker);
			if (index === -1) {
				if (this.#buffer.length > 1024 * 1024) this.#buffer = this.#buffer.subarray(-marker.length);
				return;
			}
			const noise = this.#buffer.subarray(0, index).toString("utf8").trim();
			if (noise !== "") this.#options.onLog?.(noise);
			this.#buffer = this.#buffer.subarray(index + marker.length);
			this.#synced = true;
		}
		while (this.#buffer.length >= 4) {
			const length = this.#buffer.readUInt32BE(0);
			if (length < 9 || length > MAX_FRAME) {
				this.#teardown(new RemoteError({ code: "unknown", message: "Corrupt frame from pi-env" }));
				return;
			}
			if (this.#buffer.length < 4 + length) return;
			const type = this.#buffer.readUInt8(4);
			const id = this.#buffer.readUInt32BE(5);
			const jsonLength = this.#buffer.readUInt32BE(9);
			const json = JSON.parse(this.#buffer.subarray(13, 13 + jsonLength).toString("utf8")) as Json;
			// A plain Uint8Array copy, like `NodeExecutionEnv`'s reader results, not a view of the receive buffer.
			const payload = new Uint8Array(this.#buffer.subarray(13 + jsonLength, 4 + length));
			this.#buffer = this.#buffer.subarray(4 + length);
			this.#dispatch(type, id, json, payload);
		}
	}

	#dispatch(type: number, id: number, json: Json, payload: Uint8Array): void {
		const pending = this.#pending.get(id);
		if (type === EVENT) {
			pending?.onEvent?.(json, payload);
			return;
		}
		if (type !== RESULT && type !== ERROR) return;
		if (pending === undefined) return;
		this.#pending.delete(id);
		if (type === RESULT) pending.resolve({ json, payload });
		else pending.reject(new RemoteError(json));
	}
}
