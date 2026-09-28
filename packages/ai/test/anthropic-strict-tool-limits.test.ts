import { Type } from "typebox";
import { expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model, Tool, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
	compat: {
		forceAdaptiveThinking: true,
		supportsStrictTools: true,
		supportsMidConvoSystemMessages: true,
		supportsMidConvoToolChanges: true,
	},
};

// Strict conversion turns each optional property into an `anyOf` with null.
const strictTools = (count: number, optional: boolean): Tool[] =>
	Array.from({ length: count }, (_, index) => ({
		name: `tool_${index}`,
		description: `Tool ${index}`,
		parameters: Type.Object({ value: optional ? Type.Optional(Type.String()) : Type.String() }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	}));

async function strictToolNames(context: TranscriptContext, requestModel = model): Promise<string[] | undefined> {
	let body: { tools: { name: string; strict?: boolean }[] } | undefined;
	await streamAnthropic(requestModel, context, {
		apiKey: "test-key",
		fetch: async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return new Response("", { headers: { "content-type": "text/event-stream" } });
		},
	}).result();
	return body?.tools.filter((tool) => tool.strict).map((tool) => tool.name);
}

it.each([
	["union-typed parameter", strictTools(20, true), 16],
	["strict tool", strictTools(21, false), 20],
])("admits strict tools in declaration order within Anthropic's %s limit", async (_limit, tools, admitted) => {
	const context = normalizeContext({ tools, messages: [{ role: "user", content: "Use a tool", timestamp: 0 }] });

	expect(await strictToolNames(context)).toEqual(tools.slice(0, admitted).map((tool) => tool.name));
});

it("charges identical re-declarations against the strict budget once", async () => {
	const [initial, later] = [strictTools(4, true), strictTools(14, true).slice(4)];
	const context = normalizeContext({
		tools: initial,
		messages: [
			{ role: "user", content: "Use a tool", timestamp: 0 },
			// Re-activated tools, like transcripts read back from disk, are distinct but identical objects.
			{
				role: "system",
				content: "",
				toolsAdded: [...(JSON.parse(JSON.stringify(initial)) as Tool[]), ...later],
				timestamp: 1,
			},
		],
	});

	expect(await strictToolNames(context)).toEqual([...initial, ...later].map((tool) => tool.name));
});

const grammarError =
	"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";

function rejectedSchema(message = grammarError, status = 400): Response {
	return Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status });
}

function successfulResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

interface RequestBody {
	tools: { name: string; strict?: boolean; input_schema: Record<string, unknown> }[];
	messages: { content: string | { type: string; tool?: { definition?: RequestBody["tools"][number] } }[] }[];
	metadata?: { user_id: string };
}

it.each([grammarError, "Schema is too complex for compilation."])(
	"recovers from %s without dropping tools or relaxing required strictness",
	async (message) => {
		const tools = strictTools(2, true);
		tools[1].constrainedSampling = { type: "json_schema", strict: "require" };
		const context = normalizeContext({ tools, messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
		const requests: RequestBody[] = [];
		const observed: RequestBody[] = [];
		const stream = streamAnthropic(model, context, {
			apiKey: "test-key",
			onPayload: (payload) => {
				const body = payload as RequestBody;
				body.metadata = { user_id: "from-hook" };
				observed.push(structuredClone(body));
				return body;
			},
			fetch: async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return requests.length === 1 ? rejectedSchema(message) : successfulResponse();
			},
		});
		const events = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(events.filter((type) => type === "start")).toHaveLength(1);
		expect(events).not.toContain("error");
		expect(requests).toHaveLength(2);
		expect(requests[1]).toEqual({
			...requests[0],
			tools: requests[0].tools.map((tool) => (tool.name === "tool_0" ? { ...tool, strict: undefined } : tool)),
		});
		expect(observed[1].tools[0].strict).not.toBe(true);
		expect(requests[1].tools[1].strict).toBe(true);
		expect(tools[0].constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });

		// A resumed continuation keeps the accepted prefix; a fresh window can try strict again.
		const resumed = JSON.parse(JSON.stringify({ messages: [...context.messages, result] })) as TranscriptContext;
		expect(await strictToolNames(resumed)).toEqual(["tool_1"]);
		expect(await strictToolNames(resumed, { ...model, id: "another-model" })).toEqual(["tool_0", "tool_1"]);
		expect(await strictToolNames(resumed, { ...model, baseUrl: "https://another-endpoint.invalid" })).toEqual([
			"tool_0",
			"tool_1",
		]);
		const fresh = normalizeContext({
			messages: [
				{ role: "system", content: "", toolsAdded: tools, contextWindowId: "next-window", timestamp: 2 },
				result,
				{ role: "user", content: "Hello again", timestamp: 3 },
			],
		});
		expect(await strictToolNames(fresh)).toEqual(["tool_0", "tool_1"]);
	},
);

it.each([
	["unrelated request error", "Invalid tool name", 400, "prefer"],
	["authentication error", grammarError, 401, "prefer"],
	["required strict tool", grammarError, 400, "require"],
] as const)("does not downgrade on %s", async (_case, message, status, strict) => {
	const tools = strictTools(1, false);
	tools[0].constrainedSampling = { type: "json_schema", strict };
	let requests = 0;
	const result = await streamAnthropic(
		model,
		normalizeContext({ tools, messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
		{
			apiKey: "test-key",
			fetch: async () => {
				requests++;
				return rejectedSchema(message, status);
			},
		},
	).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain(message);
	expect(requests).toBe(1);
});

it("stops after one unsuccessful schema recovery", async () => {
	let requests = 0;
	const result = await streamAnthropic(
		model,
		normalizeContext({
			tools: strictTools(1, false),
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		}),
		{
			apiKey: "test-key",
			fetch: async () => {
				requests++;
				return rejectedSchema();
			},
		},
	).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain(grammarError);
	expect(requests).toBe(2);
});

it("preserves replaced and added hook-owned declarations when recovering other tools", async () => {
	const requests: RequestBody[] = [];
	let hookCalls = 0;
	const result = await streamAnthropic(
		model,
		normalizeContext({
			tools: strictTools(2, false),
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		}),
		{
			apiKey: "test-key",
			onPayload: (payload) => {
				if (++hookCalls > 1) return;
				const body = structuredClone(payload) as RequestBody;
				body.tools[0].input_schema = { type: "object", properties: { replacement: { type: "boolean" } } };
				body.tools.push({ name: "hook_tool", strict: true, input_schema: { type: "object", properties: {} } });
				body.metadata = { user_id: "preserve-first-hook-result" };
				return body;
			},
			fetch: async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return requests.length === 1 ? rejectedSchema() : successfulResponse();
			},
		},
	).result();
	expect(result.stopReason).toBe("stop");
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEqual({
		...requests[0],
		tools: requests[0].tools.map((tool) => (tool.name === "tool_1" ? { ...tool, strict: undefined } : tool)),
	});
});

it("respects a hook that restores strict mode on the single retry", async () => {
	let requests = 0;
	let hookCalls = 0;
	const result = await streamAnthropic(
		model,
		normalizeContext({
			tools: strictTools(1, false),
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		}),
		{
			apiKey: "test-key",
			onPayload: (payload) => {
				hookCalls++;
				(payload as RequestBody).tools[0].strict = true;
			},
			fetch: async (_url, init) => {
				requests++;
				expect((JSON.parse(String(init?.body)) as RequestBody).tools[0].strict).toBe(true);
				return rejectedSchema();
			},
		},
	).result();
	expect(result.stopReason).toBe("error");
	expect(requests).toBe(2);
	expect(hookCalls).toBe(2);
});

it("recovers OAuth-renamed tools and inline redefinitions together", async () => {
	const tool = { ...strictTools(1, false)[0], name: "read" };
	const context = normalizeContext({
		tools: [tool],
		messages: [
			{ role: "user", content: "Hello", timestamp: 1 },
			{
				role: "system",
				content: "",
				toolsAdded: [{ ...tool, parameters: Type.Object({ updated: Type.Boolean() }) }],
				timestamp: 2,
			},
			{ role: "user", content: "Use the updated tool", timestamp: 3 },
		],
	});
	const requests: RequestBody[] = [];
	const result = await streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		fetch: async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return requests.length === 1 ? rejectedSchema() : successfulResponse();
		},
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(requests).toHaveLength(2);
	for (const [index, request] of requests.entries()) {
		expect(request.tools[0].name).toBe("Read");
		expect(request.tools[0].strict).toBe(index === 0 ? true : undefined);
		const inline = request.messages.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.flatMap((block) => (block.tool?.definition ? [block.tool.definition] : []))
				: [],
		);
		expect(inline).toHaveLength(1);
		expect(inline[0].name).toBe("Read");
		expect(inline[0].strict).toBe(index === 0 ? true : undefined);
		expect(inline[0].input_schema.properties).toEqual({ updated: { type: "boolean" } });
	}
});
