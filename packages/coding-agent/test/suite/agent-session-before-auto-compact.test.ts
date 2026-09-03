import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const OVERFLOW = "prompt is too long: 300000 tokens > 128000 maximum";

function overflowResponse() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
}

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function claimRollover(seen: Array<{ reason: string; willRetry: boolean }> = []) {
	return (pi: ExtensionAPI) => {
		pi.on("session_before_auto_compact", (event) => {
			seen.push({ reason: event.reason, willRetry: event.willRetry });
			return { newContext: { handoff: `handoff after ${event.reason}` } };
		});
	};
}

function replacementTools(onRollover: () => void) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "loader",
			label: "Loader",
			description: "Load the larger tool",
			parameters: Type.Object({}),
			execute: async () => {
				pi.setActiveTools(["huge"]);
				return { content: [{ type: "text" as const, text: "loaded" }], details: {} };
			},
		});
		pi.registerTool({
			name: "huge",
			label: "Huge",
			description: "x".repeat(24_000),
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		});
		pi.on("session_before_auto_compact", () => {
			onRollover();
			return { newContext: { handoff: "rollover" } };
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
		let entriesAtCompactionEnd: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.contextWindowStarted) {
				entriesAtCompactionEnd = entryTypes(harness);
			}
		});
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
		expect(entriesAtCompactionEnd).toContain("context_window");
		expect(countType(harness, "context_window")).toBe(1);
		expect(countType(harness, "compaction")).toBe(0);
		expect(retryTexts).toEqual([expect.stringContaining("handoff after overflow")]);
		expect(harness.session.messages.map((m) => m.role)).toEqual(["custom", "assistant"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps the first-request overflow exemption across repeated preparation", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		const prepare = harness.session.agent.prepareProviderRequest!;
		let queued = false;
		harness.session.agent.prepareProviderRequest = async (context, signal) => {
			const prepared = await prepare(context, signal);
			if (!queued) {
				queued = true;
				await harness.session.steer("late steering");
			}
			return prepared;
		};
		let hookCallsAtRequest = -1;
		let requestTexts: string[] = [];
		harness.setResponses([
			(context) => {
				hookCallsAtRequest = seen.length;
				requestTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("p".repeat(60_000));

		expect(hookCallsAtRequest).toBe(0);
		expect(requestTexts).toEqual(["p".repeat(60_000), "late steering"]);
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

	it("applies session_before_compact newContext before a mid-run provider request", async () => {
		const bigTool: AgentTool = {
			name: "dump",
			label: "Dump",
			description: "Return a huge result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "r".repeat(600_000) }], details: {} }),
		};
		const harness = await createHarness({
			tools: [bigTool],
			settings: { compaction: { keepRecentTokens: 155_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) =>
						event.reason === "manual" ? undefined : { newContext: { handoff: "legacy handoff" } },
					);
				},
			],
		});
		harnesses.push(harness);
		let secondTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("w".repeat(40_000)),
			fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
			(context) => {
				secondTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("warm up");
		await harness.session.prompt("dump it");

		expect(secondTexts).toEqual([expect.stringContaining("legacy handoff")]);
		expect(entryTypes(harness)).toEqual([
			"message",
			"message",
			"message",
			"message",
			"message",
			"context_window",
			"message",
		]);
	});

	it("estimates a replacement tool set before the next provider request", async () => {
		let hookCalls = 0;
		let hookCallsAtSecondRequest = -1;
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [replacementTools(() => hookCalls++)],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["loader"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("loader", {}), { stopReason: "toolUse" }),
			(context) => {
				hookCallsAtSecondRequest = hookCalls;
				expect(context.tools?.map((tool) => tool.name)).toEqual(["huge"]);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("p".repeat(36_000));

		expect(hookCallsAtSecondRequest).toBe(1);
		expect(countType(harness, "context_window")).toBe(1);
	});

	it("estimates idle tool replacements and the new prompt before the first provider request", async () => {
		let hookCalls = 0;
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [replacementTools(() => hookCalls++)],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["loader"]);
		harness.setResponses([
			fauxAssistantMessage("first done"),
			(context) => {
				expect(hookCalls).toBe(1);
				expect(context.tools?.map((tool) => tool.name)).toEqual(["huge"]);
				expect(context.messages.map(getMessageText)).toContain("p".repeat(28_000));
				return fauxAssistantMessage("second done");
			},
		]);

		await harness.session.prompt("f".repeat(12_000));
		expect(hookCalls).toBe(0);
		harness.session.setActiveToolsByName(["huge"]);
		await harness.session.prompt("p".repeat(28_000));

		expect(countType(harness, "context_window")).toBe(1);
	});

	it("keeps a newly submitted prompt after a preflight context boundary", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		let pendingTexts: string[] = [];
		let pendingTextsAtCompactionEnd: string[] = [];
		let branchTexts: string[] = [];
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_auto_compact", (event) => {
						seen.push({ reason: event.reason, willRetry: event.willRetry });
						pendingTexts = event.pendingMessages.map(getMessageText);
						branchTexts = event.branchEntries.flatMap((entry) =>
							entry.type === "message" ? [getMessageText(entry.message)] : [],
						);
						return { newContext: { handoff: `handoff after ${event.reason}` } };
					});
				},
			],
		});
		harnesses.push(harness);
		let requestTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("short"),
			(context) => {
				requestTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("p".repeat(36_000));
		expect(seen).toEqual([]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				pendingTextsAtCompactionEnd = (event.pendingMessages ?? []).map(getMessageText);
			}
		});

		const request = `PLEASE RENAME foo TO bar IN src/x.ts ${"q".repeat(28_000)}`;
		await harness.session.prompt(request);

		expect(seen).toEqual([{ reason: "threshold", willRetry: false }]);
		expect(pendingTexts).toContain(request);
		expect(pendingTextsAtCompactionEnd).toContain(request);
		expect(branchTexts).not.toContain(request);
		expect(requestTexts).toContain(request);
		const branch = harness.sessionManager.getBranch();
		const boundaryIndex = branch.findIndex((entry) => entry.type === "context_window");
		const requestIndexes = branch.flatMap((entry, index) =>
			entry.type === "message" && getMessageText(entry.message) === request ? [index] : [],
		);
		expect(requestIndexes).toHaveLength(1);
		expect(requestIndexes[0]).toBeGreaterThan(boundaryIndex);
	});

	it("does not append a pending input twice when persistence throws after updating the tree", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await harness.session.prompt("keep this input once");

		const inputs = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(inputs).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", errorMessage: "disk full" });
	});

	it("includes queued steering in preflight before the provider request", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		let hookCallsAtSecondRequest = -1;
		let requestTexts: string[] = [];
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => {
				void harness.session.steer("s".repeat(28_000));
				return fauxAssistantMessage("first done");
			},
			(context) => {
				hookCallsAtSecondRequest = seen.length;
				requestTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("second done");
			},
		]);

		await harness.session.prompt("p".repeat(36_000));

		expect(hookCallsAtSecondRequest).toBe(1);
		expect(requestTexts).toContain("s".repeat(28_000));
		expect(countType(harness, "context_window")).toBe(1);
	});

	it("includes idle trigger-turn custom messages in preflight before the provider request", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		let hookCallsAtSecondRequest = -1;
		let requestTexts: string[] = [];
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done")]);
		await harness.session.prompt("p".repeat(36_000));
		harness.setResponses([
			(context) => {
				hookCallsAtSecondRequest = seen.length;
				requestTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("second done");
			},
		]);

		await harness.session.sendCustomMessage(
			{ customType: "test", content: "c".repeat(28_000), display: true },
			{ triggerTurn: true },
		);

		expect(hookCallsAtSecondRequest).toBe(1);
		expect(requestTexts).toContain("c".repeat(28_000));
		expect(countType(harness, "context_window")).toBe(1);
	});

	it("uses a full estimate when historical usage has no known prefix", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		const huge: AgentTool = {
			name: "huge",
			label: "Huge",
			description: "x".repeat(24_000),
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [huge],
			initialActiveToolNames: [],
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "o".repeat(36_000), timestamp: 1 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old", { timestamp: 2 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(10_000),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.session.setActiveToolsByName(["huge"]);

		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(15_000);
		harness.setResponses([
			() => {
				expect(seen).toHaveLength(1);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("new");
	});

	it("ignores kept pre-compaction usage before the first response after resume", async () => {
		const seen: Array<{ reason: string; willRetry: boolean }> = [];
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 200_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 } },
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const now = Date.now();
		harness.sessionManager.appendMessage({ role: "user", content: "before compaction", timestamp: now - 3000 });
		const firstKeptEntryId = harness.sessionManager.getEntries().at(-1)!.id;
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("kept pre-compaction response", { timestamp: now - 2000 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(190_000),
		});
		harness.sessionManager.appendCompaction("summary of earlier work", firstKeptEntryId, 190_000, undefined, false);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let requestTexts: string[] = [];
		harness.setResponses([
			(context) => {
				requestTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("next");

		expect(seen).toEqual([]);
		expect(requestTexts.at(-1)).toBe("next");
		expect(countType(harness, "context_window")).toBe(0);
	});

	it("associates provider usage with the prefix sent before lifecycle handlers mutate tools", async () => {
		let hookCalls = 0;
		let changedTools = false;
		let hookCallsAtSecondRequest = -1;
		const harness = await createHarness({
			initialActiveToolNames: [],
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "huge",
						label: "Huge",
						description: "x".repeat(24_000),
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
					});
					pi.on("message_start", (event) => {
						if (!changedTools && event.message.role === "assistant") {
							changedTools = true;
							pi.setActiveTools(["huge"]);
						}
					});
					pi.on("session_before_auto_compact", () => {
						hookCalls++;
						return { newContext: { handoff: "rollover" } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(context.tools).toEqual([]);
				return fauxAssistantMessage("first done");
			},
			() => {
				hookCallsAtSecondRequest = hookCalls;
				return fauxAssistantMessage("second done");
			},
		]);

		await harness.session.prompt("p".repeat(12_000));
		expect(hookCalls).toBe(0);
		await harness.session.prompt("q".repeat(24_000));

		expect(hookCallsAtSecondRequest).toBe(1);
		expect(countType(harness, "context_window")).toBe(1);
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

	it("does not commit a rollover when cancellation arrives during either automatic hook", async () => {
		for (const legacy of [false, true]) {
			let hookCalled = false;
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						const cancel = async () => {
							await Promise.resolve();
							hookCalled = true;
							harness.session.abortCompaction();
							return { newContext: { handoff: "must not commit" } };
						};
						if (legacy) pi.on("session_before_compact", cancel);
						else pi.on("session_before_auto_compact", cancel);
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			await harness.session.prompt("one");
			await harness.session.prompt("two");

			await runAutoCompaction(harness)("threshold", false);

			expect(hookCalled).toBe(true);
			expect(countType(harness, "context_window")).toBe(0);
			expect(harness.eventsOfType("compaction_end").some((event) => event.contextWindowStarted)).toBe(false);
		}
	});

	it("reports a claimed rollover that cannot persist its boundary", async () => {
		const failures: Array<string | undefined> = [];
		const harness = await createHarness({
			extensionFactories: [
				claimRollover(),
				(pi) => {
					pi.on("session_compact_failed", (event) => {
						failures.push(event.errorMessage);
					});
				},
			],
		});
		harnesses.push(harness);
		vi.spyOn(harness.sessionManager, "appendContextWindow").mockImplementation(() => {
			throw new Error("disk full");
		});

		await expect(runAutoCompaction(harness)("threshold", false)).resolves.toBe(false);

		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ errorMessage: "Auto-compaction failed: disk full" }),
		]);
		expect(failures).toEqual(["Auto-compaction failed: disk full"]);
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
