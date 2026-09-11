import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAI } from "../src/api/openai-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Context, Model, StreamOptions } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "test-model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.test/v1?secret=query-secret",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
const apiKey = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-secret" } }))}.secret`;
const context: Context = {
	systemPrompt: "instructions-secret",
	messages: [{ role: "user", content: "prompt-secret 雪", timestamp: 1 }],
};

const providers = ["openai", "openai-codex", "azure-openai-responses"] as const;
function request(provider: (typeof providers)[number], options: StreamOptions & { serviceTier?: "flex" | "priority" }) {
	if (provider === "openai") return streamOpenAI(model, context, options);
	if (provider === "openai-codex")
		return streamCodex({ ...model, api: "openai-codex-responses", provider }, context, options);
	return streamAzure({ ...model, api: "azure-openai-responses", provider }, context, options);
}

afterEach(() => vi.restoreAllMocks());

describe("Responses request diagnostics", () => {
	it.each(["openai", "azure-openai-responses"] as const)("records the native SDK timeout for %s", async (provider) => {
		const result = await request(provider, {
			apiKey,
			timeoutMs: 5,
			maxRetries: 0,
			fetch: async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
				}),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics?.find((entry) => entry.type === "provider_request")?.details).toMatchObject({
			transport: "sse",
			sseAttempts: 1,
			localTimeout: "sdk_request",
			localTimeoutMs: 5,
		});
	});

	it.each(providers)("counts actual SSE request attempts across recovery for %s", async (provider) => {
		let attempts = 0;
		const result = await request(provider, {
			apiKey,
			transport: "sse",
			maxRetries: 1,
			fetch: async () =>
				++attempts === 1
					? new Response(JSON.stringify({ error: { message: "retry" } }), {
							status: 503,
							headers: { "retry-after-ms": "0" },
						})
					: new Response(
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "priority" } })}\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(attempts).toBe(2);
		expect(result.diagnostics?.find((entry) => entry.type === "provider_request")?.details).toMatchObject({
			transport: "sse",
			sseAttempts: 2,
			requestedServiceTier: "unknown",
			returnedServiceTier: "priority",
		});
	});

	it.each(providers)("retains allowlisted raw terminal tiers and error timing for %s", async (provider) => {
		for (const rawTier of ["priority", undefined, "private-tier-value"]) {
			const result = await request(provider, {
				apiKey,
				transport: "sse",
				onPayload: (payload) => ({ ...(payload as object), service_tier: "priority" }),
				fetch: async () =>
					new Response(
						`data: ${JSON.stringify({
							type: "response.failed",
							response: {
								status: "failed",
								service_tier: rawTier,
								error: { code: "server_error", message: "failed" },
							},
						})}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			}).result();
			expect(result.stopReason).toBe("error");
			const details = result.diagnostics?.find((entry) => entry.type === "provider_request")?.details;
			expect(details).toMatchObject({
				transport: "sse",
				requestedServiceTier: "priority",
				returnedServiceTier: rawTier === "priority" ? "priority" : "unknown",
				applicationEvents: 1,
				terminalEventMs: expect.any(Number),
				finishedMs: expect.any(Number),
			});
			expect(JSON.stringify(details)).not.toContain("private-tier-value");
			expect(details?.finishedMs).toBeGreaterThanOrEqual(details?.terminalEventMs as number);
		}
	});

	it.each(providers)("records a failed onPayload hook without claiming a network attempt for %s", async (provider) => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		const fetch = vi.fn<typeof globalThis.fetch>();
		const result = await request(provider, {
			apiKey,
			transport: "sse",
			fetch,
			onPayload: () => {
				clock = 12;
				throw new Error("hook failed");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fetch).not.toHaveBeenCalled();
		const details = result.diagnostics?.find((entry) => entry.type === "provider_request")?.details;
		expect(details).toMatchObject({
			prepareMs: 0,
			onPayloadMs: 12,
			finishedMs: 12,
			applicationEvents: 0,
			sseAttempts: 0,
			websocketAttempts: 0,
		});
		expect(details).not.toHaveProperty("transport");
	});

	it.each(providers)("records post-hook and raw tiers with SSE boundary timings for %s", async (provider) => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		const events = [
			{ type: "response.created", response: { id: "response-secret" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg-secret", role: "assistant", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, delta: "text-secret" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg-secret",
					role: "assistant",
					content: [{ type: "output_text", text: "text-secret" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "response-secret",
					status: "completed",
					service_tier: "default",
					usage: { input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000 },
				},
			},
		];
		let sentBody: Record<string, unknown> | undefined;
		let sentBytes = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			const body = init?.body;
			sentBytes =
				typeof body === "string" ? new TextEncoder().encode(body).byteLength : (body as Uint8Array).byteLength;
			sentBody = JSON.parse(
				typeof body === "string" ? body : zstdDecompressSync(body as Uint8Array).toString("utf8"),
			);
			clock = 20;
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							clock += 10;
							const event = events.shift();
							if (event) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
							else controller.close();
						},
					},
					{ highWaterMark: 0 },
				),
				{ headers: { "content-type": "text/event-stream", "x-secret": "header-secret" } },
			);
		});
		const options = {
			apiKey,
			transport: "sse" as const,
			serviceTier: "flex" as const,
			fetch,
			headers: { "x-secret": "request-header-secret" },
			onPayload: (payload: unknown) => {
				clock = 10;
				return { ...(payload as Record<string, unknown>), service_tier: "priority" };
			},
			onResponse: () => {
				clock = 30;
			},
		};
		const result = await request(provider, options).result();
		expect(result.stopReason).toBe("stop");
		expect(sentBody?.service_tier).toBe("priority");
		const diagnostic = result.diagnostics?.find((entry) => entry.type === "provider_request");
		expect(diagnostic).toMatchObject({
			details: {
				timingOrigin: "adapter_start",
				transport: "sse",
				requestedServiceTier: "priority",
				returnedServiceTier: "default",
				prepareMs: 0,
				onPayloadMs: 10,
				requestReadyMs: 10,
				headersMs: 20,
				firstApplicationEventMs: 40,
				firstContentDeltaMs: 60,
				terminalEventMs: 80,
				applicationEvents: 5,
				sseAttempts: 1,
				websocketAttempts: 0,
			},
		});
		expect(diagnostic?.details?.finishedMs).toBeGreaterThanOrEqual(80);
		if (provider === "openai-codex") {
			expect(diagnostic?.details?.sseSendBytes).toBe(sentBytes);
			expect(diagnostic?.details?.fullBodyBytes).toBe(new TextEncoder().encode(JSON.stringify(sentBody)).byteLength);
		}
		// Pricing still follows the existing option/raw-tier rules, not the diagnostic fields.
		expect(result.usage.cost.total).toBe(provider === "openai-codex" ? 1.5 : 3);
		const encoded = JSON.stringify(diagnostic);
		expect(encoded).not.toContain("secret");
		expect(
			Object.values(diagnostic!.details!).every((value) => ["string", "number", "boolean"].includes(typeof value)),
		).toBe(true);
		expect(JSON.stringify(convertResponsesMessages(model, { messages: [result] }, new Set([provider])))).not.toMatch(
			/diagnostics|provider_request|requestedServiceTier|timingOrigin/,
		);
	});
});
