import { describe, expect, it } from "vitest";
import { convertMessages, requiresToolCallId } from "../src/api/google-shared.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SKIP_VALUE = "skip_thought_signature_validator";
/** The model a session used before it switched to Gemini; its tool calls carry no Google signature. */
const OTHER_MODEL = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6.1-sol" };
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
/** A gateway route to the Gemini API, the shape of the base URL the real calls used. */
const GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio/v1beta";

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
	baseUrl = "https://example.com",
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(model: { api: string; provider: string; id: string }, thoughtSignature?: string): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "echo hi" },
						...(thoughtSignature && { thoughtSignature }),
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "bash",
						arguments: { command: "ls -la" },
					},
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
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "files" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

function functionCallSignatures(contents: ReturnType<typeof convertMessages>): (string | undefined)[] {
	return contents
		.flatMap((content) => content.parts ?? [])
		.filter((part) => part.functionCall !== undefined)
		.map((part) => part.thoughtSignature);
}

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it.each([
		makeGemini3Model("google-generative-ai", "google"),
		makeGemini3Model("google-generative-ai", "google", "gemini-3.6-flash"),
		makeGemini3Model("google-vertex", "google-vertex"),
	])("preserves tool call IDs for $id via $api history", (model) => {
		const context = makeContext(model);
		const contents = convertMessages(model, normalizeContext(context));
		const functionCallIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : []));
		const functionResponseIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionResponse?.id ? [part.functionResponse.id] : []));

		expect(functionCallIds).toEqual(["call_1", "call_2"]);
		expect(functionResponseIds).toEqual(["call_1", "call_2"]);
	});

	// The Gemini API rejects the request (400) when the first call of a step in the current turn has
	// no signature. Real calls on provider `google`, through a gateway route to that API, show which
	// models need or accept the value. A provider under another ID reaches the same API by its host,
	// also with an empty base URL: the client then sends to the SDK default, which is that host.
	it.each([
		makeGemini3Model("google-generative-ai", "google", "gemini-3-flash-preview", GEMINI_API_URL),
		makeGemini3Model("google-generative-ai", "google", "gemini-4-carbon", GATEWAY_URL),
		makeGemini3Model("google-generative-ai", "google", "gemini-pro-latest", GATEWAY_URL),
		makeGemini3Model("google-generative-ai", "google", "gemma-4-31b-it", GATEWAY_URL),
		makeGemini3Model("google-generative-ai", "my-gemini", "gemini-4-carbon", GEMINI_API_URL),
		makeGemini3Model("google-generative-ai", "my-gemini", "gemini-4-carbon", ""),
	])("puts the skip value on the first call of another model's message for $provider/$id at $baseUrl", (model) => {
		const contents = convertMessages(model, normalizeContext(makeContext(OTHER_MODEL)));

		expect(functionCallSignatures(contents)).toEqual([SKIP_VALUE, undefined]);
	});

	// The value stays on the message after its turn ends, so the request prefix does not change.
	it("keeps the skip value on another model's message in a previous turn", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const currentTurn = makeContext(OTHER_MODEL);
		const previousTurn: Context = {
			messages: [...currentTurn.messages, { role: "user", content: "Thanks", timestamp: Date.now() }],
		};

		const current = convertMessages(model, normalizeContext(currentTurn));
		const previous = convertMessages(model, normalizeContext(previousTurn));

		expect(functionCallSignatures(previous)).toEqual([SKIP_VALUE, undefined]);
		expect(previous.slice(0, current.length)).toEqual(current);
	});

	// No real call proved the value on these routes, so they send what upstream sends: no value.
	// A base URL that only names the Gemini API host in its path, or that is no URL, is another route.
	it.each([
		makeGemini3Model("google-vertex", "google-vertex"),
		makeGemini3Model(
			"google-generative-ai",
			"opencode",
			"gemini-4-carbon",
			"https://opencode.ai/inference/google/v1beta",
		),
		makeGemini3Model(
			"google-generative-ai",
			"opencode-go",
			"gemini-4-argon",
			"https://opencode.ai/inference/go/google/v1beta",
		),
		makeGemini3Model(
			"google-generative-ai",
			"my-proxy",
			"gemini-4-carbon",
			"https://proxy.example.com/generativelanguage.googleapis.com/v1beta",
		),
		makeGemini3Model("google-generative-ai", "my-gemini", "gemini-4-carbon", "not a URL"),
		makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash", GEMINI_API_URL),
		makeGemini3Model("google-generative-ai", "google", "deep-research-preview-04-2026", GEMINI_API_URL),
	])("does not add the skip value for $provider/$id at $baseUrl", (model) => {
		const contents = convertMessages(model, normalizeContext(makeContext(OTHER_MODEL)));

		expect(functionCallSignatures(contents)).toEqual([undefined, undefined]);
	});

	it("keeps a same-model signature and adds no skip value to that message", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const contents = convertMessages(model, normalizeContext(makeContext(model, validSig)));

		expect(functionCallSignatures(contents)).toEqual([validSig, undefined]);
	});

	it("does not add tool call IDs for non-Gemini-3 models", () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, normalizeContext(makeContext({ ...model, id: "other-model" })));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((part) => part.functionCall !== undefined) ?? [];
		const functionResponseParts = contents
			.flatMap((content) => content.parts ?? [])
			.filter((part) => part.functionResponse !== undefined);

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts.every((part) => part.functionCall?.id === undefined)).toBe(true);
		expect(functionResponseParts).toHaveLength(2);
		expect(functionResponseParts.every((part) => part.functionResponse?.id === undefined)).toBe(true);
	});
});

describe("requiresToolCallId", () => {
	it.each([
		[false, "gemini-2.5-flash"],
		[true, "gemini-3.6-flash"],
		[true, "claude-sonnet-4-5"],
		[true, "gpt-oss-120b"],
	] as const)("returns %s for %s", (expected, modelId) => {
		expect(requiresToolCallId(modelId)).toBe(expected);
	});
});
