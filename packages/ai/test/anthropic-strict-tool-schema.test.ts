import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface AnthropicToolPayload {
	tools?: Array<{ name: string; strict?: boolean; input_schema: Record<string, unknown> }>;
	messages: Array<{
		content:
			| string
			| Array<{
					type: string;
					tool?: { definition?: { name: string; strict?: boolean; input_schema: Record<string, unknown> } };
			  }>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	};
}

function createTool(parameters: Tool["parameters"], constrainedSampling?: Tool["constrainedSampling"]): Tool {
	return {
		name: "lookup",
		description: "Look up a value",
		parameters,
		...(constrainedSampling ? { constrainedSampling } : {}),
	};
}

function createStrictTool(parameters: Tool["parameters"]): Tool {
	return createTool(parameters, { type: "json_schema", strict: "prefer" });
}

async function captureFirstTool(tool: Tool): Promise<NonNullable<AnthropicToolPayload["tools"]>[number]> {
	let payload: AnthropicToolPayload | undefined;
	const stream = streamAnthropic(
		createModel(),
		normalizeContext({ messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }], tools: [tool] }),
		{
			apiKey: "test-key",
			cacheRetention: "none",
			onPayload: (value) => {
				payload = value as AnthropicToolPayload;
				throw new PayloadCaptured();
			},
		},
	);
	await stream.result();

	const firstTool = payload?.tools?.[0];
	if (!firstTool) {
		throw new Error("Expected a tool in the captured Anthropic payload");
	}
	return firstTool;
}

describe("Anthropic strict tool schemas", () => {
	it.each([
		{ limit: 20, optional: false, strict: "prefer" },
		{ limit: 20, optional: false, strict: "require" },
		{ limit: 16, optional: true, strict: "prefer" },
		{ limit: 16, optional: true, strict: "require" },
	] as const)(
		"shares the $limit-definition strict budget across initial tools and inline $strict redefinitions",
		async ({ limit, optional, strict }) => {
			const value = optional ? Type.Optional(Type.String()) : Type.String();
			const initial = createStrictTool(Type.Object({ value }));
			const later = Array.from({ length: limit - 1 }, (_, index) => ({
				...createStrictTool(Type.Object({ value })),
				name: `late_${index}`,
			}));
			const redefined = {
				...createTool(Type.Object({ replacement: value }), { type: "json_schema", strict }),
				description: "Redefined lookup",
			};
			const model = createModel();
			model.compat = {
				...model.compat,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
			};
			let payload: AnthropicToolPayload | undefined;
			const result = await streamAnthropic(
				model,
				normalizeContext({
					tools: [initial],
					messages: [
						{ role: "user", content: "test", timestamp: 0 },
						{ role: "system", content: "", toolsAdded: later, timestamp: 1 },
						{
							role: "system",
							content: "",
							toolsRemoved: [{ name: initial.name }],
							toolsAdded: [redefined],
							timestamp: 2,
						},
					],
				}),
				{
					apiKey: "test-key",
					onPayload: (value) => {
						payload = value as AnthropicToolPayload;
						throw new PayloadCaptured();
					},
				},
			).result();
			if (strict === "require") {
				expect(payload).toBeUndefined();
				expect(result.errorMessage).toContain("exceeds Anthropic's strict tool limits");
			} else {
				expect(payload?.tools?.[0]).toMatchObject({ name: initial.name, strict: true });
				expect(payload?.tools?.[0].input_schema.properties).toHaveProperty("value");
				expect(payload?.tools).toHaveLength(2);
				const definitions = payload?.messages.flatMap((message) =>
					typeof message.content === "string"
						? []
						: message.content.flatMap((block) =>
								block.type === "tool_addition" && block.tool?.definition ? [block.tool.definition] : [],
							),
				);
				expect(definitions?.filter((tool) => tool.strict)).toHaveLength(limit - 1);
				expect(definitions?.at(-1)).toMatchObject({ name: initial.name });
				expect(definitions?.at(-1)?.strict).toBeUndefined();
				expect(definitions?.at(-1)?.input_schema.properties).toHaveProperty("replacement");
			}
		},
	);

	it.each(["prefer", "require"] as const)(
		"budgets strict unions without silently relaxing %s tools",
		async (strict) => {
			const tools = Array.from({ length: 17 }, (_, index) => ({
				...createStrictTool(Type.Object({ value: Type.Optional(Type.String()) })),
				name: `tool_${index}`,
				...(index === 16 ? { constrainedSampling: { type: "json_schema" as const, strict } } : {}),
			}));
			let payload: AnthropicToolPayload | undefined;
			const result = await streamAnthropic(
				createModel(),
				normalizeContext({
					messages: [{ role: "user", content: "test", timestamp: 0 }],
					tools,
				}),
				{
					apiKey: "test-key",
					onPayload: (value) => {
						payload = value as AnthropicToolPayload;
						throw new PayloadCaptured();
					},
				},
			).result();
			if (strict === "require") {
				expect(payload).toBeUndefined();
				expect(result.errorMessage).toContain("exceeds Anthropic's strict tool limits");
			} else {
				expect(payload?.tools?.filter((tool) => tool.strict)).toHaveLength(16);
				expect(payload?.tools?.[16].strict).toBeUndefined();
			}
		},
	);
	it("only sends the full input schema for strict JSON-schema tools", async () => {
		const legacyParameters = Type.Object(
			{ value: Type.String() },
			{ additionalProperties: false, title: "LookupInput" },
		);
		const legacyTool = await captureFirstTool(createTool(legacyParameters));
		expect(legacyTool.strict).toBeUndefined();
		expect(legacyTool.input_schema).toEqual({
			type: "object",
			properties: legacyParameters.properties,
			required: legacyParameters.required,
		});

		const strictTool = await captureFirstTool(
			createStrictTool(
				Type.Object(
					{ value: Type.String(), optional: Type.Optional(Type.Number()) },
					{ title: "StrictLookupInput" },
				),
			),
		);
		expect(strictTool.strict).toBe(true);
		expect(strictTool.input_schema).toMatchObject({
			additionalProperties: false,
			required: ["value", "optional"],
			properties: { optional: { anyOf: [{ type: "number" }, { type: "null" }] } },
			title: "StrictLookupInput",
		});
	});

	// https://github.com/earendil-works/pi/issues/9953
	it("sends prefer tools non-strict when they use keywords Anthropic strict mode rejects", async () => {
		const unsupportedParameters: Tool["parameters"][] = [
			Type.Object({ timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })) }),
			Type.Object({ options: Type.Object({ tags: Type.Array(Type.String(), { minItems: 2 }) }) }),
			Type.Object({ expression: Type.String({ format: "regex" }) }),
		];
		for (const parameters of unsupportedParameters) {
			const tool = await captureFirstTool(createStrictTool(parameters));
			expect(tool.strict).toBeUndefined();
		}

		const supportedTool = await captureFirstTool(
			createStrictTool(
				Type.Object({
					code: Type.String({ minLength: 1, maxLength: 1000, pattern: "^[a-z]+$" }),
					url: Type.String({ format: "uri" }),
					tags: Type.Array(Type.String(), { minItems: 1 }),
				}),
			),
		);
		expect(supportedTool.strict).toBe(true);
	});
});
