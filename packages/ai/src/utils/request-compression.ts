import type * as NodeZlib from "node:zlib";
import { raceWithAbortSignal } from "./abort.ts";

const MIN_COMPRESSION_BYTES = 1024;

/** Endpoint support evidence and deliberate exclusions are recorded in docs/compression.md. */
async function compressRequest(
	input: Parameters<typeof globalThis.fetch>[0],
	init?: RequestInit,
): Promise<RequestInit | undefined> {
	if (init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return init;
	let url: URL;
	try {
		url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
	} catch {
		return init;
	}
	const encoding = "gzip";
	const origin = "https://api.anthropic.com";
	const path = "/v1/messages";
	if (url.origin !== origin || url.pathname !== path || url.username || url.password) return init;
	const headers = new Headers(init.headers);
	if (
		headers.has("content-encoding") ||
		headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
	)
		return init;
	const bytes = new TextEncoder().encode(init.body);
	if (bytes.byteLength < MIN_COMPRESSION_BYTES) return init;
	init.signal?.throwIfAborted();
	let compressed: Uint8Array<ArrayBuffer> | undefined;
	try {
		// Native acquisition keeps Node builtins out of browser bundles.
		const zlib = (typeof process !== "undefined" ? process.getBuiltinModule?.("node:zlib") : undefined) as
			| typeof NodeZlib
			| undefined;
		let compression: Promise<Uint8Array<ArrayBuffer> | undefined> | undefined;
		if (encoding === "gzip" && zlib?.gzip) {
			compression = new Promise<Uint8Array<ArrayBuffer> | undefined>((resolve) => {
				// Prefer upload latency over maximum compression; do not block the event loop.
				zlib.gzip(bytes, { level: 1 }, (error, result) => resolve(error ? undefined : new Uint8Array(result)));
			});
		} else if (encoding === "gzip" && typeof CompressionStream !== "undefined") {
			// Direct Anthropic Messages permits Content-Encoding in its browser CORS preflight.
			const body = new Blob([bytes])
				.stream()
				.pipeThrough(new CompressionStream("gzip"), { signal: init.signal ?? undefined });
			compression = new Response(body).arrayBuffer().then((buffer) => new Uint8Array(buffer));
		}
		if (compression) {
			// Native work may be queued behind unrelated thread-pool jobs. Stop waiting
			// promptly on cancellation while still observing any late result/rejection.
			compressed = await (init.signal ? raceWithAbortSignal(compression, init.signal) : compression);
		}
	} catch {
		// Compression is an optimization, not a prerequisite for a request.
	}
	init.signal?.throwIfAborted();
	if (!compressed || compressed.byteLength >= bytes.byteLength) return init;
	headers.set("content-encoding", encoding);
	// The transport must calculate the length from the compressed bytes.
	headers.delete("content-length");
	return { ...init, headers, body: compressed };
}

export function createAnthropicRequestCompressionFetch(fetch?: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => (fetch ?? globalThis.fetch)(input, await compressRequest(input, init));
}
