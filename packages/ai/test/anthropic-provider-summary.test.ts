import { gunzipSync } from "node:zlib";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, JsonObject, Message, Model, SystemMessage, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const COMPACTION_BETA = "compact-2026-09-04";

interface WireMessage {
	role: string;
	content: unknown;
	output_config?: { effort?: string };
}

interface CapturedRequest {
	body: { messages: WireMessage[]; system?: unknown; tools?: unknown; compaction?: unknown; thread?: unknown };
	betas: string[];
}

type WireEvent = { type: string } & Record<string, unknown>;

function sse(events: WireEvent[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function messageStart(): WireEvent {
	return {
		type: "message_start",
		message: { id: "msg_1", model: model.id, usage: { input_tokens: 0, output_tokens: 0 } },
	};
}

/** Fake Anthropic endpoint: records each request body and beta list, answers with the next queued response. */
function harness(responses: Response[]) {
	const requests: CapturedRequest[] = [];
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
		const headers = new Headers(init?.headers);
		// Bodies of 1 KiB and more are sent gzip-compressed to the direct endpoint.
		const body =
			headers.get("content-encoding") === "gzip"
				? gunzipSync(init?.body as Uint8Array).toString("utf8")
				: (init?.body as string);
		const beta = headers.get("anthropic-beta");
		requests.push({ body: JSON.parse(body), betas: beta ? beta.split(",") : [] });
		const response = responses.shift();
		if (!response) throw new Error("No response queued");
		return response;
	};
	const options: AnthropicOptions = {
		apiKey: "test-key",
		fetch,
		sessionId: "provider-summary-test",
		maxRetries: 0,
		thinkingEnabled: true,
		effort: "high",
	};
	return { requests, options };
}

/** A model with preserved thinking on the direct Anthropic endpoint, where message threads are on. */
const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
	contextWindow: 1_000_000,
	maxTokens: 4096,
	compat: {
		supportsMidConvoSystemMessages: true,
		supportsMidConvoToolChanges: true,
		supportsMidConvoEffort: true,
		forceAdaptiveThinking: true,
	},
};

const lookup = { name: "lookup", description: "Look up a value", parameters: Type.Object({ key: Type.String() }) };

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(callId: string, thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking, thinkingSignature: `sig-${callId}` },
			{ type: "toolCall", id: callId, name: "lookup", arguments: { key: callId } },
		],
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
		stopReason: "toolUse",
		providerThinkingLevel: "high",
		timestamp: 1,
	};
}

function toolResult(callId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "lookup",
		content: [{ type: "text", text: `value of ${callId}` }],
		isError: false,
		timestamp: 1,
	};
}

function effortMarker(effort: string): WireMessage {
	return { role: "system", content: [], output_config: { effort } };
}

const block: JsonObject = {
	type: "compaction",
	content: "Station walk: read the task note and proceed from there.",
	signature: "EuYBCkQY",
	tool_changes: [],
};

afterEach(() => {
	cleanupSessionResources();
});

describe("Anthropic provider summary block", () => {
	it("asks for a block with the messages of the normal request and reads block and usage", async () => {
		const h = harness([
			sse([
				messageStart(),
				{ type: "content_block_start", index: 0, content_block: block },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "compaction" },
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						iterations: [
							{
								type: "compaction",
								input_tokens: 95,
								output_tokens: 219,
								cache_read_input_tokens: 326_198,
								cache_creation_input_tokens: 0,
								cache_creation: null,
							},
						],
					},
				},
				{ type: "message_stop" },
			]),
			sse([
				messageStart(),
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]),
		]);
		const context = normalizeContext({
			systemPrompt: "You are a test assistant.",
			tools: [lookup],
			messages: [user("walk the stations"), assistant("call_1", "first"), toolResult("call_1")],
		});

		const summary = await stream(model, context, {
			...h.options,
			disableContinuation: true,
			providerSummary: { instructions: "One line. No next step." },
		}).result();
		await stream(model, context, h.options).result();

		const [summaryRequest, normalRequest] = h.requests;
		expect(summaryRequest.body.compaction).toEqual({ type: "summarize", instructions: "One line. No next step." });
		expect(summaryRequest.betas).toContain(COMPACTION_BETA);
		// The request that produced the next reply, sent again: same messages, ending in the effort marker.
		expect(summaryRequest.body.messages).toEqual(normalRequest.body.messages);
		expect(summaryRequest.body.messages.at(-1)).toEqual(effortMarker("high"));
		expect(summaryRequest.body.system).toEqual(normalRequest.body.system);
		expect(summaryRequest.body.tools).toEqual(normalRequest.body.tools);
		expect(normalRequest.body).not.toHaveProperty("compaction");
		expect(normalRequest.betas).not.toContain(COMPACTION_BETA);

		expect(summary.stopReason).toBe("stop");
		expect(summary.rawStopReason).toBe("compaction");
		expect(summary.content).toEqual([]);
		expect(summary.providerSummary).toEqual({
			provider: "anthropic",
			api: "anthropic-messages",
			model: model.id,
			block,
		});
		expect(summary.usage).toMatchObject({ input: 95, output: 219, cacheRead: 326_198, cacheWrite: 0 });
		expect(summary.usage.totalTokens).toBe(95 + 219 + 326_198);
		// 95 * 8 + 219 * 40 + 326198 * 0.2 per million tokens.
		expect(summary.usage.cost.total).toBeCloseTo(0.0747596, 6);
	});

	it("sends no thread with a summary request or with a block", async () => {
		const replyTo = (): Response =>
			sse([
				messageStart(),
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]);
		const h = harness([replyTo(), replyTo(), replyTo()]);
		const messages = [user("walk the stations")];
		const plain = normalizeContext({ systemPrompt: "You are a test assistant.", messages });
		const lead = plain.messages[0] as SystemMessage;
		const withBlock = {
			messages: [
				{ ...lead, providerSummary: { provider: model.provider, api: model.api, model: model.id, block } },
				...messages,
			],
		} as typeof plain;

		await stream(model, plain, h.options).result();
		await stream(model, plain, { ...h.options, providerSummary: {} }).result();
		await stream(model, withBlock, h.options).result();

		const [normal, summaryRequest, blockRequest] = h.requests;
		expect(normal.body.thread).toEqual({ type: "create" });
		expect(summaryRequest.body).not.toHaveProperty("thread");
		expect(summaryRequest.body.compaction).toEqual({ type: "summarize" });
		expect(blockRequest.body).not.toHaveProperty("thread");
	});

	it("sends the block first and no effort marker before the first kept assistant message", async () => {
		const replyTo = (): Response =>
			sse([
				messageStart(),
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]);
		const h = harness([replyTo(), replyTo(), replyTo()]);
		const kept: Message[] = [
			assistant("call_6", "sixth"),
			toolResult("call_6"),
			assistant("call_7", "seventh"),
			toolResult("call_7"),
			user("record written by the extension"),
		];
		const base = normalizeContext({ systemPrompt: "You are a test assistant.", tools: [lookup], messages: kept });
		const lead = base.messages[0] as SystemMessage;
		const contextFor = (provider: string, modelId: string) =>
			({
				messages: [{ ...lead, providerSummary: { provider, api: model.api, model: modelId, block } }, ...kept],
			}) as typeof base;

		await stream(model, base, h.options).result();
		const reply = await stream(model, contextFor(model.provider, model.id), h.options).result();
		await stream(model, contextFor(model.provider, "claude-other"), h.options).result();

		const [withoutBlock, withBlock, otherModel] = h.requests;
		expect(withoutBlock.body.messages.map((message) => message.role)).toEqual([
			"system", // effort marker before the first assistant message
			"assistant",
			"user",
			"system",
			"assistant",
			"user",
			"user",
			"system",
		]);

		expect(withBlock.body.messages[0]).toEqual({ role: "assistant", content: [block] });
		// Everything after the block is the request without it, minus the marker that led it.
		expect(withBlock.body.messages.slice(1)).toEqual(withoutBlock.body.messages.slice(1));
		expect(withBlock.body.messages[1].role).toBe("assistant");
		// The marker before the second kept assistant message stays.
		expect(withBlock.body.messages[3]).toEqual(effortMarker("high"));
		expect(withBlock.body.messages.at(-1)).toEqual(effortMarker("high"));
		expect(withBlock.body.system).toEqual(withoutBlock.body.system);
		expect(withBlock.body.tools).toEqual(withoutBlock.body.tools);
		expect(withBlock.betas).toContain(COMPACTION_BETA);
		// The journal records how many reasoning blocks the request carried and how many the API dropped.
		expect(reply.diagnostics).toEqual([
			{ type: "anthropic_thinking_blocks", timestamp: expect.any(Number), details: { sent: 2, dropped: 0 } },
		]);

		// A block another model wrote is not sent: the request is the one without a block.
		expect(otherModel.body.messages).toEqual(withoutBlock.body.messages);
		expect(otherModel.betas).not.toContain(COMPACTION_BETA);
	});

	it("does not send the tools the block restores, and sends later tool changes in place", async () => {
		const h = harness([
			sse([
				messageStart(),
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]),
		]);
		const ring = { name: "ring", description: "Ring the bell", parameters: Type.Object({}) };
		const chime = { name: "chime", description: "Play the chime", parameters: Type.Object({}) };
		const base = normalizeContext({ systemPrompt: "You are a test assistant.", tools: [lookup], messages: [] });
		const lead = base.messages[0] as SystemMessage;
		const context = {
			messages: [
				{ ...lead, providerSummary: { provider: model.provider, api: model.api, model: model.id, block } },
				// Added in the summarized conversation: the block's `tool_changes` restore it.
				{ role: "system", content: "", toolsAdded: [ring], timestamp: 1 },
				assistant("call_6", "sixth"),
				toolResult("call_6"),
				// Added in the kept conversation.
				{ role: "system", content: "", toolsAdded: [chime], timestamp: 1 },
				assistant("call_7", "seventh"),
				toolResult("call_7"),
			],
		} as typeof base;

		await stream(model, context, h.options).result();

		const { body } = h.requests[0];
		expect(body.messages[0]).toEqual({ role: "assistant", content: [block] });
		// Anything between the block and the first kept message makes Anthropic drop the kept thinking.
		expect(body.messages[1].role).toBe("assistant");
		const added = body.messages.flatMap((message) =>
			message.role === "system" && Array.isArray(message.content)
				? message.content.flatMap((part: { type: string; tool?: { definition: { name: string } } }) =>
						part.type === "tool_addition" && part.tool ? [part.tool.definition.name] : [],
					)
				: [],
		);
		expect(added).toEqual(["chime"]);
		expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
			"lookup",
			"__pi_deferred_placeholder__",
		]);
	});
});
