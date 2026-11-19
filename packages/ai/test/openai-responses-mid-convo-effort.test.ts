import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	type OpenAICodexResponsesOptions,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface Payload {
	input: Array<Record<string, unknown>>;
	reasoning?: { effort?: string };
}

const thinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

function openAIModel(compat: Model<"openai-responses">["compat"] = { supportsMidConvoEffort: true }) {
	return {
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		compat,
	} satisfies Model<"openai-responses">;
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

const toolResult = (callId: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "lookup",
	content: [{ type: "text", text: "result" }],
	isError: false,
	timestamp: 0,
});

const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

function responseEvents(responseId: string, withToolCall: boolean): object[] {
	const item = withToolCall
		? { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" }
		: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
			};
	return [
		{ type: "response.created", response: { id: responseId } },
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: responseId, status: "completed" } },
	];
}

async function runOpenAI(
	messages: Message[],
	reasoningEffort: OpenAIResponsesOptions["reasoningEffort"],
	options: { apiKey?: string; model?: Model<"openai-responses">; withToolCall?: boolean } = {},
): Promise<{ payload: Payload; message: AssistantMessage }> {
	let payload: Payload | undefined;
	const fetchMock = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		payload = JSON.parse(String(init?.body)) as Payload;
		const body = responseEvents("resp_1", options.withToolCall ?? false)
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const message = await streamOpenAIResponses(options.model ?? openAIModel(), normalizeContext({ messages }), {
		apiKey: options.apiKey ?? "sk-test",
		reasoningEffort,
		fetch: fetchMock as typeof globalThis.fetch,
	}).result();
	if (!payload) throw new Error("Request payload was not captured");
	expect(message.stopReason).not.toBe("error");
	return { payload, message };
}

describe("OpenAI Responses configuration_update", () => {
	it("keeps reasoning.effort constant and only appends input when the level changes", async () => {
		const history: Message[] = [user("one")];
		const first = await runOpenAI(history, "high");
		history.push(first.message, user("two"));
		const second = await runOpenAI(history, "high");
		history.push(second.message, user("three"));
		const third = await runOpenAI(history, "low");

		expect(first.payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "one" }] },
			update("high"),
		]);
		for (const { payload } of [first, second, third]) {
			expect(payload.reasoning?.effort).toBe("medium");
		}
		expect(second.payload.input.slice(0, first.payload.input.length)).toEqual(first.payload.input);
		expect(third.payload.input.slice(0, second.payload.input.length)).toEqual(second.payload.input);
		expect(third.payload.input.filter((item) => item.type === "configuration_update")).toEqual([
			update("high"),
			update("high"),
			update("low"),
		]);
		expect(third.payload.input.at(-1)).toEqual(update("low"));
		expect([first, second, third].map(({ message }) => message.providerThinkingLevel)).toEqual([
			"high",
			"high",
			"low",
		]);
	});

	it("applies a level change made during a tool loop to the next reply", async () => {
		const history: Message[] = [user("one")];
		const toolCall = await runOpenAI(history, "high", { withToolCall: true });
		history.push(toolCall.message, toolResult("call_1|fc_1"));
		const afterTool = await runOpenAI(history, "low");

		expect(afterTool.payload.input.slice(0, toolCall.payload.input.length)).toEqual(toolCall.payload.input);
		expect(afterTool.payload.input.slice(-2)).toEqual([
			expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
			update("low"),
		]);
		expect(afterTool.message.providerThinkingLevel).toBe("low");
	});

	it("adds items only before replies recorded by this model", async () => {
		const unstamped = (await runOpenAI([user("one")], "high", { model: openAIModel({}) })).message;
		const otherProvider: AssistantMessage = { ...unstamped, provider: "opencode", providerThinkingLevel: "high" };
		const otherModel: AssistantMessage = { ...unstamped, model: "gpt-6-sol", providerThinkingLevel: "high" };
		const recorded: AssistantMessage = { ...unstamped, providerThinkingLevel: "high" };

		const { payload } = await runOpenAI(
			[
				user("one"),
				unstamped,
				user("two"),
				otherProvider,
				user("three"),
				otherModel,
				user("four"),
				recorded,
				user("five"),
			],
			"low",
		);

		expect(payload.input.map((item) => item.type ?? item.role)).toEqual([
			"user",
			"message",
			"user",
			"message",
			"user",
			"message",
			"user",
			"configuration_update",
			"message",
			"user",
			"configuration_update",
		]);
		expect(payload.input.filter((item) => item.type === "configuration_update")).toEqual([
			update("high"),
			update("low"),
		]);
	});

	it.each([
		{
			name: "Sign in with ChatGPT",
			apiKey: "chatgpt-access-token",
			model: openAIModel(),
			level: "low",
			effort: "low",
		},
		{
			name: "the compat flag turned off",
			apiKey: "sk-test",
			model: openAIModel({ supportsMidConvoEffort: false }),
			level: "low",
			effort: "low",
		},
		{ name: "thinking off", apiKey: "sk-test", model: openAIModel(), level: undefined, effort: "none" },
	] as const)("sends the level as reasoning.effort with $name", async ({ apiKey, model, level, effort }) => {
		const first = await runOpenAI([user("one")], "high", { apiKey, model });
		const { payload, message } = await runOpenAI([user("one"), first.message, user("two")], level, {
			apiKey,
			model,
		});

		expect(payload.reasoning?.effort).toBe(effort);
		expect(payload.input.some((item) => item.type === "configuration_update")).toBe(false);
		expect(message.providerThinkingLevel).toBeUndefined();
	});
});

function mockCodexToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function decodeCodexBody(body: RequestInit["body"] | undefined): Payload {
	if (typeof body === "string") return JSON.parse(body) as Payload;
	if (body instanceof Uint8Array) return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as Payload;
	throw new Error("Unexpected Codex request body");
}

function codexModel(overrides: Partial<Model<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
	return {
		id: "gpt-6.2-sol",
		name: "GPT-6.2 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 128000,
		compat: { supportsMidConvoEffort: true },
		...overrides,
	};
}

async function runCodex(
	messages: Message[],
	reasoningEffort: OpenAICodexResponsesOptions["reasoningEffort"],
	options: {
		model?: Model<"openai-codex-responses">;
		inputTransformations?: unknown[];
	} = {},
): Promise<{ payload: Payload; message: AssistantMessage }> {
	let payload: Payload | undefined;
	const fetchMock = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		payload = decodeCodexBody(init?.body);
		const events = [
			...responseEvents("resp_codex", false).slice(0, -1),
			{
				type: "response.completed",
				response: {
					id: "resp_codex",
					status: "completed",
					...(options.inputTransformations !== undefined
						? { input_transformations: options.inputTransformations }
						: {}),
				},
			},
		];
		const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const message = await streamOpenAICodexResponses(options.model ?? codexModel(), normalizeContext({ messages }), {
		apiKey: mockCodexToken(),
		reasoningEffort,
		transport: "sse",
		fetch: fetchMock as typeof globalThis.fetch,
	}).result();
	if (!payload) throw new Error("Codex request payload was not captured");
	expect(message.stopReason).not.toBe("error");
	return { payload, message };
}

describe("OpenAI Codex Responses configuration_update", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		closeOpenAICodexWebSocketSessions();
		resetOpenAICodexWebSocketDebugStats();
	});

	it("enables supportsMidConvoEffort on built-in GPT-6 Codex models", () => {
		expect(getBuiltinModel("openai-codex", "gpt-6.2-sol").compat?.supportsMidConvoEffort).toBe(true);
		expect(getBuiltinModel("openai-codex", "gpt-6.2-astra").compat?.supportsMidConvoEffort).toBe(true);
		expect(getBuiltinModel("openai-codex", "gpt-5.6-sol").compat?.supportsMidConvoEffort).toBeUndefined();
	});

	it("keeps reasoning.effort constant and appends configuration_update across level changes", async () => {
		const history: Message[] = [user("one")];
		const first = await runCodex(history, "high");
		history.push(first.message, user("two"));
		const second = await runCodex(history, "low");

		expect(first.payload.reasoning?.effort).toBe("medium");
		expect(second.payload.reasoning?.effort).toBe("medium");
		expect(second.payload.input.slice(0, first.payload.input.length)).toEqual(first.payload.input);
		expect(second.payload.input.filter((item) => item.type === "configuration_update")).toEqual([
			update("high"),
			update("low"),
		]);
		expect([first.message.providerThinkingLevel, second.message.providerThinkingLevel]).toEqual(["high", "low"]);
	});

	it("defaults on canonical GPT-6 models when an overlay omits the flag, and respects explicit opt-out", async () => {
		const overlayWithoutFlag = await runCodex([user("one")], "high", { model: codexModel({ compat: {} }) });
		expect(overlayWithoutFlag.payload.reasoning?.effort).toBe("medium");
		expect(overlayWithoutFlag.payload.input.at(-1)).toEqual(update("high"));
		expect(overlayWithoutFlag.message.providerThinkingLevel).toBe("high");

		const optedOut = await runCodex([user("one")], "high", {
			model: codexModel({ compat: { supportsMidConvoEffort: false } }),
		});
		expect(optedOut.payload.reasoning?.effort).toBe("high");
		expect(optedOut.payload.input.some((item) => item.type === "configuration_update")).toBe(false);
		expect(optedOut.message.providerThinkingLevel).toBeUndefined();

		const customEndpoint = await runCodex([user("one")], "high", {
			model: codexModel({ baseUrl: "https://proxy.invalid/backend-api", compat: {} }),
		});
		expect(customEndpoint.payload.reasoning?.effort).toBe("high");
		expect(customEndpoint.payload.input.some((item) => item.type === "configuration_update")).toBe(false);
	});

	it("falls back to request reasoning.effort when thinking is off or none", async () => {
		const sol = codexModel({
			id: "gpt-6-sol",
			thinkingLevelMap: { ...thinkingLevelMap },
		});
		const off = await runCodex([user("one")], undefined, { model: sol });
		expect(off.payload.reasoning?.effort).toBe("none");
		expect(off.payload.input.some((item) => item.type === "configuration_update")).toBe(false);
		expect(off.message.providerThinkingLevel).toBeUndefined();

		const explicitNone = await runCodex([user("one")], "none", { model: sol });
		expect(explicitNone.payload.reasoning?.effort).toBe("none");
		expect(explicitNone.payload.input.some((item) => item.type === "configuration_update")).toBe(false);
	});

	it("preserves WebSocket previous_response_id delta continuation across an effort change", async () => {
		const sentPayloads: Array<Record<string, unknown>> = [];
		let responseCount = 0;
		class MockWebSocket extends EventTarget {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = MockWebSocket.CONNECTING;
			constructor(_url: string, _options?: unknown) {
				super();
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.dispatchEvent(new Event("open"));
				});
			}
			send(data: string): void {
				const parsed = JSON.parse(data) as Record<string, unknown>;
				sentPayloads.push(parsed);
				const id = `resp_ws_${++responseCount}`;
				queueMicrotask(() => {
					for (const event of responseEvents(id, false)) {
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
					}
				});
			}
			close(): void {
				this.readyState = MockWebSocket.CLOSED;
				this.dispatchEvent(new Event("close"));
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		const model = codexModel();
		const sessionId = "ws-effort-change-session";
		const first = await streamOpenAICodexResponses(model, normalizeContext({ messages: [user("one")] }), {
			apiKey: mockCodexToken(),
			reasoningEffort: "high",
			transport: "websocket-cached",
			sessionId,
		}).result();
		const second = await streamOpenAICodexResponses(
			model,
			normalizeContext({ messages: [user("one"), first, user("two")] }),
			{
				apiKey: mockCodexToken(),
				reasoningEffort: "low",
				transport: "websocket-cached",
				sessionId,
			},
		).result();

		expect(second.stopReason).toBe("stop");
		expect(sentPayloads).toHaveLength(2);
		expect(sentPayloads[0].previous_response_id).toBeUndefined();
		expect(sentPayloads[1].previous_response_id).toBe("resp_ws_1");
		expect(sentPayloads[1].input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "two" }] },
			update("low"),
		]);
	});
});

describe("OpenAI Responses input_transformations diagnostics", () => {
	it("records openai_input_transformations when OpenAI removes reasoning items and omits it when empty", async () => {
		const removed = {
			type: "reasoning",
			id: "rs_dropped_1",
			action: "removed",
			reason: "prefix_mismatch",
		};
		const withDrop = await runCodex([user("one")], "high", { inputTransformations: [removed] });
		expect(withDrop.message.diagnostics).toEqual([
			{
				type: "openai_input_transformations",
				timestamp: expect.any(Number),
				details: { transformations: [removed] },
			},
		]);

		const empty = await runCodex([user("one")], "high", { inputTransformations: [] });
		expect(empty.message.diagnostics).toBeUndefined();
	});
});
