import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import type { Model, StreamOptions } from "../src/types.ts";
import { cacheTraceDigest, createCacheTrace } from "../src/utils/cache-trace.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const originalDirectory = process.env.PI_CACHE_TRACE_DIR;
const directories: string[] = [];
function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-cache-trace-"));
	directories.push(path);
	process.env.PI_CACHE_TRACE_DIR = path;
	return path;
}
function records(path: string): Record<string, unknown>[] {
	return readdirSync(path)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) =>
			readFileSync(join(path, name), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		);
}
function model<T extends "openai-responses" | "openai-completions" | "anthropic-messages">(api: T): Model<T> {
	return {
		id: "test-model",
		name: "test",
		api,
		provider: "test",
		baseUrl: "https://provider.test/v1",
		input: ["text", "image"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}
afterEach(() => {
	if (originalDirectory === undefined) delete process.env.PI_CACHE_TRACE_DIR;
	else process.env.PI_CACHE_TRACE_DIR = originalDirectory;
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("private opt-in cache recorder", () => {
	it("does no serialization or builtin acquisition when disabled or in a browser", () => {
		delete process.env.PI_CACHE_TRACE_DIR;
		const builtin = vi.spyOn(process, "getBuiltinModule");
		const compat = vi.fn(() => {
			throw new Error("must not resolve disabled metadata");
		});
		expect(createCacheTrace(model("openai-responses"), undefined, undefined, compat)).toBeUndefined();
		expect(compat).not.toHaveBeenCalled();
		const toJSON = vi.fn(() => {
			throw new Error("must not read disabled content");
		});
		expect(createCacheTrace(model("openai-responses"))).toBeUndefined();
		expect(cacheTraceDigest({ toJSON })).toBeUndefined();
		expect(builtin).not.toHaveBeenCalled();
		expect(toJSON).not.toHaveBeenCalled();
		vi.stubGlobal("process", undefined);
		expect(createCacheTrace(model("openai-responses"))).toBeUndefined();
		expect(cacheTraceDigest({ toJSON })).toBeUndefined();
		vi.unstubAllGlobals();
	});

	describe.each(["openai-responses", "openai-completions", "anthropic-messages"] as const)(
		"%s SDK boundary",
		(api) => {
			it.each([0, 1, 2])(
				"captures final serialized payload with %s stateful serializations without changing requests",
				async (serializations) => {
					const path = directory();
					const key = "PRIVATE_AUTH_KEY";
					const prompt = "PRIVATE_PROMPT";
					const image = Buffer.from("PRIVATE_IMAGE").toString("base64");
					const schema = "PRIVATE_SCHEMA";
					const context = normalizeContext({
						systemPrompt: prompt,
						messages: [
							{
								role: "user",
								timestamp: 0,
								content: [
									{ type: "text", text: prompt },
									{ type: "image", data: image, mimeType: "image/png" },
								],
							},
						],
						tools: [
							{
								name: "private_tool",
								description: schema,
								parameters: Type.Object({ value: Type.String({ description: schema }) }),
							},
						],
					});
					const payloads: string[][] = [];
					for (const enabled of [false, true]) {
						if (enabled) process.env.PI_CACHE_TRACE_DIR = path;
						else delete process.env.PI_CACHE_TRACE_DIR;
						const sent: string[] = [];
						let serializationCalls = 0;
						payloads.push(sent);
						const options: StreamOptions = {
							apiKey: key,
							maxRetries: serializations === 1 ? 0 : 1,
							headers: { cookie: "PRIVATE_COOKIE", authorization: `Bearer ${key}` },
							cacheTraceContext: {
								purpose: "parent",
								sessionId: "PRIVATE_SESSION",
								extensions: [{ path: "PRIVATE_EXTENSION_PATH", loaded: false }],
							},
							onPayload(payload) {
								const body = payload as Record<string, unknown>;
								// Last wrapper, including Claude fitting/replacement before native stream restoration.
								const replacement =
									api === "anthropic-messages"
										? { ...body, system: [{ type: "text", text: "LATE_PRIVATE_PROMPT" }], stream: false }
										: { ...body, model: "late-model", service_tier: "fast" };
								if (serializations === 0) return replacement;
								return {
									...replacement,
									toJSON() {
										serializationCalls++;
										return { ...replacement, stream: true, model: `late-model-${serializationCalls}` };
									},
								};
							},
							fetch: async (_input, init) => {
								sent.push(String(init?.body));
								if (sent.length === 1 && serializations !== 1)
									return new Response('{"error":{"message":"temporarily unavailable"}}', {
										status: 503,
										headers: { "retry-after-ms": "0", "content-type": "application/json" },
									});
								const events =
									api === "anthropic-messages"
										? [
												{
													type: "message_start",
													message: {
														id: "msg_safe",
														model: "test-model",
														usage: { input_tokens: 20, output_tokens: 0 },
													},
												},
												{
													type: "message_delta",
													delta: { stop_reason: "end_turn" },
													usage: { output_tokens: 7 },
												},
												{ type: "message_stop" },
											]
										: api === "openai-responses"
											? [
													{
														type: "response.completed",
														response: {
															id: "resp_safe",
															status: "completed",
															usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 },
														},
													},
												]
											: [
													{
														id: "chatcmpl_safe",
														choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
														usage: { prompt_tokens: 20, completion_tokens: 7 },
													},
												];
								return new Response(
									events
										.map(
											(event) =>
												`${api === "anthropic-messages" ? `event: ${"type" in event ? event.type : ""}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
										)
										.join(""),
									{
										headers: {
											"content-type": "text/event-stream",
											"x-request-id": "req_safe",
											"set-cookie": "PRIVATE_RESPONSE_COOKIE",
										},
									},
								);
							},
						};
						const stream =
							api === "openai-responses"
								? responses(model(api), context, options)
								: api === "openai-completions"
									? completions(model(api), context, options)
									: anthropic(model(api), context, options);
						const result = await stream.result();
						expect(result.stopReason).toBe("stop");
						expect(sent).toHaveLength(serializations === 1 ? 1 : 2);
						expect(serializationCalls).toBe(serializations);
						if (api === "anthropic-messages") expect(JSON.parse(sent[0]).stream).toBe(true);
						else expect(JSON.parse(sent[0]).model).toBe(serializations === 0 ? "late-model" : "late-model-1");
					}
					expect(payloads[1]).toEqual(payloads[0]);
					const captured = records(path);
					const logicals = captured.filter((record) => record.kind === "logical");
					expect(logicals).toHaveLength(1);
					const logical = logicals[0];
					const wires = captured.filter((record) => record.kind === "wire");
					expect(wires).toHaveLength(serializations === 1 ? 1 : 2);
					expect(wires[0].envelope).toEqual(logical?.fullBody);
					if (serializations === 2) {
						expect(wires[1].envelope).not.toEqual(wires[0].envelope);
						expect(captured.filter((record) => record.kind === "coverage_gap")).toContainEqual(
							expect.objectContaining({ reason: "retry_logical_body_changed" }),
						);
					} else if (serializations === 0) expect(wires[1].envelope).toEqual(wires[0].envelope);
					expect(captured.filter((record) => record.kind === "attempt")).toHaveLength(
						serializations === 1 ? 1 : 2,
					);
					expect(
						captured.filter((record) => record.kind === "http_response").map((record) => record.status),
					).toEqual(serializations === 1 ? [200] : [503, 200]);
					if (api === "openai-completions")
						expect(captured.find((record) => record.kind === "terminal")?.responseId).toBe("chatcmpl_safe");
					if (api !== "anthropic-messages") expect(logical?.requested).toMatchObject({ tier: "fast" });
					const text = JSON.stringify(captured);
					for (const secret of [
						key,
						prompt,
						image,
						schema,
						"PRIVATE_COOKIE",
						"PRIVATE_RESPONSE_COOKIE",
						"PRIVATE_SESSION",
						"PRIVATE_EXTENSION_PATH",
						"LATE_PRIVATE_PROMPT",
					])
						expect(text).not.toContain(secret);
					expect(statSync(path).mode & 0o777).toBe(0o700);
					for (const name of readdirSync(path)) expect(statSync(join(path, name)).mode & 0o777).toBe(0o600);
					expect(readFileSync(join(path, "investigation.key"))).toHaveLength(32);
				},
			);
		},
	);

	it.each(["public-key", "symlink-key", "symlink-directory", "public-directory"] as const)(
		"refuses %s without overwriting or accepting it",
		(unsafe) => {
			const path = directory();
			const key = join(path, "investigation.key");
			const original = Buffer.alloc(32, 7);
			if (unsafe === "public-key") writeFileSync(key, original, { mode: 0o644 });
			if (unsafe === "symlink-key") {
				const target = join(path, "target");
				writeFileSync(target, original, { mode: 0o600 });
				symlinkSync(target, key);
			}
			if (unsafe === "symlink-directory") {
				const alias = `${path}-link`;
				directories.push(alias);
				symlinkSync(path, alias);
				process.env.PI_CACHE_TRACE_DIR = alias;
			}
			if (unsafe === "public-directory") chmodSync(path, 0o755);
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(createCacheTrace(model("openai-responses"))).toBeUndefined();
			expect(readdirSync(path).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
			if (unsafe === "public-key" || unsafe === "symlink-key") expect(readFileSync(key)).toEqual(original);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("coverage gap"));
		},
	);

	it("fails open at real fetch when metadata access throws and rejects nested/unknown metadata", async () => {
		const path = directory();
		const trace = createCacheTrace(model("openai-responses"))!;
		const response = new Response("ok");
		const get = vi.spyOn(response.headers, "get").mockImplementation(() => {
			throw new Error("PRIVATE_HEADER_ERROR");
		});
		const fetch = vi.fn(async () => response);
		const init = { body: '{"input":"PRIVATE_BODY"}', method: "POST" };
		expect(
			await trace.wrapFetch(fetch)(
				"https://user:PRIVATE_PASSWORD@provider.test/responses?token=PRIVATE_URL_TOKEN",
				init,
			),
		).toBe(response);
		expect(fetch).toHaveBeenCalledWith(
			"https://user:PRIVATE_PASSWORD@provider.test/responses?token=PRIVATE_URL_TOKEN",
			init,
		);
		trace.event("send", { reason: { secret: "PRIVATE_NESTED_SECRET" } });
		trace.event("PRIVATE_EVENT", { PRIVATE_FIELD: "PRIVATE_VALUE" });
		get.mockRestore();
		const captured = records(path);
		expect(captured.filter((record) => record.kind === "coverage_gap").length).toBeGreaterThan(0);
		expect(JSON.stringify(captured)).not.toMatch(/PRIVATE_/);
		expect(captured.find((record) => record.kind === "send")?.endpoint).toBe("https://provider.test");
	});

	it.each(
		(["record", "key", "directory"] as const).flatMap((replaced) =>
			(["fetch", "digest", "admission"] as const).map((entry) => ({ replaced, entry })),
		),
	)(
		"stops capture after same-mode $replaced replacement at $entry without changing fetch",
		async ({ replaced, entry }) => {
			const path = directory();
			const trace = createCacheTrace(model("openai-responses"))!;
			const file = readdirSync(path).find((name) => name.endsWith(".jsonl"))!;
			const originals = new Map(readdirSync(path).map((name) => [name, readFileSync(join(path, name))]));
			const target = replaced === "directory" ? path : join(path, replaced === "key" ? "investigation.key" : file);
			const previous = `${target}-previous`;
			renameSync(target, previous);
			if (replaced === "directory") {
				directories.push(previous);
				mkdirSync(path, { mode: 0o700 });
				for (const [name, bytes] of originals) writeFileSync(join(path, name), bytes, { mode: 0o600 });
			} else {
				writeFileSync(target, readFileSync(previous), { mode: 0o600 });
			}
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			const toJSON = vi.fn(() => ({ private: "must not serialize" }));
			if (entry === "digest") expect(cacheTraceDigest({ toJSON })).toBeUndefined();
			if (entry === "admission") expect(createCacheTrace(model("openai-responses"))).toBeUndefined();
			const response = new Response("ok");
			const fetch = vi.fn(async () => response);
			const init = { body: '{"input":"PRIVATE_BODY"}', method: "POST" };
			expect(await trace.wrapFetch(fetch)("https://provider.test/v1/responses", init)).toBe(response);
			expect(fetch).toHaveBeenCalledWith("https://provider.test/v1/responses", init);
			expect(cacheTraceDigest({ toJSON })).toBeUndefined();
			expect(toJSON).not.toHaveBeenCalled();
			expect(createCacheTrace(model("openai-responses"))).toBeUndefined();
			for (const [name, bytes] of originals) expect(readFileSync(join(path, name))).toEqual(bytes);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("coverage gap"));
		},
	);

	it("separates cache markers and controls from semantic prefixes without stripping schema/arguments", () => {
		const path = directory();
		const trace = createCacheTrace(model("openai-responses"))!;
		const body = {
			instructions: "PRIVATE_INSTRUCTION",
			tools: [{ parameters: { properties: { cache_control: { type: "string" } } } }],
			input: [
				{ role: "user", content: [{ type: "text", text: "PRIVATE_TEXT", cache_control: { type: "ephemeral" } }] },
			],
			service_tier: "default",
		};
		trace.logical(body);
		trace.logical({
			...body,
			service_tier: "fast",
			input: [
				{
					role: "user",
					content: [{ type: "text", text: "PRIVATE_TEXT", cache_control: { type: "ephemeral", ttl: "1h" } }],
				},
				{ role: "user", content: "new suffix" },
			],
		});
		trace.logical({ ...body, tools: [{ parameters: { properties: { cache_control: { type: "number" } } } }] });
		const logical = records(path).filter((record) => record.kind === "logical");
		const components = logical.map(
			(record) => record.components as { group: string; hmac: string; prefix: string }[],
		);
		expect(components[1].slice(0, components[0].length)).toEqual(components[0]);
		expect(logical[1].controls).not.toEqual(logical[0].controls);
		expect(logical[1].cacheMarkers).not.toEqual(logical[0].cacheMarkers);
		expect(components[2].find((item) => item.group === "tools")?.hmac).not.toBe(
			components[0].find((item) => item.group === "tools")?.hmac,
		);
	});

	it("caps individual records and stops further capture with an explicit gap", () => {
		const path = directory();
		const trace = createCacheTrace(model("openai-responses"))!;
		trace.logical({ input: Array.from({ length: 1800 }, () => ({ content: "PRIVATE_LIMIT_TEXT" })) });
		const captured = records(path);
		expect(captured.at(-1)).toMatchObject({ kind: "coverage_gap", reason: "record_limit", incomplete: true });
		expect(createCacheTrace(model("openai-responses"))).toBeUndefined();
		expect(JSON.stringify(captured)).not.toContain("PRIVATE_LIMIT_TEXT");
	});

	it("caps a process file and expires the shared investigation rather than rotating silently", () => {
		const path = directory();
		const trace = createCacheTrace(model("openai-responses"))!;
		const payload = { input: Array.from({ length: 800 }, () => ({ content: "PRIVATE_LIMIT_TEXT" })) };
		for (let i = 0; i < 200; i++) trace.logical(payload);
		expect(records(path).at(-1)).toMatchObject({ kind: "coverage_gap", reason: "file_limit", incomplete: true });
		const file = readdirSync(path).find((name) => name.endsWith(".jsonl"))!;
		expect(statSync(join(path, file)).size).toBeLessThanOrEqual(16 * 1024 * 1024);
		const fresh = directory();
		expect(createCacheTrace(model("openai-responses"))).toBeDefined();
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
		const toJSON = vi.fn();
		expect(cacheTraceDigest({ toJSON })).toBeUndefined();
		expect(toJSON).not.toHaveBeenCalled();
		expect(records(fresh).at(-1)).toMatchObject({ kind: "coverage_gap", reason: "lifetime_limit", incomplete: true });
	});
});
