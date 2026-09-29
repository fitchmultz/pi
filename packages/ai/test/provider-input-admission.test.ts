import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { stream as streamPi } from "../src/api/pi-messages.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Api, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "admission",
		name: "Admission",
		api,
		provider: "test",
		baseUrl: "https://offline.invalid/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 40_000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const hugeTool: Tool = { name: "huge", description: "x".repeat(200_000), parameters: Type.Object({}) };
const smallTool: Tool = { name: "small", description: "Small tool", parameters: Type.Object({}) };
const removedToolContext = normalizeContext({
	messages: [
		{ role: "system", content: "Keep working instructions", toolsAdded: [smallTool], timestamp: 0 },
		{ role: "user", content: "Load tool", timestamp: 1 },
		{ role: "system", content: "Loaded", toolsAdded: [hugeTool], timestamp: 2 },
		{ role: "user", content: "Remove tool", timestamp: 3 },
		{ role: "system", content: "Removed", toolsRemoved: [{ name: "huge" }], timestamp: 4 },
	],
});

const responsesModel = { ...model("openai-responses"), compat: { supportsMidConvoSystemMessages: true } };
const completionsModel = { ...model("openai-completions"), compat: { supportsMidConvoSystemMessages: true } };
const mistralModel = { ...model("mistral-conversations"), compat: { supportsMidConvoSystemMessages: true } };
const options = { apiKey: "offline-placeholder", maxRetries: 0 };

describe("provider input admission", () => {
	it("rebuilds when a synthetic orphaned-call result pushes retained input over the limit", async () => {
		const small: Tool = { name: "small", description: "small", parameters: Type.Object({}) };
		const withdrawn: Tool = { name: "huge", description: "x".repeat(1000), parameters: Type.Object({}) };
		const context = normalizeContext({
			messages: [
				{ role: "system", content: "base", toolsAdded: [small, withdrawn], timestamp: 0 },
				{ role: "system", content: "removed", toolsRemoved: [{ name: "huge" }], timestamp: 1 },
				{
					...fauxAssistantMessage(fauxToolCall("small", {})),
					api: completionsModel.api,
					provider: "test",
					model: "admission",
				},
			],
		});
		const bodies: string[] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			bodies.push(String(init?.body));
			return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		});
		// The retained input needs 319 tokens before orphan repair, but 324 afterward.
		const result = await streamCompletions({ ...completionsModel, contextWindow: 319 }, context, {
			...options,
			fetch,
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		expect(bodies[0]).toContain("No result provided");
		expect(bodies[0]).not.toContain(withdrawn.description);
	});

	it("counts Anthropic inline declarations even when the request has no top-level tools", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const result = await streamAnthropic(
			{
				...model("anthropic-messages"),
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
			},
			normalizeContext({
				messages: [
					{ role: "system", content: "Base", timestamp: 0 },
					{ role: "user", content: "Load tool", timestamp: 1 },
					{ role: "system", content: "", toolsAdded: [hugeTool], timestamp: 2 },
				],
			}),
			{ ...options, fetch },
		).result();
		expect(fetch).not.toHaveBeenCalled();
		expect(result.errorMessage).toMatch(/Estimated provider input .* exceeds .*context window/);
	});

	it.each([
		...([false, true] as const).map((supportsAdditionalTools) => ({
			name: `Responses (additional tools=${supportsAdditionalTools})`,
			run: (fetch: typeof globalThis.fetch, contextWindow: number) =>
				streamResponses(
					{ ...responsesModel, contextWindow, compat: { ...responsesModel.compat, supportsAdditionalTools } },
					removedToolContext,
					{ ...options, fetch, transport: "sse" },
				),
		})),
		{
			name: "Codex with tool search",
			run: (fetch: typeof globalThis.fetch, contextWindow: number) =>
				streamCodex(
					{
						...model("openai-codex-responses"),
						contextWindow,
						compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
					},
					removedToolContext,
					{
						...options,
						fetch,
						transport: "sse",
						apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url")}.x`,
					},
				),
		},
		{
			name: "Azure",
			run: (fetch: typeof globalThis.fetch, contextWindow: number) =>
				streamAzure(
					{ ...model("azure-openai-responses"), contextWindow, compat: { supportsMidConvoSystemMessages: true } },
					removedToolContext,
					{ ...options, fetch },
				),
		},
		...([false, true] as const).map((supportsMidConvoToolAdditions) => ({
			name: `Completions (inline tools=${supportsMidConvoToolAdditions})`,
			run: (fetch: typeof globalThis.fetch, contextWindow: number) =>
				streamCompletions(
					{
						...completionsModel,
						contextWindow,
						compat: { ...completionsModel.compat, supportsMidConvoToolAdditions },
					},
					removedToolContext,
					{ ...options, fetch },
				),
		})),
		{
			name: "Mistral",
			run: (fetch: typeof globalThis.fetch, contextWindow: number) =>
				streamMistral({ ...mistralModel, contextWindow }, removedToolContext, { ...options, fetch }),
		},
		...(["executor", "reference", "inline"] as const).map((protocol) => ({
			name: `Anthropic (${protocol})`,
			run: (fetch: typeof globalThis.fetch, contextWindow: number) =>
				streamAnthropic(
					{
						...model("anthropic-messages"),
						contextWindow,
						provider: "anthropic",
						baseUrl: "https://api.anthropic.com",
						compat: {
							supportsMidConvoSystemMessages: true,
							supportsMidConvoToolChanges: protocol !== "executor",
						},
					},
					removedToolContext,
					{
						...options,
						fetch,
						...(protocol === "reference"
							? { headers: { "anthropic-beta": "mid-conversation-tool-changes-2026-07-01" } }
							: {}),
					},
				),
		})),
	])("$name rebuilds an overflowing retained tool baseline but retains it when it fits", async ({ run }) => {
		const bodies: string[] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			bodies.push(
				new Headers(init?.headers).get("content-encoding") === "zstd"
					? zstdDecompressSync(init?.body as Uint8Array).toString()
					: String(init?.body),
			);
			return new Response("", { headers: { "content-type": "text/event-stream" } });
		});
		await run(fetch, 40_000).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(bodies[0]).toContain("Keep working instructions");
		expect(bodies[0]).toContain("Small tool");
		expect(bodies[0]).not.toContain(hugeTool.description);
		await run(fetch, 100_000).result();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(bodies[1]).toContain(hugeTool.description);
	});

	it.each(["openai-responses", "pi-messages"] as const)(
		"%s refuses oversized active schemas before transport",
		async (api) => {
			const context = normalizeContext({
				messages: [
					{ role: "system", content: "Base", toolsAdded: [hugeTool], timestamp: 0 },
					{ role: "user", content: "Use tool", timestamp: 1 },
				],
			});
			const fetch = vi.fn<typeof globalThis.fetch>(
				async () => new Response("", { headers: { "content-type": "text/event-stream" } }),
			);
			const result = await (api === "openai-responses"
				? streamResponses(
						{ ...responsesModel, compat: { ...responsesModel.compat, supportsToolSearch: true } },
						context,
						{ ...options, fetch, transport: "sse" },
					)
				: streamPi(model("pi-messages"), context, { ...options, fetch })
			).result();
			expect(fetch).not.toHaveBeenCalled();
			expect(result.errorMessage).toMatch(/Estimated provider input .* exceeds .*context window/);
		},
	);
});
