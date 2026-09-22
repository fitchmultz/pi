/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { ShellDecoder } from "@earendil-works/pi-agent-core/node";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;
		const decoder = new ShellDecoder({ ignoreBOM: true });

		const killProcess = () => {
			if (!killed && !settled) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				forceKillId = setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		const onStdout = (data: Uint8Array) => {
			if (!settled) stdout += decoder.push(data, "stdout");
		};
		const onStderr = (data: Uint8Array) => {
			if (!settled) stderr += decoder.push(data, "stderr");
		};
		const onStdoutEnd = () => {
			if (!settled) stdout += decoder.end("stdout");
		};
		const onStderrEnd = () => {
			if (!settled) stderr += decoder.end("stderr");
		};
		const finalize = (code: number) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (forceKillId) clearTimeout(forceKillId);
			options?.signal?.removeEventListener("abort", killProcess);
			proc.stdout.removeListener("data", onStdout);
			proc.stderr.removeListener("data", onStderr);
			proc.stdout.removeListener("end", onStdoutEnd);
			proc.stderr.removeListener("end", onStderrEnd);
			stdout += decoder.end("stdout");
			stderr += decoder.end("stderr");
			proc.stdout.destroy();
			proc.stderr.destroy();
			resolve({ stdout, stderr, code, killed });
		};
		const onReadError = () => {
			if (settled) return;
			killed = true;
			proc.kill("SIGKILL");
			finalize(1);
		};
		proc.stdout.on("data", onStdout);
		proc.stderr.on("data", onStderr);
		proc.stdout.once("end", onStdoutEnd);
		proc.stderr.once("end", onStderrEnd);
		// Keep error guards attached through stream destruction and any queued errors.
		proc.stdout.on("error", onReadError);
		proc.stderr.on("error", onReadError);

		// Preserve the existing idle-pipe grace for detached descendants.
		waitForChildProcess(proc).then(
			(code) => finalize(code ?? 0),
			() => finalize(1),
		);

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}
	});
}
