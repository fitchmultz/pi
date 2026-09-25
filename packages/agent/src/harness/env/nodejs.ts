import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type WriteStream } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	open as openFile,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "../context.ts";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLine,
	type TextLineReader,
	toError,
} from "../types.ts";
import { OutputCapture } from "../utils/output-capture.ts";
import { ShellDecoder, type ShellSource } from "../utils/shell-decoder.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveLocalOperationPath } from "./local-path.ts";
import { publishLocalFile, resolveLocalFileTarget } from "./publish-local-file.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_STDIO_GRACE_MS = 100;
const SPILL_HIGH_WATER_MARK = 8 * 1024 * 1024;

type SpillChunk = string | Uint8Array;

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: basename(path),
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const nodeError = isNodeError(error) ? error : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		const message = nodeError.message;
		switch (nodeError.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors.
		}
		return;
	}

	// Freeze the group first: a group SIGKILL is not atomic, so a shell waiting on a child
	// that dies first could otherwise run its next command.
	try {
		process.kill(-pid, "SIGSTOP");
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

function waitForChildProcess(
	child: ChildProcess,
	spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise({ code: exitCode, signal: exitSignal });
		};
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => {
				if (spillIsDraining()) armIdleTimer();
				else finalize();
			}, EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (child.pid) killProcessTree(child.pid);
			child.stdout?.destroy();
			child.stderr?.destroy();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
			exitCode = code;
			exitSignal = signal;
			finalize();
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		for (const stream of [child.stdout, child.stderr]) {
			// The other pipe can still report a queued error while both streams close.
			stream?.once("error", onError);
			stream?.once("close", () => stream.removeListener("error", onError));
		}
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/** Strict LF reader; Node readline does not report whether its final line was newline-terminated. */
class NodeTextLineReader implements TextLineReader {
	private readonly file: Awaited<ReturnType<typeof openFile>>;
	private readonly path: string;
	private readonly decoder = new TextDecoder();
	private readonly chunk = new Uint8Array(64 * 1024);
	private byteOffset = 0;
	private buffered = "";
	private ended = false;
	private closed = false;

	constructor(file: Awaited<ReturnType<typeof openFile>>, path: string) {
		this.file = file;
		this.path = path;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));

		try {
			while (true) {
				const newline = this.buffered.indexOf("\n");
				if (newline !== -1) {
					const text = this.buffered.slice(0, newline);
					this.buffered = this.buffered.slice(newline + 1);
					return ok({ text, terminated: true });
				}
				if (this.ended) {
					if (this.buffered.length === 0) return ok(undefined);
					const text = this.buffered;
					this.buffered = "";
					return ok({ text, terminated: false });
				}

				// Explicit positions allow an aborted read to be retried without skipping bytes.
				const { bytesRead } = await this.file.read(this.chunk, 0, this.chunk.length, this.byteOffset);
				const afterReadAbort = abortResult<TextLine | undefined>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				this.byteOffset += bytesRead;
				if (bytesRead === 0) {
					this.buffered += this.decoder.decode();
					this.ended = true;
				} else {
					this.buffered += this.decoder.decode(this.chunk.subarray(0, bytesRead), { stream: true });
				}
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.buffered = "";
		try {
			await this.file.close();
		} catch {
			// Closing is best-effort, including after cancellation or an earlier I/O failure.
		}
	}
}

export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	private activeChildPids = new Set<number>();

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	withFileMutationQueue<T>(path: string, fn: () => Promise<T>, _context: Context): Promise<T> {
		return withFileMutationQueue(resolveLocalOperationPath(this.cwd, path), fn);
	}

	async exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		return await new Promise((resolvePromise) => {
			let finalizing = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let spillError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const spillPrefix: SpillChunk[] = [];
			let spillPath: string | undefined;
			const spillQueue: SpillChunk[] = [];
			let spillStart: Promise<void> | undefined;
			let spillStream: WriteStream | undefined;
			let spillBackpressured = false;
			const decoder = new ShellDecoder();

			const onAbort = () => {
				if (child?.pid) killProcessTree(child.pid);
			};
			const failCallback = (error: unknown) => {
				if (callbackError !== undefined) return;
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				onAbort();
			};
			let capture: OutputCapture;
			try {
				capture = new OutputCapture(options?.capture, context, {
					onUpdate: options?.onUpdate,
					onError: failCallback,
				});
			} catch (error) {
				const cause = toError(error);
				resolvePromise(err(new ExecutionError("unknown", cause.message, cause)));
				return;
			}

			const settle = (result: Result<ShellExecResult, ExecutionError>) => {
				if (child?.pid) this.activeChildPids.delete(child.pid);
				capture.dispose();
				resolvePromise(result);
			};
			const pauseOutput = () => {
				child?.stdout?.pause();
				child?.stderr?.pause();
			};
			const resumeOutput = () => {
				if (finalizing || spillBackpressured) return;
				child?.stdout?.resume();
				child?.stderr?.resume();
			};
			const failSpill = (error: unknown) => {
				if (spillError !== undefined) return;
				const cause = toError(error);
				spillError = new ExecutionError(
					"unknown",
					`Failed to preserve complete shell output: ${cause.message}`,
					cause,
				);
				spillBackpressured = false;
				onAbort();
				resumeOutput();
			};
			const writeSpill = (chunk: SpillChunk): void => {
				if (spillStream === undefined || spillError || chunk.length === 0) return;
				if (spillStream.write(chunk) || spillBackpressured) return;
				spillBackpressured = true;
				pauseOutput();
				spillStream.once("drain", () => {
					spillBackpressured = false;
					resumeOutput();
				});
			};
			const startSpill = (chunk: SpillChunk): void => {
				if (spillError) return;
				if (spillStream !== undefined) {
					writeSpill(chunk);
					return;
				}
				spillQueue.push(chunk);
				if (spillStart !== undefined) return;
				pauseOutput();
				spillStart = (async () => {
					const created = await this.createTempFile(
						{ prefix: "pi-output-", suffix: ".log" },
						withoutAbortSignal(context),
					);
					if (!created.ok) throw created.error;
					spillPath = created.value;
					try {
						capture.setSpillPath(spillPath);
					} catch (error) {
						failCallback(error);
					}
					spillStream = createWriteStream(spillPath, { flags: "a", highWaterMark: SPILL_HIGH_WATER_MARK });
					spillStream.on("error", failSpill);
					for (const queued of spillQueue) writeSpill(queued);
					spillQueue.length = 0;
				})()
					.catch(failSpill)
					.finally(resumeOutput);
			};
			const finishSpill = async (): Promise<void> => {
				await spillStart;
				const stream = spillStream;
				if (stream === undefined || stream.closed) return;
				await new Promise<void>((resolveFinish) => {
					stream.once("close", resolveFinish);
					if (!stream.destroyed) stream.end();
				});
			};

			const spillIfNeeded = (): void => {
				if (!options?.capture?.spill || !capture.truncated) return;
				for (const prefix of spillPrefix) startSpill(prefix);
				spillPrefix.length = 0;
			};
			const feed = (chunk: Uint8Array, source: ShellSource): void => {
				if (finalizing) return;
				// Archive arrival order independently of completed-character display order.
				if (options?.capture?.spill) {
					if (spillStart !== undefined) startSpill(chunk);
					else spillPrefix.push(chunk);
				}
				try {
					capture.push(decoder.push(chunk, source));
				} catch (error) {
					failCallback(error);
				}
				spillIfNeeded();
			};
			const endSource = (source: ShellSource): void => {
				if (finalizing) return;
				try {
					capture.push(decoder.end(source));
				} catch (error) {
					failCallback(error);
				}
				spillIfNeeded();
			};
			const onStdout = (chunk: Uint8Array) => feed(chunk, "stdout");
			const onStderr = (chunk: Uint8Array) => feed(chunk, "stderr");
			const onStdoutEnd = () => endSource("stdout");
			const onStderrEnd = () => endSource("stderr");
			const finalize = async (
				code: number | null,
				exitSignal: NodeJS.Signals | null,
				processError?: ExecutionError,
			): Promise<void> => {
				if (finalizing) return;
				finalizing = true;
				if (timeoutId) clearTimeout(timeoutId);
				if (signal) signal.removeEventListener("abort", onAbort);
				child?.stdout?.removeListener("data", onStdout);
				child?.stderr?.removeListener("data", onStderr);
				child?.stdout?.removeListener("end", onStdoutEnd);
				child?.stderr?.removeListener("end", onStderrEnd);
				try {
					capture.push(decoder.finish());
					capture.finish();
				} catch (error) {
					failCallback(error);
				}
				spillIfNeeded();
				await finishSpill();
				try {
					capture.flush();
				} catch (error) {
					failCallback(error);
				}
				if (callbackError) {
					settle(err(callbackError));
				} else if (timedOut) {
					settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
				} else if (signal?.aborted) {
					settle(err(new ExecutionError("aborted", "aborted")));
				} else if (spillError) {
					settle(err(spillError));
				} else if (processError) {
					settle(err(processError));
				} else {
					const output = capture.snapshot();
					// Signal termination has no exit code; use the conventional 128 + signal number.
					const exitCode = code ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1);
					settle(
						ok({
							exitCode,
							truncation: output.truncation,
							...(output.spillPath === undefined ? {} : { spillPath: output.spillPath }),
							...(output.lastLineBytes === undefined ? {} : { lastLineBytes: output.lastLineBytes }),
						}),
					);
				}
			};

			try {
				const commandFromStdin = shellConfig.value.commandTransport === "stdin";
				child = spawn(
					shellConfig.value.shell,
					commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						detached: process.platform !== "win32",
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				if (child.pid) this.activeChildPids.add(child.pid);
				if (commandFromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
			} catch (error) {
				const cause = toError(error);
				void finalize(null, null, new ExecutionError("spawn_error", cause.message, cause));
				return;
			}

			timeoutId =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							onAbort();
						}, timeoutMs);

			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			child.stdout?.on("data", onStdout);
			child.stderr?.on("data", onStderr);
			child.stdout?.once("end", onStdoutEnd);
			child.stderr?.once("end", onStderrEnd);

			void waitForChildProcess(
				child,
				() =>
					spillError === undefined &&
					spillStart !== undefined &&
					(spillStream === undefined || spillBackpressured),
			).then(
				({ code, signal: exitSignal }) => finalize(code, exitSignal),
				(error: Error) => finalize(null, null, new ExecutionError("spawn_error", error.message, error)),
			);
		});
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const aborted = abortResult<TextLineReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const file = await openFile(resolved, "r");
			const afterOpenAbort = abortResult<TextLineReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await file.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeTextLineReader(file, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<string>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
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

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<Uint8Array>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(dirname(resolved), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await publishLocalFile(resolved, content, signal);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(dirname(resolved), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await appendFile(resolved, content);
			// Appended bytes are committed; late cancellation must not report a retryable failure.
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = resolveLocalOperationPath(this.cwd, sourcePath);
		const destination = resolveLocalOperationPath(this.cwd, destinationPath);
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await rename(source, destination);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const aborted = abortResult<FileInfo>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<FileInfo[]>(signal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(signal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = `${resolved.endsWith(sep) ? resolved : resolved + sep}${entry.name}`;
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const aborted = abortResult<string>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			// The addressed path must exist; a dangling final symlink still has a target identity.
			await lstat(resolved);
			return ok(await resolveLocalFileTarget(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolveLocalOperationPath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			prefix ??= "tmp-";
			return ok(await mkdtemp(join(tmpdir(), prefix)));
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
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async cleanup(_context: Context): Promise<void> {
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}
