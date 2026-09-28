import { Type } from "typebox";
import { expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model, Tool } from "../src/types.ts";
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

it.each([
	["union-typed parameter", strictTools(20, true), 16],
	["strict tool", strictTools(21, false), 20],
])("admits strict tools in declaration order within Anthropic's %s limit", async (_limit, tools, admitted) => {
	let body: { tools: { name: string; strict?: boolean }[] } | undefined;
	const context = normalizeContext({ tools, messages: [{ role: "user", content: "Use a tool", timestamp: 0 }] });
	await streamAnthropic(model, context, {
		apiKey: "test-key",
		fetch: async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return new Response("", { headers: { "content-type": "text/event-stream" } });
		},
	}).result();

	expect(body?.tools.filter((tool) => tool.strict).map((tool) => tool.name)).toEqual(
		tools.slice(0, admitted).map((tool) => tool.name),
	);
});
