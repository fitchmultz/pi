import type { ResponseReasoningItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createModel(): Model<"azure-openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "azure-openai-responses",
		provider: "azure",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"azure-openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function* createEvents(
	doneItem: ResponseReasoningItem,
	completedItem: ResponseReasoningItem,
): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		output_index: 0,
		sequence_number: 0,
		item: { type: "reasoning", id: doneItem.id, summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 1,
		item: doneItem,
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: {
			id: "resp_test",
			status: "completed",
			output: [completedItem],
		},
	} as ResponseStreamEvent;
}

function getReplayedReasoning(model: Model<"azure-openai-responses">, assistant: AssistantMessage) {
	const context = normalizeContext({
		messages: [
			{ role: "user", content: "first", timestamp: Date.now() - 1 },
			assistant,
			{ role: "user", content: "follow-up", timestamp: Date.now() },
		],
	});
	const input = convertResponsesMessages(model, context, new Set(["azure"]));
	return input.find((item) => item.type === "reasoning");
}

describe("Azure OpenAI Responses reasoning replay", () => {
	it("preserves existing encrypted_content from output_item.done", async () => {
		const model = createModel();
		const output = createOutput(model);
		const doneItem: ResponseReasoningItem = {
			type: "reasoning",
			id: "rs_done",
			summary: [],
			encrypted_content: "from-output-item-done",
		};
		const completedItem: ResponseReasoningItem = {
			...doneItem,
			encrypted_content: "from-response-completed",
		};

		await processResponsesStream(
			createEvents(doneItem, completedItem),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(getReplayedReasoning(model, output)).toMatchObject({
			type: "reasoning",
			id: "rs_done",
			encrypted_content: "from-output-item-done",
		});
	});

	it("fills encrypted_content when output_item.done omitted it", async () => {
		const model = createModel();
		const output = createOutput(model);
		const doneItem: ResponseReasoningItem = {
			type: "reasoning",
			id: "rs_missing",
			summary: [],
		};
		const completedItem: ResponseReasoningItem = {
			...doneItem,
			encrypted_content: "from-response-completed",
		};

		await processResponsesStream(
			createEvents(doneItem, completedItem),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(getReplayedReasoning(model, output)).toMatchObject({
			type: "reasoning",
			id: "rs_missing",
			encrypted_content: "from-response-completed",
		});
	});
});

describe("Azure OpenAI Responses parity with OpenAI Responses", () => {
	function getHeader(headers: HeadersInit | undefined, name: string): string | null {
		if (!headers) return null;
		if (headers instanceof Headers) return headers.get(name);
		const lower = name.toLowerCase();
		if (Array.isArray(headers)) {
			const hit = headers.find(([key]) => key.toLowerCase() === lower);
			return hit?.[1] ?? null;
		}
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === lower) return String(value);
		}
		return null;
	}

	function sseBody(responseId: string): string {
		const item = {
			type: "message",
			id: `msg_${responseId}`,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "ok", annotations: [] }],
		};
		return [
			{ type: "response.created", response: { id: responseId } },
			{ type: "response.output_item.added", output_index: 0, item },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: responseId, status: "completed" } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
	}

	it("emits configuration_update for mid-convo effort changes and records providerThinkingLevel", async () => {
		const baseModel = getModel("azure", "gpt-6.2-sol");
		const model: Model<"azure-openai-responses"> = {
			...baseModel,
			compat: { ...baseModel.compat, supportsMidConvoEffort: true },
		};
		const payloads: Array<{ input: Array<Record<string, unknown>>; reasoning?: { effort?: string } }> = [];
		const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payloads.push(JSON.parse(String(init?.body)));
			return new Response(sseBody(`resp_${payloads.length}`), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const env = { AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1" };
		const history: Message[] = [{ role: "user", content: "one", timestamp: 1 }];

		const first = await streamAzureOpenAIResponses(model, normalizeContext({ messages: history }), {
			apiKey: "azure-test-key",
			reasoningEffort: "high",
			env,
			fetch: mockFetch as typeof globalThis.fetch,
		}).result();
		expect(first.stopReason).not.toBe("error");
		expect(first.providerThinkingLevel).toBe("high");

		history.push(first, { role: "user", content: "two", timestamp: 2 });
		const second = await streamAzureOpenAIResponses(model, normalizeContext({ messages: history }), {
			apiKey: "azure-test-key",
			reasoningEffort: "low",
			env,
			fetch: mockFetch as typeof globalThis.fetch,
		}).result();
		expect(second.stopReason).not.toBe("error");
		expect(second.providerThinkingLevel).toBe("low");

		expect(payloads[0]?.reasoning?.effort).toBe("medium");
		expect(payloads[1]?.reasoning?.effort).toBe("medium");
		expect(payloads[1]?.input.filter((item) => item.type === "configuration_update")).toEqual([
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ type: "configuration_update", reasoning: { effort: "low" } },
		]);
	});

	it("honors cacheRetention and session affinity headers", async () => {
		const baseModel = getModel("azure", "gpt-6.2-sol");
		const model: Model<"azure-openai-responses"> = {
			...baseModel,
			compat: { ...baseModel.compat, supportsExplicitPromptCacheMode: true },
		};
		const env = { AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1" };
		const capture = async (cacheRetention: "none" | "short" | "long") => {
			let payload: Record<string, unknown> | undefined;
			let sessionIdHeader: string | null = null;
			let clientRequestIdHeader: string | null = null;
			await streamAzureOpenAIResponses(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
				{
					apiKey: "azure-test-key",
					sessionId: "sess-azure-1",
					cacheRetention,
					env,
					fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
						payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
						sessionIdHeader = getHeader(init?.headers, "session-id");
						clientRequestIdHeader = getHeader(init?.headers, "x-client-request-id");
						return new Response(sseBody("resp_cache"), {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						});
					}) as typeof globalThis.fetch,
				},
			).result();
			return { payload, sessionIdHeader, clientRequestIdHeader };
		};

		const none = await capture("none");
		expect(none.payload?.prompt_cache_key).toBeUndefined();
		expect(none.payload?.prompt_cache_options).toEqual({ mode: "explicit" });
		expect(none.sessionIdHeader).toBeNull();
		expect(none.clientRequestIdHeader).toBeNull();

		const long = await capture("long");
		expect(long.payload?.prompt_cache_key).toBe("sess-azure-1");
		expect(long.payload?.prompt_cache_options).toEqual({ ttl: "30m" });
		expect(long.sessionIdHeader).toBe("sess-azure-1");
		expect(long.clientRequestIdHeader).toBe("sess-azure-1");
	});
});
