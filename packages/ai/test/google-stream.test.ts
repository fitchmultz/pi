import type { GenerateContentParameters } from "@google/genai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { AssistantMessageEvent, FetchFunction, Model } from "../src/types.ts";
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
			cost: { input: 80, output: 30, cacheRead: 60, cacheWrite: 0, total: 170 },
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
});
