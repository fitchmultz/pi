import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { expect, it, vi } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { ImageContent, Model, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// https://github.com/earendil-works/pi/issues/10794
it("omits images only from error tool results in the native Anthropic payload", async () => {
	const model: Model<"anthropic-messages"> = {
		id: "test-vision-model",
		name: "Test vision model",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 4096,
	};
	const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
	const results: ToolResultMessage[] = [
		{
			role: "toolResult",
			toolCallId: "failed",
			toolName: "render",
			content: [{ type: "text", text: "Rendered preview" }, image, { type: "text", text: "Then failed" }],
			isError: true,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "image_only_error",
			toolName: "render",
			content: [image],
			isError: true,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "success",
			toolName: "render",
			content: [{ type: "text", text: "Rendered successfully" }, image],
			isError: false,
			timestamp: 3,
		},
	];
	const originalResults = structuredClone(results);
	let payload: MessageCreateParamsStreaming | undefined;
	const fetch = vi.fn<typeof globalThis.fetch>(async () => {
		throw new Error("Unexpected network request");
	});
	const result = await stream(
		model,
		normalizeContext({
			messages: [
				{ role: "user", content: "Render previews", timestamp: 0 },
				fauxAssistantMessage(
					results.map((result) => fauxToolCall(result.toolName, {}, { id: result.toolCallId })),
					{ stopReason: "toolUse" },
				),
				...results,
			],
		}),
		{
			apiKey: "test-key",
			cacheRetention: "none",
			fetch,
			onPayload: (value) => {
				payload = value as MessageCreateParamsStreaming;
				throw new Error("Payload captured before network");
			},
		},
	).result();

	expect(result.errorMessage).toBe("Payload captured before network");
	expect(fetch).not.toHaveBeenCalled();
	expect(payload?.messages.at(-1)).toEqual({
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "failed",
				content: "Rendered preview\n[image omitted: error tool results cannot contain images]\nThen failed",
				is_error: true,
			},
			{
				type: "tool_result",
				tool_use_id: "image_only_error",
				content: "[image omitted: error tool results cannot contain images]",
				is_error: true,
			},
			{
				type: "tool_result",
				tool_use_id: "success",
				content: [
					{ type: "text", text: "Rendered successfully" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
				],
				is_error: false,
			},
		],
	});
	expect(results).toEqual(originalResults);
});
