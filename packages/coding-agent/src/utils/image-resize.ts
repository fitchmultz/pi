import { Worker } from "node:worker_threads";
import {
	convertImageBytesToPngInProcess,
	IMAGE_CONVERT_PNG_WORKER_RESPONSE_TYPE,
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizedImage,
	resizeImageInProcess,
} from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

type WorkerReply<TResult> = { type: string; result: TResult } | { type: string; error: string };

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer detaches the buffer, so transfer a worker-owned copy and leave the
	// caller's bytes intact.
	return new Uint8Array(input);
}

function isTypedWorkerResponse<TResult>(value: unknown, expectedType: string): value is WorkerReply<TResult> {
	return value !== null && typeof value === "object" && "type" in value && value.type === expectedType;
}

function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

async function runImageWorker<TResult>(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	payload: Record<string, unknown>,
	responseType: string,
): Promise<TResult> {
	const worker = createResizeWorker(workerSpecifier);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<TResult>((resolve, reject) => {
			let settled = false;
			const settle = (result: TResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			worker.on("message", (message: unknown) => {
				// Ignore messages Node posts on the worker channel itself, such as
				// `{ "watch:require": [...] }` under `node --watch` (nodejs/node#65044).
				if (!isTypedWorkerResponse<TResult>(message, responseType)) return;
				if ("error" in message) fail(new Error(message.error));
				else settle(message.result);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			worker.postMessage(
				{
					...payload,
					inputBytes: inputBytesForWorker,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		// Await termination so a serial resize never starts a worker while this one is
		// still shutting down; that overlap aborted the process on macOS with Node 24 (#10695).
		await worker.terminate().catch(() => undefined);
	}
}

async function runPhotonTaskWithFallback<TResult>(
	inputBytes: Uint8Array,
	payload: Record<string, unknown>,
	responseType: string,
	fallback: () => Promise<TResult>,
): Promise<TResult> {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	// Bun compiled executables resolve worker entrypoints by string path, not via
	// new URL(..., import.meta.url). Try the string path first under Bun so the
	// release binary uses the embedded worker instead of falling back in-process.
	if (typeof process.versions.bun === "string") {
		try {
			return await runImageWorker<TResult>("./src/utils/image-resize-worker.ts", inputBytes, payload, responseType);
		} catch {}
	}

	try {
		return await runImageWorker<TResult>(workerUrl, inputBytes, payload, responseType);
	} catch {
		return fallback();
	}
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Runs Photon in a worker thread so WASM decoding, resizing, and encoding do not
 * block the TUI event loop. If the worker cannot be loaded (for example in some
 * Bun compiled executable layouts), fall back to in-process resizing so image
 * reads still work.
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	return runPhotonTaskWithFallback<ResizedImage | null>(
		inputBytes,
		{ op: "resize", mimeType, options },
		IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
		() => resizeImageInProcess(inputBytes, mimeType, options),
	);
}

/**
 * Decode an image and re-encode it as oriented PNG bytes in a short-lived worker thread,
 * releasing Photon's WASM linear memory on worker exit. Falls back in-process if needed.
 */
export async function convertImageBytesToPngInWorker(inputBytes: Uint8Array): Promise<Uint8Array | null> {
	return runPhotonTaskWithFallback<Uint8Array | null>(
		inputBytes,
		{ op: "convert-png" },
		IMAGE_CONVERT_PNG_WORKER_RESPONSE_TYPE,
		() => convertImageBytesToPngInProcess(inputBytes),
	);
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply x coordinates by ${result.originalWidth}/${result.width} and y coordinates by ${result.originalHeight}/${result.height} to map to original image.]`;
}
