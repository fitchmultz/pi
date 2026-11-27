import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../src/api/google-interactions.ts";
import { getPromptCacheTtlMs } from "../src/cache-warming.ts";
import { builtinProviders } from "../src/providers/all.ts";
import { googleProvider } from "../src/providers/google.ts";
import { GOOGLE_AI_PLAN_MODELS } from "../src/providers/google-ai-plan.models.ts";
import { googleAiPlanProvider } from "../src/providers/google-ai-plan.ts";
import type { Context, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = GOOGLE_AI_PLAN_MODELS["gemini-4-hydrogen"];
const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
const headers = { Authorization: "Bearer token" };
const encoder = new TextEncoder();

/** One SSE frame in the shape Google sends (`event:` line plus `data:` JSON). */
function frame(data: { event_type: string } & Record<string, unknown>): string {
	return `event: ${data.event_type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: string[]): Response {
	return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const completion = { event_type: "interaction.completed", interaction: { id: "i1", status: "completed" } };
const completed = frame(completion);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Google AI Ultra plan streaming", () => {
	// Event shapes from a recorded gemini-4-hydrogen tool turn, plus a summary and a text step.
	it("turns thought, text and function_call steps into one message", async () => {
		const frames = [
			frame({ event_type: "step.start", index: 0, step: { type: "thought" } }),
			frame({
				event_type: "step.delta",
				index: 0,
				delta: { type: "thought_summary", content: { type: "text", text: "Need the file." } },
			}),
			frame({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "c2ln" } }),
			frame({ event_type: "step.stop", index: 0 }),
			frame({ event_type: "step.start", index: 1, step: { type: "model_output" } }),
			frame({ event_type: "step.delta", index: 1, delta: { type: "text", text: "Reading it." } }),
			frame({ event_type: "step.stop", index: 1 }),
			frame({
				event_type: "step.start",
				index: 2,
				step: { type: "function_call", id: "call_1", name: "read_file", arguments: {} },
			}),
			frame({ event_type: "step.delta", index: 2, delta: { type: "arguments_delta", arguments: '{"path":' } }),
			frame({ event_type: "step.delta", index: 2, delta: { type: "arguments_delta", arguments: '"a.py"}' } }),
			frame({ event_type: "step.stop", index: 2 }),
			frame({
				event_type: "interaction.completed",
				interaction: {
					id: "tool-turn",
					model: model.id,
					status: "requires_action",
					usage: {
						total_tokens: 184,
						total_input_tokens: 114,
						total_cached_tokens: 10,
						total_output_tokens: 26,
						total_thought_tokens: 44,
					},
				},
			}),
			"event: done\ndata: [DONE]\n\n",
		];
		const fetch: FetchFunction = async () => sseResponse(frames);

		const message = await stream(model, context, { headers, fetch }).result();

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "Need the file.", thinkingSignature: "c2ln" },
			{ type: "text", text: "Reading it." },
			{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.py" } },
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.responseId).toBe("tool-turn");
		expect(message.usage).toMatchObject({ input: 104, cacheRead: 10, output: 70, reasoning: 44, totalTokens: 184 });
		expect(message.usage.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	it("fails a stream that closes before interaction.completed", async () => {
		const fetch: FetchFunction = async () =>
			sseResponse([
				frame({ event_type: "step.start", index: 0, step: { type: "model_output" } }),
				frame({ event_type: "step.delta", index: 0, delta: { type: "text", text: "Partial" } }),
				frame({ event_type: "interaction.status_update", interaction_id: "i1", status: "completed" }),
			]);

		const message = await stream(model, context, { headers, fetch, maxRetries: 0 }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Google stream ended before interaction.completed");
	});

	it("cancels the open body at completion without reading later events", async () => {
		let canceled = false;
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(`${completed}event: error\ndata: {"event_type":"error"}\n\n`));
				},
				cancel() {
					canceled = true;
				},
			}),
		);
		const observed: unknown[] = [];
		const result = await stream(model, context, {
			headers,
			fetch: async () => response,
			onProviderStreamEvent: (event) => {
				observed.push(event);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(observed).toEqual([completion]);
		expect(canceled).toBe(true);
		expect(response.body?.locked).toBe(false);
	});

	it("keeps the raw SSE error code", async () => {
		const fetch: FetchFunction = async () =>
			sseResponse([frame({ event_type: "error", error: { code: "model_overloaded", message: "Overloaded" } })]);
		const result = await stream(model, context, { headers, fetch }).result();
		expect(result).toMatchObject({
			stopReason: "error",
			rawStopReason: "model_overloaded",
			errorMessage: "Overloaded",
		});
	});
});

describe("Google AI Ultra plan requests", () => {
	it.each([undefined, "none"] as const)("sends the quota request with tool choice %s", async (toolChoice) => {
		let body: Record<string, unknown> = {};
		let request: { url: string; method: string | undefined; headers: Headers } | undefined;
		const fetch: FetchFunction = async (url, init) => {
			body = JSON.parse(String(init?.body));
			request = { url: String(url), method: init?.method, headers: new Headers(init?.headers) };
			return sseResponse([completed]);
		};
		const tool = {
			name: "read_file",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
		} as const;

		const result = await streamSimple(
			{
				...model,
				baseUrl: `${model.baseUrl}/`,
				headers: { authorization: "Bearer model-token", "x-custom": "model-header", "x-remove": "old" },
			},
			normalizeContext({
				systemPrompt: "Be brief.",
				tools: [tool],
				messages: [
					{ role: "user", content: "Hi", timestamp: 0 },
					{ role: "system", content: "Use plain English.", timestamp: 1 },
				],
			}),
			// Gemini 4 rejects "minimal" with a 400; the nearest supported level is sent instead.
			{
				headers: { ...headers, "x-remove": null, DPoP: "proof", "x-goog-api-key": "unused-header" },
				apiKey: "unused",
				fetch,
				...(toolChoice && { toolChoice }),
				reasoning: "minimal",
				thinkingDisplay: "omitted",
				temperature: 0.5,
				samplingParams: { topP: 0.8 },
				maxTokens: 123,
				cacheWarm: true,
				deferred: true,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(request).toMatchObject({
			url: `${model.baseUrl}/interactions:createPerUserQuota`,
			method: "POST",
		});
		expect(Object.fromEntries(request!.headers)).toEqual({
			accept: "text/event-stream",
			authorization: "Bearer token",
			"content-type": "application/json",
			"user-agent": expect.stringMatching(/^pi\//),
			"x-custom": "model-header",
		});
		expect(body).toEqual({
			model: "gemini-4-hydrogen",
			store: false,
			stream: true,
			system_instruction: "Be brief.\n\nUse plain English.",
			tools: [
				{
					type: "function",
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			],
			input: [{ type: "user_input", content: [{ type: "text", text: "Hi" }] }],
			generation_config: {
				max_output_tokens: 123,
				...(toolChoice && { tool_choice: toolChoice }),
				thinking_level: "low",
				thinking_summaries: "auto",
			},
		});
	});

	it("enforces strict JSON-schema tool sampling and rejects strict: require when unsupported", async () => {
		let body: Record<string, unknown> = {};
		const fetch: FetchFunction = async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return sseResponse([completed]);
		};
		const strictTool = {
			name: "read_file",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "require" },
		} as const;
		const toolContext = normalizeContext({
			tools: [strictTool],
			messages: [{ role: "user", content: "Hi", timestamp: 0 }],
		});

		const ok = await streamSimple(model, toolContext, { headers, fetch }).result();
		expect(ok.stopReason).toBe("stop");
		expect(body).toMatchObject({
			tools: [
				{
					type: "function",
					name: "read_file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
						additionalProperties: false,
					},
				},
			],
			generation_config: { tool_choice: "validated" },
		});

		let sent = false;
		const rejected = await streamSimple(model, toolContext, {
			headers,
			toolChoice: "none",
			fetch: async () => {
				sent = true;
				return sseResponse([completed]);
			},
		}).result();
		expect(rejected.stopReason).toBe("error");
		expect(rejected.errorMessage).toContain('Tool "read_file" requires JSON-schema constrained sampling');
		expect(sent).toBe(false);
	});

	it.each([null, "Basic abc", "Bearer"])("rejects merged Authorization %j before making the request", async (auth) => {
		let sent = false;
		const result = await stream({ ...model, headers }, context, {
			headers: { authorization: auth },
			apiKey: "not-a-plan-credential",
			fetch: async () => {
				sent = true;
				return sseResponse([completed]);
			},
		}).result();
		expect(result.errorMessage).toContain("No Bearer credentials for provider: google-ai-plan");
		expect(sent).toBe(false);
	});

	it("requires an app OAuth client and exposes no deferred operations or cache-warming TTL", () => {
		const provider = googleAiPlanProvider({ clientId: "app-client", clientSecret: "app-secret" });
		expect(builtinProviders().map(({ id }) => id)).not.toContain(provider.id);
		expect(provider.fetchDeferred).toBeUndefined();
		expect(provider.cancelDeferred).toBeUndefined();
		expect(getPromptCacheTtlMs(model, { cacheRetention: "short" })).toBeUndefined();
	});
});

describe("Google AI Ultra plan request timeout", () => {
	it("covers only the wait for the response headers, not a long stream", async () => {
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(
					encoder.encode(frame({ event_type: "step.start", index: 0, step: { type: "model_output" } })),
				);
				await sleep(100);
				controller.enqueue(
					encoder.encode(frame({ event_type: "step.delta", index: 0, delta: { type: "text", text: "Hello" } })),
				);
				controller.enqueue(encoder.encode(frame({ event_type: "step.stop", index: 0 })));
				controller.enqueue(
					encoder.encode(frame({ event_type: "interaction.completed", interaction: { status: "completed" } })),
				);
				controller.close();
			},
		});
		const fetch: FetchFunction = async () => new Response(body, { status: 200 });

		const message = await stream(model, context, { headers, fetch, timeoutMs: 20 }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("fails when the response headers do not arrive in time", async () => {
		const fetch: FetchFunction = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});

		const message = await stream(model, context, { headers, fetch, timeoutMs: 20, maxRetries: 0 }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Google response headers timed out after 20ms");
	});

	it("keeps the caller's abort signal attached after response headers", async () => {
		const controller = new AbortController();
		const reading = Promise.withResolvers();
		const fetch: FetchFunction = async (_url, init) =>
			new Response(
				new ReadableStream({
					start(body) {
						body.enqueue(
							encoder.encode(frame({ event_type: "step.start", index: 0, step: { type: "thought" } })),
						);
						init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), { once: true });
					},
				}),
			);
		const result = stream(model, context, {
			headers,
			fetch,
			signal: controller.signal,
			timeoutMs: 500,
			onProviderStreamEvent: () => reading.resolve(undefined),
		}).result();
		await reading.promise;
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
	});
});

describe("Google AI Ultra plan replay", () => {
	const planNeon = GOOGLE_AI_PLAN_MODELS["gemini-4-neon"];
	const googleNeon = googleProvider()
		.getModels()
		.find((model) => model.id === planNeon.id) as Model<"google-interactions">;
	const signedSteps = [
		{ type: "thought", signature: "c2ln", summary: [{ type: "text", text: "Read the file." }] },
		{ type: "function_call", id: "call_1", name: "read_file", arguments: { path: "a.py" } },
	];

	it.each([
		{
			source: planNeon,
			target: planNeon,
			expected: signedSteps,
			result: "one\ntwo",
		},
		{
			source: googleNeon,
			target: planNeon,
			expected: [{ type: "thought", signature: "skip_thought_signature_validator" }, signedSteps[1]],
			result: "one\ntwo",
		},
		{
			source: planNeon,
			target: googleNeon,
			expected: [{ ...signedSteps[1], signature: "skip_thought_signature_validator" }],
			result: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
		},
	])("projects a $source.provider turn for $target.provider on the same Neon model", async (test) => {
		const previous = await stream(test.source, context, {
			headers,
			apiKey: "google-key",
			fetch: async () =>
				sseResponse([
					frame({
						event_type: "interaction.completed",
						interaction: { id: "tool-turn", status: "requires_action", steps: signedSteps },
					}),
				]),
		}).result();
		expect(previous.stopReason).toBe("toolUse");
		expect(previous.googleInteractionsReplay?.steps).toEqual(signedSteps);
		const history: Context = {
			messages: [
				...context.messages,
				previous,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read_file",
					content: [
						{ type: "text", text: "one" },
						{ type: "text", text: "two" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		};
		let body: unknown;
		const result = await stream(test.target, normalizeContext(history), {
			headers,
			apiKey: "google-key",
			sessionId: "same-model-replay",
			fetch: async (url, init) => {
				body = await new Request(url, init).json();
				return sseResponse([completed]);
			},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(body).toHaveProperty("input", [
			{ type: "user_input", content: [{ type: "text", text: "Hi" }] },
			...test.expected,
			{ type: "function_result", call_id: "call_1", name: "read_file", result: test.result },
		]);
		expect(body).not.toHaveProperty("previous_interaction_id");
	});

	it("replays signed thoughts and projects grouped text and an unsigned call from two same-plan turns", async () => {
		const unsignedCall = { type: "function_call", id: "call_2", name: "read_file", arguments: { path: "b.py" } };
		const firstText = { type: "text", text: "one" };
		const secondText = { type: "text", text: "two" };
		const messages: Context["messages"] = [...context.messages];
		for (const { callId, steps } of [
			{ callId: "call_1", steps: signedSteps },
			{
				callId: unsignedCall.id,
				steps: [
					{ type: "model_output", content: [firstText] },
					{ type: "model_output", content: [secondText] },
					unsignedCall,
				],
			},
		]) {
			const previous = await stream(planNeon, normalizeContext({ messages }), {
				headers,
				fetch: async () =>
					sseResponse([
						frame({
							event_type: "interaction.completed",
							interaction: { id: callId, status: "requires_action", steps },
						}),
					]),
			}).result();
			expect(previous.stopReason, previous.errorMessage).toBe("toolUse");
			messages.push(previous, {
				role: "toolResult",
				toolCallId: callId,
				toolName: "read_file",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 2,
			});
		}

		let body: unknown;
		const result = await stream(planNeon, normalizeContext({ messages }), {
			headers,
			fetch: async (url, init) => {
				body = await new Request(url, init).json();
				return sseResponse([completed]);
			},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(body).toHaveProperty("input", [
			{ type: "user_input", content: [{ type: "text", text: "Hi" }] },
			...signedSteps,
			{ type: "function_result", call_id: "call_1", name: "read_file", result: "file contents" },
			{ type: "model_output", content: [firstText, secondText] },
			{ type: "thought", signature: "skip_thought_signature_validator" },
			unsignedCall,
			{ type: "function_result", call_id: "call_2", name: "read_file", result: "file contents" },
		]);
	});
});
