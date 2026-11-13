import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { spawn } from "child_process";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessGroupAfterExit,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/**
 * How far the local shell reads ahead of a consumer that writes output to a file: while the promises
 * `onData` returned for this many bytes are pending, the shell does not read from the command.
 * Durable's shell spill buffers the same amount (`SPILL_HIGH_WATER_MARK`); docs/performance.md records
 * the measurement.
 */
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			/**
			 * Receives each output chunk in order. A consumer that stores a chunk asynchronously returns
			 * a promise that settles once the chunk is stored and rejects if storing fails; pi returns one
			 * for each chunk it writes to a full-output file. An implementation may ignore it; one that
			 * can pause its source can use it to limit the output waiting to be stored.
			 */
			onData: (data: Buffer) => void | Promise<void>;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Timeout of the local shell backend. Its message keeps the `timeout:<seconds>` form custom operations throw.
 * `shellExit` is set when the shell itself exited before the deadline, so the tool was only still waiting
 * because background processes kept writing to the inherited stdout/stderr pipes (#11613).
 */
export class ShellTimeoutError extends Error {
	readonly shellExit: { exitCode: number; afterSeconds: number } | undefined;

	constructor(timeout: number | undefined, shellExit: { exitCode: number; afterSeconds: number } | undefined) {
		super(`timeout:${timeout}`);
		this.shellExit = shellExit;
	}
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			const startedAt = performance.now();
			let shellExitedAfterMs: number | undefined;
			let killed = false;
			child.once("exit", () => {
				shellExitedAfterMs = performance.now() - startedAt;
				// A kill that landed while the shell was starting its next step can miss that step.
				if (killed && child.pid) killProcessGroupAfterExit(child.pid);
			});
			let timedOut = false;
			let exitedBeforeDeadlineAfterMs: number | undefined;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let outputError: Error | undefined;
			// Bytes handed to onData whose returned promise has not settled.
			let pendingOutputBytes = 0;
			// Settles once every promise onData returned has settled.
			let outputSettled = Promise.resolve();
			const onAbort = () => {
				killed = true;
				if (child.pid) killProcessTree(child.pid);
			};
			const failOutput = (error: unknown) => {
				outputError = error instanceof Error ? error : new Error(String(error));
				onAbort();
			};
			// Not after a failure: the pipes must flow for the killed command's exit to be seen.
			const outputIsBackedUp = () => !outputError && pendingOutputBytes >= MAX_PENDING_OUTPUT_BYTES;
			const handleData = (data: Buffer) => {
				if (outputError) return;
				try {
					const written = onData(data);
					// Extensions are loaded without type checking, so their callback may return any value.
					if (!(written instanceof Promise)) return;
					// Captured so that the callback below does not keep `data` alive until the write completes.
					const bytes = data.length;
					pendingOutputBytes += bytes;
					// Checked on every chunk: Node resumes both pipes itself when the shell exits.
					if (outputIsBackedUp()) {
						child.stdout?.pause();
						child.stderr?.pause();
					}
					const settled = written.catch(failOutput).then(() => {
						pendingOutputBytes -= bytes;
						if (!outputIsBackedUp()) {
							child.stdout?.resume();
							child.stderr?.resume();
						}
					});
					const earlier = outputSettled;
					outputSettled = settled.then(() => earlier);
				} catch (error) {
					failOutput(error);
				}
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						exitedBeforeDeadlineAfterMs = shellExitedAfterMs;
						// Also when the shell already exited: on Unix the group kill still reaches background
						// processes holding the pipes. Windows cannot find them once the shell pid is gone.
						onAbort();
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child, outputIsBackedUp);
				await outputSettled;
				if (outputError) throw outputError;
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const signalCode = child.signalCode;
				const resolvedExitCode = exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
				if (timedOut) {
					throw new ShellTimeoutError(
						timeout,
						exitedBeforeDeadlineAfterMs !== undefined
							? { exitCode: resolvedExitCode, afterSeconds: Math.round(exitedBeforeDeadlineAfterMs / 100) / 10 }
							: undefined,
					);
				}
				return { exitCode: resolvedExitCode };
			} finally {
				child.stdout?.off("data", handleData);
				child.stderr?.off("data", handleData);
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;
