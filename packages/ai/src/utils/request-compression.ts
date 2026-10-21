import type * as NodeZlib from "node:zlib";
import { raceWithAbortSignal } from "./abort.ts";
import type { CacheTrace } from "./cache-trace.ts";

const MIN_COMPRESSION_BYTES = 1024;
const MAX_OPENAI_BYTES = 128 * 1024 * 1024;
const MAX_OPENAI_RATIO = 100;
type CompressedApi = "anthropic-messages" | "openai-responses";

/** Endpoint support evidence and deliberate exclusions are recorded in docs/compression.md. */
async function compressRequest(
	api: CompressedApi,
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
	const encoding = api === "anthropic-messages" ? "gzip" : "zstd";
	const origin = encoding === "gzip" ? "https://api.anthropic.com" : "https://api.openai.com";
	const path = encoding === "gzip" ? "/v1/messages" : "/v1/responses";
	if (url.origin !== origin || url.pathname !== path || url.username || url.password) return init;
	const headers = new Headers(init.headers);
	if (
		headers.has("content-encoding") ||
		headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
	)
		return init;
	// No Web zstd codec is used: avoid copying large browser requests for a no-op.
	if (encoding === "zstd" && (typeof process === "undefined" || !process.getBuiltinModule)) return init;
	// UTF-8 cannot be smaller than the UTF-16 code-unit count. Avoid allocating
	// another oversized body before measuring its precise encoded length.
	if (encoding === "zstd" && init.body.length > MAX_OPENAI_BYTES) return init;
	const bytes = new TextEncoder().encode(init.body);
	if (bytes.byteLength < MIN_COMPRESSION_BYTES || (encoding === "zstd" && bytes.byteLength > MAX_OPENAI_BYTES))
		return init;
	init.signal?.throwIfAborted();
	let compressed: Uint8Array<ArrayBuffer> | undefined;
	try {
		// Native acquisition keeps Node builtins out of browser bundles.
		const zlib = (typeof process !== "undefined" ? process.getBuiltinModule?.("node:zlib") : undefined) as
			| typeof NodeZlib
			| undefined;
		let compression: Promise<Uint8Array<ArrayBuffer> | undefined> | undefined;
		if (encoding === "zstd" && zlib?.zstdCompress) {
			compression = new Promise<Uint8Array<ArrayBuffer> | undefined>((resolve) => {
				zlib.zstdCompress(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }, (error, result) =>
					resolve(error ? undefined : new Uint8Array(result)),
				);
			});
		} else if (encoding === "gzip" && zlib?.gzip) {
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
	// OpenAI rejects >128 MiB bodies and >100:1 decompression ratios. Do not turn
	// an otherwise valid JSON request into a compression-specific 413 response.
	if (
		encoding === "zstd" &&
		(compressed.byteLength > MAX_OPENAI_BYTES || bytes.byteLength > compressed.byteLength * MAX_OPENAI_RATIO)
	)
		return init;
	headers.set("content-encoding", encoding);
	// The transport must calculate the length from the compressed bytes.
	headers.delete("content-length");
	return { ...init, headers, body: compressed };
}

export function createRequestCompressionFetch(
	api: CompressedApi,
	fetch?: typeof globalThis.fetch,
	trace?: CacheTrace,
): typeof globalThis.fetch {
	return async (input, init) => {
		const compressed = await compressRequest(api, input, init);
		// Preserve both the SDK's final JSON and the actual wire bytes in opt-in tracing.
		return (
			trace?.wrapFetch(fetch, typeof init?.body === "string" ? init.body : undefined) ??
			fetch ??
			globalThis.fetch
		)(input, compressed);
	};
}
