import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, ProviderHeaders, Tool } from "../src/types.ts";

class PayloadCaptured extends Error {}

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

async function capturePayload<T>(
	model: Model<Api>,
	context: Context,
	configuredHeaders?: ProviderHeaders,
): Promise<{ payload: T; response: AssistantMessage; headers: Headers }> {
	let captured: T | undefined;
	let headers = new Headers();
	const stream = streamSimple(
		model,
		{
			...context,
			messages: context.messages.map((message) =>
				message.role === "system"
					? { ...message, deferredToolEntries: [{ namespace: "host_only", name: "undeclared_entry" }] }
					: message,
			),
		},
		{
			apiKey: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`,
			transport: "sse",
			headers: configuredHeaders,
			maxRetries: 0,
			fetch: async (_url, init) => {
				headers = new Headers(init?.headers);
				throw new PayloadCaptured();
			},
			onPayload: (payload) => {
				captured = JSON.parse(JSON.stringify(payload)) as T;
			},
		},
	);
	const response = await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	expect(JSON.stringify(captured)).not.toContain("contextWindowId");
	expect(JSON.stringify(captured)).not.toContain("deferredToolEntries");
	expect(JSON.stringify(captured)).not.toContain("undeclared_entry");
	return { payload: captured, response, headers };
}

const modelBase = {
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

const baseTool = tool("base_tool");
const lateTool = tool("late_tool");
const context: Context = {
	messages: [
		{
			role: "system",
			content: "base prompt",
			sections: { rules: "<rules>\nold rules\n</rules>", docs: "<docs>\nread docs\n</docs>" },
			toolsAdded: [baseTool],
			timestamp: 0,
		},
		{ role: "user", content: "before", timestamp: 1 },
		{
			role: "system",
			content: "updated guidance",
			sections: { rules: "<rules>\nnew rules\n</rules>", docs: null },
			toolsRemoved: [{ name: "base_tool" }],
			toolsAdded: [lateTool],
			timestamp: 2,
		},
	],
};
const additionContext: Context = {
	messages: [
		{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
		{ role: "user", content: "before", timestamp: 1 },
		{ role: "system", content: "updated guidance", toolsAdded: [lateTool], timestamp: 2 },
	],
};

const anthropicNativeModel: Model<"anthropic-messages"> = {
	...modelBase,
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "anthropic",
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

interface AnthropicPayload {
	betas?: string[];
	system?: Array<{ text: string }>;
	tools?: Array<{ name: string; defer_loading?: boolean; cache_control?: unknown }>;
	messages: Array<{ role: string; content: Array<{ type: string; text?: string; tool?: { name: string } }> }>;
}

describe("transcript system messages", () => {
	test.each(["assistant-tail", "next-user", "tool-result", "paused-tail", "empty-assistant"] as const)(
		"Anthropic tool changes use a legal boundary or rebuild immediately (%s)",
		async (placement) => {
			const model = { ...anthropicNativeModel, baseUrl: "https://api.anthropic.com" };
			const initial = await capturePayload<AnthropicPayload>(model, {
				messages: additionContext.messages.slice(0, 2),
			});
			const assistant: AssistantMessage = {
				...initial.response,
				stopReason: placement === "tool-result" ? "toolUse" : "stop",
				rawStopReason: placement === "paused-tail" ? "pause_turn" : "end_turn",
				content:
					placement === "tool-result"
						? [{ type: "toolCall", id: "call", name: baseTool.name, arguments: {} }]
						: [{ type: "text", text: "Done" }],
			};
			const messages: Context["messages"] = [
				...additionContext.messages.slice(0, 2),
				assistant,
				{ role: "system", content: "New policy", toolsRemoved: [baseTool], toolsAdded: [lateTool], timestamp: 3 },
			];
			if (placement === "empty-assistant") messages.push({ ...assistant, content: [] });
			if (placement === "next-user" || placement === "empty-assistant")
				messages.push({ role: "user", content: "Continue", timestamp: 4 });
			if (placement === "tool-result")
				messages.push({
					role: "toolResult",
					toolCallId: "call",
					toolName: baseTool.name,
					content: [{ type: "text", text: "Result" }],
					isError: false,
					timestamp: 4,
				});
			const { payload } = await capturePayload<AnthropicPayload>(model, { messages });
			const positional = placement === "next-user" || placement === "tool-result" || placement === "empty-assistant";
			if (positional) {
				expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"]);
				expect(payload.messages.at(-1)?.content).toMatchObject([
					{ type: "text" },
					{ type: "tool_removal" },
					{ type: "tool_addition" },
				]);
			} else {
				expect(payload.messages.some((message) => message.role === "system")).toBe(false);
				expect(payload.tools?.some((tool) => tool.name === baseTool.name)).toBe(false);
				expect(payload.tools?.some((tool) => tool.name === lateTool.name)).toBe(true);
				expect(JSON.stringify(payload.system)).toContain("New policy");
			}
		},
	);

	test.each(["model", "options"] as const)(
		"bound Anthropic protocol overrides conflicting %s beta headers with a warning",
		async (source) => {
			for (const firstBeta of ["inline-tools-2026-09-15", "mid-conversation-tool-changes-2026-07-01"]) {
				const model = { ...anthropicNativeModel, baseUrl: "https://api.anthropic.com" };
				const messages = additionContext.messages.slice(0, 2);
				const initial = await capturePayload<AnthropicPayload>(
					model,
					{ messages },
					{ "anthropic-beta": firstBeta },
				);
				const other = firstBeta.startsWith("inline")
					? "mid-conversation-tool-changes-2026-07-01"
					: "inline-tools-2026-09-15";
				const configured = { "Anthropic-Beta": `${other},custom-beta` };
				const next = await capturePayload<AnthropicPayload>(
					source === "model" ? { ...model, headers: configured } : model,
					{
						messages: [
							...messages,
							{ ...initial.response, stopReason: "stop", content: [{ type: "text", text: "Done" }] },
							{ role: "user", content: "Continue", timestamp: Date.now() },
						],
					},
					source === "options" ? configured : undefined,
				);
				expect(next.headers.get("anthropic-beta")).toContain(firstBeta);
				expect(next.headers.get("anthropic-beta")).not.toContain(other);
				expect(next.headers.get("anthropic-beta")).toContain("custom-beta");
				expect(next.response.diagnostics).toContainEqual(
					expect.objectContaining({
						type: "provider_configuration_warning",
						details: expect.objectContaining({ message: expect.stringContaining("bound") }),
					}),
				);
			}
		},
	);

	test("Anthropic inline mode introduces tools without an initial tool and keeps subsequent additions positional", async () => {
		const model = { ...anthropicNativeModel, baseUrl: "https://api.anthropic.com" };
		const messages: Context["messages"] = [
			{ role: "system", content: "Base", timestamp: 0 },
			{ role: "user", content: "Start", timestamp: 1 },
		];
		const initial = await capturePayload<AnthropicPayload>(model, { messages });
		for (const added of [baseTool, lateTool]) {
			messages.push({ role: "system", content: "", toolsAdded: [added], timestamp: Date.now() });
			const next = await capturePayload<AnthropicPayload>(model, { messages });
			expect(next.payload.tools).toBeUndefined();
			expect(next.payload.system).toEqual(initial.payload.system);
			expect(next.headers.get("anthropic-beta")).toBe(initial.headers.get("anthropic-beta"));
			expect(next.payload.messages.at(-2)?.role).toBe("user");
			expect(next.payload.messages.at(-1)?.content).toMatchObject([
				{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: added.name } } },
			]);
			messages.push({ ...next.response, stopReason: "stop", content: [{ type: "text", text: "Done" }] });
			messages.push({ role: "user", content: "Continue", timestamp: Date.now() });
		}
	});

	test("an explicitly disabled Anthropic tool protocol cannot be enabled mid-window", async () => {
		const model = { ...anthropicNativeModel, baseUrl: "https://api.anthropic.com" };
		const messages = additionContext.messages.slice(0, 2);
		const initial = await capturePayload<AnthropicPayload>(model, { messages }, { "anthropic-beta": null });
		expect(initial.headers.get("anthropic-beta")).toBeNull();
		const next = await capturePayload<AnthropicPayload>(
			model,
			{
				messages: [
					...messages,
					{ ...initial.response, stopReason: "stop", content: [{ type: "text", text: "Done" }] },
				],
			},
			{ "anthropic-beta": "inline-tools-2026-09-15" },
		);
		expect(next.headers.get("anthropic-beta")).toBeNull();
		expect(next.response.diagnostics?.some((entry) => entry.type === "provider_configuration_warning")).toBe(true);
	});

	test.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const)(
		"%s preserves the original native search identity after callback replacement",
		async (api) => {
			const model: Model<Api> = {
				...modelBase,
				id: "fixture",
				name: "Fixture",
				api,
				provider: "openai",
				compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: true },
			};
			const search = { ...baseTool, toolSearch: true as const };
			const replacement = { ...search, name: "new_search" };
			const messages: Context["messages"] = [
				{ role: "system", content: "Base", toolsAdded: [search], timestamp: 0 },
				{ role: "user", content: "Find tools", timestamp: 1 },
			];
			type Payload = { tools: unknown[]; input: Array<{ type?: string; tools?: unknown[] }> };
			const { payload: first } = await capturePayload<Payload>(model, { messages });
			const { payload: next } = await capturePayload<Payload>(model, {
				messages: [
					...messages,
					{ role: "system", content: "", toolsRemoved: [search], toolsAdded: [replacement], timestamp: 2 },
				],
			});
			expect(first.tools).toMatchObject([{ type: "tool_search" }]);
			expect(next.tools).toEqual(first.tools);
			expect(next.input.find((item) => item.type === "additional_tools")?.tools).toMatchObject([
				{ type: "function", name: "new_search" },
			]);
		},
	);

	test("public Responses restricts retained tools with allowed_tools, including revoking every tool", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		};
		const { payload } = await capturePayload<{ tools: unknown[]; tool_choice: unknown }>(model, context);
		expect(payload.tools).toMatchObject([{ name: "base_tool" }]);
		expect(payload.tool_choice).toEqual({
			type: "allowed_tools",
			mode: "auto",
			tools: [{ type: "function", name: "late_tool" }],
		});
		const { payload: revoked } = await capturePayload<{ tools: unknown[]; tool_choice: unknown }>(model, {
			messages: [...context.messages, { role: "system", content: "", toolsRemoved: [lateTool], timestamp: 3 }],
		});
		expect(revoked.tools).toEqual(payload.tools);
		expect(revoked.tool_choice).toBe("none");
	});

	test("binds new Anthropic prefixes to inline redefinitions without changing earlier tools or thinking", async () => {
		const model = { ...anthropicNativeModel, baseUrl: "https://api.anthropic.com" };
		const initialContext = { messages: additionContext.messages.slice(0, 2) };
		const initial = await capturePayload<AnthropicPayload>(model, initialContext);
		expect(initial.payload.betas).toContain("inline-tools-2026-09-15");
		expect(initial.response.diagnostics).toContainEqual({
			type: "anthropic_tool_protocol",
			timestamp: expect.any(Number),
			details: { inline: true, beta: "inline-tools-2026-09-15", windowId: null },
		});
		const previous: AssistantMessage = {
			...initial.response,
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "Earlier reasoning", thinkingSignature: "saved-signature" },
				{ type: "text", text: "Ready" },
			],
		};
		const changed = { ...baseTool, parameters: Type.Object({ query: Type.String() }) };
		const nextContext: Context = {
			messages: [
				...initialContext.messages,
				previous,
				{ role: "system", content: "", toolsRemoved: [baseTool], toolsAdded: [changed], timestamp: 3 },
				{ role: "user", content: "Continue with the updated schema", timestamp: 4 },
			],
		};
		const { payload, headers } = await capturePayload<AnthropicPayload>(model, nextContext);
		expect(payload.betas).toEqual(initial.payload.betas);
		expect(initial.headers.get("anthropic-beta")).toContain("inline-tools-2026-09-15");
		expect(headers.get("anthropic-beta")).toBe(initial.headers.get("anthropic-beta"));
		expect(payload.system).toEqual(initial.payload.system);
		expect(payload.tools).toEqual(initial.payload.tools);
		expect(payload.messages.find((message) => message.role === "assistant")?.content).toContainEqual({
			type: "thinking",
			thinking: "Earlier reasoning",
			signature: "saved-signature",
		});
		expect(payload.messages.at(-1)).toMatchObject({
			role: "system",
			content: [
				{ type: "tool_removal", tool: { type: "tool_reference", name: "base_tool" } },
				{
					type: "tool_addition",
					tool: {
						type: "tool_definition",
						definition: {
							name: "base_tool",
							input_schema: { properties: { query: { type: "string" } }, required: ["query"] },
						},
					},
				},
			],
		});

		// A legacy response binds the old protocol even when replayed by the upgraded SDK.
		const legacyContext: Context = {
			messages: nextContext.messages.map((message) =>
				message === previous ? { ...previous, diagnostics: undefined } : message,
			),
		};
		const { payload: legacy } = await capturePayload<AnthropicPayload>(model, legacyContext);
		expect(legacy.betas ?? []).not.toContain("inline-tools-2026-09-15");
		expect(legacy.betas).toContain("mid-conversation-tool-changes-2026-07-01");
		expect(legacy.tools?.[0]).toMatchObject({ name: "base_tool", input_schema: { required: ["query"] } });
		expect(JSON.stringify(legacy.messages)).not.toContain("tool_definition");
	});

	test.each(
		(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const).flatMap((api) =>
			[false, true].map((supportsAdditionalTools) => ({ api, supportsAdditionalTools })),
		),
	)(
		"$api appends description changes and reactivation, but rebuilds for a changed schema (additional_tools=$supportsAdditionalTools)",
		async ({ api, supportsAdditionalTools }) => {
			const model: Model<Api> = {
				...modelBase,
				id: "fixture",
				name: "Fixture",
				api,
				provider: "openai",
				compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools, supportsToolSearch: true },
			};
			type Payload = { tools: unknown[]; instructions?: string; input: unknown[] };
			const initialContext = { messages: additionContext.messages.slice(0, 2) };
			const { payload: initial } = await capturePayload<Payload>(model, initialContext);
			const changed = { ...baseTool, description: "Updated usage guidance" };
			const changedContext: Context = {
				messages: [
					...initialContext.messages,
					{ role: "system", content: "", toolsRemoved: [baseTool], toolsAdded: [changed], timestamp: 3 },
					{ role: "system", content: "", toolsRemoved: [baseTool], timestamp: 4 },
					{ role: "system", content: "", toolsAdded: [baseTool], timestamp: 5 },
				],
			};
			const { payload } = await capturePayload<Payload>(model, changedContext);
			expect(payload.tools).toEqual(initial.tools);
			expect(payload.instructions).toEqual(initial.instructions);
			expect(payload.input.slice(0, initial.input.length)).toEqual(initial.input);
			expect(JSON.stringify(payload.input)).toContain("Updated usage guidance");
			expect(JSON.stringify(payload.input)).toContain("no longer available");
			expect(JSON.stringify(payload.input.at(-1))).toContain("available again");
			expect(JSON.stringify(payload.input.at(-1))).toContain(baseTool.description);
			const schemaContext: Context = {
				messages: [
					...changedContext.messages,
					{
						role: "system",
						content: "",
						toolsRemoved: [baseTool],
						toolsAdded: [{ ...baseTool, parameters: Type.Object({ query: Type.String() }) }],
						timestamp: 6,
					},
				],
			};
			const { payload: schemaChange } = await capturePayload<Payload>(model, schemaContext);
			expect(schemaChange.tools).not.toEqual(initial.tools);
			expect(JSON.stringify(schemaChange.tools)).toContain('"required":["query"]');
			const { payload: afterSchemaChange } = await capturePayload<Payload>(model, {
				messages: [
					...schemaContext.messages,
					{
						role: "system",
						content: "",
						toolsRemoved: [baseTool],
						toolsAdded: [lateTool],
						timestamp: 7,
					},
				],
			});
			expect(afterSchemaChange.tools).toEqual(schemaChange.tools);
			expect(afterSchemaChange.input.slice(0, schemaChange.input.length)).toEqual(schemaChange.input);
			expect(JSON.stringify(afterSchemaChange.input)).toContain("no longer available");
		},
	);

	test("sends Anthropic updates and tool changes in native system messages", async () => {
		const { payload } = await capturePayload<AnthropicPayload>(anthropicNativeModel, context);

		expect(payload.betas).toContain("mid-conversation-tool-changes-2026-07-01");
		expect(payload.system?.map((block) => block.text)).toEqual([
			"base prompt\n\n<rules>\nold rules\n</rules>\n\n<docs>\nread docs\n</docs>",
		]);
		// Initial tools stay active and carry the cache breakpoint; the placeholder and every
		// later declaration are deferred; the removed tool stays declared.
		expect(payload.tools).toMatchObject([
			{ name: "base_tool", cache_control: { type: "ephemeral" } },
			{ name: "__pi_deferred_placeholder__", defer_loading: true },
			{ name: "late_tool", defer_loading: true },
		]);
		expect(payload.tools?.[0]?.defer_loading).toBeUndefined();
		expect(payload.tools?.[1]?.cache_control).toBeUndefined();
		expect(payload.tools?.[2]?.cache_control).toBeUndefined();
		const update = payload.messages.at(-1);
		expect(update).toMatchObject({
			role: "system",
			content: [
				{ type: "text" },
				{ type: "tool_removal", tool: { name: "base_tool" } },
				{ type: "tool_addition", tool: { name: "late_tool" } },
			],
		});
		expect(update?.content[0]?.text).toContain("updated guidance");
		expect(update?.content[0]?.text).toContain("<rules>\nnew rules\n</rules>");
		expect(update?.content[0]?.text).toContain('Removed system prompt section "docs"');

		// The placeholder is declared before any change so its scaffolding is cached from request one.
		const { payload: initial } = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: context.messages.slice(0, 2),
		});
		expect(initial.tools?.map((tool) => tool.name)).toEqual(["base_tool", "__pi_deferred_placeholder__"]);
	});

	test("sends the current Anthropic tool list when native tool changes cannot express the history", async () => {
		const redefinedTool = { ...baseTool, description: "changed", parameters: Type.Object({ query: Type.String() }) };
		const fallbackContexts: Context[] = [
			// Same-name redefinition: blocks reference tools by name only.
			{
				messages: [
					{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
					{ role: "user", content: "Before", timestamp: 1 },
					{
						role: "system",
						content: "updated guidance",
						toolsRemoved: [{ name: "base_tool" }],
						toolsAdded: [redefinedTool],
						timestamp: 2,
					},
				],
			},
			// No initial tool: Anthropic rejects an all-deferred tool list.
			{
				messages: [
					{ role: "system", content: "base prompt", timestamp: 0 },
					{ role: "user", content: "Before", timestamp: 1 },
					{ role: "system", content: "updated guidance", toolsAdded: [redefinedTool], timestamp: 2 },
				],
			},
		];
		for (const fallbackContext of fallbackContexts) {
			const { payload } = await capturePayload<AnthropicPayload>(anthropicNativeModel, fallbackContext);
			expect(payload.betas ?? []).not.toContain("inline-tools-2026-09-15");
			expect(payload.tools?.[0]).toMatchObject({
				name: "base_tool",
				description: "changed",
				cache_control: { type: "ephemeral" },
			});
			expect(payload.tools?.[0]?.defer_loading).toBeUndefined();
			expect(payload.messages.at(-1)?.content.map((block) => block.type)).toEqual(["text"]);
		}
	});

	test("folds Anthropic updates into the system prompt without native support", async () => {
		const model: Model<"anthropic-messages"> = {
			...modelBase,
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
		};
		const { payload } = await capturePayload<{
			betas?: string[];
			system?: Array<{ text: string }>;
			tools?: Array<{ name: string }>;
			messages: Array<{ role: string }>;
		}>(model, context);

		expect(payload.betas ?? []).not.toContain("mid-conversation-tool-changes-2026-07-01");
		expect(payload.system?.map((block) => block.text)).toEqual([
			"base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>",
		]);
		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
	});

	test("requires both Anthropic capabilities for native tool changes", async () => {
		const model: Model<"anthropic-messages"> = {
			...modelBase,
			id: "claude-opus-5",
			name: "Claude Opus 5",
			api: "anthropic-messages",
			provider: "anthropic",
			compat: { supportsMidConvoToolChanges: true },
		};
		const { payload } = await capturePayload<{
			betas?: string[];
			tools?: Array<{ name: string }>;
			messages: Array<{ role: string }>;
		}>(model, context);

		expect(payload.betas ?? []).not.toContain("mid-conversation-tool-changes-2026-07-01");
		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
	});

	test("anchors OpenAI additions at their developer message", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		};
		const { payload } = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; role?: string; content?: string; tools?: Array<{ name: string }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.name)).toEqual(["base_tool"]);
		expect(payload.input.find((item) => item.type === "additional_tools")?.tools?.map((value) => value.name)).toEqual(
			["late_tool"],
		);
		expect(
			payload.input
				.filter((item) => item.role === "developer" && item.type === undefined)
				.map((item) => item.content),
		).toEqual(["base prompt", "updated guidance"]);
	});

	test("maps system-message additions into synthetic tool search", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
		};
		const { payload } = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; tools?: Array<{ name: string }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.name)).toEqual(["base_tool"]);
		expect(payload.input.map((item) => item.type)).toContain("tool_search_call");
		expect(payload.input.find((item) => item.type === "tool_search_output")?.tools).toMatchObject([
			{ type: "namespace", tools: [{ name: "late_tool" }] },
		]);
	});

	test("folds OpenAI updates into the leading developer message without native support", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-4.1",
			name: "GPT-4.1",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsAdditionalTools: true },
		};
		const { payload } = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; role?: string; content?: string }>;
		}>(model, context);

		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.input.map((item) => item.type ?? item.role)).toEqual(["developer", "user"]);
		expect(payload.input[0]?.content).toBe("base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>");
	});

	test.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const)(
		"%s retains removed declarations and appends an immediate unavailability notice",
		async (api) => {
			const model: Model<Api> = {
				...modelBase,
				id: "gpt-5.4",
				name: "GPT-5.4",
				api,
				provider: "openai",
				compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
			};
			const { payload } = await capturePayload<{
				tools?: Array<{ name: string }>;
				input: Array<{ type?: string; role?: string; content?: string }>;
			}>(model, context);

			expect(payload.tools?.map((value) => value.name)).toEqual(["base_tool"]);
			expect(payload.input.some((item) => item.type === "additional_tools")).toBe(true);
			expect(payload.input.at(-1)?.content).toContain("Tool base_tool is no longer available");
		},
	);

	test("anchors Kimi additions in tool-bearing system messages", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "kimi-k3",
			name: "Kimi K3",
			api: "openai-completions",
			provider: "moonshotai",
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
		};
		const { payload } = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string; tools?: Array<{ function?: { name: string } }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool"]);
		expect(payload.messages.find((message) => message.tools)?.tools?.map((value) => value.function?.name)).toEqual([
			"late_tool",
		]);
		expect(payload.messages.filter((message) => message.role === "system").map((message) => message.content)).toEqual(
			["base prompt", undefined, "updated guidance"],
		);
	});

	test("keeps Kimi K2 system text inline without dynamic tool messages", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "kimi-k2.7-code",
			name: "Kimi K2.7 Code",
			api: "openai-completions",
			provider: "moonshotai",
			compat: { supportsMidConvoSystemMessages: true },
		};
		const { payload } = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string; tools?: Array<{ function?: { name: string } }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
		expect(payload.messages.filter((message) => message.role === "system").map((message) => message.content)).toEqual(
			["base prompt", "updated guidance"],
		);
	});

	test("folds OpenAI-compatible updates into the system prompt without native support", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "custom-model",
			name: "Custom model",
			api: "openai-completions",
			provider: "custom-provider",
			reasoning: false,
		};
		const { payload } = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string }>;
		}>(model, context);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect(payload.messages[0]?.content).toBe("base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>");
	});
});
