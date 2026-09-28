import { fauxAssistantMessage, type Message, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";

const model: Model<"openai-responses"> = {
	id: "admission",
	name: "Admission",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://offline.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 40_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsMidConvoSystemMessages: true },
};
const huge = "x".repeat(200_000);

describe("Agent request admission", () => {
	it.each<{ name: string; messages: Message[] }>([
		{
			name: "removed tool declarations",
			messages: [
				{
					role: "system",
					content: "Small prompt",
					toolsAdded: [{ name: "old", description: huge, parameters: { type: "object" } }],
					timestamp: 0,
				},
				{ role: "user", content: "Continue", timestamp: 1 },
				{ role: "system", content: "Small update", toolsRemoved: [{ name: "old" }], timestamp: 2 },
			],
		},
		{
			name: "failed partial assistant content",
			messages: [
				{ ...fauxAssistantMessage(huge), stopReason: "error" },
				{ role: "user", content: "Continue", timestamp: 1 },
			],
		},
		{
			name: "unsupported images",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Continue" },
						...Array.from({ length: 140 }, () => ({
							type: "image" as const,
							mimeType: "image/png",
							data: "aGVsbG8=",
						})),
					],
					timestamp: 1,
				},
			],
		},
	])("admits fitting native input after omitting $name", async ({ messages }) => {
		const agent = new Agent({
			streamFn: (target, context, options) => streamSimple(target as Model<"openai-responses">, context, options),
		});
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			expect(String(init?.body)).not.toContain(huge);
			return new Response(
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const result = await (
			await agent.streamResponse(model, normalizeContext({ messages }), {
				apiKey: "offline-placeholder",
				transport: "sse",
				maxRetries: 0,
				fetch,
			})
		).result();
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});
});
