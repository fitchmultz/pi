import { Type } from "typebox";
import { expect, it } from "vitest";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { createProvider } from "../src/models.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { shortHash } from "../src/utils/hash.ts";
import { toolKey } from "../src/utils/tool-identity.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const provider = createProvider({
	id: model.provider,
	auth: { apiKey: { name: "Fixture", resolve: async () => undefined } },
	models: [model],
	api: openAICompletionsApi(),
});
const left: Tool = { namespace: "left", name: "lookup", description: "Left", parameters: Type.Object({}) };
const right: Tool = { ...left, namespace: "right", description: "Right" };

it("uses distinct function aliases and decodes the exact identity across model-switch replay", async () => {
	const previous: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "before", namespace: "left", name: "lookup", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "native",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const context = normalizeContext({
		tools: [left, right, { ...left, name: "ordinary", namespace: undefined }],
		messages: [
			previous,
			{
				role: "toolResult",
				toolCallId: "before",
				toolName: "lookup",
				namespace: "left",
				content: [],
				isError: false,
				timestamp: 1,
			},
		],
	});
	const stream = provider.stream(model, context, {
		apiKey: "fixture-key",
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as {
				tools: { function: { name: string; description: string } }[];
				messages: { tool_calls?: { function: { name: string } }[] }[];
			};
			const names = body.tools.map((tool) => tool.function.name);
			expect(new Set(names).size).toBe(3);
			expect(names).toContain("ordinary");
			const leftName = body.tools.find(
				(tool) => tool.function.description === "Left" && tool.function.name !== "ordinary",
			)!.function.name;
			expect(body.messages.find((message) => message.tool_calls)?.tool_calls?.[0].function.name).toBe(leftName);
			const rightName = body.tools.find((tool) => tool.function.description === "Right")!.function.name;
			return new Response(
				`data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "after", type: "function", function: { name: rightName, arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const events = [];
	for await (const event of stream) events.push(event);
	expect((await stream.result()).content).toEqual([
		{ type: "toolCall", id: "after", name: "lookup", namespace: "right", arguments: {} },
	]);
	expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
		toolCall: { name: "lookup", namespace: "right" },
	});
	expect(previous.content[0]).toMatchObject({ name: "lookup", namespace: "left" });
});

it("rejects alias collisions before dispatch instead of selecting a wrong tool", async () => {
	const alias = `pi_ns_${shortHash(toolKey(left))}`;
	let dispatched = false;
	const result = await provider
		.stream(
			model,
			normalizeContext({ tools: [left, { ...left, namespace: undefined, name: alias }], messages: [] }),
			{
				apiKey: "fixture-key",
				fetch: async () => {
					dispatched = true;
					throw new Error("Unexpected dispatch");
				},
			},
		)
		.result();
	expect(dispatched).toBe(false);
	expect(result).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("Ambiguous namespaced tool alias"),
	});
});
