import type {
	Response,
	ResponseFunctionToolCall,
	ResponseFunctionWebSearch,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseOutputText,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.4",
	name: "Fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 4096,
};
const url = "https://example.com/guide";
const uncitedUrl = "https://example.com/reference";
const calls: ResponseFunctionWebSearch[] = [
	{
		type: "web_search_call",
		id: "ws_search",
		status: "completed",
		action: {
			type: "search",
			queries: ["official guide"],
			sources: [
				{ type: "url", url },
				{ type: "url", url: uncitedUrl },
			],
		},
	},
	{ type: "web_search_call", id: "ws_open", status: "completed", action: { type: "open_page", url } },
	{
		type: "web_search_call",
		id: "ws_find",
		status: "failed",
		action: { type: "find_in_page", url, pattern: "missing heading" },
	},
];
const citation: ResponseOutputText.URLCitation = {
	type: "url_citation",
	start_index: 0,
	end_index: 6,
	url,
	title: "Official guide",
};
const message: ResponseOutputMessage = {
	type: "message",
	id: "msg_web",
	role: "assistant",
	status: "completed",
	content: [
		{ type: "output_text", text: "Guide. ", annotations: [citation] },
		{ type: "output_text", text: "Again.", annotations: [{ ...citation, end_index: 5 }] },
	],
};
const local: ResponseFunctionToolCall = {
	type: "function_call",
	id: "fc_local",
	call_id: "call_local",
	name: "read",
	arguments: '{"path":"README.md"}',
};
const expectedCitations = [
	{ itemId: "msg_web", contentIndex: 0, annotation: citation },
	{ itemId: "msg_web", contentIndex: 1, annotation: { ...citation, end_index: 5 } },
];

function response(output: ResponseOutputItem[]): Response {
	return {
		id: "resp_web",
		object: "response",
		created_at: 1,
		status: "completed",
		model: model.id,
		output,
		output_text: "Guide. Again.",
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		parallel_tool_calls: true,
		temperature: null,
		top_p: null,
		tool_choice: "auto",
		tools: [],
	};
}

function completedEvents(items: ResponseOutputItem[], terminalItems = items): ResponseStreamEvent[] {
	return [
		...items.map(
			(item, output_index): ResponseStreamEvent => ({
				type: "response.output_item.done",
				output_index,
				sequence_number: output_index,
				item,
			}),
		),
		{ type: "response.completed", sequence_number: items.length, response: response(terminalItems) },
	];
}

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...model.cost, total: 0 } },
		stopReason: "pending",
		timestamp: 1,
	};
}

async function process(events: ResponseStreamEvent[], output = createOutput()): Promise<AssistantMessage> {
	await processResponsesStream(
		(async function* () {
			yield* events;
		})(),
		output,
		new AssistantMessageEventStream(),
		model,
	);
	return output;
}

describe("Responses web-search metadata", () => {
	it("retains native calls and citation positions without duplicating terminal records or creating local tool calls", async () => {
		const wireItem = structuredClone(local);
		const output = await process(completedEvents([...calls, message, local]));
		expect(JSON.parse(JSON.stringify(output)).webSearch).toEqual({ calls, citations: expectedCitations });
		expect(output.content).toEqual([
			{ type: "text", text: "Guide. Again.", textSignature: '{"v":1,"id":"msg_web"}' },
			{
				type: "toolCall",
				id: "call_local|fc_local",
				name: "read",
				arguments: { path: "README.md" },
				responsesItem: wireItem,
			},
		]);
		expect(output.stopReason).toBe("toolUse");
		// Hosted items are replayable state, never locally executable tool calls.
		const replay = convertResponsesMessages(
			model,
			normalizeContext({ messages: [output] }),
			new Set([model.provider]),
		);
		expect(replay.filter((item) => item.type === "function_call")).toHaveLength(1);
		expect(replay.filter((item) => item.type === "web_search_call")).toEqual(calls);
	});

	it("keeps terminal-only sources and citations, including enrichment of an existing call", async () => {
		const searchWithoutSources: ResponseFunctionWebSearch = {
			...calls[0],
			action: { type: "search", queries: ["official guide"] },
		};
		const plain: ResponseOutputMessage = {
			...message,
			content: [
				{ type: "output_text", text: "Guide. ", annotations: [] },
				{ type: "output_text", text: "Again.", annotations: [] },
			],
		};
		const output = await process(completedEvents([searchWithoutSources, plain], [...calls, message]));
		expect(output.webSearch).toEqual({ calls, citations: expectedCitations });
		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({ type: "text", text: "Guide. Again." });
		expect(output.stopReason).toBe("stop");
	});

	it("does not invent web metadata from ordinary text or file citations", async () => {
		const plain: ResponseOutputMessage = {
			...message,
			content: [
				{
					type: "output_text",
					text: url,
					annotations: [{ type: "file_citation", file_id: "file_a", filename: "a.txt", index: 0 }],
				},
			],
		};
		const output = await process(completedEvents([plain]));
		expect(output).not.toHaveProperty("webSearch");
		expect(output.content[0]).toMatchObject({ type: "text", text: url });
		expect(output.stopReason).toBe("stop");
	});

	it("retains received completed items when the stream ends early, without claiming the response completed", async () => {
		const output = createOutput();
		await expect(process(completedEvents([calls[0], message]).slice(0, -1), output)).rejects.toThrow(
			"before a terminal response event",
		);
		expect(output.webSearch).toEqual({ calls: [calls[0]], citations: expectedCitations });
		expect(output.stopReason).toBe("pending");
	});

	it("preserves metadata through the native Codex HTTP adapter with fake credentials", async () => {
		const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
		const events = completedEvents([...calls, message, local]);
		let requests = 0;
		const output = await streamCodex(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] }),
			{
				apiKey: token,
				transport: "sse",
				maxRetries: 0,
				fetch: async () => {
					requests++;
					return new globalThis.Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		).result();
		expect(requests).toBe(1);
		expect(output.stopReason).toBe("toolUse");
		expect(output.webSearch).toEqual({ calls, citations: expectedCitations });
		expect(output.content[0]).toMatchObject({ type: "text", text: "Guide. Again." });
	});
});
