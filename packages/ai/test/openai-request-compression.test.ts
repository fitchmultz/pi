import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeZlib from "node:zlib";
import { gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { createRequestCompressionFetch } from "../src/utils/request-compression.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "Test GPT",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
};
const content = Array.from(
	{ length: 400 },
	(_, i) => `const item${i} = { value: "${createHash("sha256").update(String(i)).digest("hex")}", label: "日本語" };`,
).join("\n");
const context = normalizeContext({ messages: [{ role: "user", content, timestamp: 1 }] });
const endpoint = "https://api.openai.com/v1/responses";
const sse = `data: ${JSON.stringify({
	type: "response.completed",
	response: {
		id: "resp_test",
		status: "completed",
		usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
	},
})}\n\n`;
const response = () => new Response(sse, { headers: { "content-type": "text/event-stream" } });
const directories: string[] = [];
function request(body: RequestInit["body"] = JSON.stringify({ text: content })): RequestInit {
	return { method: "POST", headers: { "content-type": "application/json" }, body };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("direct OpenAI Responses request zstd", () => {
	it("compresses the final SDK JSON losslessly and preserves custom fetch, auth, callbacks, and cancellation", async () => {
		let sent: RequestInit | undefined;
		let finalPayload: unknown;
		const controller = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			expect(String(input)).toBe(endpoint);
			sent = init;
			return response();
		});
		const onResponse = vi.fn();
		const result = await stream(model, context, {
			apiKey: "sk-test-key",
			fetch,
			signal: controller.signal,
			onResponse,
			onPayload: (payload) => {
				finalPayload = { ...(payload as object), metadata: { source: "final-payload" } };
				return finalPayload;
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(onResponse).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledOnce();
		expect(sent?.body).toBeInstanceOf(Uint8Array);
		const bytes = sent?.body as Uint8Array;
		const decoded = zstdDecompressSync(bytes).toString("utf8");
		expect(JSON.parse(decoded)).toEqual(finalPayload);
		expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(decoded));
		expect(Buffer.byteLength(decoded)).toBeLessThanOrEqual(bytes.byteLength * 100);
		const headers = new Headers(sent?.headers);
		expect(headers.get("content-encoding")).toBe("zstd");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("authorization")).toBe("Bearer sk-test-key");
		// The SDK composes its own abort signal with the caller's; the wrapper keeps it.
		expect(sent?.signal).toBeInstanceOf(AbortSignal);
		controller.abort();
		expect(sent?.signal?.aborted).toBe(true);
	});

	it.each([
		"https://gateway.example/v1",
		"https://api.openai.com.example/v1",
		"https://api.openai.com:8443/v1",
		"http://api.openai.com/v1",
		"https://api.openai.com/proxy/v1",
		"https://example.openai.azure.com/openai/v1",
		"https://chatgpt.com/backend-api/codex",
	])("leaves compatible/custom SDK base %s uncompressed", async (baseUrl) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			expect(typeof init?.body).toBe("string");
			expect(new Headers(init?.headers).has("content-encoding")).toBe(false);
			expect(JSON.parse(init?.body as string).input).toBeDefined();
			return response();
		});
		expect((await stream({ ...model, baseUrl }, context, { apiKey: "sk-test", fetch }).result()).stopReason).toBe(
			"stop",
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("does not retry a compression rejection", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			expect(new Headers(init?.headers).get("content-encoding")).toBe("zstd");
			return Response.json({ error: { message: "Unsupported encoding" } }, { status: 415 });
		});
		expect((await stream(model, context, { apiKey: "sk-test", fetch }).result()).stopReason).toBe("error");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("keeps retry payloads and opt-in logical/wire trace fingerprints accurate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-openai-compression-"));
		directories.push(dir);
		vi.stubEnv("PI_CACHE_TRACE_DIR", dir);
		vi.stubEnv("PI_CACHE_TRACE_SESSION_ID", "");
		const bodies: Uint8Array[] = [];
		const result = await stream(model, context, {
			apiKey: "sk-private-test-key",
			maxRetries: 1,
			fetch: async (_input, init) => {
				bodies.push(init?.body as Uint8Array);
				return bodies.length === 1
					? Response.json({ error: { message: "Overloaded" } }, { status: 503, headers: { "retry-after": "0" } })
					: response();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toEqual(bodies[1]);
		const log = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => readFileSync(join(dir, name), "utf8"))
			.join("");
		const records = log
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const logical = records.filter((record) => record.kind === "logical");
		expect(logical).toHaveLength(1);
		expect(logical[0].fullBody.bytes).toBe(zstdDecompressSync(bodies[0]).byteLength);
		const wire = records.filter((record) => record.kind === "wire");
		expect(wire).toHaveLength(2);
		expect(wire[0].envelope.bytes).toBe(bodies[0].byteLength);
		expect(records.filter((record) => record.kind === "coverage_gap")).toEqual([]);
		expect(log).not.toContain("sk-private-test-key");
		expect(log).not.toContain("日本語");
	});

	it("sends compressed bytes over HTTP without changing compressed SSE response handling", async () => {
		let received: Buffer | undefined;
		let encoding: string | undefined;
		let length: string | undefined;
		const server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			received = Buffer.concat(chunks);
			encoding = req.headers["content-encoding"];
			length = req.headers["content-length"];
			res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
			res.end(gzipSync(sse));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing server address");
			const result = await stream(model, context, {
				apiKey: "sk-test",
				// Only the test transport routes the canonical request to an offline receiver.
				fetch: (_input, init) => globalThis.fetch(`http://127.0.0.1:${address.port}`, init),
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(encoding).toBe("zstd");
			expect(Number(length)).toBe(received?.byteLength);
			expect(zstdDecompressSync(received!).toString()).toContain("日本語");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});

describe("Responses zstd eligibility, limits, and runtime fallbacks", () => {
	it.each([
		[endpoint, request("{}")],
		[endpoint, { ...request(), headers: { "content-type": "application/json", "Content-Encoding": "identity" } }],
		[endpoint, { ...request(), headers: { "content-type": "application/json", "Content-Encoding": "zstd" } }],
		[endpoint, { ...request(), headers: { "content-type": "text/plain" } }],
		[endpoint, { ...request(), method: "GET" }],
		[endpoint, request(new Uint8Array(2048))],
		[endpoint, request(new Blob([content]))],
		["https://api.openai.com/v1/chat/completions", request()],
		["https://api.openai.com/v1/responses/compact", request()],
		["https://user@api.openai.com/v1/responses", request()],
		["not a URL", request()],
	] as const)("passes ineligible request through unchanged (%s)", async (url, init) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("openai-responses", fetch)(url, init);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(url, init);
		expect(fetch.mock.calls[0][1]).toBe(init);
	});

	it("uses UTF-8 bytes, zstd level 3, and preserves caller headers and signal", async () => {
		const body = JSON.stringify({ text: "日".repeat(400) });
		expect(body.length).toBeLessThan(1024);
		const headers = new Headers({
			"content-type": "application/json; charset=utf-8",
			"content-length": "9999",
			"x-test": "keep",
		});
		const controller = new AbortController();
		const init = { ...request(body), headers, signal: controller.signal };
		const zlib = process.getBuiltinModule("node:zlib") as typeof NodeZlib;
		const compress = vi.spyOn(zlib, "zstdCompress");
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("openai-responses", fetch)(new Request(endpoint), init);
		const sent = fetch.mock.calls[0][1]!;
		expect(compress.mock.calls[0][1]).toEqual({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
		expect(sent.signal).toBe(controller.signal);
		expect(new Headers(sent.headers).get("content-encoding")).toBe("zstd");
		expect(new Headers(sent.headers).has("content-length")).toBe(false);
		expect(new Headers(sent.headers).get("x-test")).toBe("keep");
		expect(headers.get("content-length")).toBe("9999");
		expect(headers.has("content-encoding")).toBe(false);
		expect(zstdDecompressSync(sent.body as Uint8Array).toString()).toBe(body);
	});

	it.each([1023, 1024])("uses the 1 KiB threshold for a %i-byte JSON body", async (size) => {
		const body = JSON.stringify({ x: "x".repeat(size - 8) });
		expect(Buffer.byteLength(body)).toBe(size);
		const init = request(body);
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("openai-responses", fetch)(endpoint, init);
		const sent = fetch.mock.calls[0][1]!;
		if (size < 1024) expect(sent).toBe(init);
		else {
			expect(new Headers(sent.headers).get("content-encoding")).toBe("zstd");
			expect(zstdDecompressSync(sent.body as Uint8Array).toString()).toBe(body);
		}
	});

	it("leaves highly compressible JSON unchanged to avoid the documented 100:1 rejection", async () => {
		const body = JSON.stringify({ text: "x".repeat(200000) });
		expect(Buffer.byteLength(body) / zstdCompressSync(body).byteLength).toBeGreaterThan(100);
		const init = request(body);
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("openai-responses", fetch)(endpoint, init);
		expect(fetch.mock.calls[0][1]).toBe(init);
	});

	it("skips bodies above 128 MiB before allocating UTF-8 bytes or invoking native compression", async () => {
		const zlib = process.getBuiltinModule("node:zlib") as typeof NodeZlib;
		const compress = vi.spyOn(zlib, "zstdCompress");
		const encode = vi.spyOn(TextEncoder.prototype, "encode");
		const init = request(`"${"x".repeat(128 * 1024 * 1024)}"`);
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null));
		await createRequestCompressionFetch("openai-responses", fetch)(endpoint, init);
		expect(compress).not.toHaveBeenCalled();
		expect(encode).not.toHaveBeenCalled();
		expect(fetch.mock.calls[0][1]).toBe(init);
	});

	it.each(["browser", "missing-native", "failed", "callback-error", "larger"])(
		"falls back to original JSON when %s",
		async (mode) => {
			const zlib = process.getBuiltinModule("node:zlib") as typeof NodeZlib;
			if (mode === "browser") vi.stubGlobal("process", undefined);
			else if (mode === "missing-native") vi.spyOn(process, "getBuiltinModule").mockReturnValue(undefined);
			else if (mode === "failed")
				vi.spyOn(zlib, "zstdCompress").mockImplementation(() => {
					throw new Error("zstd failed");
				});
			else if (mode === "callback-error")
				vi.spyOn(zlib, "zstdCompress").mockImplementation((_input, _options, callback) =>
					callback(new Error("zstd failed"), Buffer.alloc(0)),
				);
			else
				vi.spyOn(zlib, "zstdCompress").mockImplementation((_input, _options, callback) =>
					callback(null, Buffer.alloc(100000)),
				);
			const init = request();
			const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
			await createRequestCompressionFetch("openai-responses", fetch)(endpoint, init);
			expect(fetch.mock.calls[0][1]).toBe(init);
		},
	);

	it("settles an aborted stream before queued native compression completes", async () => {
		const zlib = process.getBuiltinModule("node:zlib") as typeof NodeZlib;
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		let finish!: () => void;
		vi.spyOn(zlib, "zstdCompress").mockImplementation((_input, _options, callback) => {
			finish = () => callback(null, Buffer.alloc(1024));
			entered.resolve();
		});
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		const result = stream(model, context, { apiKey: "sk-test", fetch, signal: controller.signal }).result();
		await entered.promise;
		controller.abort();
		try {
			expect((await result).stopReason).toBe("aborted");
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			finish();
		}
	}, 1500);
});
