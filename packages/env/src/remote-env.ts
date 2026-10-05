import { randomUUID } from "node:crypto";
import { type PlatformPath, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	type FileWatcher,
	type LineScan,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	StreamDecoder,
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { type Connection, type Json, RemoteError, type RemoteInfo } from "./connection.ts";
import { PollingWatcher } from "./polling-watch.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** Bytes per `pread` or `write` request; frames are at most 16 MiB. */
const TRANSFER_CHUNK = 8 * 1024 * 1024;
const LINE_CHUNK = 64 * 1024;

export interface RemoteExecutionEnvOptions {
	connection: Connection;
	/** The file namespace: equal ids see the same files (`FileSystem.id`), e.g. `pi-env:<env name>`. */
	id: string;
	cwd: string;
	shellPath?: string;
	/** Added to the remote environment of every command that inherits it, like `NodeExecutionEnv`'s `shellEnv`. */
	shellEnv?: Record<string, string>;
	/** Interval of the polling watcher. */
	watchIntervalMs?: number;
}

/** An info record from the daemon. */
type RemoteFileInfo = { name: string; kind: FileKind | "other"; size: number; mtimeSec: number; mtimeNsec: number };

function abortResult<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

/** `NodeExecutionEnv`'s mapping of Node error codes to `FileError` codes. */
function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	if (!(error instanceof RemoteError)) {
		const cause = error instanceof Error ? error : new Error(String(error));
		return new FileError("unknown", cause.message, fallbackPath, cause);
	}
	const path = error.path ?? fallbackPath;
	switch (error.code) {
		case "aborted":
			return new FileError("aborted", error.message, path, error);
		case "ENOENT":
			return new FileError("not_found", error.message, path, error);
		case "EACCES":
		case "EPERM":
			return new FileError("permission_denied", error.message, path, error);
		case "ENOTDIR":
			return new FileError("not_directory", error.message, path, error);
		case "EISDIR":
			return new FileError("is_directory", error.message, path, error);
		case "EINVAL":
		case "SYMLINK":
		case "NOT_REGULAR":
			return new FileError("invalid", error.message, path, error);
	}
	return new FileError("unknown", error.message, path, error);
}

/** Node's path rules of the remote system. */
export async function remotePath(connection: Connection): Promise<PlatformPath> {
	return (await connection.info()).os === "windows" ? win32 : posix;
}

function toInfo(path: string, remote: RemoteFileInfo, paths: PlatformPath): Result<FileInfo, FileError> {
	if (remote.kind === "other") return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: paths.basename(path),
		path,
		kind: remote.kind,
		size: remote.size,
		mtimeMs: remote.mtimeSec * 1000 + remote.mtimeNsec / 1e6,
	});
}

class RemoteBinaryReader implements BinaryReader {
	readonly #env: RemoteExecutionEnv;
	readonly #handle: number;
	readonly #path: string;
	#closed = false;

	constructor(env: RemoteExecutionEnv, handle: number, path: string) {
		this.#env = env;
		this.#handle = handle;
		this.#path = path;
	}

	#closedResult<T>(): Result<T, FileError> | undefined {
		return this.#closed ? err(new FileError("invalid", "Binary reader is closed", this.#path)) : undefined;
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const early = abortResult<FileInfo>(context.abortSignal, this.#path) ?? this.#closedResult<FileInfo>();
		if (early) return early;
		try {
			const { json } = await this.#env.connection.request("fstat", { handle: this.#handle });
			return toInfo(this.#path, json as unknown as RemoteFileInfo, await remotePath(this.#env.connection));
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const early = abortResult<Uint8Array>(context.abortSignal, this.#path) ?? this.#closedResult<Uint8Array>();
		if (early) return early;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#path));
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (total < length) {
				const { payload } = await this.#env.connection.request("pread", {
					handle: this.#handle,
					offset: offset + total,
					length: Math.min(length - total, TRANSFER_CHUNK),
				});
				const aborted = abortResult<Uint8Array>(context.abortSignal, this.#path);
				if (aborted) return aborted;
				if (payload.length === 0) break;
				chunks.push(payload);
				total += payload.length;
			}
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
		if (chunks.length === 1) return ok(chunks[0]!);
		const bytes = new Uint8Array(total);
		let position = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, position);
			position += chunk.length;
		}
		return ok(bytes);
	}

	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const early = abortResult<LineScan>(context.abortSignal, this.#path) ?? this.#closedResult<LineScan>();
		if (early) return early;
		const { startLine, endLine } = options;
		if (
			!Number.isSafeInteger(startLine) ||
			startLine < 0 ||
			(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
		) {
			return err(new FileError("invalid", "Invalid line range", this.#path));
		}
		try {
			const { json } = await this.#env.connection.request(
				"scanLines",
				{ handle: this.#handle, startLine, ...(endLine === undefined ? {} : { endLine }) },
				context.abortSignal ? { signal: context.abortSignal } : {},
			);
			return ok(json as unknown as LineScan);
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#env.connection.request("close", { handle: this.#handle }).catch(() => undefined);
	}
}

class RemoteDirReader implements DirReader {
	readonly #env: RemoteExecutionEnv;
	readonly #handle: number;
	readonly #path: string;
	#done = false;
	#closed = false;

	constructor(env: RemoteExecutionEnv, handle: number, path: string) {
		this.#env = env;
		this.#handle = handle;
		this.#path = path;
	}

	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.#path);
		if (aborted) return aborted;
		if (this.#closed) return err(new FileError("invalid", "Directory reader is closed", this.#path));
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.#path));
		}
		if (this.#done) return ok({ entries: [], done: true });
		try {
			const { json } = await this.#env.connection.request("readdir", { handle: this.#handle, max: maxEntries });
			const entries: FileInfo[] = [];
			for (const entry of json.entries as { name: string; info?: RemoteFileInfo; error?: Json }[]) {
				const paths = await remotePath(this.#env.connection);
				const path = paths.resolve(this.#path, entry.name);
				if (entry.error !== undefined) {
					// Removed between enumeration and lstat: not part of the listing any more.
					if (entry.error.code === "ENOENT") continue;
					return err(toFileError(new RemoteError(entry.error), path));
				}
				const info = toInfo(path, entry.info!, paths);
				if (info.ok) entries.push(info.value);
			}
			this.#done = json.done === true;
			return ok({ entries, done: this.#done });
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#env.connection.request("close", { handle: this.#handle }).catch(() => undefined);
	}
}

/** `NodeTextLineReader` over positional reads of a remote file. */
class RemoteTextLineReader implements TextLineReader {
	readonly #reader: RemoteBinaryReader;
	readonly #path: string;
	readonly #decoder = new StreamDecoder();
	#offset = 0;
	#buffered = "";
	#ended = false;
	#closed = false;

	constructor(reader: RemoteBinaryReader, path: string) {
		this.#reader = reader;
		this.#path = path;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, this.#path);
		if (aborted) return aborted;
		if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", this.#path));
		while (true) {
			const newline = this.#buffered.indexOf("\n");
			if (newline !== -1) {
				const text = this.#buffered.slice(0, newline);
				this.#buffered = this.#buffered.slice(newline + 1);
				return ok({ text, terminated: true });
			}
			if (this.#ended) {
				if (this.#buffered.length === 0) return ok(undefined);
				const text = this.#buffered;
				this.#buffered = "";
				return ok({ text, terminated: false });
			}
			const bytes = await this.#reader.read(this.#offset, LINE_CHUNK, context);
			if (!bytes.ok) return bytes;
			this.#offset += bytes.value.length;
			if (bytes.value.length === 0) {
				this.#buffered += this.#decoder.decode();
				this.#ended = true;
			} else {
				this.#buffered += this.#decoder.decode(bytes.value);
			}
		}
	}

	async close(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffered = "";
		await this.#reader.close(context);
	}
}

/**
 * An `ExecutionEnv` on another machine, reached through a pi-env daemon. Results match `NodeExecutionEnv` running on
 * that machine: the daemon performs the system calls, and this class applies Node's path, error, and result rules.
 */
export class RemoteExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly connection: Connection;
	readonly #shellPath: string | undefined;
	readonly #shellEnv: Record<string, string> | undefined;
	readonly #watchIntervalMs: number | undefined;
	/** Running commands this environment started, for `cleanup()`. */
	readonly #running = new Set<number>();

	constructor(options: RemoteExecutionEnvOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.connection = options.connection;
		this.#shellPath = options.shellPath;
		this.#shellEnv = options.shellEnv;
		this.#watchIntervalMs = options.watchIntervalMs;
	}

	/** Node's `resolvePath` on the remote system, with its home directory. */
	async #resolve(path: string): Promise<string> {
		const { home, os } = await this.connection.info();
		const windows = os === "windows";
		const paths = windows ? win32 : posix;
		let normalized = path;
		if (normalized === "~") {
			normalized = home;
		} else if (normalized.startsWith("~/") || (windows && normalized.startsWith("~\\"))) {
			normalized = paths.join(home, normalized.slice(2));
		} else if (normalized.startsWith("file://")) {
			try {
				normalized = fileURLToPath(normalized, { windows });
			} catch {
				// Keep malformed URLs as ordinary paths, as Node does.
			}
		}
		return paths.isAbsolute(normalized) ? paths.resolve(normalized) : paths.resolve(this.cwd, normalized);
	}

	async #fileOp<T>(
		path: string,
		context: Context,
		run: (resolved: string) => Promise<T>,
		check: "before" | "both" = "before",
	): Promise<Result<T, FileError>> {
		let resolved: string;
		try {
			resolved = await this.#resolve(path);
		} catch (error) {
			return err(toFileError(error, path));
		}
		const aborted = abortResult<T>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const value = await run(resolved);
			if (check === "both") {
				const after = abortResult<T>(context.abortSignal, resolved);
				if (after) return after;
			}
			return ok(value);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok(await this.#resolve(path));
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok((await remotePath(this.connection)).join(...parts));
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		// Node's `readFile(path, "utf8")` keeps a byte-order mark, unlike `TextDecoder`.
		return bytes.ok
			? ok(Buffer.from(bytes.value.buffer, bytes.value.byteOffset, bytes.value.length).toString("utf8"))
			: bytes;
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const opened = await this.openBinaryReader(path, undefined, context);
		if (!opened.ok) return opened;
		try {
			const chunks: Uint8Array[] = [];
			for (let offset = 0; ; ) {
				const bytes = await opened.value.read(offset, TRANSFER_CHUNK, context);
				if (!bytes.ok) return bytes;
				if (bytes.value.length === 0) break;
				chunks.push(bytes.value);
				offset += bytes.value.length;
			}
			// Node's `readFile` returns a Buffer.
			return ok(Buffer.concat(chunks));
		} finally {
			await opened.value.close(context);
		}
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("open", {
				path: resolved,
				noFollow: options?.noFollow === true,
			});
			return { handle: json.handle as number, resolved };
		});
		if (!opened.ok) return opened;
		const reader = new RemoteBinaryReader(this, opened.value.handle, opened.value.resolved);
		const aborted = abortResult<BinaryReader>(context.abortSignal, opened.value.resolved);
		if (aborted) {
			await reader.close(context);
			return aborted;
		}
		return ok(reader);
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await this.openBinaryReader(path, undefined, context);
		if (!opened.ok) return opened;
		const reader = opened.value as RemoteBinaryReader;
		return ok(new RemoteTextLineReader(reader, await this.#resolve(path)));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async #write(path: string, content: string | Uint8Array, append: boolean, context: Context) {
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				// Large contents go in pieces: the first write truncates (or appends), the rest append.
				for (let offset = 0, first = true; first || offset < bytes.length; first = false) {
					const piece = bytes.subarray(offset, offset + TRANSFER_CHUNK);
					await this.connection.request("write", { path: resolved, append: append || !first }, { payload: piece });
					offset += piece.length;
				}
			},
			append ? "both" : "before",
		);
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, false, context);
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, true, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = await this.#resolve(path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		if (!Number.isSafeInteger(size) || size < 0) {
			return err(new FileError("invalid", "File size must be a non-negative safe integer", resolved));
		}
		return this.#fileOp(
			path,
			context,
			async (target) => {
				await this.connection.request("truncate", { path: target, size });
			},
			"both",
		);
	}

	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				await this.connection.request("fsync", { path: resolved });
			},
			"both",
		);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = await this.#resolve(sourcePath);
		const destination = await this.#resolve(destinationPath);
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await this.connection.request("rename", { path: source, to: destination });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const result = await this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("lstat", { path: resolved });
			return toInfo(resolved, json as unknown as RemoteFileInfo, await remotePath(this.connection));
		});
		return result.ok ? result.value : result;
	}

	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { json: opened } = await this.connection.request("opendir", { path: resolved });
			const handle = opened.handle as number;
			const entries: { name: string; info?: RemoteFileInfo; error?: Json }[] = [];
			try {
				for (let done = false; !done; ) {
					if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted", resolved);
					const { json } = await this.connection.request("readdir", { handle, max: 1000 });
					entries.push(...(json.entries as typeof entries));
					done = json.done === true;
				}
			} finally {
				await this.connection.request("close", { handle }).catch(() => undefined);
			}
			// Node's `readdir` fails on any entry it cannot lstat. libuv sorts names by bytes on POSIX; on Windows it keeps
			// the file system's order, which the daemon reports.
			const paths = await remotePath(this.connection);
			if (paths === posix) {
				entries.sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
			}
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const entryPath = paths.resolve(resolved, entry.name);
				if (entry.error !== undefined) throw toFileError(new RemoteError(entry.error), entryPath);
				const info = toInfo(entryPath, entry.info!, paths);
				if (info.ok) infos.push(info.value);
			}
			return infos;
		});
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("opendir", { path: resolved });
			return { handle: json.handle as number, resolved };
		});
		if (!opened.ok) return opened;
		const reader = new RemoteDirReader(this, opened.value.handle, opened.value.resolved);
		const aborted = abortResult<DirReader>(context.abortSignal, opened.value.resolved);
		if (aborted) {
			await reader.close(context);
			return aborted;
		}
		return ok(reader);
	}

	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("realpath", { path: resolved });
			return json.path as string;
		});
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			await this.connection.request("mkdir", { path: resolved, recursive: options?.recursive ?? true });
		});
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			await this.connection.request("rm", {
				path: resolved,
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			});
		});
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const { tmpdir } = await this.connection.info();
			const paths = await remotePath(this.connection);
			const { json } = await this.connection.request("mkdtemp", { path: paths.join(tmpdir, prefix ?? "tmp-") });
			return ok(json.path as string);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		const paths = await remotePath(this.connection);
		const filePath = paths.join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await this.connection.request("write", { path: filePath, append: false }, { payload: new Uint8Array(0) });
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const aborted = abortResult<FileWatcher>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const resolved = await Promise.all(
				targets.map(async (target) => ({ ...target, path: await this.#resolve(target.path) })),
			);
			return ok(await PollingWatcher.open(this, resolved, onChange, this.#watchIntervalMs));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined) {
			if (!Number.isFinite(timeout) || timeout <= 0) {
				return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			}
			if (timeout * 1000 > MAX_TIMEOUT_MS) {
				return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
			}
		}
		const inheritEnv = options?.inheritEnv ?? true;
		let cwd: string;
		try {
			cwd = options?.cwd ? await this.#resolve(options.cwd) : this.cwd;
		} catch (error) {
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
		let callbackError: ExecutionError | undefined;
		let settled = false;
		let id: number | undefined;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const { json } = await this.connection.request(
				"exec",
				{
					...(typeof command === "string" ? { command } : { argv: [...command] }),
					cwd,
					env: inheritEnv ? { ...this.#shellEnv, ...options?.env } : { ...options?.env },
					inheritEnv,
					...(this.#shellPath === undefined ? {} : { shellPath: this.#shellPath }),
					...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
					...(options?.spill === undefined ? {} : { spill: options.spill }),
				},
				{
					signal: controller.signal,
					onStart: (requestId) => {
						id = requestId;
						this.#running.add(requestId);
					},
					onEvent: (event, payload) => {
						if (settled || callbackError !== undefined || event.kind !== "output") return;
						const text = Buffer.from(payload.buffer, payload.byteOffset, payload.length).toString("utf8");
						if (text === "" || options?.onOutput === undefined) return;
						try {
							options.onOutput(text, context, { stream: event.stream === "stderr" ? "stderr" : "stdout" });
						} catch (error) {
							const cause = error instanceof Error ? error : new Error(String(error));
							callbackError = new ExecutionError("callback_error", cause.message, cause);
							controller.abort();
						}
					},
				},
			);
			if (callbackError) return err(callbackError);
			return ok({
				exitCode: json.exitCode as number,
				...(typeof json.spillPath === "string" ? { spillPath: json.spillPath } : {}),
			});
		} catch (error) {
			if (callbackError) return err(callbackError);
			if (!(error instanceof RemoteError)) {
				return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
			}
			const failure =
				error.code === "timeout"
					? new ExecutionError("timeout", `timeout:${timeout}`)
					: error.code === "aborted"
						? new ExecutionError("aborted", "aborted")
						: error.code === "shell_unavailable" || error.code === "spawn_error"
							? new ExecutionError(error.code, error.message)
							: new ExecutionError("unknown", error.message);
			if (typeof error.fields.spillPath === "string") failure.spillPath = error.fields.spillPath;
			return err(failure);
		} finally {
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (id !== undefined) this.#running.delete(id);
		}
	}

	async cleanup(_context: Context): Promise<void> {
		// Kill without aborting, so the commands settle with their killed status, as `NodeExecutionEnv` does.
		for (const id of this.#running) this.connection.kill(id);
		this.#running.clear();
	}
}

export type { RemoteInfo };
