import type { BetaResponseOutputItem, BetaResponseOutputMessage } from "openai/resources/beta/responses/responses.js";
import { describe, expect, it } from "vitest";
import {
	convertResponsesMessages,
	processResponsesStream,
	type ResponsesEvent,
} from "../src/api/openai-responses-shared.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Model, ToolResultMessage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const providers = new Set(["openai"]);
const textItem = (id: string, text: string): BetaResponseOutputMessage => ({
	type: "message",
	id,
	role: "assistant",
	status: "completed",
	phase: "final_answer",
	content: [{ type: "output_text", text, annotations: [] }],
});
async function capture(model: Model<"openai-responses">, items: BetaResponseOutputItem[]): Promise<AssistantMessage> {
	const output: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
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
	async function* events(): AsyncGenerator<ResponsesEvent> {
		for (const [output_index, item] of items.entries())
			yield { type: "response.output_item.done", output_index, item, sequence_number: output_index };
		yield {
			type: "response.completed",
			sequence_number: items.length,
			response: { id: "resp", status: "completed", output: items },
		} as ResponsesEvent;
	}
	await processResponsesStream(events(), output, new AssistantMessageEventStream(), model);
	return output;
}
function replay(model: Model<"openai-responses">, message: AssistantMessage, results: ToolResultMessage[] = []) {
	return convertResponsesMessages(model, normalizeContext({ messages: [message, ...results] }), providers);
}

describe("edited Responses content", () => {
	// PR #83: authoritative native history must not undo content redaction.
	it.each(["gpt-5.2", "gpt-6-astra"] as const)("honors a replacement without signatures on %s", async (id) => {
		const model = getBuiltinModel("openai", id);
		const original = await capture(model, [textItem("msg_secret", "original secret")]);
		const edited = { ...original, content: [{ type: "text" as const, text: "redacted" }] };
		const input = replay(model, edited);
		expect(JSON.stringify(input)).not.toContain("original secret");
		expect(input).toContainEqual(
			expect.objectContaining({ content: [{ type: "output_text", text: "redacted", annotations: [] }] }),
		);
		expect(original.responsesOutput).toEqual([textItem("msg_secret", "original secret")]);
	});

	it("drops opaque state from the edited message while preserving untouched adjacent hosted state", async () => {
		const model = getBuiltinModel("openai", "gpt-6-astra");
		const reasoning: BetaResponseOutputItem = {
			type: "reasoning",
			id: "rs",
			summary: [],
			encrypted_content: "opaque-reasoning",
		};
		const program: BetaResponseOutputItem = {
			type: "program",
			id: "prog",
			call_id: "program",
			code: "text(3)",
			fingerprint: "opaque-program",
		};
		const compaction: BetaResponseOutputItem = {
			type: "compaction",
			id: "cmp",
			encrypted_content: "opaque-compaction",
		};
		const child = { ...textItem("child", "child answer"), agent: { agent_name: "/root/child" } };
		const adjacent = await capture(model, [reasoning, program, compaction, child]);
		expect(replay(model, adjacent)).toEqual(adjacent.responsesOutput);
		const original = await capture(model, [
			{ ...program, id: "secret_program", code: "text('original secret')" },
			{
				type: "program_output",
				id: "secret_result",
				call_id: "program",
				result: "original secret",
				status: "completed",
			},
			{
				type: "agent_message",
				id: "secret_mail",
				author: "/root/child",
				recipient: "/root",
				content: [{ type: "encrypted_content", encrypted_content: "stale-mail" }],
				agent: { agent_name: "/root" },
			},
			textItem("root", "original secret"),
		]);
		const edited = structuredClone(original);
		for (const block of edited.content) if (block.type === "text") block.text = "redacted";
		edited.content.push({ type: "text", text: "new context" });
		const input = convertResponsesMessages(model, normalizeContext({ messages: [adjacent, edited] }), providers);
		for (const item of [reasoning, program, compaction, child]) expect(input).toContainEqual(item);
		expect(JSON.stringify(input)).not.toContain("original secret");
		expect(JSON.stringify(input)).not.toContain("stale-mail");
		expect(input).toContainEqual(
			expect.objectContaining({ content: [{ type: "output_text", text: "redacted", annotations: [] }] }),
		);
		expect(JSON.stringify(input).match(/new context/g)).toHaveLength(1);
		edited.content = edited.content.filter((block) => block.type !== "text");
		const removed = replay(model, edited);
		expect(removed).toEqual([]);
	});

	it("does not replay the old summary or ciphertext after a thinking edit", async () => {
		const model = getBuiltinModel("openai", "gpt-6-astra");
		const original = await capture(model, [
			{
				type: "reasoning",
				id: "rs",
				summary: [{ type: "summary_text", text: "original secret" }],
				encrypted_content: "stale-ciphertext",
			},
			textItem("answer", "answer"),
		]);
		const edited = structuredClone(original);
		for (const block of edited.content) if (block.type === "thinking") block.thinking = "redacted reasoning";
		const input = replay(model, edited);
		expect(JSON.stringify(input)).not.toContain("original secret");
		expect(JSON.stringify(input)).not.toContain("stale-ciphertext");
		expect(JSON.stringify(input)).toContain("redacted reasoning");
	});

	it("reconstructs edited call arguments without stale program caller or native input", async () => {
		const model = getBuiltinModel("openai", "gpt-6-astra");
		const original = await capture(model, [
			{
				type: "program",
				id: "prog",
				call_id: "program",
				code: "text('original secret')",
				fingerprint: "private-fingerprint",
			},
			{
				type: "function_call",
				id: "fc",
				call_id: "call",
				name: "read",
				arguments: '{"value":"original secret"}',
				caller: { type: "program", caller_id: "program" },
			},
		]);
		const edited = structuredClone(original);
		for (const block of edited.content) if (block.type === "toolCall") block.arguments = { value: "redacted" };
		const input = replay(model, edited);
		expect(JSON.stringify(input)).not.toContain("original secret");
		expect(JSON.stringify(input)).not.toContain("private-fingerprint");
		const call = input.find((item) => item.type === "function_call");
		expect(call).toMatchObject({ arguments: '{"value":"redacted"}' });
		expect(call).not.toHaveProperty("caller");
	});

	it("relocates a late ordinary synchronous result on the same model without disturbing hosted injection order", async () => {
		const model = getBuiltinModel("openai", "gpt-5.2");
		const call: BetaResponseOutputItem = {
			type: "function_call",
			id: "fc",
			call_id: "call",
			name: "read",
			arguments: "{}",
		};
		const first = await capture(model, [call]);
		const later = await capture(model, [textItem("later", "later answer")]);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call|fc",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		};
		const input = convertResponsesMessages(model, normalizeContext({ messages: [first, later, result] }), providers);
		expect(input.map((item) => item.type)).toEqual(["function_call", "function_call_output", "message"]);
	});
});
