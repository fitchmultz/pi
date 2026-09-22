import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";
import { normalizeContext } from "../../../ai/src/utils/transcript.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createHarness } from "./harness.ts";

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
				needsContinuation: true,
			},
			{
				...fauxAssistantMessage([], { responseId: "program_done" }),
				...metadata,
				responsesOutput: [{ type: "compaction", id: "cmp", encrypted_content: "encrypted-window" }],
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
