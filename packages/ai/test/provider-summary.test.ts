import { describe, expect, it } from "vitest";
import { resolveProviderSummary, supportsProviderSummary } from "../src/provider-summary.ts";
import type { AssistantMessage, JsonObject, Message, Model, SystemMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const writer: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 4096,
	compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

const keptReply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "kept reply" }],
	api: writer.api,
	provider: writer.provider,
	model: writer.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

function contextWith(block: JsonObject) {
	const base = normalizeContext({ systemPrompt: "You are a test assistant.", messages: [] });
	const lead: SystemMessage = {
		...(base.messages[0] as SystemMessage),
		providerSummary: { provider: writer.provider, api: writer.api, model: writer.id, block, timestamp: 7 },
	};
	const restated: Message = {
		role: "system",
		content: "",
		toolsAdded: [{ name: "ring", description: "Ring the bell", parameters: { type: "object", properties: {} } }],
		timestamp: 1,
	};
	const record: Message = { role: "user", content: "record", timestamp: 1 };
	return { ...base, messages: [lead, restated, keptReply, record] };
}

describe("provider summary", () => {
	it("is supported by Anthropic Messages models with per-message effort on routes that keep system messages in place", () => {
		expect(supportsProviderSummary(writer)).toBe(true);
		expect(supportsProviderSummary({ ...writer, compat: {} })).toBe(false);
		expect(supportsProviderSummary({ ...writer, api: "openai-completions", compat: {} })).toBe(false);
		// A route that folds later system messages or tool changes into the leading one cannot send a block.
		expect(
			supportsProviderSummary({ ...writer, compat: { ...writer.compat, supportsMidConvoSystemMessages: false } }),
		).toBe(false);
		expect(
			supportsProviderSummary({ ...writer, compat: { ...writer.compat, supportsMidConvoToolChanges: false } }),
		).toBe(false);
	});

	it("leaves the transcript as it is for the model that wrote the block", () => {
		const context = contextWith({ type: "compaction", content: "the summary", signature: "sig" });
		expect(resolveProviderSummary(writer, context)).toBe(context);
	});

	it.each([
		["another model", { ...writer, id: "claude-other" }],
		["another provider", { ...writer, provider: "cloudflare-ai-gateway" }],
		["another API", { ...writer, api: "openai-completions", compat: {} } as Model<"openai-completions">],
	])("gives %s the summary text as a user message before the first kept message", (_name, reader) => {
		const context = contextWith({ type: "compaction", content: "the summary", signature: "sig" });
		const [lead, restated, kept, record] = context.messages;

		const resolved = resolveProviderSummary(reader, context);

		const { providerSummary: _block, ...plainLead } = lead as SystemMessage;
		// The stand-in carries the time of the block, so the usage of the kept reply is not read as
		// the size of this transcript.
		expect(resolved.messages).toEqual([
			plainLead,
			restated,
			{ role: "user", content: "Summary of the earlier conversation:\n\nthe summary", timestamp: 7 },
			kept,
			record,
		]);
		expect(resolved.messages[0]).not.toHaveProperty("providerSummary");
		// The stored transcript keeps its block.
		expect(context.messages[0]).toHaveProperty("providerSummary");
	});

	it("says that the summary is unavailable when the block has no readable text", () => {
		const resolved = resolveProviderSummary(
			{ ...writer, id: "claude-other" },
			contextWith({ type: "compaction", signature: "sig" }),
		);
		expect(resolved.messages[2]).toMatchObject({
			role: "user",
			content: "The earlier conversation was summarized. Its summary is not available to this model.",
		});
	});
});
