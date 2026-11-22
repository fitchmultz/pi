import type { GenerateContentParameters } from "@google/genai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { AssistantMessageEvent, FetchFunction, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<T extends "google-generative-ai" | "google-vertex">(api: T): Model<T> {
	return {
		id: "gemini-3-flash-preview",
		name: "Synthetic Gemini",
		api,
		provider: "test-provider",
		baseUrl: "https://google.invalid/v1",
		reasoning: true,
		input: ["text"],
		// Whole-dollar token rates make the accounting expectations exact.
		cost: { input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

function respond(chunks: unknown[]) {
	const fetch = vi.fn<FetchFunction>(
		async () =>
			new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			}),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

// Record event values at delivery time: partial messages remain mutable during streaming.
function eventValue(event: AssistantMessageEvent) {
	if (event.type === "done" || event.type === "error") return [event.type, event.reason];
	if (event.type === "start") return [event.type];
	if ("delta" in event) return [event.type, event.contentIndex, event.delta];
	if ("content" in event) return [event.type, event.contentIndex, event.content];
	return [event.type, event.contentIndex];
}

afterEach(() => vi.unstubAllGlobals());

describe("Google SDK streaming protocol", () => {
	it("preserves block transitions, replay signatures, tool IDs and cached/thinking usage", async () => {
		const fetch = respond([
			{
				responseId: "",
				candidates: [{ content: { parts: [{ text: "plan", thought: true, thoughtSignature: "dGhpbms=" }] } }],
			},
			{
				responseId: "first-response",
				candidates: [
					{
						content: {
							parts: [
								{ text: " more", thought: true },
								{ text: "", thoughtSignature: "dGV4dA==" },
								{ text: "Answer" },
							],
						},
					},
				],
			},
			{
				responseId: "later-response",
				candidates: [
					{
						content: {
							parts: [
								{ functionCall: { id: "given", name: "lookup", args: { n: 1 } }, thoughtSignature: "dG9vbA==" },
								{ functionCall: { id: "given", name: "lookup", args: { n: 2 } } },
								{ functionCall: { name: "lookup" } },
								{ text: "after tools" },
							],
						},
					},
				],
			},
			{
				candidates: [{ finishReason: "STOP" }],
				usageMetadata: {
					promptTokenCount: 100,
					cachedContentTokenCount: 20,
					candidatesTokenCount: 10,
					thoughtsTokenCount: 5,
					totalTokenCount: 115,
				},
			},
		]);
		const stream = streamGoogle(model("google-generative-ai"), context, { apiKey: "test-key" });
		const events: ReturnType<typeof eventValue>[] = [];
		for await (const event of stream) events.push(eventValue(event));
		const result = await stream.result();

		expect(events).toEqual([
			["start"],
			["thinking_start", 0],
			["thinking_delta", 0, "plan"],
			["thinking_delta", 0, " more"],
			["thinking_end", 0, "plan more"],
			["text_start", 1],
			["text_delta", 1, ""],
			["text_delta", 1, "Answer"],
			["text_end", 1, "Answer"],
			["toolcall_start", 2],
			["toolcall_delta", 2, '{"n":1}'],
			["toolcall_end", 2],
			["toolcall_start", 3],
			["toolcall_delta", 3, '{"n":2}'],
			["toolcall_end", 3],
			["toolcall_start", 4],
			["toolcall_delta", 4, "{}"],
			["toolcall_end", 4],
			["text_start", 5],
			["text_delta", 5, "after tools"],
			["text_end", 5, "after tools"],
			["done", "toolUse"],
		]);
		expect(result).toMatchObject({
			api: "google-generative-ai",
			provider: "test-provider",
			model: "gemini-3-flash-preview",
			responseId: "first-response",
			rawStopReason: "STOP",
		});
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "plan more", thinkingSignature: "dGhpbms=" },
			{ type: "text", text: "Answer", textSignature: "dGV4dA==" },
			{ type: "toolCall", id: "given", name: "lookup", arguments: { n: 1 }, thoughtSignature: "dG9vbA==" },
			{ type: "toolCall", id: expect.stringMatching(/^lookup_\d+_\d+$/), name: "lookup", arguments: { n: 2 } },
			{ type: "toolCall", id: expect.stringMatching(/^lookup_\d+_\d+$/), name: "lookup", arguments: {} },
			{ type: "text", text: "after tools" },
		]);
		const ids = result.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
		expect(new Set(ids).size).toBe(3);
		expect(result.usage).toEqual({
			input: 80,
			output: 15,
			cacheRead: 20,
			cacheWrite: 0,
			reasoning: 5,
			totalTokens: 115,
			cost: { input: 80, output: 30, cacheRead: 60, cacheWrite: 0, total: 170, totalFromProvider: false },
		});
		expect(fetch).toHaveBeenCalledOnce();

		let replay: GenerateContentParameters | undefined;
		await streamGoogle(model("google-generative-ai"), { messages: [...context.messages, result] } as typeof context, {
			apiKey: "test-key",
			onPayload: (payload) => {
				replay = payload as GenerateContentParameters;
				throw new Error("captured replay");
			},
		}).result();
		expect(replay?.contents).toMatchObject([
			{ role: "user" },
			{
				role: "model",
				parts: [
					{ text: "plan more", thought: true, thoughtSignature: "dGhpbms=" },
					{ text: "Answer", thoughtSignature: "dGV4dA==" },
					{ functionCall: { id: "given", name: "lookup", args: { n: 1 } }, thoughtSignature: "dG9vbA==" },
					{ functionCall: { name: "lookup", args: { n: 2 } } },
					{ functionCall: { name: "lookup", args: {} } },
					{ text: "after tools" },
				],
			},
			{ role: "user" }, // Missing tool results are synthesized by transcript normalization.
		]);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([
		{ id: "gemini-4-neon", tier: "flex", input: 40, output: 15, cacheRead: 30, total: 85 },
		{ id: "gemini-4-neon", tier: "priority", input: 144, output: 54, cacheRead: 108, total: 306 },
		{ id: "gemini-4-carbon", tier: "flex", input: 40, output: 15, cacheRead: 30, total: 85 },
		{ id: "gemini-4-carbon", tier: "priority", input: 144, output: 54, cacheRead: 108, total: 306 },
		{ id: "gemini-4-argon", tier: "priority", input: 144, output: 54, cacheRead: 108, total: 306 },
		{ id: "gemini-3.5-flash-lite", tier: "priority", input: 144, output: 54, cacheRead: 100, total: 298 },
		{ id: "gemini-3.5-flash-lite", tier: "flex", input: 40, output: 15, cacheRead: 40, total: 95 },
		{ id: "gemini-2.5-pro", tier: "flex", input: 40, output: 15, cacheRead: 60, total: 115 },
		{ id: "gemini-4-carbon", tier: "standard", input: 80, output: 30, cacheRead: 60, total: 170 },
		{ id: "gemini-4-carbon", tier: undefined, input: 80, output: 30, cacheRead: 60, total: 170 },
		{ id: "gemini-4-carbon", tier: "unknown", input: 80, output: 30, cacheRead: 60, total: 170 },
		{ id: "custom-model", tier: "priority", input: 80, output: 30, cacheRead: 60, total: 170 },
		{
			id: "gemini-4-carbon",
			provider: "custom-proxy",
			tier: "priority",
			input: 80,
			output: 30,
			cacheRead: 60,
			total: 170,
		},
	])(
		"prices $id from returned $tier rather than requested Priority",
		async ({ id, provider = "google", tier, input, output, cacheRead, total }) => {
			const fetch = respond([
				{
					candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
					usageMetadata: {
						promptTokenCount: 100,
						cachedContentTokenCount: 20,
						candidatesTokenCount: 10,
						thoughtsTokenCount: 5,
						totalTokenCount: 115,
						serviceTier: tier,
					},
				},
			]);
			const result = await streamGoogle({ ...model("google-generative-ai"), id, provider }, context, {
				apiKey: "test-key",
				onPayload: (payload) => {
					const params = payload as GenerateContentParameters;
					return { ...params, config: { ...params.config, serviceTier: "priority" } };
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.usage).toEqual({
				input: 80,
				output: 15,
				cacheRead: 20,
				cacheWrite: 0,
				reasoning: 5,
				totalTokens: 115,
				cost: { input, output, cacheRead, cacheWrite: 0, total, totalFromProvider: false },
			});
			expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toHaveProperty("serviceTier", "priority");
		},
	);

	it.each([
		{
			api: "google-generative-ai",
			prefix: "Google",
			run: () => streamGoogle(model("google-generative-ai"), context, { apiKey: "test-key" }),
		},
		{
			api: "google-vertex",
			prefix: "Google Vertex",
			run: () => streamVertex(model("google-vertex"), context, { apiKey: "test-key" }),
		},
	])("retains $api identity and fails an empty SDK stream", async ({ api, prefix, run }) => {
		respond([]);
		const stream = run();
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		expect(events).toEqual(["start", "error"]);
		expect(await stream.result()).toMatchObject({
			api,
			provider: "test-provider",
			content: [],
			stopReason: "error",
			errorMessage: `${prefix} stream ended without a finish reason`,
			usage: { input: 0, output: 0, totalTokens: 0 },
		});
	});

	it("keeps consumed usage and partial content when the SDK stream fails without retrying", async () => {
		const fetch = vi.fn<FetchFunction>(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } })}\n\n`,
								),
							);
						},
						pull(controller) {
							controller.error(new Error("stream disconnected"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		vi.stubGlobal("fetch", fetch);
		const stream = streamVertex(model("google-vertex"), context, { apiKey: "test-key", maxRetries: 2 });
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		expect(events).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(await stream.result()).toMatchObject({
			content: [{ type: "text", text: "partial" }],
			stopReason: "error",
			errorMessage: "stream disconnected",
			usage: { input: 4, output: 2, totalTokens: 6 },
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("builds current system/tools config and sends payload-hook replacements through the SDK", async () => {
		const fetch = respond([{ candidates: [{ finishReason: "STOP" }] }]);
		const controller = new AbortController();
		const transcript = normalizeContext({
			systemPrompt: "base",
			tools: [{ name: "removed", description: "old", parameters: Type.Object({}) }],
			messages: [
				...context.messages,
				{
					role: "system",
					content: "update",
					toolsRemoved: [{ name: "removed" }],
					toolsAdded: [
						{
							name: "lookup",
							description: "Find a value",
							parameters: Type.Object({ value: Type.String() }),
							constrainedSampling: { type: "json_schema", strict: "require" },
						},
					],
					timestamp: 1,
				},
			],
		});
		const vertexModel = model("google-vertex");
		const result = await streamVertex(vertexModel, transcript, {
			apiKey: "test-key",
			temperature: 0,
			maxTokens: 23,
			signal: controller.signal,
			thinking: { enabled: true, level: "MEDIUM", budgetTokens: 999 },
			onPayload: (payload, requestModel) => {
				expect(requestModel).toBe(vertexModel);
				const params = payload as GenerateContentParameters;
				expect(params).toMatchObject({
					model: "gemini-3-flash-preview",
					contents: [{ role: "user", parts: [{ text: "hello" }] }],
					config: {
						automaticContinuation: false,
						temperature: 0,
						maxOutputTokens: 23,
						systemInstruction: "base\n\nupdate",
						thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
						toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
					},
				});
				expect(params.config?.abortSignal).toBe(controller.signal);
				expect(params.config?.thinkingConfig).not.toHaveProperty("thinkingBudget");
				expect(params.config?.tools).toMatchObject([
					{ functionDeclarations: [{ name: "lookup", parametersJsonSchema: { required: ["value"] } }] },
				]);
				return { ...params, config: { ...params.config, temperature: 0.75 } };
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
		expect(body).toMatchObject({
			generationConfig: {
				temperature: 0.75,
				maxOutputTokens: 23,
				thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
			},
			toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
		});
		expect(body.tools[0].functionDeclarations).toHaveLength(1);
		expect(body.tools[0].functionDeclarations[0].name).toBe("lookup");
	});

	it.each([
		{ api: "google-generative-ai" as const, id: "gemini-4-neon", expected: ["\nuser\n"] },
		{ api: "google-generative-ai" as const, id: "vendor-gemini-4-neon", expected: ["\nuser\n"] },
		{ api: "google-vertex" as const, id: "gemini-4-neon", expected: ["\nuser\n"] },
		{ api: "google-generative-ai" as const, id: "gemini-4-carbon", expected: undefined },
		{ api: "google-generative-ai" as const, id: "gemini-4-hydrogen", expected: undefined },
	])("sets stopSequences=$expected for $api/$id", async ({ api, id, expected }) => {
		const fetch = respond([{ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]);
		const stream =
			api === "google-generative-ai"
				? streamGoogle({ ...model(api), id }, context, { apiKey: "test-key" })
				: streamVertex({ ...model(api), id }, context, { apiKey: "test-key" });
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		const body = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as {
			generationConfig?: { stopSequences?: string[] };
		};
		if (expected === undefined) {
			expect(body.generationConfig?.stopSequences).toBeUndefined();
		} else {
			expect(body.generationConfig?.stopSequences).toEqual(expected);
		}
	});

	it("rejects a pre-aborted request before payload hooks or HTTP", async () => {
		const fetch = respond([]);
		const controller = new AbortController();
		controller.abort();
		const onPayload = vi.fn();
		const stream = streamGoogle(model("google-generative-ai"), context, {
			apiKey: "test-key",
			signal: controller.signal,
			onPayload,
		});
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		expect(events).toEqual(["error"]);
		expect(await stream.result()).toMatchObject({
			stopReason: "aborted",
			content: [],
			errorMessage: "Request aborted",
		});
		expect(onPayload).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "google provider via gateway",
			target: { ...model("google-generative-ai"), provider: "google", baseUrl: "https://gateway.invalid/v1beta" },
			expectedStore: false,
		},
		{
			name: "direct Gemini API host",
			target: {
				...model("google-generative-ai"),
				provider: "custom",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			},
			expectedStore: false,
		},
		{
			name: "custom non-Gemini endpoint",
			target: { ...model("google-generative-ai"), provider: "custom", baseUrl: "https://proxy.invalid/v1" },
			expectedStore: undefined,
		},
		{
			name: "google-vertex",
			target: { ...model("google-vertex"), provider: "google-vertex" },
			expectedStore: undefined,
		},
	])("sets store=$expectedStore for $name", async ({ target, expectedStore }) => {
		const fetch = respond([{ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]);
		const result =
			target.api === "google-generative-ai"
				? await streamGoogle(target, context, { apiKey: "test-key" }).result()
				: await streamVertex(target, context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		const body = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as { store?: boolean };
		expect(body.store).toBe(expectedStore);
	});

	it.each([
		{ id: "gemini-4-neon", compat: undefined, expected: undefined },
		{ id: "gemini-4-carbon", compat: undefined, expected: undefined },
		{ id: "vendor-gemini-4-argon", compat: undefined, expected: undefined },
		{ id: "gemini-3.6-flash", compat: undefined, expected: undefined },
		{ id: "gemini-3.8-flash", compat: undefined, expected: undefined },
		{ id: "gemini-3.5-flash", compat: undefined, expected: 0.4 },
		{ id: "gemini-3-flash-preview", compat: undefined, expected: 0.4 },
		{ id: "gemini-4-neon", compat: { supportsTemperature: true }, expected: 0.4 },
		{ id: "gemini-3.5-flash", compat: { supportsTemperature: false }, expected: undefined },
	])("sends temperature=$expected for $id (compat=$compat)", async ({ id, compat, expected }) => {
		const fetch = respond([{ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]);
		const result = await streamGoogle({ ...model("google-generative-ai"), id, compat }, context, {
			apiKey: "test-key",
			temperature: 0.4,
		}).result();

		expect(result.stopReason).toBe("stop");
		const body = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as {
			generationConfig?: { temperature?: number };
		};
		expect(body.generationConfig?.temperature).toBe(expected);
	});

	it("surfaces promptFeedback blockReason and keeps only PROHIBITED_CONTENT retryable", async () => {
		respond([
			{
				promptFeedback: {
					blockReason: "SAFETY",
					blockReasonMessage: "Blocked by safety filter",
				},
			},
		]);
		const safetyResult = await streamGoogle(model("google-generative-ai"), context, { apiKey: "test-key" }).result();
		expect(safetyResult.stopReason).toBe("error");
		expect(safetyResult.rawStopReason).toBe("SAFETY");
		expect(safetyResult.errorMessage).toBe("Prompt blocked (SAFETY): Blocked by safety filter");
		expect(isRetryableAssistantError(safetyResult)).toBe(false);

		respond([{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }]);
		const prohibitedResult = await streamGoogle(model("google-generative-ai"), context, {
			apiKey: "test-key",
		}).result();
		expect(prohibitedResult.stopReason).toBe("error");
		expect(prohibitedResult.rawStopReason).toBe("PROHIBITED_CONTENT");
		expect(prohibitedResult.errorMessage).toBe("Prompt blocked: PROHIBITED_CONTENT");
		expect(isRetryableAssistantError(prohibitedResult)).toBe(true);
	});

	it("invokes onResponse and honors Retry-After / x-should-retry headers on HTTP errors", async () => {
		const observed: Array<{ status: number; headers: Record<string, string> }> = [];
		const fetch = vi
			.fn<FetchFunction>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after-ms": "1", "x-request-id": "req-1" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
					{
						status: 200,
						headers: { "content-type": "text/event-stream", "x-request-id": "req-2" },
					},
				),
			);
		const result = await streamGoogle(model("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch,
			maxRetries: 1,
			onResponse: (response) => {
				observed.push(response);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(observed).toEqual([
			expect.objectContaining({ status: 429, headers: expect.objectContaining({ "x-request-id": "req-1" }) }),
			expect.objectContaining({ status: 200, headers: expect.objectContaining({ "x-request-id": "req-2" }) }),
		]);

		const stopFetch = vi.fn<FetchFunction>(
			async () =>
				new Response(JSON.stringify({ error: { message: "stop retrying" } }), {
					status: 429,
					headers: { "content-type": "application/json", "x-should-retry": "false" },
				}),
		);
		const stopResult = await streamGoogle(model("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch: stopFetch,
			maxRetries: 2,
		}).result();
		expect(stopResult.stopReason).toBe("error");
		expect(stopFetch).toHaveBeenCalledTimes(1);
	});

	it("bounds only response-header wait with timeoutMs and leaves active streams running", async () => {
		const slowHeadersFetch = vi.fn<FetchFunction>(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const timedOut = await streamGoogle(model("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch: slowHeadersFetch,
			timeoutMs: 25,
		}).result();
		expect(timedOut.stopReason).toBe("error");
		expect(timedOut.errorMessage).toBe("Google response headers timed out after 25ms");
		expect(isRetryableAssistantError(timedOut)).toBe(true);

		const slowBodyFetch = vi.fn<FetchFunction>(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							setTimeout(() => {
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "slow stream ok" }] }, finishReason: "STOP" }] })}\n\n`,
									),
								);
								controller.close();
							}, 40);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const streamed = await streamGoogle(model("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch: slowBodyFetch,
			timeoutMs: 20,
		}).result();
		expect(streamed.stopReason).toBe("stop");
		expect(streamed.content).toEqual([{ type: "text", text: "slow stream ok" }]);
	});
});
