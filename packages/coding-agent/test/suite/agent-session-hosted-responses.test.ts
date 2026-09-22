import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type ToolCall,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import {
	convertResponsesMessages,
	processResponsesStream,
	type ResponsesEvent,
} from "../../../ai/src/api/openai-responses-shared.ts";
import { getBuiltinModel } from "../../../ai/src/providers/all.ts";
import { normalizeContext, snapshotResponsesContent } from "../../../ai/src/utils/transcript.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createHarness } from "./harness.ts";

// PR #83: compaction's internal call-only projection must retain native async identity, while real edits still win.
it.each([false, true])(
	"carries native async calls across compaction without bypassing context edits (edited=%s)",
	async (edited) => {
		const harness = await createHarness({ tools: [] });
		try {
			const model = getBuiltinModel("openai", "gpt-6-astra");
			const identity = { api: model.api, provider: model.provider, model: model.id };
			const nativeCall = {
				type: "function_call" as const,
				id: "fc_work",
				call_id: "work",
				name: "work",
				arguments: '{"value":"original secret"}',
				async: true,
				status: "completed" as const,
			};
			const text = {
				type: "message" as const,
				id: "msg_old",
				role: "assistant" as const,
				status: "completed" as const,
				content: [{ type: "output_text" as const, text: "independent answer", annotations: [] }],
			};
			const original: AssistantMessage = {
				...fauxAssistantMessage([], { responseId: "old", stopReason: "pending" }),
				...identity,
			};
			async function* events(): AsyncGenerator<ResponsesEvent> {
				yield {
					type: "response.completed",
					sequence_number: 1,
					response: { id: "old", status: "completed", output: [nativeCall, text] },
				} as ResponsesEvent;
			}
			await processResponsesStream(events(), original, createAssistantMessageEventStream(), model);
			const manager = harness.sessionManager;
			const originalId = manager.appendMessage(original);
			const laterId = manager.appendMessage({
				...fauxAssistantMessage("later answer", { responseId: "later" }),
				...identity,
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "work|fc_work",
				toolName: "work",
				content: [{ type: "text", text: "late result" }],
				isError: false,
				timestamp: 2,
			});
			if (edited)
				manager.appendContextEdit(originalId, {
					content: original.content.map((block) =>
						block.type === "toolCall" ? { ...block, arguments: { value: "redacted" } } : block,
					),
				});
			manager.appendCompaction("summary", laterId, 100);
			const messages = manager
				.buildSessionProjection()
				.messages.filter((message) => message.role === "assistant" || message.role === "toolResult");
			const input = convertResponsesMessages(model, normalizeContext({ messages }), new Set(["openai"]));
			const replayedCall = input.find((item) => item.type === "function_call");
			if (edited) {
				expect(JSON.stringify(input)).not.toContain("original secret");
				expect(replayedCall).toMatchObject({ arguments: '{"value":"redacted"}', async: true });
			} else {
				expect(replayedCall).toEqual(nativeCall);
				expect(input.map((item) => item.type)).toEqual(["function_call", "message", "function_call_output"]);
				expect(input.filter((item) => item.type === "function_call_output")).toEqual([
					{ type: "function_call_output", call_id: "work", output: "late result" },
				]);
				const carried = messages.find((message) => message.role === "assistant" && message.responseId === "old");
				expect(carried).toMatchObject({ content: [{ responsesItem: nativeCall }] });
				expect(carried).not.toHaveProperty("responsesOutput", expect.anything());
				expect(carried).not.toHaveProperty("responsesContent", expect.anything());
			}
			expect(original.responsesOutput).toEqual([nativeCall, text]);
		} finally {
			harness.cleanup();
		}
	},
);

// PR #83: context_edit preserves metadata, but native replay must use the replacement content.
it.each(["gpt-5.2", "gpt-6-astra"] as const)(
	"sends session context redaction instead of retained native text on %s",
	async (id) => {
		const harness = await createHarness({ tools: [] });
		try {
			const model = getBuiltinModel("openai", id);
			const original = {
				...fauxAssistantMessage([
					{ type: "text", text: "original secret", textSignature: '{"v":1,"id":"msg_secret"}' },
				]),
				provider: model.provider,
				api: model.api,
				model: model.id,
				responsesOutput: [
					{
						type: "message",
						id: "msg_secret",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "original secret", annotations: [] }],
					},
				],
			} satisfies AssistantMessage;
			const entryId = harness.sessionManager.appendMessage({
				...original,
				responsesContent: snapshotResponsesContent(original.content),
			});
			harness.sessionManager.appendContextEdit(entryId, { content: "redacted" });
			const messages = harness.sessionManager
				.buildSessionProjection()
				.messages.filter((message) => message.role === "assistant");
			expect(messages[0].content).toEqual([{ type: "text", text: "redacted" }]);
			const input = convertResponsesMessages(model, normalizeContext({ messages }), new Set(["openai"]));
			expect(JSON.stringify(input)).not.toContain("original secret");
			expect(JSON.stringify(input)).toContain("redacted");
			expect(harness.sessionManager.getEntry(entryId)).toMatchObject({
				message: { content: [{ text: "original secret" }] },
			});
		} finally {
			harness.cleanup();
		}
	},
);

it("keeps the terminal journal snapshot immutable when a hosted call passes admission later", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const item: NonNullable<ToolCall["responsesItem"]> = {
		type: "function_call",
		id: "fc_live",
		call_id: "live",
		name: "work",
		arguments: "{}",
	};
	const call: ToolCall = {
		type: "toolCall",
		id: "live|fc_live",
		name: "work",
		arguments: {},
		streaming: true,
		responsesItem: item,
	};
	const execute = vi.fn<AgentTool["execute"]>(async () => ({
		content: [{ type: "text", text: "done" }],
		details: undefined,
	}));
	const harness = await createHarness({
		tools: [{ name: "work", label: "Work", description: "Work", parameters: Type.Object({}), execute }],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", async () => {
					await gate;
				});
			},
		],
	});
	harness.session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.responseId === "live")
			release();
	});
	try {
		harness.setResponses([
			{ ...fauxAssistantMessage([call], { responseId: "live", stopReason: "toolUse" }), responsesOutput: [item] },
			fauxAssistantMessage("answer"),
		]);
		await harness.session.prompt("go");
		expect(execute).toHaveBeenCalledOnce();
		const terminal = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					!entry.checkpoint &&
					entry.message.role === "assistant" &&
					entry.message.responseId === "live",
			);
		expect(terminal).toMatchObject({
			message: { content: [expect.not.objectContaining({ executionStarted: true })] },
		});
		expect(
			harness.sessionManager
				.buildSessionProjection()
				.messages.find((message) => message.role === "assistant" && message.responseId === "live"),
		).toMatchObject({ content: [{ executionStarted: true }] });
	} finally {
		release();
		harness.cleanup();
	}
});

it("persists hosted caller, program state, compaction and admission across session restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-hosted-journal-"));
	const manager = SessionManager.create(directory, directory);
	const caller = { type: "program" as const, caller_id: "program" };
	const item = {
		type: "function_call" as const,
		id: "fc_read",
		call_id: "read",
		name: "read_record",
		arguments: "{}",
		caller,
	};
	const call: ToolCall = {
		type: "toolCall",
		id: "read|fc_read",
		name: "read_record",
		arguments: {},
		responsesItem: item,
	};
	const output: AssistantMessage["responsesOutput"] = [
		{
			type: "program",
			id: "prog",
			call_id: "program",
			code: "text(await tools.read_record({}));",
			fingerprint: "opaque-program",
		},
		item,
	];
	const execute = vi.fn<AgentTool["execute"]>(async () => {
		const journal = readFileSync(manager.getSessionFile()!, "utf8");
		expect(journal).toContain('"executionStarted":true');
		expect(journal).toContain('"fingerprint":"opaque-program"');
		return { content: [{ type: "text", text: '{"value":3}' }], details: undefined };
	});
	const tool: AgentTool = {
		name: "read_record",
		label: "Read",
		description: "Read",
		parameters: Type.Object({}),
		allowedCallers: ["programmatic"],
		outputSchema: { type: "object" },
		execute,
	};
	const wrapped = wrapToolDefinition(createToolDefinitionFromAgentTool(tool));
	expect(wrapped).toMatchObject({ allowedCallers: ["programmatic"], outputSchema: { type: "object" } });
	const harness = await createHarness({
		sessionManager: manager,
		tools: [wrapped],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	try {
		const native = harness.getModel();
		const metadata = { api: native.api, provider: native.provider, model: native.id };
		harness.setResponses([
			{
				...fauxAssistantMessage([call], { responseId: "hosted_call", stopReason: "toolUse" }),
				...metadata,
				responsesOutput: output,
				responsesContent: snapshotResponsesContent([call]),
				needsContinuation: true,
			},
			{
				...fauxAssistantMessage([], { responseId: "program_done" }),
				...metadata,
				responsesOutput: [{ type: "compaction", id: "cmp", encrypted_content: "encrypted-window" }],
				responsesContent: [],
				needsContinuation: true,
			},
			fauxAssistantMessage("answer"),
		]);
		await harness.session.prompt("go");
		expect(harness.faux.state.callCount).toBe(3);
		expect(execute).toHaveBeenCalledOnce();
		const reopened = SessionManager.open(manager.getSessionFile()!);
		const messages = reopened
			.buildSessionProjection()
			.messages.filter((message) => message.role === "assistant" || message.role === "toolResult");
		const input = convertResponsesMessages(native, normalizeContext({ messages }), new Set(["openai"]));
		expect(input.slice(0, 3)).toEqual([
			...output!,
			{ type: "function_call_output", call_id: "read", caller, output: '{"value":3}' },
		]);
		expect(input).toContainEqual({ type: "compaction", id: "cmp", encrypted_content: "encrypted-window" });
		expect(input.filter((item) => item.type === "function_call")).toHaveLength(1);
		expect(
			messages.find((message) => message.role === "assistant" && message.responseId === "hosted_call"),
		).toMatchObject({ content: [{ executionStarted: true }] });
		harness.session.agent.state.messages = reopened.buildSessionProjection().messages;
		harness.setResponses([fauxAssistantMessage("continued")]);
		await harness.session.prompt("continue");
		expect(execute).toHaveBeenCalledOnce();
	} finally {
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});
