import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model, ProviderHeaders } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Runs the real Anthropic SDK against a fake fetch to verify header merging,
// auth header omission/override, and case-insensitive anthropic-version overrides.

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createRecordingFetch(requests: Request[]): typeof globalThis.fetch {
	return async (input, init) => {
		requests.push(new Request(input, init));
		return sseResponse();
	};
}

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

describe("Anthropic Messages headers with the real SDK", () => {
	it("removes x-api-key via null for custom gateway headers without failing SDK auth validation", async () => {
		const requests: Request[] = [];

		const message = await streamAnthropic(anthropicModel, context, {
			apiKey: "resolved-key",
			headers: { "x-api-key": null, "x-custom": "gateway-token" },
			fetch: createRecordingFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("x-api-key")).toBeNull();
		expect(requests[0].headers.get("authorization")).toBeNull();
		expect(requests[0].headers.get("x-custom")).toBe("gateway-token");
	});

	it("preserves explicit Authorization when x-api-key is removed via null", async () => {
		const requests: Request[] = [];

		const message = await streamAnthropic(anthropicModel, context, {
			apiKey: "resolved-key",
			headers: { "X-Api-Key": null, Authorization: "Bearer custom-token" },
			fetch: createRecordingFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("x-api-key")).toBeNull();
		expect(requests[0].headers.get("authorization")).toBe("Bearer custom-token");
	});

	it("allows cf-aig-authorization without Authorization: null", async () => {
		const requests: Request[] = [];

		const message = await streamAnthropic(anthropicModel, context, {
			headers: { "cf-aig-authorization": "Bearer cf-token" },
			fetch: createRecordingFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("x-api-key")).toBeNull();
		expect(requests[0].headers.get("authorization")).toBeNull();
		expect(requests[0].headers.get("cf-aig-authorization")).toBe("Bearer cf-token");
	});

	it("uses the resolved apiKey when x-api-key is explicitly undefined in headers", async () => {
		const requests: Request[] = [];
		const headers = { "x-api-key": undefined } as unknown as ProviderHeaders;

		const message = await streamAnthropic(anthropicModel, context, {
			apiKey: "resolved-key",
			headers,
			fetch: createRecordingFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("x-api-key")).toBe("resolved-key");
	});

	it("lets options.headers anthropic-version override a differently cased model.headers entry", async () => {
		const requests: Request[] = [];
		const modelWithVersion: Model<"anthropic-messages"> = {
			...anthropicModel,
			headers: { "Anthropic-Version": "2024-01-01" },
		};

		const message = await streamAnthropic(modelWithVersion, context, {
			apiKey: "resolved-key",
			headers: { "anthropic-version": "2025-01-01" },
			fetch: createRecordingFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("anthropic-version")).toBe("2025-01-01");
	});

	it("lets options.headers anthropic-version: null remove a differently cased model.headers entry", async () => {
		const requests: Request[] = [];
		const modelWithVersion: Model<"anthropic-messages"> = {
			...anthropicModel,
			headers: { "Anthropic-Version": "2024-01-01" },
		};

		const message = await streamAnthropic(modelWithVersion, context, {
			apiKey: "resolved-key",
			headers: { "anthropic-version": null },
			fetch: createRecordingFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("anthropic-version")).toBeNull();
	});
});
