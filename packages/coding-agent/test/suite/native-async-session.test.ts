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
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

const toolCall = (id = "call"): ToolCall => ({
	type: "toolCall",
	id: `${id}|fc_${id}`,
	name: "work",
	arguments: { path: "original" },
	async: true,
	responsesItem: {
		type: "function_call",
		id: `fc_${id}`,
		call_id: id,
		name: "work",
		arguments: '{"path":"original"}',
		async: true,
		status: "completed",
	},
});
const assistant = (call = toolCall()): AssistantMessage =>
	structuredClone(fauxAssistantMessage([call], { responseId: "response", stopReason: "toolUse" }));
const result: AgentToolResult = { content: [{ type: "text", text: "real result" }], details: undefined };

it("finalizes synchronous window edits in registration order without rewriting history", async () => {
	const observed: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				for (const text of ["first excerpt", "final excerpt"]) {
					pi.registerContextWindowHook((event) => {
						const entry = event.contextEntries.find((entry) =>
							entry.messages.some((message) => message.role === "toolResult"),
						)!;
						observed.push(JSON.stringify(entry.messages));
						return [{ type: "context_edit", targetId: entry.sourceEntry.id, replacement: { content: text } }];
					});
				}
			},
		],
	});
	try {
		harness.sessionManager.appendMessage(assistant());
		const id = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: toolCall().id,
			toolName: "work",
			content: result.content,
			isError: true,
			timestamp: 1,
		});
		harness.session.newContext({ handoff: "continue" });
		expect(observed[0]).toContain("real result");
		expect(observed[1]).toContain("first excerpt");
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: toolCall().id,
				isError: true,
				content: [{ type: "text", text: "final excerpt" }],
			}),
		);
		expect(harness.sessionManager.getEntry(id)).toMatchObject({ message: { content: result.content } });
	} finally {
		harness.cleanup();
	}
});

it("validates a final-window edit batch before publishing any of it", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-native-window-hook-failure-"));
	const harness = await createHarness({
		sessionManager: SessionManager.create(directory, directory),
		extensionFactories: [
			(pi) => {
				pi.registerContextWindowHook((event) => [
					{
						type: "context_edit",
						targetId: event.contextEntries.find((entry) =>
							entry.messages.some((message) => message.role === "toolResult"),
						)!.sourceEntry.id,
						replacement: { content: "accepted excerpt" },
					},
				]);
				pi.registerContextWindowHook((event) => {
					const targetId = event.contextEntries.find((entry) =>
						entry.messages.some((message) => message.role === "toolResult"),
					)!.sourceEntry.id;
					return [targetId, "missing"].map((id) => ({
						type: "context_edit",
						targetId: id,
						replacement: { content: "excerpt" },
					}));
				});
			},
		],
	});
	try {
		harness.sessionManager.appendMessage(assistant());
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: toolCall().id,
			toolName: "work",
			content: result.content,
			isError: false,
			timestamp: 1,
		});
		harness.session.refreshContext();
		expect(() => harness.session.newContext()).toThrow();
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_edit")).toMatchObject([
			{ replacement: { content: [{ type: "text", text: "accepted excerpt" }] } },
		]);
		expect(harness.eventsOfType("entry_appended")).toHaveLength(1);
		expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionProjection().messages);
		expect(harness.session.messages).toEqual(
			SessionManager.open(harness.sessionManager.getSessionFile()!).buildSessionProjection().messages,
		);
		expect(harness.eventsOfType("context_window_started")).toHaveLength(1);
	} finally {
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("native journal projection", () => {
	it.each([false, true])(
		"keeps only the raw tail after a coalesced compaction anchor (straddling=%s)",
		(straddling) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-native-kept-tail-"));
			try {
				const manager = SessionManager.create(directory, directory);
				const original = assistant();
				original.content.push({ type: "text", text: "old response prose" });
				manager.appendMessage(original);
				manager.appendContextWindow("fresh", 100);
				const second = { ...assistant(toolCall("second")), responseId: "second-response" };
				if (straddling) {
					manager.appendMessage({ ...second, stopReason: "pending" }, true);
					manager.appendMessage({
						role: "toolResult",
						toolCallId: toolCall("second").id,
						toolName: "work",
						content: [{ type: "text", text: "already summarized receipt" }],
						isError: false,
						timestamp: 1,
					});
				}
				const checkpointId = manager.appendMessage({ ...assistant(), stopReason: "pending" }, true);
				// The final entry belongs to the kept raw range, but coalesces ahead of the summarized receipt.
				const finalIds = straddling ? [manager.appendMessage(second)] : [];
				const tailId = manager.appendMessage({ role: "user", content: "unsummarized tail", timestamp: 2 });
				const summaryId = manager.appendCompaction("older material", checkpointId, 100);
				const reopened = SessionManager.open(manager.getSessionFile()!);
				expect(reopened.buildContextEntries().map((entry) => entry.id)).toEqual([summaryId, ...finalIds, tailId]);
				expect(JSON.stringify(reopened.buildSessionProjection().messages)).not.toContain("old response prose");
				expect(reopened.getEntries()).toEqual(manager.getEntries());
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

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

	it("carries native calls across windows and compaction without reviving old response content on reopen", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-native-window-projection-"));
		try {
			let manager = SessionManager.create(directory, directory);
			const call = { ...toolCall(), namespace: "jobs" };
			const completed = { ...toolCall(), id: "completed|fc_completed" };
			const original = assistant(call);
			original.content.push({ type: "text", text: "old response prose" }, completed);
			const originalId = manager.appendMessage(original);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: completed.id,
				toolName: "work",
				content: result.content,
				isError: false,
				timestamp: 1,
			});
			manager.appendContextWindow("first window", 100);
			// Preflight can finish after rollover; its prefix still belongs to the old response.
			const admitted = { ...call, executionStarted: true, executionArguments: { path: "admitted" } };
			manager.appendMessage(
				{ ...original, content: [admitted, ...original.content.slice(1)], stopReason: "pending" },
				true,
			);
			const file = manager.getSessionFile()!;
			manager = SessionManager.open(file);
			let projection = manager.buildSessionProjection();
			expect(projection.messages.filter((message) => message.role === "assistant")).toMatchObject([
				{ content: [admitted] },
			]);
			expect(
				projection.entries.find((entry) => entry.messages.some((message) => message.role === "assistant"))
					?.sourceEntry.id,
			).toBe(originalId);
			expect(manager.buildContextEntries().some((entry) => entry.type === "message")).toBe(false);

			manager.appendContextWindow("second window", 100);
			const detached = { ...admitted, executionDetached: true };
			manager.appendMessage(
				{ ...original, content: [detached, ...original.content.slice(1)], stopReason: "pending" },
				true,
			);
			manager.appendCompaction("summary", null, 100);
			manager = SessionManager.open(file);
			projection = manager.buildSessionProjection();
			expect(projection.messages.filter((message) => message.role === "assistant")).toMatchObject([
				{ content: [detached] },
			]);
			expect(projection.messages.some((message) => message.role === "toolResult")).toBe(false);

			const resultId = manager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "work",
				content: result.content,
				isError: false,
				timestamp: 2,
			});
			manager.appendCompaction("result retained", resultId, 100);
			manager = SessionManager.open(file);
			projection = manager.buildSessionProjection();
			expect(projection.messages.filter((message) => message.role === "assistant")).toMatchObject([
				{ content: [detached] },
			]);
			expect(projection.messages.filter((message) => message.role === "toolResult")).toMatchObject([
				{ toolCallId: call.id, content: result.content },
			]);
			manager.appendContextWindow("finished", 100);
			expect(
				SessionManager.open(file)
					.buildSessionProjection()
					.messages.map((message) => message.role),
			).toEqual(["custom"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reopens explicitly retained receipts with original provenance and honors later windows, compaction, and edits", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-native-retained-receipt-"));
		try {
			let manager = SessionManager.create(directory, directory);
			const call = { ...toolCall(), executionStarted: true, executionArguments: { path: "admitted" } };
			const original = assistant(call);
			original.content.push({ type: "text", text: "old response prose" });
			const callId = manager.appendMessage(original);
			const receipt = {
				role: "toolResult" as const,
				toolCallId: call.id,
				toolName: "work",
				content: result.content,
				isError: false,
				timestamp: 2,
			};
			const resultId = manager.appendMessage(receipt);
			manager.appendContextWindow("receipt arrived during handoff", 100, [resultId]);
			const file = manager.getSessionFile()!;
			manager = SessionManager.open(file);
			let projection = manager.buildSessionProjection();
			expect(projection.messages.filter((message) => message.role === "toolResult")).toEqual([receipt]);
			expect(projection.messages.filter((message) => message.role === "assistant")).toMatchObject([
				{ content: [call] },
			]);
			expect(projection.entries.slice(1).map((entry) => entry.sourceEntry.id)).toEqual([callId, resultId]);

			const secondWindow = manager.appendContextWindow("receipt still unconsumed", 100, [resultId]);
			manager = SessionManager.open(file);
			expect(manager.buildSessionProjection().messages.filter((message) => message.role === "toolResult")).toEqual([
				receipt,
			]);
			expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);

			manager.appendContextEdit(resultId, { content: [{ type: "text", text: "edited receipt" }] });
			expect(
				SessionManager.open(file)
					.buildSessionProjection()
					.messages.filter((message) => message.role === "toolResult"),
			).toMatchObject([{ content: [{ type: "text", text: "edited receipt" }] }]);
			for (const omittedId of [callId, resultId]) {
				manager.branch(secondWindow);
				manager.appendContextEdit(omittedId, null);
				expect(
					SessionManager.open(file)
						.buildSessionProjection()
						.messages.map((message) => message.role),
				).toEqual(["custom"]);
			}

			manager.branch(secondWindow);
			manager.appendCompaction("retain the receipt", resultId, 100);
			projection = SessionManager.open(file).buildSessionProjection();
			expect(projection.messages.filter((message) => message.role === "toolResult")).toEqual([receipt]);
			expect(projection.entries.slice(1).map((entry) => entry.sourceEntry.id)).toEqual([callId, resultId]);
			manager.appendCompaction("receipt summarized", null, 100);
			expect(
				SessionManager.open(file)
					.buildSessionProjection()
					.messages.map((message) => message.role),
			).toEqual(["compactionSummary"]);

			manager.branch(secondWindow);
			manager.appendContextWindow("receipt consumed", 100);
			expect(
				SessionManager.open(file)
					.buildSessionProjection()
					.messages.map((message) => message.role),
			).toEqual(["custom"]);
			manager.branch(callId);
			manager.appendContextWindow("other branch", 100, [resultId]);
			expect(
				SessionManager.open(file)
					.buildSessionProjection()
					.messages.filter((message) => message.role === "toolResult"),
			).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("carries a delayed result's call across compaction and windows, respecting branch-local context edits", () => {
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
		expect(messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(
			messages.some(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			),
		).toBe(false);
		manager.branch(callId);
		expect(manager.buildSessionProjection().messages).toHaveLength(1);
		manager.appendContextWindow("fresh", 100);
		expect(manager.buildSessionProjection().messages.filter((message) => message.role === "assistant")).toMatchObject(
			[{ content: [{ ...toolCall(), executionStarted: true }] }],
		);
		manager.appendContextEdit(callId, null);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call|fc_call",
			toolName: "work",
			content: result.content,
			isError: false,
			timestamp: 3,
		});
		expect(manager.buildSessionProjection().messages.some((message) => message.role === "assistant")).toBe(false);
		expect(manager.buildSessionProjection().messages.some((message) => message.role === "toolResult")).toBe(false);
	});
});

it.each(
	[
		{ executionStarted: false, resumeAvailable: false },
		{ executionStarted: true, resumeAvailable: true },
		{ executionStarted: true, resumeAvailable: false },
	].flatMap((admission) =>
		(["compaction", "context edit", "context window"] as const).map((omission) => ({ ...admission, omission })),
	),
)(
	"does not replay completed native calls after $omission omits their receipt (started=$executionStarted, resume=$resumeAvailable)",
	async ({ executionStarted, resumeAvailable, omission }) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-native-omitted-outcome-"));
		const manager = SessionManager.create(directory, directory);
		const execute = vi.fn<AgentTool["execute"]>(async () => result);
		const resume = vi.fn<NonNullable<AgentTool["resume"]>>(async () => result);
		const harness = await createHarness({
			sessionManager: manager,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({ path: Type.String() }),
					async: true,
					execute,
					resume: resumeAvailable ? resume : undefined,
				},
			],
		});
		const model: Model<"openai-responses"> = {
			...harness.getModel(),
			api: "openai-responses",
			compat: { supportsAsyncTools: true },
		};
		harness.session.agent.state.model = model;
		const completed = { ...toolCall("completed"), ...(executionStarted ? { executionStarted: true } : {}) };
		const completedShared = {
			...toolCall("completed-shared"),
			...(executionStarted ? { executionStarted: true } : {}),
		};
		const pending = toolCall("pending");
		const retained = toolCall("retained");
		const thinkingText = "OLD_REASONING_SUMMARY";
		const signedReasoning = {
			type: "reasoning",
			id: "rs_pending",
			summary: [{ type: "summary_text", text: thinkingText }],
		};
		const response: AssistantMessage = {
			...assistant(completed),
			api: model.api,
			provider: model.provider,
			model: model.id,
			responseId: "kept-response",
			content: [
				{ type: "text", text: "kept prose before" },
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_completed", summary: [] }),
				},
				completed,
				{
					type: "thinking",
					thinking: thinkingText,
					thinkingSignature: JSON.stringify(signedReasoning),
				},
				completedShared,
				pending,
				retained,
				{ type: "text", text: "kept prose after" },
			],
		};
		if (omission === "compaction") {
			manager.appendMessage(fauxAssistantMessage("old prose", { responseId: "old-response" }));
			manager.appendContextWindow("fresh", 100);
		}
		manager.appendMessage({ ...response, stopReason: "pending" }, true);
		const resultIds = [completed, completedShared].map((call) =>
			manager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "work",
				content: [{ type: "text", text: "OMITTED_RECEIPT" }],
				isError: false,
				timestamp: 1,
			}),
		);
		const anchorId =
			omission === "compaction"
				? manager.appendMessage(
						fauxAssistantMessage("", { responseId: "old-response", stopReason: "pending" }),
						true,
					)
				: undefined;
		manager.appendMessage(response);
		const retainedResultId = manager.appendMessage({
			role: "toolResult",
			toolCallId: retained.id,
			toolName: "work",
			content: [{ type: "text", text: "RETAINED_RECEIPT" }],
			isError: false,
			timestamp: 2,
		});
		manager.appendMessage({ role: "user", content: "kept tail", timestamp: 3 });
		if (anchorId) manager.appendCompaction("earlier outcomes summarized", anchorId, 100);
		else if (omission === "context window") manager.appendContextWindow("fresh", 100, [retainedResultId]);
		else for (const resultId of resultIds) manager.appendContextEdit(resultId, null);
		const file = manager.getSessionFile()!;
		const saved = readFileSync(file, "utf8");
		manager.setSessionFile(file);
		harness.session.refreshContext();
		const pendingBefore = harness.session.getPendingToolCalls();
		const wireInputs: ReturnType<typeof convertResponsesMessages>[] = [];
		const switchedInputs: ReturnType<typeof convertResponsesMessages>[] = [];
		harness.session.agent.streamFunction = (requestModel, context) => {
			wireInputs.push(convertResponsesMessages(requestModel, context, new Set([requestModel.provider])));
			switchedInputs.push(
				convertResponsesMessages({ ...requestModel, id: "other-model" }, context, new Set([requestModel.provider])),
			);
			const answer: AssistantMessage = {
				...fauxAssistantMessage("continued"),
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: answer });
			stream.push({ type: "done", reason: "stop", message: answer });
			stream.end();
			return stream;
		};
		try {
			await harness.session.prompt("continue without repeating completed work");
			expect(execute.mock.calls.map(([id]) => id)).toEqual([pending.id]);
			expect(resume).not.toHaveBeenCalled();
			expect(pendingBefore).toMatchObject([{ toolCallId: pending.id }]);
			expect(pendingBefore).toHaveLength(1);
			expect(harness.session.getPendingToolCalls()).toEqual([]);
			const wire = JSON.stringify(wireInputs);
			expect(wire).not.toContain('"call_id":"completed"');
			expect(wire).not.toContain('"call_id":"completed-shared"');
			expect(wire).not.toContain("rs_completed");
			expect(wire).not.toContain("OMITTED_RECEIPT");
			expect(wire).not.toContain("outcome is unknown");
			expect(wire).not.toContain("toolExecutionFailed");
			expect(wire).toContain('"call_id":"pending"');
			expect(wire).toContain("rs_pending");
			expect(wire).toContain('"call_id":"retained"');
			expect(wire).toContain("RETAINED_RECEIPT");
			expect(wire.includes("kept prose before")).toBe(omission !== "context window");
			expect(wire.includes("kept prose after")).toBe(omission !== "context window");
			const pendingIndex = wireInputs[0].findIndex(
				(item) => item.type === "function_call" && item.call_id === "pending",
			);
			expect(wireInputs[0][pendingIndex]).toEqual(pending.responsesItem);
			expect(wireInputs[0][pendingIndex - 1]).toEqual(signedReasoning);
			expect(JSON.stringify(switchedInputs).includes(thinkingText)).toBe(omission !== "context window");
			expect(JSON.stringify(harness.session.messages)).not.toContain("outcome is unknown");
			expect(readFileSync(file, "utf8").startsWith(saved)).toBe(true);
		} finally {
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

it.each(
	(["ordinary", "skipped", "background"] as const).flatMap((failure) =>
		(["compaction", "context window", "context edit"] as const).map((omission) => ({ failure, omission })),
	),
)("preserves a $failure failure's reset veto after $omission omits its receipt", async ({ failure, omission }) => {
	const execute = vi.fn<AgentTool["execute"]>(async () => result);
	const resume = vi.fn<NonNullable<AgentTool["resume"]>>(async () => ({
		...result,
		newContext: { handoff: "resumed reset" },
	}));
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		tools: [
			{
				name: "work",
				label: "Work",
				description: "Work",
				parameters: Type.Object({ path: Type.String() }),
				async: true,
				execute,
				resume,
			},
		],
	});
	harness.session.agent.state.model = {
		...harness.getModel(),
		api: "openai-responses",
		compat: { supportsAsyncTools: true },
	} as Model<"openai-responses">;
	const stream = harness.session.agent.streamFunction;
	const wireInputs: ReturnType<typeof convertResponsesMessages>[] = [];
	harness.session.agent.streamFunction = (model, context, options) => {
		wireInputs.push(convertResponsesMessages(model, context, new Set([model.provider])));
		return stream(harness.getModel(), context, options);
	};
	const reset = { ...toolCall("reset"), executionStarted: true };
	const failed = failure === "ordinary" ? { ...toolCall("failed"), async: false } : toolCall("failed");
	harness.sessionManager.appendMessage({ ...assistant(reset), content: [reset, failed] });
	const receiptId = harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: failed.id,
		toolName: "work",
		content: [{ type: "text", text: "omitted failure" }],
		isError: true,
		...(failure === "skipped" ? { executionSkipped: true } : {}),
		timestamp: 2,
	});
	if (omission === "compaction") harness.sessionManager.appendCompaction("outcomes summarized", null, 100);
	else if (omission === "context window") harness.sessionManager.appendContextWindow("fresh", 100);
	else harness.sessionManager.appendContextEdit(receiptId, null);
	harness.session.refreshContext();
	harness.setResponses([fauxAssistantMessage("continued"), fauxAssistantMessage("continued after reset")]);
	try {
		await harness.session.prompt("resume pending work");
		expect(execute).not.toHaveBeenCalled();
		expect(resume).toHaveBeenCalledOnce();
		expect(harness.eventsOfType("context_window_started")).toHaveLength(failure === "background" ? 1 : 0);
		expect(harness.session.getPendingToolCalls()).toEqual([]);
		expect(JSON.stringify(wireInputs)).not.toContain("toolExecutionFailed");
	} finally {
		harness.cleanup();
	}
});

it.each(["stop", "error"] as const)(
	"starts an explicit fresh window and preserves the late native result until a successful response (%s)",
	async (outcome) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const executing = new Promise<void>((resolve) => {
			started = resolve;
		});
		let workSignal: AbortSignal | undefined;
		const execute = vi.fn<AgentTool["execute"]>(async (_id, _args, signal) => {
			workSignal = signal;
			started();
			await gate;
			return result;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 600_000 }],
			settings: {
				compaction: { enabled: false },
				retry: { enabled: false },
			},
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({ path: Type.String() }),
					async: true,
					execute,
				},
				{
					name: "reset",
					label: "Reset",
					description: "Start a fresh context",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: undefined, newContext: { handoff: "continue work" } }),
				},
			],
		});
		harness.session.agent.state.model = {
			...harness.getModel(),
			api: "openai-responses",
			compat: { supportsAsyncTools: true },
		} as Model<"openai-responses">;
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && event.message.responseId === "first")
				harness.session.agent.steer({ role: "user", content: "queued input", timestamp: Date.now() });
		});
		const requests: Array<unknown[]> = [];
		harness.session.agent.streamFunction = (model, context) => {
			requests.push(structuredClone(context.messages));
			const first = requests.length === 1;
			const stopReason = first ? "toolUse" : requests.length === 3 ? outcome : "stop";
			const message: AssistantMessage = {
				...fauxAssistantMessage(
					first
						? [
								{ type: "text", text: "old response prose" },
								toolCall(),
								{ type: "toolCall", id: "reset", name: "reset", arguments: {} },
							]
						: "new window answer",
					{ responseId: first ? "first" : `response-${requests.length}`, stopReason },
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
				errorMessage: stopReason === "error" ? "provider failed" : undefined,
			};
			message.usage = { ...message.usage, input: 100, totalTokens: 100 };
			const stream = createAssistantMessageEventStream();
			void (async () => {
				stream.push({ type: "start", partial: message });
				if (first) {
					stream.push({ type: "toolcall_end", partial: message, toolCall: toolCall(), contentIndex: 1 });
					await executing;
				}
				if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: stopReason, message });
				stream.end();
			})();
			return stream;
		};
		const run = harness.session.prompt("old user input");
		try {
			await vi.waitFor(() => expect(requests).toHaveLength(2));
			expect(harness.eventsOfType("context_window_started")).toHaveLength(1);
			expect(harness.session.getPendingToolCalls()).toMatchObject([{ toolCallId: toolCall().id }]);
			expect(workSignal?.aborted).toBe(false);
			expect(requests[1]).toContainEqual(expect.objectContaining({ role: "user", content: "queued input" }));
			expect(requests[1]).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					content: [expect.objectContaining({ id: toolCall().id, responsesItem: toolCall().responsesItem })],
				}),
			);
			expect(JSON.stringify(requests[1])).not.toContain("old response prose");
			expect(JSON.stringify(requests[1])).not.toContain("old user input");
			release();
			await run;
			expect(execute).toHaveBeenCalledOnce();
			expect(requests).toHaveLength(3);
			expect(requests[2]).toContainEqual(
				expect.objectContaining({
					role: "toolResult",
					toolCallId: toolCall().id,
					content: result.content,
					isError: false,
				}),
			);
			expect(
				harness.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === toolCall().id,
					),
			).toHaveLength(1);
			expect(harness.session.getPendingToolCalls()).toEqual([]);
			harness.session.newContext({ handoff: "next task" });
			expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(
				outcome === "error" ? 1 : 0,
			);
		} finally {
			release();
			await run;
			harness.cleanup();
		}
	},
);

it("uses the last successful prefix after a failed response without dropping a newly completed result", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let resultWritten!: () => void;
	const completed = new Promise<void>((resolve) => {
		resultWritten = resolve;
	});
	const consumedCall = toolCall("consumed");
	const lateCall = toolCall("late");
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		tools: [
			{
				name: "work",
				label: "Work",
				description: "Work",
				parameters: Type.Object({ path: Type.String() }),
				async: true,
				execute: async () => {
					await gate;
					return result;
				},
			},
		],
	});
	harness.session.agent.state.model = {
		...harness.getModel(),
		api: "openai-responses",
		compat: { supportsAsyncTools: true },
	} as Model<"openai-responses">;
	harness.sessionManager.appendMessage(assistant(consumedCall));
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: consumedCall.id,
		toolName: "work",
		content: result.content,
		isError: false,
		timestamp: 1,
	});
	harness.session.refreshContext();
	harness.session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			event.message.role === "toolResult" &&
			event.message.toolCallId === lateCall.id
		)
			resultWritten();
	});
	const finishTurn = harness.session.agent.finishTurn;
	harness.session.agent.finishTurn = async (turn, signal) => {
		await finishTurn?.(turn, signal);
		if (turn.message.responseId === "success") return { action: "continue" };
		if (turn.message.responseId === "failed") harness.session.newContext({ handoff: "continue with the new result" });
		return undefined;
	};
	const inputs: Array<unknown[]> = [];
	harness.session.agent.streamFunction = (model, context) => {
		inputs.push(structuredClone(context.messages));
		const request = inputs.length;
		const stopReason = request === 1 ? "toolUse" : request === 2 ? "error" : "stop";
		const message: AssistantMessage = {
			...fauxAssistantMessage(request === 1 ? [lateCall] : "answer", {
				responseId: request === 1 ? "success" : request === 2 ? "failed" : "fresh",
				stopReason,
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			errorMessage: request === 2 ? "response failed" : undefined,
		};
		message.usage = { ...message.usage, input: 100, totalTokens: 100 };
		const stream = createAssistantMessageEventStream();
		void (async () => {
			stream.push({ type: "start", partial: message });
			if (request === 1)
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: lateCall, partial: message });
			if (request === 2) {
				release();
				await completed;
				// Failed native steering continues in a new request, before agent_end clears the failed prefix.
				stream.push({
					type: "steering",
					message: { role: "user", content: "continue", timestamp: 2 },
					status: "failed",
				});
				stream.push({ type: "error", reason: "error", error: message });
			} else stream.push({ type: "done", reason: request === 1 ? "toolUse" : "stop", message });
			stream.end();
		})();
		return stream;
	};
	try {
		await harness.session.prompt("consume the old result and start new work");
		expect(inputs).toHaveLength(3);
		expect(inputs[0]).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: consumedCall.id }));
		expect(inputs[1]).not.toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: lateCall.id }));
		expect(harness.eventsOfType("context_window_started")).toHaveLength(1);
		expect(inputs[2]).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: lateCall.id, content: result.content }),
		);
		expect(inputs[2]).not.toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: consumedCall.id }),
		);
	} finally {
		release();
		harness.cleanup();
	}
});

it.each(["reopen", "compact", "navigation", "fork", "continuation", "failed continuation"] as const)(
	"remembers consumed receipts after %s without discarding filtered or late receipts",
	async (boundary) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-native-consumed-"));
		const manager = SessionManager.create(directory, directory);
		const consumed = toolCall("consumed");
		const filtered = toolCall("filtered");
		const late = toolCall("late");
		const original = assistant(consumed);
		original.content.push(filtered, late);
		manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		manager.appendMessage(original);
		let consumedId = "";
		for (const call of [consumed, filtered]) {
			const id = manager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: result.content,
				isError: false,
				timestamp: 2,
			});
			if (call === consumed) consumedId = id;
		}
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let persisted!: () => void;
		const receiptPersisted = new Promise<void>((resolve) => {
			persisted = resolve;
		});
		const execute = vi.fn(async () => {
			await gate;
			return result;
		});
		const harness = await createHarness({
			sessionManager: manager,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({ path: Type.String() }),
					async: true,
					execute,
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: event.messages.filter(
							(message) => message.role !== "toolResult" || message.toolCallId !== filtered.id,
						),
					}));
					pi.on("session_before_compact", () => ({
						compaction: { summary: "summary", firstKeptEntryId: consumedId, tokensBefore: 100 },
					}));
				},
			],
		});
		harness.session.refreshContext();
		harness.session.agent.state.model = {
			...harness.getModel(),
			api: "openai-responses",
			compat: { supportsAsyncTools: true },
		} as Model<"openai-responses">;
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "toolResult") persisted();
		});
		harness.session.agent.finishTurn = () => ({ action: "end" });
		harness.session.agent.streamFunction = (model, context) => {
			expect(context.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: consumed.id }),
			);
			expect(context.messages).not.toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: filtered.id }),
			);
			expect(context.messages).not.toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: late.id }),
			);
			const response = {
				...fauxAssistantMessage("completed without the late receipt", { responseId: "successful" }),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			const stream = createAssistantMessageEventStream();
			void (async () => {
				stream.push({ type: "start", partial: response });
				release();
				await receiptPersisted;
				if (boundary === "continuation" || boundary === "failed continuation") {
					stream.push({ type: "response_end", message: response });
					const successor = { ...response, responseId: "successor" };
					const receipt = manager
						.getBranch()
						.reverse()
						.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
					if (receipt?.type !== "message" || receipt.message.role !== "toolResult")
						throw new Error("late receipt was not persisted");
					stream.push({ type: "start", partial: successor, continuationInput: [receipt.message] });
					if (boundary === "failed continuation") {
						successor.stopReason = "error";
						successor.errorMessage = "successor failed";
						stream.push({ type: "error", reason: "error", error: successor });
					} else stream.push({ type: "done", reason: "stop", message: successor });
				} else stream.push({ type: "done", reason: "stop", message: response });
				stream.end();
			})();
			return stream;
		};
		let restored: Awaited<ReturnType<typeof createHarness>> | undefined;
		try {
			await harness.session.prompt("consume only the provided receipt");
			expect(execute).toHaveBeenCalledOnce();
			const leafId = manager.getLeafId()!;
			let session = harness.session;
			if (boundary === "compact") await session.compact();
			else if (boundary === "navigation") {
				await session.navigateTree(consumedId);
				session.newContext();
				expect(session.messages).toContainEqual(
					expect.objectContaining({ role: "toolResult", toolCallId: consumed.id }),
				);
				await session.navigateTree(leafId);
			} else {
				const file = boundary === "fork" ? manager.createBranchedSession(leafId)! : manager.getSessionFile()!;
				restored = await createHarness({ sessionManager: SessionManager.open(file) });
				session = restored.session;
			}
			session.newContext();
			expect(
				session.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
			).toEqual(boundary === "continuation" ? [filtered.id] : [filtered.id, late.id]);
		} finally {
			release();
			restored?.cleanup();
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

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
		harness.session.newContext({ handoff: "resume the detached work" });
		expect(harness.eventsOfType("context_window_started")).toHaveLength(1);
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

it.each([
	{ stopReason: "error", blocked: false },
	{ stopReason: "error", blocked: true },
	{ stopReason: "length", blocked: false },
	{ stopReason: "length", blocked: true },
] as const)(
	"keeps native admission and its result during $stopReason recovery (blocked=$blocked)",
	async ({ stopReason, blocked }) => {
		let releasePreflight!: () => void;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		const preflight = vi.fn(async () => {
			await preflightGate;
			return blocked ? { block: true, reason: "blocked before execution", terminate: true } : undefined;
		});
		const execute = vi.fn<AgentTool["execute"]>(async () => ({ ...result, terminate: true }));
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: {
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
			},
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({ path: Type.String() }),
					async: true,
					execute,
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", preflight);
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		const originalStream = harness.session.agent.streamFunction;
		let resultWritten!: () => void;
		const completedTool = new Promise<void>((resolve) => {
			resultWritten = resolve;
		});
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "toolResult") resultWritten();
		});
		harness.session.agent.state.model = {
			...harness.getModel(),
			api: "openai-responses",
			compat: { supportsAsyncTools: true },
		} as Model<"openai-responses">;
		harness.session.agent.streamFunction = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const source = await originalStream(harness.getModel(), context, options);
				for await (const event of source) {
					if (event.type === "done" || event.type === "error") await completedTool;
					const copy = structuredClone(event);
					if ("partial" in copy) copy.partial.api = model.api;
					if ("message" in copy && copy.message.role === "assistant") copy.message.api = model.api;
					if ("error" in copy) copy.error.api = model.api;
					stream.push(copy);
				}
				stream.end();
			})();
			return stream;
		};
		let recoveredMessages: unknown[] = [];
		const beforeCall = {
			type: "thinking" as const,
			thinking: "before call",
			thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_call", summary: [] }),
		};
		const dangling = {
			...beforeCall,
			thinking: "before unfinished answer",
			thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_answer", summary: [] }),
		};
		harness.setResponses([
			{
				...assistant(),
				content: [beforeCall, toolCall(), dangling, { type: "text", text: "unfinished answer" }],
				stopReason,
				errorMessage: stopReason === "error" ? "terminated" : undefined,
			},
			(context) => {
				recoveredMessages = structuredClone(context.messages);
				return fauxAssistantMessage("recovered");
			},
		]);
		const run = harness.session.prompt("x".repeat(5000));
		try {
			await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce());
			expect(execute).not.toHaveBeenCalled();
			expect(harness.session.getPendingToolCalls()).toMatchObject([{ toolCallId: toolCall().id, state: "pending" }]);
			expect(harness.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({
					type: "message",
					checkpoint: true,
					message: expect.objectContaining({ content: expect.arrayContaining([toolCall()]) }),
				}),
			);
			releasePreflight();
			await run;

			expect(harness.faux.state.callCount).toBe(2);
			expect(preflight).toHaveBeenCalledOnce();
			expect(execute).toHaveBeenCalledTimes(blocked ? 0 : 1);
			expect(harness.session.getPendingToolCalls()).toEqual([]);
			const recoveredCall = {
				...toolCall(),
				...(blocked
					? {}
					: {
							executionStarted: true,
							executionArguments: { path: "original" },
							executionDetached: false,
						}),
			};
			expect(recoveredMessages).toContainEqual(
				expect.objectContaining({ role: "assistant", content: [beforeCall, recoveredCall] }),
			);
			const projection = harness.sessionManager.buildSessionProjection().messages;
			expect(projection).toContainEqual(
				expect.objectContaining({ role: "assistant", content: [beforeCall, recoveredCall] }),
			);
			expect(harness.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ stopReason, content: expect.arrayContaining([dangling]) }),
				}),
			);
			const toolResults = projection.filter((message) => message.role === "toolResult");
			expect(toolResults).toMatchObject([
				{
					toolCallId: toolCall().id,
					content: blocked ? [{ type: "text", text: "blocked before execution" }] : result.content,
					isError: blocked,
				},
			]);
			expect(recoveredMessages).toContainEqual(toolResults[0]);
			expect(harness.session.getLastAssistantText()).toBe("recovered");
		} finally {
			releasePreflight();
			await run;
			harness.cleanup();
		}
	},
);

it.each([false, true])(
	"preserves an earlier async result during length recovery (selected truncated call=%s)",
	async (truncatedCall) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let resultWritten!: () => void;
		const completedTool = new Promise<void>((resolve) => {
			resultWritten = resolve;
		});
		const execute = vi.fn<AgentTool["execute"]>(async () => {
			await gate;
			return { ...result, terminate: true };
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: {
				retry: { enabled: false },
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
			},
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({ path: Type.String() }),
					async: true,
					execute,
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.session.agent.state.model = {
			...harness.getModel(),
			api: "openai-responses",
			compat: { supportsAsyncTools: true },
		} as Model<"openai-responses">;
		const finishTurn = harness.session.agent.finishTurn;
		harness.session.agent.finishTurn = async (turn, signal) => {
			const decision = await finishTurn?.(turn, signal);
			return turn.message.stopReason === "length" ? { action: "end" } : (decision ?? undefined);
		};
		harness.session.subscribe((event) => {
			if (event.type !== "message_end") return;
			if (event.message.role === "toolResult" && event.message.toolCallId === toolCall().id) resultWritten();
			if (event.message.role === "assistant" && event.message.responseId === "first")
				harness.session.agent.steer({ role: "user", content: "keep going", timestamp: Date.now() });
		});
		let requests = 0;
		let recoveredMessages: unknown[] = [];
		harness.session.agent.streamFunction = (model, context) => {
			const request = ++requests;
			if (request === 3) recoveredMessages = structuredClone(context.messages);
			const stream = createAssistantMessageEventStream();
			const call = toolCall();
			const stopReason = request === 1 ? "toolUse" : request === 2 ? "length" : "stop";
			const message: AssistantMessage = {
				...fauxAssistantMessage(
					request === 1
						? [call]
						: request === 2 && truncatedCall
							? [{ type: "toolCall", id: "truncated", name: "work", arguments: { path: "partial" } }]
							: "answer",
					{ responseId: request === 1 ? "first" : `response-${request}`, stopReason },
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			void (async () => {
				stream.push({ type: "start", partial: message });
				if (request === 1) stream.push({ type: "toolcall_end", partial: message, toolCall: call, contentIndex: 0 });
				if (request === 2) {
					release();
					await completedTool;
				}
				stream.push({ type: "done", reason: stopReason, message });
				stream.end();
			})();
			return stream;
		};
		try {
			await harness.session.prompt("x".repeat(5000));

			const entries = harness.sessionManager.getEntries();
			const lateResult = entries.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === toolCall().id,
			);
			expect(lateResult).toMatchObject({ message: { content: result.content, isError: false } });
			const omittedIds = entries.flatMap((entry) =>
				entry.type === "context_edit" && entry.replacement === null ? [entry.targetId] : [],
			);
			expect(omittedIds).not.toContain(lateResult?.id);
			const projectedResults = harness.sessionManager
				.buildSessionProjection()
				.messages.filter((message) => message.role === "toolResult");
			expect(projectedResults).toMatchObject([
				{ toolCallId: toolCall().id, content: result.content, isError: false },
			]);
			expect(recoveredMessages).toContainEqual(projectedResults[0]);
			expect(harness.session.getPendingToolCalls()).toEqual([]);
			expect(execute).toHaveBeenCalledOnce();
			expect(requests).toBe(3);
			if (truncatedCall) {
				const truncatedResult = entries.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "truncated",
				);
				expect(truncatedResult).toMatchObject({ message: { isError: true } });
				expect(omittedIds).toContain(truncatedResult?.id);
			}
		} finally {
			release();
			harness.cleanup();
		}
	},
);
