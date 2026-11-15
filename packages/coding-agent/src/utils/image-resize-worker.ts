import { parentPort } from "node:worker_threads";
import {
	type ConvertPngWorkerResponse,
	convertImageBytesToPngInProcess,
	IMAGE_CONVERT_PNG_WORKER_RESPONSE_TYPE,
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizeImageWorkerResponse,
	resizeImageInProcess,
} from "./image-resize-core.ts";

type ImageWorkerRequest =
	| {
			op?: "resize";
			inputBytes: Uint8Array;
			mimeType: string;
			options?: ImageResizeOptions;
	  }
	| {
			op: "convert-png";
			inputBytes: Uint8Array;
	  };

function isImageWorkerRequest(value: unknown): value is ImageWorkerRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.op === "convert-png") {
		return record.inputBytes instanceof Uint8Array;
	}
	if (record.op !== undefined && record.op !== "resize") return false;
	return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}

const port = parentPort;
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

port.once("message", (message: unknown) => {
	void (async () => {
		const isConvertPng =
			message !== null && typeof message === "object" && (message as Record<string, unknown>).op === "convert-png";
		try {
			if (!isImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			if (message.op === "convert-png") {
				const result = await convertImageBytesToPngInProcess(message.inputBytes);
				const response: ConvertPngWorkerResponse = { type: IMAGE_CONVERT_PNG_WORKER_RESPONSE_TYPE, result };
				if (result && result.byteOffset === 0 && result.byteLength === result.buffer.byteLength) {
					port.postMessage(response, [result.buffer]);
				} else {
					port.postMessage(response);
				}
				return;
			}
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			const response: ResizeImageWorkerResponse = { type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE, result };
			port.postMessage(response);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const response: ResizeImageWorkerResponse | ConvertPngWorkerResponse = isConvertPng
				? { type: IMAGE_CONVERT_PNG_WORKER_RESPONSE_TYPE, error: errorMessage }
				: { type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE, error: errorMessage };
			port.postMessage(response);
		}
	})();
});
