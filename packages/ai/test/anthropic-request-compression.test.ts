import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeZlib from "node:zlib";
import { gunzipSync, gzipSync } from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { createRequestCompressionFetch } from "../src/utils/request-compression.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
};
const content = "A code-heavy conversation with Unicode: 日本語.\n".repeat(1000);
const context = normalizeContext({ messages: [{ role: "user", content, timestamp: 1 }] });
const endpoint = "https://api.anthropic.com/v1/messages?beta=true";
const sse = [
	{
		type: "message_start",
		message: { id: "msg_test", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
	},
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");
const response = () => new Response(sse, { headers: { "content-type": "text/event-stream" } });
const directories: string[] = [];
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "pi-compression-"));
	directories.push(dir);
	return dir;
}
function request(body: RequestInit["body"] = JSON.stringify({ text: content })): RequestInit {
	return { method: "POST", headers: { "content-type": "application/json" }, body };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("direct Anthropic request gzip", () => {
	it.each([
		{ apiKey: "test-api-key" },
		{ apiKey: "sk-ant-oat-test-oauth" },
		{ headers: { Authorization: "Bearer test-header-token" } },
	] satisfies AnthropicOptions[])("compresses final SDK JSON losslessly with auth %j", async (auth) => {
		let sent: RequestInit | undefined;
		let finalPayload: unknown;
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			expect(String(input)).toBe(endpoint);
			sent = init;
			return response();
		});
		const onResponse = vi.fn();
		const result = await stream(model, context, {
			...auth,
			fetch,
			onResponse,
			onPayload: (payload) => {
				finalPayload = { ...(payload as object), metadata: { user_id: "final-payload" } };
				return finalPayload;
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(onResponse).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledOnce();
		expect(sent?.body).toBeInstanceOf(Uint8Array);
		const bytes = sent?.body as Uint8Array;
		const decoded = gunzipSync(bytes).toString("utf8");
		// The SDK moves betas to headers rather than sending them in JSON.
		const { betas: _betas, ...expected } = finalPayload as Record<string, unknown>;
		expect(JSON.parse(decoded)).toEqual(expected);
		expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(decoded) / 4);
		const headers = new Headers(sent?.headers);
		expect(headers.get("content-encoding")).toBe("gzip");
		expect(headers.get("content-type")).toBe("application/json");
		if (auth.apiKey === "test-api-key") expect(headers.get("x-api-key")).toBe(auth.apiKey);
		else expect(headers.get("authorization")).toContain("Bearer ");
	});

	it.each([
		"https://gateway.example",
		"https://api.anthropic.com.example",
		"https://api.anthropic.com:8443",
		"http://api.anthropic.com",
		"https://api.anthropic.com/proxy",
	])("leaves compatible/custom route %s uncompressed through the SDK", async (baseUrl) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			expect(typeof init?.body).toBe("string");
			expect(new Headers(init?.headers).has("content-encoding")).toBe(false);
			return response();
		});
		expect((await stream({ ...model, baseUrl }, context, { apiKey: "test", fetch }).result()).stopReason).toBe(
			"stop",
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("preserves injected SDK clients, even when their endpoint is canonical", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			expect(typeof init?.body).toBe("string");
			expect(new Headers(init?.headers).has("content-encoding")).toBe(false);
			return response();
		});
		const client = new Anthropic({ apiKey: "test", fetch });
		expect((await stream(model, context, { client }).result()).stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("preserves federation token caching and never compresses token exchanges", async () => {
		const identityTokenFile = join(directory(), "identity.jwt");
		writeFileSync(identityTokenFile, "header.payload.signature");
		const paths: string[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const path = new URL(String(input)).pathname;
			paths.push(path);
			if (path === "/v1/oauth/token") {
				expect(typeof init?.body).toBe("string");
				expect(new Headers(init?.headers).has("content-encoding")).toBe(false);
				return Response.json({ access_token: "federated-token", expires_in: 3600 });
			}
			expect(new Headers(init?.headers).get("content-encoding")).toBe("gzip");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer federated-token");
			expect(gunzipSync(init?.body as Uint8Array).toString()).toContain("日本語");
			return response();
		};
		for (let i = 0; i < 2; i++) {
			const result = await stream(model, context, {
				fetch,
				env: {
					ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
					ANTHROPIC_ORGANIZATION_ID: "org-test",
					ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
				},
			}).result();
			expect(result.stopReason).toBe("stop");
		}
		expect(paths).toEqual(["/v1/oauth/token", "/v1/messages", "/v1/messages"]);
	});

	it("keeps retry payloads and opt-in logical/wire tracing accurate without recording plaintext", async () => {
		const dir = directory();
		vi.stubEnv("PI_CACHE_TRACE_DIR", dir);
		vi.stubEnv("PI_CACHE_TRACE_SESSION_ID", "");
		const bodies: Uint8Array[] = [];
		const result = await stream(model, context, {
			apiKey: "private-api-key",
			maxRetries: 1,
			fetch: async (_input, init) => {
				bodies.push(init?.body as Uint8Array);
				return bodies.length === 1
					? Response.json(
							{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
							{
								status: 529,
								headers: { "retry-after": "0" },
							},
						)
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
		expect(logical[0].fullBody.bytes).toBe(gunzipSync(bodies[0]).byteLength);
		const wire = records.filter((record) => record.kind === "wire");
		expect(wire).toHaveLength(2);
		expect(wire[0].envelope.bytes).toBe(bodies[0].byteLength);
		expect(records.filter((record) => record.kind === "coverage_gap")).toEqual([]);
		expect(log).not.toContain("private-api-key");
		expect(log).not.toContain("日本語");
	});

	it("sends correct bytes over HTTP and lets native fetch decode compressed SSE responses", async () => {
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
				apiKey: "test",
				// Route only the offline test's final request to a local receiver.
				fetch: (_input, init) => globalThis.fetch(`http://127.0.0.1:${address.port}`, init),
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(encoding).toBe("gzip");
			expect(Number(length)).toBe(received?.byteLength);
			expect(gunzipSync(received!).toString()).toContain("日本語");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});

describe("gzip eligibility and runtime fallbacks", () => {
	it.each([
		[endpoint, request("{}")],
		[endpoint, { ...request(), headers: { "content-type": "application/json", "Content-Encoding": "identity" } }],
		[endpoint, { ...request(), headers: { "content-type": "application/json", "Content-Encoding": "gzip" } }],
		[endpoint, { ...request(), headers: { "content-type": "text/plain" } }],
		[endpoint, { ...request(), method: "GET" }],
		[endpoint, request(new Uint8Array(2048))],
		[endpoint, request(new Blob([content]))],
		["https://api.anthropic.com/v1/oauth/token", request()],
		["https://api.anthropic.com/v1/messages/count_tokens", request()],
		["https://user@api.anthropic.com/v1/messages", request()],
		["not a URL", request()],
	] as const)("passes ineligible request through unchanged (%s)", async (url, init) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("anthropic-messages", fetch)(url, init);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(url, init);
		expect(fetch.mock.calls[0][1]).toBe(init);
	});

	it("uses UTF-8 bytes for the threshold and removes stale length without mutating caller headers", async () => {
		const body = JSON.stringify({ text: "日".repeat(400) });
		expect(body.length).toBeLessThan(1024);
		const headers = new Headers({
			"content-type": "application/json; charset=utf-8",
			"content-length": "9999",
			"x-test": "keep",
		});
		const init = { ...request(body), headers };
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("anthropic-messages", fetch)(new URL(endpoint), init);
		const sent = fetch.mock.calls[0][1]!;
		expect(new Headers(sent.headers).get("content-encoding")).toBe("gzip");
		expect(new Headers(sent.headers).has("content-length")).toBe(false);
		expect(new Headers(sent.headers).get("x-test")).toBe("keep");
		expect(headers.get("content-length")).toBe("9999");
		expect(headers.has("content-encoding")).toBe(false);
		expect(gunzipSync(sent.body as Uint8Array).toString()).toBe(body);
	});

	it.each(["unavailable", "failed", "larger"])("falls back to original JSON when %s", async (mode) => {
		const zlib = process.getBuiltinModule("node:zlib") as typeof NodeZlib;
		if (mode === "unavailable") {
			vi.stubGlobal("process", undefined);
			vi.stubGlobal("CompressionStream", undefined);
		} else if (mode === "failed")
			vi.spyOn(zlib, "gzip").mockImplementation(() => {
				throw new Error("gzip failed");
			});
		else
			vi.spyOn(zlib, "gzip").mockImplementation((_input, _options, callback) =>
				callback(null, Buffer.alloc(100000)),
			);
		const init = request();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("anthropic-messages", fetch)(endpoint, init);
		expect(fetch.mock.calls[0][1]).toBe(init);
	});

	it("uses native Web CompressionStream when Node builtins are unavailable", async () => {
		vi.stubGlobal("process", undefined);
		const init = request();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await createRequestCompressionFetch("anthropic-messages", fetch)(endpoint, init);
		const sent = fetch.mock.calls[0][1]!;
		expect(new Headers(sent.headers).get("content-encoding")).toBe("gzip");
		expect(gunzipSync(sent.body as Uint8Array).toString()).toBe(init.body);
	});

	it("settles an aborted stream before queued native compression completes", async () => {
		const zlib = process.getBuiltinModule("node:zlib") as typeof NodeZlib;
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		let finish!: () => void;
		vi.spyOn(zlib, "gzip").mockImplementation((_input, _options, callback) => {
			finish = () => callback(null, Buffer.from("late result"));
			entered.resolve();
		});
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		const result = stream(model, context, { apiKey: "test", fetch, signal: controller.signal }).result();
		await entered.promise;
		controller.abort();
		try {
			expect((await result).stopReason).toBe("aborted");
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			finish();
		}
	}, 1500);

	it("stops waiting for Web CompressionStream on abort", async () => {
		vi.stubGlobal("process", undefined);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.stubGlobal(
			"CompressionStream",
			class {
				readable: ReadableStream;
				writable: WritableStream;
				constructor() {
					const stream = new TransformStream({
						transform: async (chunk, output) => {
							entered.resolve();
							await finish.promise;
							output.enqueue(chunk);
						},
					});
					this.readable = stream.readable;
					this.writable = stream.writable;
				}
			},
		);
		const controller = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		const result = createRequestCompressionFetch("anthropic-messages", fetch)(endpoint, {
			...request(),
			signal: controller.signal,
		});
		await entered.promise;
		controller.abort();
		try {
			await expect(result).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			finish.resolve();
		}
	}, 1500);
});
