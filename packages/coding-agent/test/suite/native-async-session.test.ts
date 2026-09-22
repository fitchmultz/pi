import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

const toolCall = (): ToolCall => ({
	type: "toolCall",
	id: "call|fc_call",
	name: "work",
	arguments: { path: "original" },
	async: true,
	responsesItem: {
		type: "function_call",
		id: "fc_call",
		call_id: "call",
		name: "work",
		arguments: '{"path":"original"}',
		async: true,
		status: "completed",
	},
});
const assistant = (call = toolCall()): AssistantMessage =>
	structuredClone(fauxAssistantMessage([call], { responseId: "response", stopReason: "toolUse" }));
const result: AgentToolResult = { content: [{ type: "text", text: "real result" }], details: undefined };

describe("native journal projection", () => {
	it("coalesces late execution checkpoints without losing later response content or usage", () => {
		const manager = SessionManager.inMemory();
		const original = assistant();
		original.stopReason = "pending";
		manager.appendMessage(structuredClone(original), true);
		original.content.push({ type: "text", text: "independent answer" });
		original.stopReason = "toolUse";
		original.usage.totalTokens = 9;
		const finalId = manager.appendMessage(structuredClone(original));
		const detached = assistant({ ...toolCall(), executionStarted: true, executionDetached: true });
		detached.stopReason = "pending";
		manager.appendMessage(detached, true);
		const projection = manager.buildSessionProjection();
		expect(projection.messages).toHaveLength(1);
		expect(projection.entries[0].sourceEntry.id).toBe(finalId);
		expect(projection.messages[0]).toMatchObject({
			usage: { totalTokens: 9 },
			content: [{ executionDetached: true }, { text: "independent answer" }],
		});
	});

	it("retains all admitted calls when a late pending checkpoint contains only an earlier prefix", () => {
		const manager = SessionManager.inMemory();
		const first = { ...toolCall(), executionStarted: true, executionArguments: { path: "admitted" } };
		const second = { ...toolCall(), id: "second", executionStarted: true };
		const newer = assistant(first);
		newer.stopReason = "pending";
		newer.content.push(second);
		manager.appendMessage(newer, true);
		const late = assistant({ ...first, executionDetached: true });
		late.stopReason = "pending";
		manager.appendMessage(late, true);
		expect(manager.buildSessionProjection().messages[0]).toMatchObject({
			content: [
				{ id: first.id, executionArguments: { path: "admitted" }, executionDetached: true },
				{ id: second.id, executionStarted: true },
			],
		});
	});

	it("carries a delayed result's call across compaction, respects context edits, and stays branch/window local", () => {
		const manager = SessionManager.inMemory();
		const callId = manager.appendMessage(assistant({ ...toolCall(), executionStarted: true }));
		const laterId = manager.appendMessage(fauxAssistantMessage("later answer", { responseId: "later" }));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call|fc_call",
			toolName: "work",
			content: result.content,
			isError: false,
			timestamp: 2,
		});
		manager.appendCompaction("summary", laterId, 100);
		let messages = manager.buildSessionProjection().messages;
		expect(
			messages.filter(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			),
		).toHaveLength(1);
		manager.appendContextEdit(callId, null);
		messages = manager.buildSessionProjection().messages;
		expect(
			messages.some(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			),
		).toBe(false);
		manager.branch(callId);
		expect(manager.buildSessionProjection().messages).toHaveLength(1);
		manager.appendContextWindow("fresh", 100);
		expect(manager.buildSessionProjection().messages.some((message) => message.role === "assistant")).toBe(false);
	});
});

it("normal AgentSession persists admission before effects, detaches, and reattaches with original identity", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-native-async-journal-"));
	const manager = SessionManager.create(directory, directory);
	let executeStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		executeStarted = resolve;
	});
	const execute = vi.fn<AgentTool["execute"]>(async (_id, args, signal) => {
		const bytes = readFileSync(manager.getSessionFile()!, "utf8");
		expect(bytes).toContain('"executionStarted":true');
		expect(bytes).toContain('"executionArguments":{"path":"admitted"}');
		expect(args).toEqual({ path: "admitted" });
		executeStarted();
		await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
		return { ...result, pending: true };
	});
	const resume = vi.fn<NonNullable<AgentTool["resume"]>>(async (_id, args) => {
		expect(args).toEqual({ path: "admitted" });
		return result;
	});
	const tool: AgentTool = {
		name: "work",
		label: "Work",
		description: "Work",
		parameters: Type.Object({ path: Type.String() }),
		async: true,
		execute,
		resume,
	};
	const preflight = vi.fn();
	const harness = await createHarness({
		sessionManager: manager,
		tools: [tool],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", (event) => {
					preflight();
					Object.assign(event.input, { path: "admitted" });
				});
			},
		],
	});
	try {
		const originalStream = harness.session.agent.streamFunction;
		const native = {
			...harness.getModel(),
			api: "openai-responses",
			compat: { supportsAsyncTools: true },
		} as Model<"openai-responses">;
		harness.session.agent.state.model = native;
		harness.session.agent.streamFunction = (_model, context, options) => {
			const cloned = createAssistantMessageEventStream();
			void (async () => {
				const source = await originalStream(harness.getModel(), context, options);
				for await (const event of source) {
					if (event.type === "done" && event.message.responseId === "response") await started;
					// Namespace decoders clone each provider frame, including the final ToolCall.
					cloned.push(structuredClone(event));
				}
				cloned.end();
			})();
			return cloned;
		};
		harness.setResponses([assistant(), fauxAssistantMessage("reattached"), fauxAssistantMessage("finished")]);
		const run = harness.session.prompt("go");
		await started;
		await vi.waitFor(() =>
			expect(
				harness
					.eventsOfType("message_end")
					.some((event) => event.message.role === "assistant" && event.message.responseId === "response"),
			).toBe(true),
		);
		const finalized = SessionManager.open(manager.getSessionFile()!).buildSessionProjection().messages;
		expect(finalized.find((message) => message.role === "assistant")).toMatchObject({
			content: [{ executionStarted: true, executionArguments: { path: "admitted" } }],
		});
		expect(harness.session.agent.state.messages.find((message) => message.role === "assistant")).toMatchObject({
			content: [{ executionStarted: true, executionArguments: { path: "admitted" } }],
		});
		await harness.session.abort();
		await run;
		expect(harness.eventsOfType("tool_execution_detached")).toHaveLength(1);
		expect(harness.session.getPendingToolCalls()).toMatchObject([{ toolCallId: "call|fc_call", state: "detached" }]);
		expect(harness.eventsOfType("agent_settled").at(-1)).toMatchObject({ pendingToolCalls: [{ state: "detached" }] });
		const reopened = SessionManager.open(manager.getSessionFile()!);
		harness.session.agent.state.messages = reopened.buildSessionProjection().messages;
		await harness.session.prompt("continue");
		expect(execute).toHaveBeenCalledOnce();
		expect(resume).toHaveBeenCalledOnce();
		expect(preflight).toHaveBeenCalledOnce();
		expect(harness.session.getPendingToolCalls()).toEqual([]);
		expect(
			manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);
		expect(harness.session.getSessionStats().assistantMessages).toBe(
			harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant").length,
		);
	} finally {
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});
