import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { streamSimple as streamAzureOpenAIResponsesSimple } from "../src/api/azure-openai-responses.ts";
import { streamSimple as streamOpenAICodexResponsesSimple } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamOpenAIResponsesSimple } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, JsonObject, Message, Model, SystemMessage } from "../src/types.ts";

const lookup = { name: "lookup", description: "Look up a value", parameters: Type.Object({ key: Type.String() }) };
const ring = { name: "ring", description: "Ring the bell", parameters: Type.Object({}) };

const compactionBlock: JsonObject = {
	type: "compaction",
	id: "cmp_test_123",
	encrypted_content: "gAAAAAB_test_encrypted_payload",
};

function sse(events: Array<Record<string, unknown>>): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function makeCodexJwt(accountId = "acct_test"): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.sig`;
}

function keptReply(
	model: Model<"openai-responses" | "openai-codex-responses" | "azure-openai-responses">,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_kept_1",
					encrypted_content: "enc_reasoning_1",
					summary: [],
				}),
			},
			{ type: "text", text: "kept answer" },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		providerThinkingLevel: "high",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

afterEach(() => {
	cleanupSessionResources();
});

describe("OpenAI Responses provider summary blocks", () => {
	it("sends compaction_trigger on openai-responses and captures + replays the encrypted compaction item", async () => {
		const model = getModel("openai", "gpt-6.2-sol");
		const payloads: Array<{ input: Array<Record<string, unknown>>; max_output_tokens?: number }> = [];
		const responses = [
			sse([
				{ type: "response.created", response: { id: "resp_cmp" } },
				{ type: "response.output_item.done", output_index: 0, item: compactionBlock },
				{
					type: "response.completed",
					response: {
						id: "resp_cmp",
						status: "completed",
						output: [compactionBlock],
						usage: {
							input_tokens: 100,
							output_tokens: 30,
							total_tokens: 130,
							input_tokens_details: { cached_tokens: 80 },
						},
					},
				},
			]),
			sse([
				{ type: "response.created", response: { id: "resp_next" } },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_next",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "ok" }],
					},
				},
				{
					type: "response.completed",
					response: { id: "resp_next", status: "completed", output: [] },
				},
			]),
		];
		const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			payloads.push(JSON.parse(String(init?.body)));
			const next = responses.shift();
			if (!next) throw new Error("No queued response");
			return next;
		}) as typeof globalThis.fetch;

		const summaryContext = normalizeContext({
			systemPrompt: "You are a test assistant.",
			tools: [lookup],
			messages: [{ role: "user", content: "remember alpha=42", timestamp: 1 }],
		});
		const summaryResult = await streamOpenAIResponsesSimple(model, summaryContext, {
			apiKey: "sk-test-key",
			reasoning: "high",
			maxTokens: 4000,
			disableContinuation: true,
			providerSummary: { instructions: "ignored by OpenAI" },
			fetch: mockFetch,
		}).result();

		expect(summaryResult.stopReason).toBe("stop");
		expect(summaryResult.content).toEqual([]);
		expect(summaryResult.providerSummary).toEqual({
			provider: "openai",
			api: "openai-responses",
			model: "gpt-6.2-sol",
			block: compactionBlock,
		});
		expect(summaryResult.usage).toMatchObject({ input: 20, cacheRead: 80, output: 30, totalTokens: 130 });
		expect(payloads[0]?.max_output_tokens).toBeUndefined();
		expect(payloads[0]?.input.at(-2)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
		expect(payloads[0]?.input.at(-1)).toEqual({ type: "compaction_trigger" });

		const leadBase = summaryContext.messages[0] as SystemMessage;
		const leadWithBlock: SystemMessage = {
			...leadBase,
			providerSummary: { ...summaryResult.providerSummary!, timestamp: 5 },
		};
		const summarizedTools: Message = {
			role: "system",
			content: "",
			toolsAdded: [ring],
			timestamp: 5,
		};
		const replayContext = {
			...summaryContext,
			messages: [
				leadWithBlock,
				summarizedTools,
				keptReply(model),
				{ role: "user" as const, content: "next", timestamp: 6 },
			],
		};

		const nextResult = await streamOpenAIResponsesSimple(model, replayContext, {
			apiKey: "sk-test-key",
			reasoning: "low",
			fetch: mockFetch,
		}).result();
		expect(nextResult.stopReason).toBe("stop");

		const replayInput = payloads[1]?.input ?? [];
		const initialToolsItem = replayInput[0] as { type?: string; tools?: Array<{ name?: string }> } | undefined;
		expect(initialToolsItem?.type).toBe("additional_tools");
		expect(initialToolsItem?.tools?.map((tool) => tool.name)).toEqual(["lookup"]);
		const devIndex = replayInput.findIndex(
			(item) => item.role === "developer" && item.content === "You are a test assistant.",
		);
		const cmpIndex = replayInput.findIndex((item) => item.type === "compaction");
		const ringIndex = replayInput.findIndex(
			(item) =>
				item.type === "additional_tools" &&
				Array.isArray(item.tools) &&
				item.tools.some((tool: { name?: string }) => tool.name === "ring"),
		);
		const reasoningIndex = replayInput.findIndex((item) => item.type === "reasoning" && item.id === "rs_kept_1");

		expect(devIndex).toBeGreaterThanOrEqual(0);
		expect(cmpIndex).toBe(devIndex + 1);
		expect(replayInput[cmpIndex]).toEqual(compactionBlock);
		expect(ringIndex).toBeGreaterThan(cmpIndex);
		expect(reasoningIndex).toBeGreaterThan(ringIndex);
	});

	it("backfills the compaction block from response.completed when output_item.done is absent", async () => {
		const model = getModel("openai", "gpt-6.2-sol");
		const result = await streamOpenAIResponsesSimple(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			}),
			{
				apiKey: "sk-test-key",
				reasoning: "medium",
				providerSummary: {},
				fetch: (async () =>
					sse([
						{ type: "response.created", response: { id: "resp_terminal_only" } },
						{
							type: "response.completed",
							response: { id: "resp_terminal_only", status: "completed", output: [compactionBlock] },
						},
					])) as typeof globalThis.fetch,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.providerSummary?.block).toEqual(compactionBlock);
	});

	it("rejects providerSummary before dispatch when using Sign in with ChatGPT on openai", async () => {
		const model = getModel("openai", "gpt-6.2-sol");
		let called = false;
		const result = await streamOpenAIResponsesSimple(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			}),
			{
				apiKey: "eyJhbGciOiJSUzI1NiJ9.chatgpt-oauth-token.sig",
				reasoning: "medium",
				providerSummary: {},
				fetch: (async () => {
					called = true;
					throw new Error("should not be called");
				}) as typeof globalThis.fetch,
			},
		).result();

		expect(called).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Sign in with ChatGPT");
		expect(result.providerSummary).toBeUndefined();
	});

	it("allows providerSummary when OpenAI credentials are supplied via headers without apiKey", async () => {
		const model = getModel("openai", "gpt-6.2-sol");
		const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
		const result = await streamOpenAIResponsesSimple(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			}),
			{
				headers: { authorization: "Bearer sk-header-key" },
				reasoning: "medium",
				providerSummary: {},
				fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
					payloads.push(JSON.parse(String(init?.body)));
					return sse([
						{ type: "response.created", response: { id: "resp_hdr_cmp" } },
						{ type: "response.output_item.done", output_index: 0, item: compactionBlock },
						{
							type: "response.completed",
							response: { id: "resp_hdr_cmp", status: "completed", output: [compactionBlock] },
						},
					]);
				}) as typeof globalThis.fetch,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.providerSummary?.block).toEqual(compactionBlock);
		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.input.at(-1)).toEqual({ type: "compaction_trigger" });
	});

	it("sends compaction_trigger over SSE on openai-codex-responses even when transport is auto", async () => {
		const model = getModel("openai-codex", "gpt-6.2-sol");
		const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
		const result = await streamOpenAICodexResponsesSimple(
			model,
			normalizeContext({
				systemPrompt: "sys",
				tools: [lookup],
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			}),
			{
				apiKey: makeCodexJwt(),
				reasoning: "high",
				transport: "auto",
				disableContinuation: true,
				providerSummary: {},
				fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
					const headers = new Headers(init?.headers);
					const rawBody =
						headers.get("content-encoding") === "zstd"
							? zstdDecompressSync(init?.body as Uint8Array).toString("utf8")
							: String(init?.body);
					payloads.push(JSON.parse(rawBody));
					return sse([
						{ type: "response.created", response: { id: "resp_codex_cmp" } },
						{ type: "response.output_item.done", output_index: 0, item: compactionBlock },
						{
							type: "response.completed",
							response: { id: "resp_codex_cmp", status: "completed", output: [compactionBlock] },
						},
					]);
				}) as typeof globalThis.fetch,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.providerSummary).toEqual({
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-6.2-sol",
			block: compactionBlock,
		});
		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.input.at(-1)).toEqual({ type: "compaction_trigger" });
	});

	it("supports compaction_trigger and summaryBlock replay on azure-openai-responses", async () => {
		const baseModel = getModel("azure", "gpt-6.2-sol");
		const model: Model<"azure-openai-responses"> = {
			...baseModel,
			compat: {
				...baseModel.compat,
				supportsMidConvoEffort: true,
				supportsMidConvoSystemMessages: true,
				supportsAdditionalTools: true,
			},
		};
		const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
		const baseContext = normalizeContext({
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		});
		const summaryResult = await streamAzureOpenAIResponsesSimple(model, baseContext, {
			apiKey: "azure-test-key",
			env: { AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1" },
			reasoning: "high",
			providerSummary: {},
			fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
				payloads.push(JSON.parse(String(init?.body)));
				return sse([
					{ type: "response.created", response: { id: "resp_azure_cmp" } },
					{ type: "response.output_item.done", output_index: 0, item: compactionBlock },
					{
						type: "response.completed",
						response: { id: "resp_azure_cmp", status: "completed", output: [compactionBlock] },
					},
				]);
			}) as typeof globalThis.fetch,
		}).result();

		expect(summaryResult.stopReason).toBe("stop");
		expect(summaryResult.providerSummary?.block).toEqual(compactionBlock);
		expect(payloads[0]?.input.at(-1)).toEqual({ type: "compaction_trigger" });
	});
});
