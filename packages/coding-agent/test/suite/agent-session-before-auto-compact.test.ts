import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const OVERFLOW = "prompt is too long: 300000 tokens > 128000 maximum";

function overflowResponse() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
}

function claimRollover(seen: Array<{ reason: string; willRetry: boolean }> = []) {
	return (pi: ExtensionAPI) => {
		pi.on("session_before_auto_compact", (event) => {
			seen.push({ reason: event.reason, willRetry: event.willRetry });
			return { newContext: { handoff: `handoff after ${event.reason}` } };
		});
	};
}

function entryTypes(harness: Harness): string[] {
	return harness.sessionManager.getBranch().map((entry) => entry.type);
}

function countType(harness: Harness, type: string): number {
	return entryTypes(harness).filter((t) => t === type).length;
}

function forbidSummarizationAuth(harness: Harness): void {
	(harness.session as unknown as { _getSummarizationRequestAuth: () => Promise<never> })._getSummarizationRequestAuth =
		async () => {
			throw new Error("summarization auth must not be resolved for a claimed rollover");
		};
}

function runAutoCompaction(harness: Harness) {
	return (
		harness.session as unknown as {
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		}
	)._runAutoCompaction.bind(harness.session);
}

describe("session_before_auto_compact", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rolls over a single oversized first owner turn without summarization auth", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		const harness = await createHarness({ extensionFactories: [claimRollover(seen)] });
		harnesses.push(harness);
		forbidSummarizationAuth(harness);
		let retryTexts: string[] = [];
		harness.setResponses([
			overflowResponse(),
			(context) => {
				retryTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("continued in a fresh window");
			},
		]);

		await harness.session.prompt("x".repeat(600_000));

		expect(seen).toEqual([{ reason: "overflow", willRetry: true }]);
		expect(countType(harness, "context_window")).toBe(1);
		expect(countType(harness, "compaction")).toBe(0);
		expect(retryTexts).toEqual([expect.stringContaining("handoff after overflow")]);
		expect(harness.session.messages.map((m) => m.role)).toEqual(["custom", "assistant"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rolls over when an oversized tool result crosses the threshold before the next response", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		const bigTool: AgentTool = {
			name: "dump",
			label: "Dump",
			description: "Return a huge result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "r".repeat(600_000) }], details: {} }),
		};
		const harness = await createHarness({ tools: [bigTool], extensionFactories: [claimRollover(seen)] });
		harnesses.push(harness);
		forbidSummarizationAuth(harness);
		let secondTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
			(context) => {
				secondTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("dump it");

		expect(seen).toEqual([{ reason: "threshold", willRetry: false }]);
		expect(countType(harness, "context_window")).toBe(1);
		expect(countType(harness, "compaction")).toBe(0);
		expect(secondTexts).toEqual([expect.stringContaining("handoff after threshold")]);
		// The oversized result stays in the transcript for recovery, before the boundary.
		expect(entryTypes(harness)).toEqual(["message", "message", "message", "context_window", "message"]);
	});

	it("rolls over when no summarization credentials exist", async () => {
		const harness = await createHarness({ withConfiguredAuth: false, extensionFactories: [claimRollover()] });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old request ".repeat(100), timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old response ".repeat(100)));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await expect(runAutoCompaction(harness)("threshold", false)).resolves.toBe(false);

		expect(countType(harness, "context_window")).toBe(1);
		expect(harness.session.messages.map((m) => m.role)).toEqual(["custom"]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", contextWindowStarted: true, aborted: true, willRetry: false }),
		]);
	});

	it("retries an overflow exactly once", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		const harness = await createHarness({ extensionFactories: [claimRollover(seen)] });
		harnesses.push(harness);
		harness.setResponses([overflowResponse(), overflowResponse(), fauxAssistantMessage("must remain unused")]);

		await harness.session.prompt("x".repeat(600_000));

		expect(seen).toHaveLength(1);
		expect(countType(harness, "context_window")).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("compaction_end").map((e) => e.errorMessage ?? "rolled over")).toEqual([
			"rolled over",
			expect.stringContaining("Context overflow recovery failed after one compact-and-retry attempt"),
		]);
	});

	it("falls through to normal compaction when no handler claims the trigger", async () => {
		let autoHookCalls = 0;
		let beforeCompactCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_auto_compact", () => {
						autoHookCalls++;
						return undefined;
					});
					pi.on("session_before_compact", (event) => {
						beforeCompactCalls++;
						return {
							compaction: {
								summary: "extension summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: 1,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old request ".repeat(100), timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old response ".repeat(100)));
		harness.sessionManager.appendMessage({ role: "user", content: "new request ".repeat(100), timestamp: 2 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("new response ".repeat(100)));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await runAutoCompaction(harness)("threshold", false);

		expect(autoHookCalls).toBe(1);
		expect(beforeCompactCalls).toBe(1);
		expect(countType(harness, "compaction")).toBe(1);
		expect(countType(harness, "context_window")).toBe(0);
	});

	it("does not fire for manual compaction", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				claimRollover(seen),
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "manual summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 1,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old request ".repeat(100), timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old response ".repeat(100)));
		harness.sessionManager.appendMessage({ role: "user", content: "new request ".repeat(100), timestamp: 2 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("new response ".repeat(100)));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await harness.session.compact();

		expect(seen).toEqual([]);
		expect(countType(harness, "compaction")).toBe(1);
		expect(countType(harness, "context_window")).toBe(0);
	});
});
