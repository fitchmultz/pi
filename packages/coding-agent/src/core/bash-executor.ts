/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { ShellDecoder, type ShellSource } from "@earendil-works/pi-agent-core/node";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;
	let acceptingOutput = true;
	let tempFileCompletion: Promise<void> | undefined;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath, { flags: "wx", mode: 0o600 });
		tempFileCompletion = finished(tempFileStream, { cleanup: true });
		void tempFileCompletion.catch(() => {});
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new ShellDecoder();

	const appendText = (decoded: string) => {
		// Interactive full logs contain sanitized text, unlike the tool's raw spill.
		const text = sanitizeBinaryOutput(stripAnsi(decoded)).replace(/\r/g, "");
		if (text.length === 0) return;
		if (tempFileStream) tempFileStream.write(text);

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const onData = (data: Buffer, source: ShellSource) => {
		if (!acceptingOutput) return;
		totalBytes += data.length;
		if (totalBytes > DEFAULT_MAX_BYTES) ensureTempFile();
		appendText(decoder.push(data, source));
	};
	const onEnd = (source: ShellSource) => {
		if (acceptingOutput) appendText(decoder.end(source));
	};

	let execution: { exitCode: number | null } | undefined;
	let executionError: unknown;
	try {
		execution = await operations.exec(command, cwd, { onData, onEnd, signal: options?.signal });
	} catch (error) {
		executionError = error;
	}
	acceptingOutput = false;
	let truncationResult: ReturnType<typeof truncateTail>;
	try {
		appendText(decoder.finish());
		truncationResult = truncateTail(outputChunks.join(""));
		if (truncationResult.truncated) ensureTempFile();
	} finally {
		tempFileStream?.end();
		await tempFileCompletion;
	}

	const cancelled = options?.signal?.aborted ?? false;
	if (!execution && !cancelled) throw executionError;
	return {
		output: truncationResult.content,
		exitCode: cancelled ? undefined : (execution?.exitCode ?? undefined),
		cancelled,
		truncated: truncationResult.truncated,
		fullOutputPath: tempFilePath,
	};
}
