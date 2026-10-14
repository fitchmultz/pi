import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateProjectedContextTokens,
	prepareCompaction,
} from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function text(message: { content: string | Array<{ type: string; text?: string }> }): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

describe("session context edits", () => {
	it.each([false, true])("keeps returned arrays and derived messages defensive (compacted=%s)", (compacted) => {
		const session = SessionManager.inMemory();
		const customId = session.appendCustomMessageEntry("context", "canonical", false);
		const modelId = session.appendModelChange("faux", "selected");
		const compactionId = compacted ? session.appendCompaction("summary", customId, 100) : undefined;
		const branchIds = compactionId ? [customId, modelId, compactionId] : [customId, modelId];
		const contextIds = compactionId ? [compactionId, customId, modelId] : [customId, modelId];

		session.getBranch().reverse();
		session.getBranch(session.getLeafId()!).splice(0);
		session.buildContextEntries().splice(0);
		const projection = session.buildSessionProjection();
		const custom = projection.messages.find((message) => message.role === "custom");
		if (!custom || !projection.model) throw new Error("missing projected context");
		custom.content = "caller mutation";
		projection.model.modelId = "caller mutation";
		for (const entry of projection.entries) entry.messages.splice(0);
		projection.entries.splice(0);
		projection.messages.splice(0);

		expect(session.getBranch().map((entry) => entry.id)).toEqual(branchIds);
		expect(session.buildContextEntries().map((entry) => entry.id)).toEqual(contextIds);
		const fresh = session.buildSessionProjection();
		expect(fresh.entries.map((entry) => entry.sourceEntry.id)).toEqual(contextIds);
		expect(fresh.messages).toEqual([
			...(compacted ? [expect.objectContaining({ role: "compactionSummary", summary: "summary" })] : []),
			expect.objectContaining({ role: "custom", content: "canonical" }),
		]);
		expect(fresh.model).toEqual({ provider: "faux", modelId: "selected" });
	});

	it("omits a target only from model projection", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const assistantId = session.appendMessage(assistant("partial"));
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "raw output" }],
			details: { path: "large.txt" },
			isError: true,
			timestamp: Date.now(),
		};
		const resultId = session.appendMessage(result);
		session.appendContextEdit(assistantId, null);
		session.appendContextEdit(resultId, null);

		expect(session.getBranch().filter((entry) => entry.type === "message")).toHaveLength(3);
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual(["user"]);
		expect((session.getEntry(resultId) as { message: ToolResultMessage }).message).toBe(result);
	});

	it("replaces only content and lets the latest edit win", () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendMessage(assistant("original"));
		expect(session.buildSessionProjection().messages[0]).toMatchObject({
			content: [{ type: "text", text: "original" }],
		});
		session.appendContextEdit(targetId, { content: [{ type: "text", text: "first" }] });
		expect(session.buildSessionProjection().messages[0]).toMatchObject({
			content: [{ type: "text", text: "first" }],
		});
		session.appendContextEdit(targetId, null);
		expect(session.buildSessionProjection().messages).toEqual([]);
		session.appendContextEdit(targetId, { content: [{ type: "text", text: "restored" }] });

		const projected = session.buildSessionProjection().messages[0];
		expect(projected.role).toBe("assistant");
		if (projected.role !== "assistant") throw new Error("expected assistant");
		expect(text(projected)).toBe("restored");
		expect(projected.usage.totalTokens).toBe(11);
		expect(text((session.getEntry(targetId) as { message: AssistantMessage }).message)).toBe("original");
	});

	it("normalizes string replacements for array-only assistant and tool-result roles", () => {
		const session = SessionManager.inMemory();
		const assistantId = session.appendMessage(assistant("original"));
		const resultId = session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "original result" }],
			isError: false,
			timestamp: Date.now(),
		});
		const assistantEditId = session.appendContextEdit(assistantId, { content: "assistant replacement" });
		const resultEditId = session.appendContextEdit(resultId, { content: "result replacement" });

		expect(session.getEntry(assistantEditId)).toMatchObject({
			replacement: { content: [{ type: "text", text: "assistant replacement" }] },
		});
		expect(session.getEntry(resultEditId)).toMatchObject({
			replacement: { content: [{ type: "text", text: "result replacement" }] },
		});
		const projected = session.buildSessionProjection().messages;
		expect(projected[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "assistant replacement" }],
		});
		expect(projected[1]).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "result replacement" }],
		});
	});

	it("normalizes imported string replacements while projecting array-only roles", () => {
		const session = SessionManager.inMemory();
		const assistantId = session.appendMessage(assistant("original"));
		const editId = session.appendContextEdit(assistantId, null);
		const edit = session.getEntry(editId);
		if (edit?.type !== "context_edit") throw new Error("expected context edit");
		edit.replacement = { content: "imported replacement" };

		expect(session.buildSessionProjection().messages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "imported replacement" }],
		});
	});

	it("keeps edits branch-relative", () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		session.appendContextEdit(targetId, { content: "edited" });
		expect(text(session.buildSessionProjection().messages[0] as { content: string })).toBe("edited");

		session.branch(targetId);
		expect(text(session.buildSessionProjection().messages[0] as { content: string })).toBe("original");
	});

	it("uses a self-referencing compaction to retain no preceding entries", () => {
		const session = SessionManager.inMemory();
		session.appendModelChange("faux", "selected");
		session.appendThinkingLevelChange("high");
		session.appendMessage({ role: "user", content: "discarded", timestamp: Date.now() });
		const compactionId = session.appendCompaction("exact handoff", null, 100);
		session.appendMessage({ role: "user", content: "after", timestamp: Date.now() });

		const compaction = session.getEntry(compactionId);
		expect(compaction).toMatchObject({ type: "compaction", firstKeptEntryId: compactionId });
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
		]);
		expect(session.buildSessionContext()).toMatchObject({
			model: { provider: "faux", modelId: "selected" },
			thinkingLevel: "high",
		});
		expect(
			session
				.buildSessionProjection()
				.messages.map((message) => ("summary" in message ? message.summary : text(message as { content: string }))),
		).toEqual(["exact handoff", "after"]);
	});

	it("applies post-compaction edits to retained pre-compaction entries", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "summarized", timestamp: Date.now() });
		const retainedId = session.appendMessage({ role: "user", content: "original retained", timestamp: Date.now() });
		session.appendCompaction("summary", retainedId, 100);
		expect(session.buildSessionProjection().messages).toEqual([
			expect.objectContaining({ role: "compactionSummary", summary: "summary" }),
			expect.objectContaining({ role: "user", content: "original retained" }),
		]);
		session.appendContextEdit(retainedId, { content: "edited retained" });

		expect(
			session
				.buildSessionProjection()
				.messages.map((message) => ("summary" in message ? message.summary : text(message as { content: string }))),
		).toEqual(["summary", "edited retained"]);
	});

	it("uses only the newest summary when a repeated compaction retains entries before the older compaction", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "summarized first", timestamp: Date.now() });
		const retainedId = session.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
		session.appendCompaction("first summary", retainedId, 100);
		session.appendMessage(assistant("after first compaction"));
		session.appendCompaction("second summary", retainedId, 80);
		session.appendMessage({ role: "user", content: "new tail ".repeat(100), timestamp: Date.now() });

		const summaries = session
			.buildSessionProjection()
			.messages.flatMap((message) => ("summary" in message ? [message.summary] : []));
		expect(summaries).toEqual(["second summary"]);
		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.previousSummary).toBe("second summary");
	});

	it("supports repeated retain-none compactions", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "discarded", timestamp: Date.now() });
		session.appendCompaction("first handoff", null, 100);
		session.appendMessage({ role: "user", content: "also discarded", timestamp: Date.now() });
		const secondId = session.appendCompaction("second handoff", null, 50);

		expect(session.getEntry(secondId)).toMatchObject({ firstKeptEntryId: secondId });
		expect(
			session.buildSessionProjection().messages.map((message) => ("summary" in message ? message.summary : "")),
		).toEqual(["second handoff"]);
	});

	it("does not trust pre-edit assistant usage for projected context estimates", () => {
		const session = SessionManager.inMemory();
		const largeUserId = session.appendMessage({
			role: "user",
			content: "discarded input ".repeat(2_000),
			timestamp: Date.now(),
		});
		const response = assistant("small answer");
		response.usage = { ...response.usage, input: 10_000, totalTokens: 10_001 };
		const assistantId = session.appendMessage(response);
		session.appendContextEdit(largeUserId, null);

		const editedEstimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(editedEstimate.usageTokens).toBe(0);
		expect(editedEstimate.tokens).toBeLessThan(100);

		session.appendContextEdit(assistantId, null);
		expect(estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens).toBe(0);
	});

	it("uses recent assistant usage without rereading compacted ancestry", () => {
		const session = SessionManager.inMemory();
		const archivedEntries = 1_000;
		for (let i = 0; i < archivedEntries; i++) {
			session.appendMessage({ role: "user", content: "archived input", timestamp: i });
		}
		session.appendCompaction("previous work", null, 10_000);
		const userId = session.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		session.appendContextEdit(userId, { content: "edited" });
		const response = assistant("answer");
		response.usage = { ...response.usage, input: 4_000, output: 100, totalTokens: 4_100 };
		session.appendMessage(response);
		session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		let archivedReads = 0;
		const branch = new Proxy(session.getBranch(), {
			get(target, key, receiver) {
				const index = typeof key === "string" ? Number(key) : Number.NaN;
				if (Number.isInteger(index) && index >= 0 && index < archivedEntries) archivedReads++;
				return Reflect.get(target, key, receiver);
			},
		});
		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), branch);
		expect(estimate.usageTokens).toBe(4_100);
		expect(estimate.trailingTokens).toBe(1);
		expect(estimate.tokens).toBe(4_101);
		expect(archivedReads).toBe(0);
	});

	// Regression for upstream #10287: recovery omissions must not replace valid usage with a raw estimate.
	it.each([
		{ chars: 320_000, usage: 50_000 },
		{ chars: 400_000, usage: 50_000 },
		{ chars: 20_000, usage: 78_000 },
	])("preserves usage across repeated retry omissions ($chars chars, $usage tokens)", ({ chars, usage }) => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "a".repeat(chars), timestamp: Date.now() });
		const response = assistant("anchor");
		response.usage = { ...response.usage, input: usage, totalTokens: usage + 1 };
		session.appendMessage(response);
		session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		for (let attempt = 0; attempt < 2; attempt++) {
			const failedId = session.appendMessage({ ...assistant("partial"), stopReason: "error" });
			const resultId = session.appendMessage({
				role: "toolResult",
				toolCallId: `call-${attempt}`,
				toolName: "read",
				content: [{ type: "text", text: "unused tool output" }],
				isError: false,
				timestamp: Date.now(),
			});
			session.appendContextEdit(failedId, null);
			session.appendContextEdit(resultId, null);
			const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
			expect(estimate).toMatchObject({ tokens: usage + 2, usageTokens: usage + 1, trailingTokens: 1 });
		}
	});

	it.each(["prefix", "anchor", "suffix"] as const)("invalidates usage for a %s replacement", (target) => {
		const session = SessionManager.inMemory();
		const prefix = session.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		const anchor = session.appendMessage(assistant("answer"));
		const suffix = session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		session.appendContextEdit({ prefix, anchor, suffix }[target], { content: "replacement" });
		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.usageTokens).toBe(0);
		expect(estimate.tokens).toBe(target === "anchor" ? 5 : 6);
	});

	// Regression for upstream #9409: replayed reasoning must consume the retention budget.
	it.each(["thinking", "toolCall"] as const)("counts %s signatures in estimates and compaction cuts", (type) => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		const response = assistant("");
		response.usage = { ...response.usage, input: 0, output: 0, totalTokens: 0 };
		const signature = "s".repeat(400_000);
		response.content =
			type === "thinking"
				? [{ type, thinking: "", thinkingSignature: signature }]
				: [{ type, id: "call-1", name: "read", arguments: {}, thoughtSignature: signature }];
		const signedId = session.appendMessage(response);
		session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.tokens).toBe(type === "thinking" ? 100_002 : 100_004);
		const preparation = prepareCompaction(session.getBranch(), DEFAULT_COMPACTION_SETTINGS);
		expect(preparation?.firstKeptEntryId).toBe(signedId);
		expect(preparation?.tokensBefore).toBe(estimate.tokens);
	});

	it("does not reuse post-edit assistant usage after a later compaction", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({ role: "user", content: "small input", timestamp: Date.now() });
		session.appendContextEdit(userId, { content: "edited input" });
		const response = assistant("answer");
		response.usage = { ...response.usage, input: 50_000, output: 1, totalTokens: 50_001 };
		session.appendMessage(response);
		session.appendCompaction("small summary", userId, 50_001);

		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.usageTokens).toBe(0);
		expect(estimate.tokens).toBeLessThan(100);
	});

	it("includes effective system and tool context in edited estimates", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "system",
			content: "system prompt ".repeat(3_000),
			toolsAdded: [
				{
					name: "example",
					description: "tool declaration ".repeat(100),
					parameters: { type: "object", properties: {} },
				},
			],
			timestamp: Date.now(),
		});
		const userId = session.appendMessage({ role: "user", content: "ask", timestamp: Date.now() });
		session.appendMessage(assistant("done"));
		session.appendContextEdit(userId, { content: "ask" });

		expect(
			estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens,
		).toBeGreaterThan(10_000);
	});

	it("does not advance past a boundary replacement of the candidate input", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
		session.appendMessage(assistant("old answer"));
		const replacedUserId = session.appendMessage({
			role: "user",
			content: "original input",
			timestamp: Date.now(),
		});
		const assistantId = session.appendMessage(assistant("answered original input"));
		session.appendContextEdit(replacedUserId, { content: "NEW-INSTRUCTION ".repeat(100) });
		session.appendContextEdit(assistantId, null);
		session.appendCustomEntry("bookkeeping", { source: "test" });

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.firstKeptEntryId).toBe(replacedUserId);
		expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("NEW-INSTRUCTION");
		expect(JSON.stringify(preparation?.turnPrefixMessages)).not.toContain("NEW-INSTRUCTION");
	});

	it("does not let metadata move the cut past unsent boundary input", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "old request", timestamp: Date.now() });
		session.appendMessage(assistant("old answer"));
		const instructionId = session.appendCustomMessageEntry("next-work", "UNSENT-INSTRUCTION ".repeat(100), false);
		session.appendCustomEntry("bookkeeping", { source: "test" });

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.firstKeptEntryId).toBe(instructionId);
		expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("UNSENT-INSTRUCTION");
		expect(JSON.stringify(preparation?.turnPrefixMessages)).not.toContain("UNSENT-INSTRUCTION");
	});

	it("does not treat an omitted custom message as a recovery attempt", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "user",
			content: "unanswered input ".repeat(100),
			timestamp: Date.now(),
		});
		const customId = session.appendCustomMessageEntry("temporary", "temporary context", false);
		session.appendContextEdit(customId, null);

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation).toBeUndefined();
	});

	it("advances past input for an omitted assistant recovery suffix with metadata", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage({
			role: "user",
			content: "recovery input ".repeat(100),
			timestamp: Date.now(),
		});
		const attemptId = session.appendMessage(assistant("failed attempt"));
		session.appendContextEdit(attemptId, null);
		session.appendCustomEntry("bookkeeping", { source: "test" });

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.firstKeptEntryId).toBe(attemptId);
		expect(preparation?.turnPrefixMessages).toEqual([
			expect.objectContaining({ role: "user", content: expect.stringContaining("recovery input") }),
		]);
		expect(preparation?.messagesToSummarize).not.toContainEqual(
			expect.objectContaining({ role: "user", content: expect.stringContaining("recovery input") }),
		);
		expect(userId).not.toBe(attemptId);
	});

	it("prepares compaction from edited model content", () => {
		const session = SessionManager.inMemory();
		const omittedId = session.appendMessage({ role: "user", content: "OMIT-ME ".repeat(100), timestamp: Date.now() });
		session.appendMessage(assistant("old answer ".repeat(100)));
		session.appendContextEdit(omittedId, null);
		session.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });
		session.appendMessage(assistant("suffix"));

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation).toBeDefined();
		expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("OMIT-ME");
		expect(JSON.stringify(preparation?.turnPrefixMessages)).not.toContain("OMIT-ME");
	});
});
