import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type FakeListener = (event: unknown) => void;

interface SentFrame {
	socketId: number;
	payload: Record<string, unknown>;
}

interface FakeSocketControl {
	id: number;
	url: string;
	headers: Record<string, string>;
	closed: boolean;
	emitOpen: () => void;
	emitMessage: (payload: Record<string, unknown>) => void;
	emitError: (message: string) => void;
	emitClose: (code?: number, reason?: string) => void;
}

class FakeWebSocketHarness {
	readonly sockets: FakeSocketControl[] = [];
	readonly sent: SentFrame[] = [];
	private readonly handlers: Array<(socket: FakeSocketControl, payload: Record<string, unknown>) => void> = [];
	private readonly connectBehaviors: Array<(socket: FakeSocketControl) => void> = [];
	private nextId = 1;

	onConnect(behavior: (socket: FakeSocketControl) => void): void {
		this.connectBehaviors.push(behavior);
	}

	onSend(handler: (socket: FakeSocketControl, payload: Record<string, unknown>) => void): void {
		this.handlers.push(handler);
	}

	install(): void {
		const harness = this;
		class FakeWebSocket {
			readyState = 0;
			private readonly listeners = new Map<string, Set<FakeListener>>();
			private readonly control: FakeSocketControl;

			constructor(url: string, options?: { headers?: Record<string, string> }) {
				const id = harness.nextId++;
				const socket = this;
				this.control = {
					id,
					url,
					headers: options?.headers ?? {},
					closed: false,
					emitOpen() {
						socket.readyState = 1;
						socket.dispatch("open", {});
					},
					emitMessage(payload) {
						socket.dispatch("message", { data: JSON.stringify(payload) });
					},
					emitError(message) {
						socket.dispatch("error", { message });
					},
					emitClose(code = 1000, reason = "") {
						socket.readyState = 3;
						socket.control.closed = true;
						socket.dispatch("close", { code, reason });
					},
				};
				harness.sockets.push(this.control);
				const behavior = harness.connectBehaviors.shift();
				queueMicrotask(() => {
					if (behavior) behavior(this.control);
					else this.control.emitOpen();
				});
			}

			addEventListener(type: string, listener: FakeListener): void {
				let set = this.listeners.get(type);
				if (!set) {
					set = new Set();
					this.listeners.set(type, set);
				}
				set.add(listener);
			}

			removeEventListener(type: string, listener: FakeListener): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				const payload = JSON.parse(data) as Record<string, unknown>;
				harness.sent.push({ socketId: this.control.id, payload });
				const handler = harness.handlers.shift();
				if (handler) {
					queueMicrotask(() => handler(this.control, payload));
				}
			}

			close(code = 1000, reason = ""): void {
				if (this.control.closed) return;
				this.control.closed = true;
				this.readyState = 3;
				this.dispatch("close", { code, reason });
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of [...(this.listeners.get(type) ?? [])]) {
					listener(event);
				}
			}
		}

		vi.stubGlobal("WebSocket", FakeWebSocket);
	}
}

function createOpenAIModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-6.2-sol",
		name: "GPT-6.2 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 15, cacheRead: 0.1, cacheWrite: 2.5 },
		contextWindow: 272000,
		maxTokens: 128000,
		compat: {
			supportsMidConvoSystemMessages: true,
			supportsMidConvoEffort: true,
			supportsExplicitPromptCacheMode: true,
		},
		...overrides,
	};
}

function emitSimpleReply(socket: FakeSocketControl, responseId: string, msgId: string, text: string): void {
	const item = {
		type: "message",
		id: msgId,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	socket.emitMessage({ type: "response.created", sequence_number: 0, response: { id: responseId } });
	socket.emitMessage({
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 0,
		item: { ...item, content: [] },
	});
	socket.emitMessage({
		type: "response.output_text.delta",
		sequence_number: 2,
		output_index: 0,
		content_index: 0,
		delta: text,
	});
	socket.emitMessage({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item });
	socket.emitMessage({
		type: "response.completed",
		sequence_number: 4,
		response: {
			id: responseId,
			status: "completed",
			output: [item],
			usage: {
				input_tokens: 10,
				output_tokens: 4,
				total_tokens: 14,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	});
}

function createSseReplyResponse(responseId: string, text: string): Response {
	const item = {
		type: "message",
		id: "msg_sse_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const events = [
		{ type: "response.created", sequence_number: 0, response: { id: responseId } },
		{ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", sequence_number: 3, output_index: 0, item },
		{
			type: "response.completed",
			sequence_number: 4,
			response: {
				id: responseId,
				status: "completed",
				output: [item],
				usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
			},
		},
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("openai-responses WebSocket mode", () => {
	let harness: FakeWebSocketHarness;

	beforeEach(() => {
		harness = new FakeWebSocketHarness();
		harness.install();
	});

	afterEach(() => {
		cleanupSessionResources();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reuses one session socket and sends incremental previous_response_id deltas across turns including effort changes", async () => {
		const model = createOpenAIModel();
		const sessionId = "ws-session-delta";

		harness.onSend((socket) => emitSimpleReply(socket, "resp_turn_1", "msg_turn_1", "OK"));
		harness.onSend((socket) => emitSimpleReply(socket, "resp_turn_2", "msg_turn_2", "FALCON"));

		const turn1Context: TranscriptContext = normalizeContext({
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "Remember FALCON.", timestamp: 1 }],
		});
		const turn1 = await streamOpenAIResponses(model, turn1Context, {
			apiKey: "sk-test-key",
			sessionId,
			reasoningEffort: "medium",
			transport: "auto",
		}).result();

		expect(turn1.stopReason).toBe("stop");
		expect(turn1.responseId).toBe("resp_turn_1");
		expect(harness.sockets).toHaveLength(1);
		expect(harness.sockets[0]?.url).toBe("wss://api.openai.com/v1/responses");
		expect(harness.sockets[0]?.headers.authorization).toBe("Bearer sk-test-key");
		expect(harness.sent[0]?.payload).toMatchObject({
			type: "response.create",
			model: "gpt-6.2-sol",
			store: false,
		});
		expect(harness.sent[0]?.payload.stream).toBeUndefined();
		expect(harness.sent[0]?.payload.previous_response_id).toBeUndefined();

		const turn2Context: TranscriptContext = normalizeContext({
			systemPrompt: "Be concise.",
			messages: [
				{ role: "user", content: "Remember FALCON.", timestamp: 1 },
				turn1,
				{ role: "user", content: "What word?", timestamp: 2 },
			],
		});
		const turn2 = await streamOpenAIResponses(model, turn2Context, {
			apiKey: "sk-test-key",
			sessionId,
			reasoningEffort: "high",
			transport: "auto",
		}).result();

		expect(turn2.stopReason).toBe("stop");
		expect(harness.sockets).toHaveLength(1);
		expect(harness.sent[1]?.socketId).toBe(harness.sent[0]?.socketId);
		expect(harness.sent[1]?.payload.previous_response_id).toBe("resp_turn_1");
		// Only the new user turn + configuration_update item should be sent on Turn 2.
		expect(harness.sent[1]?.payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "What word?" }] },
			{ type: "configuration_update", reasoning: { effort: "high" } },
		]);

		cleanupSessionResources(sessionId);
		expect(harness.sockets[0]?.closed).toBe(true);
	});

	it("skips incremental previous_response_id when transport is websocket or disableContinuation is true", async () => {
		const model = createOpenAIModel();
		const sessionId = "ws-session-no-delta";

		harness.onSend((socket) => emitSimpleReply(socket, "resp_1", "msg_1", "first"));
		harness.onSend((socket) => emitSimpleReply(socket, "resp_warm", "msg_warm", "w"));
		harness.onSend((socket) => emitSimpleReply(socket, "resp_2", "msg_2", "second"));

		const ctx1 = normalizeContext({
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const turn1 = await streamOpenAIResponses(model, ctx1, {
			apiKey: "sk-test-key",
			sessionId,
			transport: "websocket-cached",
		}).result();

		// Cache warming sets disableContinuation: true; it must send full input without clearing Turn 1's baseline.
		const warm = await streamOpenAIResponses(model, ctx1, {
			apiKey: "sk-test-key",
			sessionId,
			transport: "websocket-cached",
			disableContinuation: true,
		}).result();
		expect(warm.stopReason).toBe("stop");
		expect(harness.sent[1]?.payload.previous_response_id).toBeUndefined();

		const ctx2 = normalizeContext({
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				turn1,
				{ role: "user", content: "next", timestamp: 2 },
			],
		});
		const turn2 = await streamOpenAIResponses(model, ctx2, {
			apiKey: "sk-test-key",
			sessionId,
			transport: "websocket-cached",
		}).result();
		expect(turn2.stopReason).toBe("stop");
		expect(harness.sent[2]?.payload.previous_response_id).toBe("resp_1");

		// Explicit transport: "websocket" disables incremental deltas.
		harness.onSend((socket) => emitSimpleReply(socket, "resp_3", "msg_3", "third"));
		const ctx3 = normalizeContext({
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				turn1,
				{ role: "user", content: "next", timestamp: 2 },
				turn2,
				{ role: "user", content: "third", timestamp: 3 },
			],
		});
		await streamOpenAIResponses(model, ctx3, {
			apiKey: "sk-test-key",
			sessionId,
			transport: "websocket",
		}).result();
		expect(harness.sent[3]?.payload.previous_response_id).toBeUndefined();
	});

	it("recovers once on previous_response_not_found by reconnecting and sending full input", async () => {
		const model = createOpenAIModel();
		const sessionId = "ws-session-recover";

		harness.onSend((socket) => emitSimpleReply(socket, "resp_1", "msg_1", "first"));
		harness.onSend((socket) => {
			socket.emitMessage({
				type: "error",
				status: 400,
				error: {
					type: "invalid_request_error",
					code: "previous_response_not_found",
					message: "Previous response resp_1 was evicted",
				},
			});
		});
		harness.onSend((socket) => emitSimpleReply(socket, "resp_2_recovered", "msg_2", "recovered"));

		const turn1 = await streamOpenAIResponses(
			model,
			normalizeContext({ messages: [{ role: "user", content: "one", timestamp: 1 }] }),
			{ apiKey: "sk-test-key", sessionId, transport: "auto" },
		).result();

		const turn2 = await streamOpenAIResponses(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "one", timestamp: 1 },
					turn1,
					{ role: "user", content: "two", timestamp: 2 },
				],
			}),
			{ apiKey: "sk-test-key", sessionId, transport: "auto" },
		).result();

		expect(turn2.stopReason).toBe("stop");
		expect(turn2.responseId).toBe("resp_2_recovered");
		expect(harness.sockets).toHaveLength(2);
		expect(harness.sent[1]?.payload.previous_response_id).toBe("resp_1");
		expect(harness.sent[2]?.payload.previous_response_id).toBeUndefined();
		expect(Array.isArray(harness.sent[2]?.payload.input)).toBe(true);
		expect((harness.sent[2]?.payload.input as unknown[]).length).toBeGreaterThan(1);
	});

	it("falls back to HTTP SSE on pre-stream WebSocket failure and remembers fallback per session", async () => {
		const model = createOpenAIModel();
		const sessionId = "ws-session-fallback";

		harness.onConnect((socket) => socket.emitError("ECONNREFUSED"));
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(createSseReplyResponse("resp_sse_1", "from-sse-1"))
			.mockResolvedValueOnce(createSseReplyResponse("resp_sse_2", "from-sse-2"));

		const result1 = await streamOpenAIResponses(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
			{ apiKey: "sk-test-key", sessionId, transport: "auto" },
		).result();

		expect(result1.stopReason).toBe("stop");
		expect(result1.responseId).toBe("resp_sse_1");
		expect(result1.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "provider_transport_failure",
				details: expect.objectContaining({
					configuredTransport: "auto",
					fallbackTransport: "sse",
					eventsEmitted: false,
				}),
			}),
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(harness.sockets).toHaveLength(1);

		// Second turn in the same session skips WebSocket directly until session cleanup.
		const result2 = await streamOpenAIResponses(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hi again", timestamp: 2 }] }),
			{ apiKey: "sk-test-key", sessionId, transport: "auto" },
		).result();

		expect(result2.stopReason).toBe("stop");
		expect(result2.responseId).toBe("resp_sse_2");
		expect(harness.sockets).toHaveLength(1);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("surfaces non-retryable server API errors without falling back to SSE", async () => {
		const model = createOpenAIModel();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		harness.onSend((socket) => {
			socket.emitMessage({
				type: "error",
				status: 429,
				error: {
					type: "rate_limit_error",
					code: "subscription_sharing_usage_limit_exceeded",
					message: "Usage limit reached",
				},
			});
		});

		const result = await streamOpenAIResponses(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
			{ apiKey: "chatgpt-jwt-token", transport: "auto", maxRetries: 0 },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("chatgpt.com/settings/usage");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not fall back to SSE after the first WebSocket response event has been emitted", async () => {
		const model = createOpenAIModel();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		harness.onSend((socket) => {
			socket.emitMessage({ type: "response.created", sequence_number: 0, response: { id: "resp_partial" } });
			socket.emitClose(1006, "abnormal");
		});

		const events: string[] = [];
		const s = streamOpenAIResponses(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
			{ apiKey: "sk-test-key", transport: "auto" },
		);
		for await (const event of s) events.push(event.type);
		const result: AssistantMessage = await s.result();

		expect(result.stopReason).toBe("error");
		expect(events.filter((type) => type === "start")).toHaveLength(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("bypasses WebSocket for non-openai providers, transport: sse, and injected custom fetch", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(createSseReplyResponse("resp_cf", "cf"))
			.mockResolvedValueOnce(createSseReplyResponse("resp_sse", "sse"));

		const cfModel = createOpenAIModel({
			provider: "cloudflare-ai-gateway",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw/openai",
		});
		const cfResult = await streamOpenAIResponses(
			cfModel,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
			{ apiKey: "cf-key", transport: "auto" },
		).result();
		expect(cfResult.stopReason).toBe("stop");

		const sseResult = await streamOpenAIResponses(
			createOpenAIModel(),
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 2 }] }),
			{ apiKey: "sk-test", transport: "sse" },
		).result();
		expect(sseResult.stopReason).toBe("stop");

		const customFetch = vi.fn(async () => createSseReplyResponse("resp_custom", "custom"));
		const customResult = await streamOpenAIResponses(
			createOpenAIModel(),
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 3 }] }),
			{ apiKey: "sk-test", transport: "auto", fetch: customFetch as typeof globalThis.fetch },
		).result();
		expect(customResult.stopReason).toBe("stop");

		expect(harness.sockets).toHaveLength(0);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(customFetch).toHaveBeenCalledTimes(1);
	});

	it("closes and evicts the pooled socket when the consumer exits mid-stream", async () => {
		const harness = new FakeWebSocketHarness();
		harness.onSend((socket) => {
			socket.emitMessage({ type: "response.created", sequence_number: 0, response: { id: "resp_abandoned" } });
		});
		harness.onSend((socket) => {
			emitSimpleReply(socket, "resp_fresh", "msg_fresh", "Fresh reply");
		});
		harness.install();

		const first = await streamOpenAIResponses(
			createOpenAIModel(),
			normalizeContext({ messages: [{ role: "user", content: "first", timestamp: 1 }] }),
			{
				apiKey: "sk-test",
				sessionId: "sess-early-exit",
				transport: "auto",
				onProviderStreamEvent: () => {
					throw new Error("consumer aborted mid-stream");
				},
			},
		).result();
		expect(first.stopReason).toBe("error");
		expect(first.errorMessage).toContain("consumer aborted mid-stream");
		expect(harness.sockets).toHaveLength(1);
		expect(harness.sockets[0]?.closed).toBe(true);

		const second = await streamOpenAIResponses(
			createOpenAIModel(),
			normalizeContext({ messages: [{ role: "user", content: "second", timestamp: 2 }] }),
			{
				apiKey: "sk-test",
				sessionId: "sess-early-exit",
				transport: "auto",
			},
		).result();
		expect(second.stopReason).toBe("stop");
		expect(second.responseId).toBe("resp_fresh");
		expect(harness.sockets).toHaveLength(2);
	});
});
