import type { GenerateContentParameters } from "@google/genai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle, streamSimple as streamGoogleSimple } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessageEvent, FetchFunction, Model, Tool } from "../src/types.ts";
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

afterEach(() => {
	vi.unstubAllGlobals();
	cleanupSessionResources();
});

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
			errorMessage: `${prefix} stream ended without a finish reason after receiving 0 chunks`,
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
		expect(safetyResult.errorMessage).toBe("Google prompt blocked: SAFETY. Blocked by safety filter");
		expect(isRetryableAssistantError(safetyResult)).toBe(false);

		respond([{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }]);
		const prohibitedResult = await streamGoogle(model("google-generative-ai"), context, {
			apiKey: "test-key",
		}).result();
		expect(prohibitedResult.stopReason).toBe("error");
		expect(prohibitedResult.rawStopReason).toBe("PROHIBITED_CONTENT");
		expect(prohibitedResult.errorMessage).toBe("Google prompt blocked: PROHIBITED_CONTENT");
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

	it("splits consecutive same-type parts with distinct thought signatures and preserves signature-only parts", async () => {
		const sig1 = "QUFBQQ==";
		const sig2 = "QkJCQg==";
		const sig3 = "Q0NDQw==";
		const sig4 = "RERERA==";
		const sig5 = "RUVFRQ==";
		respond([
			{
				candidates: [
					{
						content: {
							parts: [
								{ text: "thought A", thought: true, thoughtSignature: sig1 },
								{ text: "thought B", thought: true, thoughtSignature: sig2 },
								{ thought: true, thoughtSignature: sig3 },
								{ text: "part 1", thoughtSignature: sig4 },
								{ text: "part 2", thoughtSignature: sig5 },
								{ thoughtSignature: sig1 },
							],
						},
						finishReason: "STOP",
					},
				],
			},
		]);
		const target = { ...model("google-generative-ai"), id: "gemini-4-neon", provider: "google" };
		const result = await streamGoogle(target, context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thought A", thinkingSignature: sig1 },
			{ type: "thinking", thinking: "thought B", thinkingSignature: sig2 },
			{ type: "thinking", thinking: "", thinkingSignature: sig3 },
			{ type: "text", text: "part 1", textSignature: sig4 },
			{ type: "text", text: "part 2", textSignature: sig5 },
			{ type: "text", text: "", textSignature: sig1 },
		]);

		let replay: GenerateContentParameters | undefined;
		await streamGoogle(target, { messages: [...context.messages, result] } as typeof context, {
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
					{ thought: true, text: "thought A", thoughtSignature: sig1 },
					{ thought: true, text: "thought B", thoughtSignature: sig2 },
					{ thought: true, text: "", thoughtSignature: sig3 },
					{ text: "part 1", thoughtSignature: sig4 },
					{ text: "part 2", thoughtSignature: sig5 },
					{ text: "", thoughtSignature: sig1 },
				],
			},
		]);
	});

	it("attaches a trailing signature-only part onto the current unsigned block without splitting", async () => {
		const sig = "QUFBQQ==";
		respond([
			{
				candidates: [
					{
						content: {
							parts: [{ text: "hello" }, { thoughtSignature: sig }],
						},
						finishReason: "STOP",
					},
				],
			},
		]);
		const result = await streamGoogle(model("google-generative-ai"), context, { apiKey: "test-key" }).result();
		expect(result.content).toEqual([{ type: "text", text: "hello", textSignature: sig }]);
	});

	it("falls back once from VALIDATED on 400 schema rejection for prefer tools and memoizes per session", async () => {
		const preferredTool: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: Type.Object({ value: Type.String(), optional: Type.Optional(Type.Number()) }),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};
		const transcript = normalizeContext({
			tools: [preferredTool],
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		const bodies: Array<Record<string, unknown>> = [];
		const fetch = vi.fn<FetchFunction>(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			if (bodies.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							code: 400,
							status: "INVALID_ARGUMENT",
							message: "The specified schema produces a constraint that has too many states for serving.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		});

		const target = { ...model("google-generative-ai"), id: "gemini-4-neon" };
		const first = await streamGoogle(target, transcript, {
			apiKey: "test-key",
			fetch,
			sessionId: "sess-strict-fallback",
		}).result();
		expect(first.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toMatchObject({ toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } });
		expect(bodies[1].toolConfig).toBeUndefined();
		expect(first.diagnostics?.[0]).toMatchObject({
			type: "google_strict_tools_fallback",
			details: { reason: "strict_tool_schema_rejected" },
		});

		// Subsequent turn in the same session skips VALIDATED immediately.
		const second = await streamGoogle(target, transcript, {
			apiKey: "test-key",
			fetch,
			sessionId: "sess-strict-fallback",
		}).result();
		expect(second.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(bodies[2].toolConfig).toBeUndefined();

		// Cleanup resets session memory.
		cleanupSessionResources("sess-strict-fallback");
		await streamGoogle(target, transcript, {
			apiKey: "test-key",
			fetch,
			sessionId: "sess-strict-fallback",
		}).result();
		expect(bodies).toHaveLength(4);
		expect(bodies[3]).toMatchObject({ toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } });
	});

	it("does not relax strict:require tools or downgrade unrelated 400 errors", async () => {
		const requireTool: Tool = {
			name: "must_be_strict",
			description: "Required strict tool",
			parameters: Type.Object({ value: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "require" },
		};
		const preferTool: Tool = {
			name: "prefer_strict",
			description: "Preferred strict tool",
			parameters: Type.Object({ value: Type.String(), optional: Type.Optional(Type.Number()) }),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};

		// require-only: never retries.
		const requireFetch = vi.fn<FetchFunction>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 400,
							status: "INVALID_ARGUMENT",
							message: "The specified schema produces a constraint that has too many states for serving.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		);
		const requireResult = await streamGoogle(
			{ ...model("google-generative-ai"), id: "gemini-4-neon" },
			normalizeContext({ tools: [requireTool], messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{ apiKey: "test-key", fetch: requireFetch },
		).result();
		expect(requireResult.stopReason).toBe("error");
		expect(requireFetch).toHaveBeenCalledTimes(1);

		// Mixed prefer + require: relaxes prefer schema while keeping VALIDATED for require.
		const mixedBodies: Array<Record<string, unknown>> = [];
		const mixedFetch = vi.fn<FetchFunction>(async (_input, init) => {
			mixedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			if (mixedBodies.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							code: 400,
							status: "INVALID_ARGUMENT",
							message: "The specified schema produces a constraint that has too many states for serving.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const mixedResult = await streamGoogle(
			{ ...model("google-generative-ai"), id: "gemini-4-neon" },
			normalizeContext({
				tools: [preferTool, requireTool],
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
			}),
			{ apiKey: "test-key", fetch: mixedFetch },
		).result();
		expect(mixedResult.stopReason).toBe("stop");
		expect(mixedBodies).toHaveLength(2);
		expect(mixedBodies[1]).toMatchObject({ toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } });
		const secondDecls = (
			mixedBodies[1].tools as Array<{
				functionDeclarations: Array<{ parametersJsonSchema: { required?: string[] } }>;
			}>
		)[0].functionDeclarations;
		expect(secondDecls[0].parametersJsonSchema.required).toEqual(["value"]);
		expect(secondDecls[1].parametersJsonSchema.required).toEqual(["value"]);

		// Unrelated 400 (e.g. missing thought_signature): never downgrades.
		const unrelatedFetch = vi.fn<FetchFunction>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 400,
							status: "INVALID_ARGUMENT",
							message: "Function call 'bash' in the 1. content block is missing a thought_signature.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		);
		const unrelatedResult = await streamGoogle(
			{ ...model("google-generative-ai"), id: "gemini-4-neon" },
			normalizeContext({ tools: [preferTool], messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{ apiKey: "test-key", fetch: unrelatedFetch },
		).result();
		expect(unrelatedResult.stopReason).toBe("error");
		expect(unrelatedFetch).toHaveBeenCalledTimes(1);
	});

	it("keeps systemInstruction cache-stable on Gemini 4 by emitting mid-convo system updates inline in contents", async () => {
		const neon = { ...model("google-generative-ai"), id: "gemini-4-neon", provider: "google" };
		const turn1 = normalizeContext({
			systemPrompt: "base prompt",
			messages: [{ role: "user", content: "step 1", timestamp: 1 }],
		});
		const assistantTurn1 = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done 1" }],
			api: "google-generative-ai" as const,
			provider: "google",
			model: "gemini-4-neon",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		const turn2 = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				{ role: "user", content: "step 1", timestamp: 1 },
				assistantTurn1,
				{ role: "system", content: "", sections: { cwd: "/new/dir" }, timestamp: 3 },
				{ role: "user", content: "step 2", timestamp: 4 },
			],
		});
		const capturePayload = async (
			targetModel: Model<"google-generative-ai">,
			transcript: ReturnType<typeof normalizeContext>,
		) => {
			let captured: { contents?: unknown[]; config?: GenerateContentParameters["config"] } | undefined;
			await streamGoogle(targetModel, transcript, {
				apiKey: "test-key",
				onPayload: (payload) => {
					const params = payload as GenerateContentParameters;
					captured = {
						contents: Array.isArray(params.contents) ? params.contents : undefined,
						config: params.config,
					};
					throw new Error("captured");
				},
			}).result();
			return captured;
		};

		const payload1 = await capturePayload(neon, turn1);
		const payload2 = await capturePayload(neon, turn2);
		expect(payload1?.config?.systemInstruction).toBe("base prompt");
		expect(payload2?.config?.systemInstruction).toBe("base prompt");
		expect(payload2?.contents).toEqual([
			{ role: "user", parts: [{ text: "step 1" }] },
			{ role: "model", parts: [{ text: "done 1" }] },
			{
				role: "user",
				parts: [
					{ text: '<system_update>\nUpdated system prompt section "cwd":\n\n/new/dir\n</system_update>' },
					{ text: "step 2" },
				],
			},
		]);

		// Tool result immediately followed by a system update stays in one user turn.
		const afterTool = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				{ role: "user", content: "cd", timestamp: 1 },
				{
					...assistantTurn1,
					content: [{ type: "toolCall", id: "c1", name: "change_dir", arguments: { path: "/new/dir" } }],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "change_dir",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "system", content: "", sections: { cwd: "/new/dir" }, timestamp: 4 },
			],
		});
		const payloadAfterTool = await capturePayload(neon, afterTool);
		expect(payloadAfterTool?.config?.systemInstruction).toBe("base prompt");
		expect(payloadAfterTool?.contents).toHaveLength(3);
		expect(payloadAfterTool?.contents?.[2]).toMatchObject({
			role: "user",
			parts: [
				{ functionResponse: { id: "c1", name: "change_dir", response: { output: "ok" } } },
				{ text: '<system_update>\nUpdated system prompt section "cwd":\n\n/new/dir\n</system_update>' },
			],
		});

		// compat.supportsMidConvoSystemMessages overrides model ID detection both ways.
		const neonDisabled = await capturePayload({ ...neon, compat: { supportsMidConvoSystemMessages: false } }, turn2);
		expect(neonDisabled?.config?.systemInstruction).toBe("base prompt\n\n/new/dir");
		expect(neonDisabled?.contents).toEqual([
			{ role: "user", parts: [{ text: "step 1" }] },
			{ role: "model", parts: [{ text: "done 1" }] },
			{ role: "user", parts: [{ text: "step 2" }] },
		]);

		const gemini3Enabled = await capturePayload(
			{
				...model("google-generative-ai"),
				id: "gemini-3-flash-preview",
				compat: { supportsMidConvoSystemMessages: true },
			},
			turn2,
		);
		expect(gemini3Enabled?.config?.systemInstruction).toBe("base prompt");
		expect(gemini3Enabled?.contents?.[2]).toEqual(payload2?.contents?.[2]);
	});

	it("treats Cloudflare AI Gateway /google-ai-studio custom providers as Gemini API and supports cf-aig-authorization without apiKey", async () => {
		const fetch = respond([
			{
				candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
				usageMetadata: {
					promptTokenCount: 100,
					cachedContentTokenCount: 20,
					candidatesTokenCount: 10,
					totalTokenCount: 110,
					serviceTier: "priority",
				},
			},
		]);
		const cfGoogleModel: Model<"google-generative-ai"> = {
			...model("google-generative-ai"),
			id: "gemini-4-neon",
			provider: "google-cf",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acc123/workos/google-ai-studio/v1beta",
			headers: { "cf-aig-authorization": "Bearer cf-gateway-token" },
		};
		const unsignedHistory = normalizeContext({
			messages: [
				{ role: "user", content: "find it", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "x" } }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-6.2-sol",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		let capturedPayload: GenerateContentParameters | undefined;
		const stream = streamGoogleSimple(cfGoogleModel, unsignedHistory, {
			reasoning: "medium",
			onPayload: (payload) => {
				capturedPayload = payload as GenerateContentParameters;
				return {
					...(payload as Record<string, unknown>),
					config: {
						...((payload as { config?: Record<string, unknown> }).config ?? {}),
						serviceTier: "priority",
					},
				};
			},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		const [reqInput, reqInit] = fetch.mock.calls[0]!;
		const sentHeaders = new Headers(reqInit?.headers ?? (reqInput instanceof Request ? reqInput.headers : undefined));
		expect(sentHeaders.get("cf-aig-authorization")).toBe("Bearer cf-gateway-token");
		expect(sentHeaders.get("x-goog-api-key")).toBe("cf-gateway-token");
		// sendsToGeminiApi() enables store: false, skip_thought_signature_validator, and service-tier pricing.
		expect((capturedPayload?.config as Record<string, unknown> | undefined)?.store).toBe(false);
		expect(capturedPayload?.contents).toMatchObject([
			{ role: "user" },
			{
				role: "model",
				parts: [{ thoughtSignature: "skip_thought_signature_validator" }],
			},
			{ role: "user" },
		]);
		// Priority tier scales input/output/cacheRead by 1.8x (gemini-4-neon).
		expect(result.usage.cost.input).toBeCloseTo(80 * 1.8, 6);
		expect(result.usage.cost.output).toBeCloseTo(20 * 1.8, 6);
		expect(result.usage.cost.cacheRead).toBeCloseTo(60 * 1.8, 6);
	});

	it("recognizes Workers AI binding /google-ai-studio URLs, strips null headers, clamps usage.input, and prices prefixed model IDs", async () => {
		const fetch = respond([
			{
				candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
				usageMetadata: {
					promptTokenCount: 20,
					cachedContentTokenCount: 50,
					candidatesTokenCount: 10,
					totalTokenCount: 60,
					serviceTier: "priority",
				},
			},
		]);
		const bindingModel: Model<"google-generative-ai"> = {
			...model("google-generative-ai"),
			id: "models/gemini-4-neon",
			provider: "google-binding",
			baseUrl: "https://workers-binding.ai/ai-gateway/gateways/workos/google-ai-studio/v1beta",
		};

		let capturedPayload: GenerateContentParameters | undefined;
		const stream = streamGoogleSimple(bindingModel, context, {
			headers: {
				"cf-aig-authorization": "Bearer cloudflare-gateway-binding",
				"x-goog-api-key": null,
			},
			onPayload: (payload) => {
				capturedPayload = payload as GenerateContentParameters;
				return payload;
			},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		const [reqInput, reqInit] = fetch.mock.calls[0]!;
		const sentHeaders = new Headers(reqInit?.headers ?? (reqInput instanceof Request ? reqInput.headers : undefined));
		expect(sentHeaders.get("cf-aig-authorization")).toBe("Bearer cloudflare-gateway-binding");
		expect(sentHeaders.get("x-goog-api-key")).toBeNull();
		expect((capturedPayload?.config as Record<string, unknown> | undefined)?.store).toBe(false);
		// Clamped to 0 when cachedContentTokenCount exceeds promptTokenCount.
		expect(result.usage.input).toBe(0);
		expect(result.usage.cost.input).toBe(0);
		// Prefixed model ID ("models/gemini-4-neon") still gets Priority 1.8x pricing.
		expect(result.usage.cost.output).toBeCloseTo(20 * 1.8, 6);
		expect(result.usage.cost.cacheRead).toBeCloseTo(150 * 1.8, 6);
	});
});
