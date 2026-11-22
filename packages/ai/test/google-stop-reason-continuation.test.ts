import { FinishReason } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { streamSimple as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { mapStopReason } from "../src/api/google-shared.ts";
import { streamSimple as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
import { calculateContextTokens } from "../src/utils/estimate.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function createModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "gemini-4-neon",
		name: "Gemini 4 Neon",
		api,
		provider: "google",
		baseUrl: "https://upstream.test/v1beta",
		reasoning: true,
		input: ["text"],
		// Whole-dollar token rates make multi-hop cost verification exact.
		cost: { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 262_144,
	};
}

function sse(chunk: unknown): Response {
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Google CONTINUATION finish reason", () => {
	// #12097: @google/genai 2.32.0, needed for httpOptions.fetch, adds FinishReason.CONTINUATION.
	it("maps CONTINUATION to length, like MAX_TOKENS", () => {
		expect(mapStopReason(FinishReason.CONTINUATION)).toBe("length");
	});

	it("resumes multi-hop CONTINUATION inside Pi with Hop-1 prompt size and summed output/cost", async () => {
		const fetch = vi
			.fn<FetchFunction>()
			.mockResolvedValueOnce(
				sse({
					responseId: "resp-hop-1",
					candidates: [
						{
							content: { role: "model", parts: [{ text: "thinking hard", thought: true }] },
							finishReason: "CONTINUATION",
							continuationToken: "token-1",
						},
					],
					usageMetadata: {
						promptTokenCount: 1_000,
						cachedContentTokenCount: 200,
						candidatesTokenCount: 0,
						thoughtsTokenCount: 64_000,
						totalTokenCount: 65_000,
					},
				}),
			)
			.mockResolvedValueOnce(
				sse({
					responseId: "resp-hop-2",
					candidates: [
						{
							content: { role: "model", parts: [{ text: "final answer" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 65_000,
						cachedContentTokenCount: 64_000,
						candidatesTokenCount: 5_000,
						thoughtsTokenCount: 10_000,
						totalTokenCount: 80_000,
					},
				}),
			);

		const model = createModel("google-generative-ai");
		const stream = streamGoogleGenerativeAI(model, context, { apiKey: "test-key", fetch });
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(eventTypes.filter((type) => type === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(result.rawStopReason).toBe("STOP");
		expect(result.responseId).toBe("resp-hop-1");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thinking hard", thinkingSignature: undefined },
			{ type: "text", text: "final answer" },
		]);

		// Hop 1 prompt: 800 uncached + 200 cached = 1000.
		// Hop 2 prompt: 1000 uncached + 64000 cached = 65000 (billed, but NOT summed into context size!).
		// Combined output: 64000 + 15000 = 79000; combined reasoning: 74000; true context: 80000.
		expect(result.usage).toEqual({
			input: 800,
			output: 79_000,
			cacheRead: 200,
			cacheWrite: 0,
			reasoning: 74_000,
			totalTokens: 80_000,
			cost: {
				input: 800 + 1_000,
				output: 64_000 * 2 + 15_000 * 2,
				cacheRead: 200 * 0.1 + 64_000 * 0.1,
				cacheWrite: 0,
				total: 1_800 + 158_000 + 6_420,
				totalFromProvider: false,
			},
		});
		expect(calculateContextTokens(result.usage)).toBe(80_000);
		expect(isContextOverflow(result, model.contextWindow)).toBe(false);

		const hop1Body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		const hop2Body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
		expect(hop1Body.continuationToken).toBeUndefined();
		expect(hop2Body.continuationToken).toBe("token-1");
		expect(hop2Body.contents).toEqual(hop1Body.contents);
	});

	it("retries transient HTTP failures on continuation hops through Pi's retry policy", async () => {
		const fetch = vi
			.fn<FetchFunction>()
			.mockResolvedValueOnce(
				sse({
					candidates: [
						{
							content: { role: "model", parts: [{ text: "hop1-" }] },
							finishReason: "CONTINUATION",
							continuationToken: "token-1",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: "temporary overload" } }), {
					status: 503,
					headers: { "content-type": "application/json", "retry-after-ms": "1" },
				}),
			)
			.mockResolvedValueOnce(
				sse({
					candidates: [{ content: { role: "model", parts: [{ text: "hop2" }] }, finishReason: "STOP" }],
				}),
			);

		const result = await streamGoogleVertex(createModel("google-vertex"), context, {
			apiKey: "test-key",
			fetch,
			maxRetries: 1,
		}).result();

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hop1-hop2" }]);
	});

	it("stops with length when disableContinuation is set or when the server repeats the same token", async () => {
		const chunk = {
			candidates: [
				{
					content: { role: "model", parts: [{ text: "partial" }] },
					finishReason: "CONTINUATION",
					continuationToken: "token-same",
				},
			],
		};
		const disabledFetch = vi.fn<FetchFunction>(async () => sse(chunk));
		const disabled = await streamGoogleGenerativeAI(createModel("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch: disabledFetch,
			disableContinuation: true,
		}).result();
		expect(disabledFetch).toHaveBeenCalledTimes(1);
		expect(disabled.stopReason).toBe("length");
		expect(disabled.rawStopReason).toBe("CONTINUATION");

		const repeatedFetch = vi.fn<FetchFunction>(async () => sse(chunk));
		const repeated = await streamGoogleVertex(createModel("google-vertex"), context, {
			apiKey: "test-key",
			fetch: repeatedFetch,
		}).result();
		// Hop 1 yields token-same; Hop 2 echoes token-same -> loop breaks without spinning.
		expect(repeatedFetch).toHaveBeenCalledTimes(2);
		expect(repeated.stopReason).toBe("length");
		expect(repeated.rawStopReason).toBe("CONTINUATION");
	});
});
