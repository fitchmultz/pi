import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
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

describe("native provider input admission", () => {
	it.each([
		{
			name: "Responses",
			run: (fetch: typeof globalThis.fetch) =>
				streamResponses(responsesModel, removedToolContext, { ...options, fetch, transport: "sse" }),
		},
		{
			name: "Completions",
			run: (fetch: typeof globalThis.fetch) =>
				streamCompletions(completionsModel, removedToolContext, { ...options, fetch }),
		},
		{
			name: "Mistral",
			run: (fetch: typeof globalThis.fetch) =>
				streamMistral(mistralModel, removedToolContext, { ...options, fetch }),
		},
	])("$name admits removed schemas when the native request sends only current tools", async ({ run }) => {
		const bodies: string[] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			bodies.push(String(init?.body));
			return new Response("", { headers: { "content-type": "text/event-stream" } });
		});
		await run(fetch).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(bodies[0]).toContain("Keep working instructions");
		expect(bodies[0]).toContain("Small tool");
		expect(bodies[0]).not.toContain(hugeTool.description);
	});

	it.each([false, true])(
		"Anthropic counts removed deferred declarations only when native tool changes send them (%s)",
		async (supportsMidConvoToolChanges) => {
			const fetch = vi.fn<typeof globalThis.fetch>(
				async () => new Response("", { headers: { "content-type": "text/event-stream" } }),
			);
			const result = await streamAnthropic(
				{
					...model("anthropic-messages"),
					compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges },
				},
				removedToolContext,
				{ ...options, fetch },
			).result();
			if (supportsMidConvoToolChanges) {
				expect(fetch).not.toHaveBeenCalled();
				expect(result.errorMessage).toMatch(/Estimated provider input .* exceeds .*context window/);
			} else {
				expect(fetch).toHaveBeenCalledOnce();
			}
		},
	);

	it.each(["openai-responses", "pi-messages"] as const)(
		"%s refuses native tool-search schemas before transport",
		async (api) => {
			const call = { ...fauxToolCall("search", { query: "huge" }), kind: "toolSearch" as const };
			const context = normalizeContext({
				messages: [
					{ role: "user", content: "Find huge tool", timestamp: 1 },
					{ ...fauxAssistantMessage(call), api, provider: "test", model: "admission" },
					{
						role: "toolResult",
						toolCallId: call.id,
						toolName: "search",
						toolCallKind: "toolSearch",
						content: [],
						isError: false,
						timestamp: 2,
						toolsAdded: [hugeTool],
					},
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
