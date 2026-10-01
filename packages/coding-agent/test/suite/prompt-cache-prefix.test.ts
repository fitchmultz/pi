import { fauxAssistantMessage, fauxToolCall, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { type InstructionGroupCollector, instructionGroupsExtension } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

interface Payload {
	input: unknown[];
	tools?: unknown[];
	instructions?: string;
}

// Both serializers must stop before transport; this is prefix evidence, not a live cache-hit measurement.
it.each(["openai-responses", "openai-codex-responses"] as const)(
	"%s adds discovered declarations positionally without rewriting the request prefix",
	async (api) => {
		const model = {
			id: "gpt-6.1-sol",
			name: "Sol",
			api,
			provider: api === "openai-responses" ? "openai" : "openai-codex",
			baseUrl: api === "openai-responses" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1000,
			compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		} satisfies Model<"openai-responses" | "openai-codex-responses">;
		const captures: Payload[] = [];
		const capture = async (context: TranscriptContext) => {
			const options = {
				apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`,
				onPayload(value: unknown) {
					captures.push(JSON.parse(JSON.stringify(value)) as Payload);
					throw new Error("offline payload captured");
				},
			};
			const result = await (api === "openai-responses"
				? responsesStream({ ...model, api }, context, options)
				: codexStream({ ...model, api }, context, options)
			).result();
			expect(result.errorMessage).toContain("offline payload captured");
		};
		const h = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				instructionGroupsExtension,
				(pi) => {
					pi.registerTool({
						name: "browse",
						label: "Browse",
						description: "Inspect a page",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "page inspected" }], details: undefined }),
					});
					pi.events.on("pi:instruction-groups", (data) =>
						(data as InstructionGroupCollector).register({
							name: "browser",
							description: "Browser",
							tools: ["browse"],
							instructions: () => "Inspect before acting.",
						}),
					);
				},
			],
		});
		try {
			await h.session.bindExtensions({});
			h.setResponses([
				async (context) => {
					await capture(context);
					return fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), {
						stopReason: "toolUse",
					});
				},
				async (context) => {
					await capture(context);
					return fauxAssistantMessage("done");
				},
			]);
			await h.session.prompt("Enable browser");
			expect(captures).toHaveLength(2);
			const [before, after] = captures;
			expect(JSON.stringify(after.input.slice(0, before.input.length))).toBe(JSON.stringify(before.input));
			expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
			expect(after.instructions).toBe(before.instructions);
			expect(JSON.stringify(before)).not.toContain('"name":"browse"');
			expect(JSON.stringify(after.input)).toContain('"type":"additional_tools"');
			expect(JSON.stringify(after.input)).toContain('"name":"browse"');
			expect(h.session.getActiveToolNames()).toContain("browse");
		} finally {
			h.cleanup();
		}
	},
);
