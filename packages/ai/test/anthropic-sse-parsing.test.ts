import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Api, Model, ToolCall } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		beta: {
			messages: {
				create: () => ({
					asResponse: async () => response,
				}),
			},
		},
	} as unknown as Anthropic;
}

type ResponseContentBlock = { type: "thinking"; thinking: string; signature: string } | { type: "text"; text: string };

function createResponseModelSseResponse(model: string, contentBlock: ResponseContentBlock): Response {
	return createSseResponse([
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: { id: "msg_response_model", model, usage: { input_tokens: 100, output_tokens: 0 } },
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: contentBlock }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 100, output_tokens: 20 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);
}

describe("Anthropic raw SSE parsing", () => {
	it.each(["close", "error", "abort"] as const)(
		"filters non-message frames and awaits the final callback and body EOF (%s)",
		async (ending) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const nextRead = Promise.withResolvers<void>();
			const abort = new AbortController();
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			let reads = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					start(c) {
						controller = c;
					},
					pull(c) {
						if (++reads === 1) {
							c.enqueue(
								new TextEncoder().encode(
									[
										{ event: "ping", data: "not json" },
										{ event: "unknown", data: "not json" },
										...minimalAnthropicEvents,
									]
										.map(({ event, data }) => `event: ${event}\ndata: ${data}\n\n`)
										.join(""),
								),
							);
						} else nextRead.resolve();
					},
				},
				{ highWaterMark: 0 },
			);
			let settled = false;
			const callbacks: string[] = [];
			const result = streamAnthropic(
				getModel("anthropic", "claude-haiku-4-5"),
				normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
				{
					client: createFakeAnthropicClient(new Response(body)),
					signal: abort.signal,
					onPayload: () => {
						callbacks.push("onPayload");
					},
					onResponse: () => {
						callbacks.push("onResponse");
					},
					onProviderStreamEvent: async (event) => {
						const type = (event as { type: string }).type;
						callbacks.push(type);
						if (type === "message_stop") {
							entered.resolve();
							await release.promise;
						}
					},
				},
			)
				.result()
				.then((message) => {
					settled = true;
					return message;
				});
			try {
				await entered.promise;
				expect(settled).toBe(false);
				expect(reads).toBe(1);
				release.resolve();
				await nextRead.promise;
				expect(settled).toBe(false);
				if (ending === "error") controller.error(new Error("body failed"));
				else {
					if (ending === "abort") abort.abort();
					controller.close();
				}
				const message = await result;
				expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
				expect(message.responseId).toBe("msg_test");
				expect(message.usage).toMatchObject({ input: 12, output: 5, totalTokens: 17 });
				expect(message.stopReason).toBe(ending === "close" ? "stop" : ending === "abort" ? "aborted" : "error");
				expect(message.errorMessage).toBe(
					ending === "close" ? undefined : ending === "abort" ? "Request was aborted" : "body failed",
				);
				expect(callbacks).toEqual([
					"onPayload",
					"onResponse",
					...minimalAnthropicEvents.map((event) => event.event),
				]);
				expect(body.locked).toBe(false);
			} finally {
				release.resolve();
				controller.error(new Error("test cleanup"));
				await result;
			}
		},
	);

	it.each(["onPayload", "onResponse", "onProviderStreamEvent"] as const)(
		"preserves the native error when %s throws",
		async (callback) => {
			const result = await streamAnthropic(
				getModel("anthropic", "claude-haiku-4-5"),
				normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
				{
					client: createFakeAnthropicClient(createSseResponse(minimalAnthropicEvents)),
					[callback]: () => {
						throw new Error("callback failed");
					},
				},
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("callback failed");
		},
	);

	// Regression test for earendil-works/pi#3936.
	it("rejects EOF before message_stop while retaining consumed content and usage", async () => {
		const result = await streamAnthropic(
			getModel("anthropic", "claude-haiku-4-5"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ client: createFakeAnthropicClient(createSseResponse(minimalAnthropicEvents.slice(0, -1))) },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream ended before message_stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage).toMatchObject({ input: 12, output: 5, totalTokens: 17 });
	});

	it("forwards parsed provider stream events in order", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const providerEvents: unknown[] = [];
		const eventModels: Model<Api>[] = [];
		const result = await streamAnthropic(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				client: createFakeAnthropicClient(createSseResponse(minimalAnthropicEvents)),
				onProviderStreamEvent: async (event, eventModel) => {
					await Promise.resolve();
					providerEvents.push(event);
					eventModels.push(eventModel);
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(providerEvents.map((event) => (event as { type: string }).type)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(eventModels).toEqual([model, model, model, model, model, model]);
	});

	it("keeps signed thinking replayable when a proxy relabels the model", async () => {
		// Regression test for earendil-works/pi#9188.
		const model = getModel("anthropic", "claude-opus-5");
		const responseModel = "kimi-for-coding";
		const initialContext = normalizeContext({
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		});
		const first = await streamAnthropic(model, initialContext, {
			client: createFakeAnthropicClient(
				createResponseModelSseResponse(responseModel, {
					type: "thinking",
					thinking: "reasoning",
					signature: "signature",
				}),
			),
		}).result();

		expect(first.model).toBe(model.id);
		expect(first.responseModel).toBe(responseModel);

		const transformed = transformMessages([...initialContext.messages, first], model);
		const replayedAssistant = transformed.find((message) => message.role === "assistant");
		expect(replayedAssistant?.content).toEqual([
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "signature" },
		]);
	});

	it("uses a returned fallback model for cost attribution", async () => {
		const fallbackModel = "fallback-model";
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-opus-5"),
			compat: {
				allowedFallbackModels: [
					{
						provider: "anthropic",
						model: fallbackModel,
						cost: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		};
		const result = await streamAnthropic(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				client: createFakeAnthropicClient(
					createResponseModelSseResponse(fallbackModel, { type: "text", text: "done" }),
				),
			},
		).result();

		expect(result.model).toBe(model.id);
		expect(result.responseModel).toBe(fallbackModel);
		expect(result.usage.cost.input).toBeCloseTo(0.0003, 10);
		expect(result.usage.cost.output).toBeCloseTo(0.0001, 10);
	});

	it("fails safely when Anthropic falls back after output begins", async () => {
		const model = getModel("anthropic", "claude-opus-5");
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_fallback",
						model: "claude-opus-5",
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "partial" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "fallback",
						from: { model: "claude-opus-5" },
						to: { model: "claude-opus-4-8" },
					},
				}),
			},
		]);

		const result = await streamAnthropic(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ client: createFakeAnthropicClient(response) },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unsupported mid-output model fallback");
	});

	it("forces streaming after an onPayload replacement", async () => {
		let streaming: boolean | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: { stream?: boolean }) => {
						streaming = params.stream;
						return { asResponse: async () => createSseResponse(minimalAnthropicEvents) };
					},
				},
			},
		} as unknown as Anthropic;

		await streamAnthropic(
			getModel("anthropic", "claude-fable-5-1"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				client,
				onPayload: (payload) => ({ ...(payload as Record<string, unknown>), stream: false }),
			},
		).result();

		expect(streaming).toBe(true);
	});

	it("omits the interleaved-thinking beta when thinking is disabled", async () => {
		let betaFeatures: string[] | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: { betas?: string[] }) => {
						betaFeatures = params.betas;
						return { asResponse: async () => createSseResponse(minimalAnthropicEvents) };
					},
				},
			},
		} as unknown as Anthropic;

		await streamAnthropic(
			getModel("openrouter", "anthropic/claude-haiku-4.5"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ client, thinkingEnabled: false },
		).result();

		expect(betaFeatures ?? []).not.toContain("interleaved-thinking-2025-05-14");
	});

	it("passes managed beta features to injected clients", async () => {
		let betaFeatures: string[] | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: { betas?: string[] }) => {
						betaFeatures = params.betas;
						return { asResponse: async () => createSseResponse(minimalAnthropicEvents) };
					},
				},
			},
		} as unknown as Anthropic;

		const result = await streamAnthropic(
			getModel("anthropic", "claude-fable-5-1"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ client },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(betaFeatures).toContain("mid-conversation-output-config-2026-07-01");
		expect(betaFeatures).toContain("thinking-binding-controls-2026-08-01");
	});

	it("uses the serving model input transformations from the final stream event", async () => {
		const events = minimalAnthropicEvents.map((event) => ({ ...event }));
		events[0].data = JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_transformations",
				model: "claude-fable-5-1",
				usage: { input_tokens: 12, output_tokens: 0 },
				input_transformations: [
					{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
				],
			},
		});
		const delta = JSON.parse(events[4].data) as Record<string, unknown>;
		delta.input_transformations = [
			{ type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" },
		];
		events[4].data = JSON.stringify(delta);

		const result = await streamAnthropic(
			getModel("anthropic", "claude-fable-5-1"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ client: createFakeAnthropicClient(createSseResponse(events)) },
		).result();

		expect(result.diagnostics).toEqual([
			{
				type: "anthropic_input_transformations",
				timestamp: expect.any(Number),
				details: {
					transformations: [
						{
							type: "thinking_dropped",
							path: "messages.3.content.0",
							reason: "model_binding_mismatch",
						},
					],
				},
			},
		]);
	});
	it("repairs malformed SSE JSON and malformed streamed tool JSON", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		});

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();

		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments).toEqual({
			path: "A\\H",
			text: "col1\tcol2",
		});
	});

	it("preserves content from content_block_start events", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		});
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_initial_content",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "Initial text" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: " plus delta" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "thinking",
						thinking: "Initial thinking",
						signature: "initial signature",
					},
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 1,
					delta: { type: "thinking_delta", thinking: " plus delta" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 1,
					delta: { type: "signature_delta", signature: " plus delta" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.content).toEqual([
			{ type: "text", text: "Initial text plus delta" },
			{
				type: "thinking",
				thinking: "Initial thinking plus delta",
				thinkingSignature: "initial signature plus delta",
			},
		]);
	});

	it("preserves refusal stop details from message_delta", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		});
		const explanation =
			"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, provide feedback, or request an exemption based on how you use Claude, visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.";
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_01XFUDYJgAACzvnptvVoYEL",
						usage: {
							input_tokens: 412,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: {
						stop_reason: "refusal",
						stop_details: {
							type: "refusal",
							category: "cyber",
							explanation,
						},
					},
					usage: {
						input_tokens: 412,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("refusal");
		expect(result.errorMessage).toBe(explanation);
	});

	it("preserves sensitive stop reasons with a descriptive error message", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		});
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_sensitive",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "sensitive" },
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("sensitive");
		expect(result.errorMessage).toBe("Provider stopped with: sensitive");
	});

	it("treats message_delta without usage as a no-op for usage accumulation", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		});
		const response = createSseResponse(
			minimalAnthropicEvents.map((event) =>
				event.event === "message_delta"
					? {
							event: "message_delta",
							data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
						}
					: event,
			),
		);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(12);
		expect(result.usage.totalTokens).toBe(12);
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		});
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
