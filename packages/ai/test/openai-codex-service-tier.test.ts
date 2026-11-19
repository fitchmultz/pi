import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { Model, ProviderResponse } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.2-sol",
	name: "GPT-6.2 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "Say hello", timestamp: 1 }] });
const apiKey = `aaa.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }))}.bbb`;
const rejection = {
	code: "service_tier_not_allowed",
	message:
		"Fast mode isn't available for the selected model in your workspace. Choose Standard speed or another model.",
};
const completed = {
	type: "response.completed",
	response: {
		id: "resp_success",
		status: "completed",
		usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
	},
};

function sse(event: object): Response {
	return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function httpRequestBody(body: RequestInit["body"]): Record<string, unknown> {
	const json = body instanceof Uint8Array ? zstdDecompressSync(body).toString("utf8") : body;
	if (typeof json !== "string") throw new Error("Expected a JSON request body");
	return JSON.parse(json) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex Standard service tier fallback", () => {
	it.each([
		["options", "priority"],
		["options", "ultrafast"],
		["onPayload", "priority"],
		["onPayload", "ultrafast"],
	] as const)("retries HTTP 400 when %s sets %s and bills at the Standard rate", async (source, tier) => {
		const onPayload = vi.fn((payload: unknown) =>
			source === "onPayload" && payload && typeof payload === "object"
				? Object.freeze({ ...payload, service_tier: tier })
				: undefined,
		);
		const onResponse = vi.fn<(response: ProviderResponse) => void>();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				Response.json({ error: rejection }, { status: 400, headers: { "retry-after": "86400" } }),
			)
			.mockResolvedValueOnce(sse(completed));

		const result = await stream(model, context, {
			apiKey,
			transport: "sse",
			serviceTier: source === "options" ? tier : undefined,
			onPayload,
			onResponse,
			fetch,
			maxRetries: 0,
		}).result();

		expect(result).toMatchObject({ stopReason: "stop", usage: { cost: { input: 1, output: 2, total: 3 } } });
		expect(fetch).toHaveBeenCalledTimes(2);
		const first = httpRequestBody(fetch.mock.calls[0][1]?.body);
		const second = httpRequestBody(fetch.mock.calls[1][1]?.body);
		expect(first).toHaveProperty("service_tier", tier);
		expect(second).not.toHaveProperty("service_tier");
		expect(first).toEqual({ ...second, service_tier: tier });
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(onResponse.mock.calls.map(([response]) => response.status)).toEqual([400, 200]);
	});

	it.each([
		{ tier: "priority", code: "invalid_request_error", attempts: 1 },
		{ tier: undefined, code: rejection.code, attempts: 1 },
		{ tier: "default", code: rejection.code, attempts: 1 },
		{ tier: "priority", code: rejection.code, attempts: 2 },
	] as const)(
		"makes $attempts HTTP attempts for $code with requested tier $tier",
		async ({ tier, code, attempts }) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () =>
				Response.json({ error: { code, message: "Request rejected" } }, { status: 400 }),
			);
			const result = await stream(model, context, {
				apiKey,
				transport: "sse",
				serviceTier: tier,
				maxRetries: 1,
				fetch,
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Request rejected");
			expect(fetch).toHaveBeenCalledTimes(attempts);
		},
	);

	it("does not resend when onResponse aborts the request", async () => {
		const controller = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: rejection }, { status: 400 }));
		const result = await stream(model, context, {
			apiKey,
			transport: "sse",
			serviceTier: "priority",
			signal: controller.signal,
			onResponse: () => controller.abort(),
			fetch,
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ servedTier: undefined, total: 3 },
		{ servedTier: "priority", total: 6 },
	])(
		"falls back after an SSE error event and honors the returned tier ($servedTier)",
		async ({ servedTier, total }) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(sse({ type: "error", ...rejection }))
				.mockResolvedValueOnce(
					sse({ ...completed, response: { ...completed.response, service_tier: servedTier } }),
				);
			const result = await stream(model, context, { apiKey, transport: "sse", serviceTier: "fast", fetch }).result();

			expect(result).toMatchObject({ stopReason: "stop", usage: { cost: { total } } });
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(httpRequestBody(fetch.mock.calls[1][1]?.body)).not.toHaveProperty("service_tier");
		},
	);

	it.each([
		{ type: "error", error: rejection },
		{ type: "response.failed", response: { id: "resp_rejected", status: "failed", error: rejection } },
	])("retries a WebSocket $type once without a service tier", async (failure) => {
		const requests: unknown[] = [];
		class MockWebSocket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}

			send(json: string): void {
				requests.push(JSON.parse(json));
				const event = requests.length === 1 ? failure : completed;
				queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })));
			}

			close(): void {}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);
		const fetch = vi.fn<typeof globalThis.fetch>();
		const result = await stream(model, context, {
			apiKey,
			transport: "websocket",
			serviceTier: "priority",
			fetch,
		}).result();

		expect(result).toMatchObject({ stopReason: "stop", responseId: "resp_success", usage: { cost: { total: 3 } } });
		expect(requests).toHaveLength(2);
		expect(requests[0]).toHaveProperty("service_tier", "priority");
		expect(requests[1]).not.toHaveProperty("service_tier");
		expect(fetch).not.toHaveBeenCalled();
	});
});
