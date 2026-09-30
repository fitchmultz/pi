interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();
const pendingRecordCleanups = new Set<() => void>();
// Native SIGTERM shutdown deliberately skips a blocked stdout drain.
process.once("exit", () => {
	for (const cleanup of pendingRecordCleanups) cleanup();
});

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string | Uint8Array): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				// Writable emits an error as well as reporting it to the callback.
				// Keep it handled until the promise settles so owned record stages can be removed.
				const onError = (error: Error) => reject(error);
				process.stdout.once("error", onError);
				const cleanup = () => process.stdout.off("error", onError);
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) {
							reject(error);
							queueMicrotask(cleanup);
						} else {
							cleanup();
							resolve();
						}
					});
				} catch (error) {
					cleanup();
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		setImmediate(() => process.exit(1));
	});
}

/** One complete record owns the queue until its bounded chunks have drained. */
export function writeRawStdoutChunks(chunks: AsyncIterable<Uint8Array>, cleanup: () => void): void {
	const previous = rawStdoutWriteTail;
	pendingRecordCleanups.add(cleanup);
	rawStdoutWriteTail = (async () => {
		try {
			await previous;
			for await (const chunk of chunks) await writeRawStdoutChunk(chunk);
		} finally {
			pendingRecordCleanups.delete(cleanup);
			cleanup();
		}
	})();
	void rawStdoutWriteTail.catch(() => {
		// Let rejected successors run their owned-stage cleanup before the fatal exit.
		setImmediate(() => process.exit(1));
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
