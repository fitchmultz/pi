import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getNativeToolSearch,
	processResponsesStream,
	resolveResponsesTranscript,
} from "../src/api/openai-responses-shared.ts";
import { streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Message, Model, Tool } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { shortHash } from "../src/utils/hash.ts";
import { findTool, toolKey } from "../src/utils/tool-identity.ts";
import { getCurrentTools, normalizeContext, resolveTranscriptTools } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const search: Tool = {
	name: "discover",
	description: "Discover records",
	parameters: Type.Object({ query: Type.String() }),
	toolSearch: true,
};
const record: Tool = {
	name: "lookup",
	namespace: "records",
	description: "Find a record",
	parameters: Type.Object({ id: Type.String() }),
};
function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "pending",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
const nativeSearchItem = {
	type: "tool_search_call",
	id: "ts_1",
	call_id: "search_1",
	execution: "client",
	status: "completed",
	arguments: { query: "records" },
} as const;
async function* searchEvents(): AsyncGenerator<ResponseStreamEvent> {
	const item = nativeSearchItem;
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: { ...item, status: "in_progress" },
	};
	yield { type: "response.output_item.done", sequence_number: 1, output_index: 0, item };
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "response_1", status: "completed", output: [item] },
	} as ResponseStreamEvent;
}

it("parses a real client search item as an executable call and replays its original call ID", async () => {
	const message = output();
	await processResponsesStream(searchEvents(), message, new AssistantMessageEventStream(), model, {
		toolSearchTool: search,
	});
	expect(message.stopReason).toBe("toolUse");
	expect(message.content).toEqual([
		{
			type: "toolCall",
			kind: "toolSearch",
			id: "search_1|ts_1",
			name: "discover",
			arguments: { query: "records" },
			responsesItem: nativeSearchItem,
		},
	]);
	const result: Message = {
		role: "toolResult",
		toolCallId: "search_1|ts_1",
		toolName: "discover",
		toolCallKind: "toolSearch",
		toolsAdded: [record],
		content: [],
		isError: false,
		timestamp: 2,
	};
	const context = normalizeContext({
		messages: [{ role: "system", content: "Base", toolsAdded: [search], timestamp: 0 }, message, result],
	});
	const wire = convertResponsesMessages(model, context, new Set(["openai"]), {
		supportsToolSearch: true,
		supportsAdditionalTools: true,
	});
	expect(wire.find((item) => item.type === "tool_search_call")).toMatchObject({
		type: "tool_search_call",
		call_id: "search_1",
		execution: "client",
		status: "completed",
		arguments: { query: "records" },
	});
	expect(wire.find((item) => item.type === "tool_search_output")).toMatchObject({
		call_id: "search_1",
		tools: [{ type: "namespace", name: "records", tools: [{ name: "lookup" }] }],
	});
	expect(wire.filter((item) => item.type === "additional_tools")).toEqual([]);
	expect(wire.filter((item) => item.type === "function_call_output")).toEqual([]);
});

it("returns only identity metadata in parsed native search calls", async () => {
	const message = output();
	await processResponsesStream(searchEvents(), message, new AssistantMessageEventStream(), model, {
		toolSearchTool: { name: "discover", namespace: "catalog" },
	});
	expect(message.content[0]).toMatchObject({ name: "discover", namespace: "catalog", kind: "toolSearch" });
});

it("emits the client-search contract through all three Responses request builders", async () => {
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
	for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"] as const) {
		const target: Model<Api> = { ...model, api, compat: { supportsToolSearch: true } };
		let payload: { tools?: Array<{ type: string }>; input?: Array<{ type?: string; call_id?: string }> } | undefined;
		const previous = {
			...output(),
			api,
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					kind: "toolSearch",
					id: "original|ts_1",
					name: search.name,
					arguments: { query: "records" },
				},
			],
		} as AssistantMessage;
		await streamSimple(
			target,
			{
				tools: [search],
				messages: [
					previous,
					{
						role: "toolResult",
						toolCallId: "original|ts_1",
						toolName: search.name,
						toolCallKind: "toolSearch",
						toolsAdded: [record],
						content: [],
						isError: false,
						timestamp: 2,
					},
				],
			},
			{
				apiKey: token,
				transport: "sse",
				fetch: async () => {
					throw new Error("Unexpected network request");
				},
				onPayload: (value) => {
					payload = value as typeof payload;
					throw new Error("Captured before network");
				},
			},
		).result();
		expect(payload?.tools?.map((tool) => tool.type)).toEqual(["tool_search"]);
		expect(payload?.input?.filter((item) => item.type === "tool_search_output")).toMatchObject([
			{ call_id: "original" },
		]);
		expect(payload?.input?.some((item) => item.type === "additional_tools")).toBe(false);
	}
});

describe("native declaration selection", () => {
	it("uses native search only for one active handler, otherwise preserves every ordinary function", () => {
		const second = { ...search, name: "other_discovery" };
		for (const [tools, supported, types] of [
			[[search], true, ["tool_search"]],
			[[search], false, ["function"]],
			[[search, second], true, ["function", "function"]],
		] as const) {
			const wire = convertResponsesTools(tools, { toolSearchTool: getNativeToolSearch(tools, supported) });
			expect(wire.map((tool) => tool.type)).toEqual(types);
		}
	});

	it("keeps exact namespaces and non-strict schemas", () => {
		const schema = {
			type: "object",
			properties: { id: { $ref: "#/$defs/id" } },
			$defs: { id: { type: "string", minLength: 3 } },
			additionalProperties: { type: "string" },
		};
		const tools = convertResponsesTools([
			{ ...record, parameters: schema },
			{ ...record, namespace: "other" },
		]);
		expect(tools).toMatchObject([
			{ type: "namespace", name: "records", tools: [{ name: "lookup", parameters: schema, strict: false }] },
			{ type: "namespace", name: "other" },
		]);
	});
});

it("does not reload a removed native search result during full-state fallback", () => {
	const previous = {
		...output(),
		stopReason: "toolUse",
		content: [{ type: "toolCall", kind: "toolSearch", id: "search_1|ts_1", name: search.name, arguments: {} }],
	} as AssistantMessage;
	const context = normalizeContext({
		tools: [search],
		messages: [
			previous,
			{
				role: "toolResult",
				toolCallId: "search_1|ts_1",
				toolName: search.name,
				toolCallKind: "toolSearch",
				toolsAdded: [record],
				content: [],
				isError: false,
				timestamp: 2,
			},
			{ role: "system", content: "Removed", toolsRemoved: [record], timestamp: 3 },
		],
	});
	for (const supportsMidConvoSystemMessages of [false, true]) {
		const projected = resolveResponsesTranscript(context, supportsMidConvoSystemMessages, true);
		expect(getCurrentTools(projected.messages)).toEqual([search]);
		const wire = convertResponsesMessages(model, context, new Set(["openai"]), {
			supportsMidConvoSystemMessages,
			supportsToolSearch: true,
			supportsAdditionalTools: true,
		});
		expect(wire.some((item) => item.type === "tool_search_output")).toBe(false);
		expect(wire.some((item) => item.type === "function_call_output")).toBe(true);
	}
});

it("round-trips bare search matches through a known wire namespace and rejects forged namespaces", async () => {
	const bare: Tool = { ...record, namespace: undefined };
	const native = { ...model, compat: { supportsToolSearch: true, supportsAdditionalTools: true } };
	const previous = {
		...output(),
		stopReason: "toolUse",
		content: [{ type: "toolCall", kind: "toolSearch", id: "search|ts_1", name: search.name, arguments: {} }],
	} as AssistantMessage;
	const context = normalizeContext({
		tools: [search],
		messages: [
			previous,
			{
				role: "toolResult",
				toolCallId: "search|ts_1",
				toolName: search.name,
				toolCallKind: "toolSearch",
				toolsAdded: [bare],
				content: [],
				isError: false,
				timestamp: 2,
			},
		],
	});
	let wireNamespace = "";
	const result = await streamResponses(native, context, {
		apiKey: "fixture",
		transport: "sse",
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as {
				input: Array<{ type?: string; tools?: Array<{ type: string; name: string }> }>;
			};
			const loaded = body.input.find((item) => item.type === "tool_search_output")!.tools![0];
			expect(loaded.type).toBe("namespace");
			wireNamespace = loaded.name;
			expect(wireNamespace).toBe(`pi_loaded_${shortHash(toolKey(bare))}`);
			const calls = [wireNamespace, "forged"].map((namespace, index) => ({
				type: "function_call",
				id: `fc_${index}`,
				call_id: `call_${index}`,
				name: bare.name,
				namespace,
				arguments: "{}",
			}));
			const events = calls.flatMap((item, output_index) => [
				{ type: "response.output_item.added", item, output_index },
				{ type: "response.output_item.done", item, output_index },
			]);
			return new Response(
				[...events, { type: "response.completed", response: { id: "next", status: "completed", output: calls } }]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	}).result();
	expect(result.stopReason).toBe("toolUse");
	const calls = result.content.filter((block) => block.type === "toolCall");
	expect(calls[0]).toMatchObject({ name: bare.name, namespace: undefined });
	expect(calls[1]).toMatchObject({ name: bare.name, namespace: "forged" });
	expect(findTool([bare], calls[0])).toBe(bare);
	expect(findTool([bare], calls[1])).toBeUndefined();
	let replay: Array<{ type?: string; namespace?: string; name?: string }> = [];
	await streamResponses(native, normalizeContext({ messages: [...context.messages, result] }), {
		apiKey: "fixture",
		transport: "sse",
		fetch: async () => {
			throw new Error("Unexpected network");
		},
		onPayload: (payload) => {
			replay = (payload as { input: typeof replay }).input;
			throw new Error("Captured");
		},
	}).result();
	expect(replay.filter((item) => item.type === "function_call").map((item) => item.namespace)).toEqual([
		wireNamespace,
		"forged",
	]);
	expect(bare.namespace).toBeUndefined();
});

it("rejects a generated native namespace that collides with an actual namespace", async () => {
	const bare: Tool = { ...record, namespace: undefined };
	const collision: Tool = { ...record, namespace: `pi_loaded_${shortHash(toolKey(bare))}` };
	const context = normalizeContext({
		tools: [search, collision],
		messages: [
			{
				role: "toolResult",
				toolCallId: "search",
				toolName: search.name,
				toolCallKind: "toolSearch",
				toolsAdded: [bare],
				content: [],
				isError: false,
				timestamp: 2,
			},
		],
	});
	const result = await streamResponses({ ...model, compat: { supportsToolSearch: true } }, context, {
		apiKey: "fixture",
		transport: "sse",
		fetch: async () => {
			throw new Error("Unexpected network");
		},
	}).result();
	expect(result).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("Ambiguous namespaced tool alias"),
	});
});

it("keeps repeated native results additive when mid-conversation instructions are unsupported", () => {
	const message = {
		...output(),
		content: [
			{
				type: "toolCall",
				kind: "toolSearch",
				id: "search_1|ts_1",
				name: "discover",
				arguments: { query: "records" },
			},
		],
		stopReason: "toolUse",
	} as AssistantMessage;
	const result: Message = {
		role: "toolResult",
		toolCallId: "search_1|ts_1",
		toolName: "discover",
		toolCallKind: "toolSearch",
		toolsAdded: [record],
		content: [],
		isError: false,
		timestamp: 2,
	};
	const context = normalizeContext({
		messages: [
			{ role: "system", content: "Base", toolsAdded: [search], timestamp: 0 },
			message,
			result,
			{ ...message, content: [{ ...message.content[0], id: "search_2|ts_2" }] } as AssistantMessage,
			{ ...result, toolCallId: "search_2|ts_2" },
		],
	});
	const normalized = resolveResponsesTranscript(context, false, true);
	expect(resolveTranscriptTools(normalized.messages, true)).toMatchObject({
		requestTools: [search],
		anchorsAdditions: true,
	});
	const wire = convertResponsesMessages(model, context, new Set(["openai"]), {
		supportsToolSearch: true,
		supportsAdditionalTools: true,
	});
	expect(wire.filter((item) => item.type === "tool_search_output")).toHaveLength(2);
	expect(wire.some((item) => item.type === "additional_tools")).toBe(false);
});
