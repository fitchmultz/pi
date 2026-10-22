import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import {
	buildSessionProjection,
	type FileEntry,
	parseSessionEntries,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// Recoverable length stops need output below the model's desired limit.
const models = [{ id: "faux-1", contextWindow: 100_000, maxTokens: 1_000 }];

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const summarizeCompaction = (pi: ExtensionAPI) => {
	pi.on("session_before_compact", (event) => ({
		compaction: {
			summary: "recovery summary",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
	}));
};

/** Results that do not answer a still-unanswered call of the preceding assistant message. */
function unpairedResults(messages: Message[]): string[] {
	const unpaired: string[] = [];
	let calls = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			calls = new Set(message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
		} else if (message.role === "toolResult" && !calls.delete(message.toolCallId)) {
			unpaired.push(message.toolCallId);
		}
	}
	return unpaired;
}

const isLengthStop = (message: { role: string; stopReason?: string }) =>
	message.role === "assistant" && message.stopReason === "length";

const resultTexts = (messages: Message[]) =>
	messages.flatMap((message) => (message.role === "toolResult" ? [getMessageText(message)] : []));

const messageEntries = (entries: FileEntry[]) =>
	entries.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message");

const contextEditTargets = (entries: FileEntry[]) =>
	entries.flatMap((entry) => (entry.type === "context_edit" ? [entry.targetId] : []));

// #11227: recovery must omit a truncated tool call and its matching results together.
describe("truncated tool-call recovery across session boundaries", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("resumes a crashed journal without orphaned or lost results, reexecution, journal rewrites or usage loss", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-length-recovery-"));
		dirs.push(dir);
		const executions = { outer: 0, inner: 0 };
		const tools = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "inner",
				label: "inner",
				description: "Reports usage",
				parameters: Type.Object({}),
				execute: async () => {
					executions.inner++;
					return { content: [{ type: "text", text: "inner ran" }], details: {}, usage: usage(20, 0.2) };
				},
			});
			pi.registerTool({
				name: "outer",
				label: "outer",
				description: "Calls inner",
				parameters: Type.Object({}),
				execute: async (_id, _params, _signal, _onUpdate, ctx) => {
					executions.outer++;
					const outcome = await ctx.executeTool("inner", {});
					return {
						content: [{ type: "text", text: `outer saw: ${getMessageText(outcome.result)}` }],
						details: {},
					};
				},
			});
		};
		// A pruning extension replaces the truncated attempt's result, so recovery meets a projected copy.
		const pruneTruncatedResults = (pi: ExtensionAPI) => {
			pi.on("turn_end", (event) =>
				isLengthStop(event.message)
					? {
							entries: event.toolResultEntryIds.map((targetId) => ({
								type: "context_edit" as const,
								targetId,
								replacement: { content: "pruned" },
							})),
						}
					: undefined,
			);
		};
		const live = await createHarness({
			models,
			settings: { compaction: { enabled: true } },
			sessionManager: SessionManager.create(dir, dir),
			initialActiveToolNames: ["outer", "inner"],
			extensionFactories: [tools, pruneTruncatedResults],
		});
		harnesses.push(live);
		const liveFile = live.sessionManager.getSessionFile()!;
		const crashFile = join(dir, "crashed.jsonl");
		// Some providers number calls per response, so the truncated call reuses the valid call's ID.
		live.setResponses([
			fauxAssistantMessage([fauxToolCall("outer", {}, { id: "call_0" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("outer", {}, { id: "call_0" })], { stopReason: "length" }),
			() => {
				// The process dies while this request is in flight; this is the journal it leaves.
				copyFileSync(liveFile, crashFile);
				return fauxAssistantMessage("reply lost in the crash");
			},
		]);
		await live.session.prompt("check status");
		live.session.dispose();
		expect(executions).toEqual({ outer: 1, inner: 1 });

		const crashed = readFileSync(crashFile, "utf8");
		const crashedEntries = parseSessionEntries(crashed);
		const crashedMessages = messageEntries(crashedEntries);
		const truncatedIndex = crashedMessages.findIndex((entry) => isLengthStop(entry.message));
		const truncatedId = crashedMessages[truncatedIndex]!.id;
		const truncatedResultId = crashedMessages[truncatedIndex + 1]!.id;
		const validResult = crashedMessages.find((entry) => entry.message.role === "toolResult")!;
		expect(crashedMessages[truncatedIndex + 1]!.message.role).toBe("toolResult");
		expect(validResult.message).toMatchObject({ toolCallId: "call_0", nestedCalls: { calls: [{ name: "inner" }] } });
		expect(contextEditTargets(crashedEntries)).toEqual([truncatedResultId]);

		const resumed = await createHarness({
			models,
			settings: { compaction: { enabled: true } },
			sessionManager: SessionManager.open(crashFile, dir),
			initialActiveToolNames: ["outer", "inner"],
			extensionFactories: [tools, summarizeCompaction],
		});
		harnesses.push(resumed);
		// createAgentSession() seeds the agent with the journal's context the same way.
		resumed.session.agent.state.messages = resumed.sessionManager.buildSessionContext().messages;
		const statsBefore = resumed.session.getSessionStats();
		let request: Message[] = [];
		resumed.setResponses([
			(context) => {
				request = context.messages;
				return fauxAssistantMessage("done");
			},
		]);

		await resumed.session.prompt("continue");

		expect(unpairedResults(request)).toEqual([]);
		expect(request.some(isLengthStop)).toBe(false);
		expect(resultTexts(request)).toEqual(["outer saw: inner ran"]);
		expect(executions).toEqual({ outer: 1, inner: 1 });

		// The crashed journal stays byte-identical; recovery appends only its omissions before the new turn.
		const journal = readFileSync(crashFile, "utf8");
		expect(journal.startsWith(crashed)).toBe(true);
		const appended = parseSessionEntries(journal.slice(crashed.length));
		const firstMessage = appended.findIndex((entry) => entry.type === "message");
		expect(appended.slice(0, firstMessage).map((entry) => entry.type)).toEqual(["context_edit", "context_edit"]);
		expect(appended.slice(firstMessage).every((entry) => entry.type === "message")).toBe(true);
		expect(contextEditTargets(appended).sort()).toEqual([truncatedId, truncatedResultId].sort());
		expect(appended.every((entry) => entry.type !== "context_edit" || entry.replacement === null)).toBe(true);

		const reply = messageEntries(appended).find((entry) => getMessageText(entry.message) === "done")!;
		const replyUsage = reply.message.role === "assistant" ? reply.message.usage : undefined;
		const statsAfter = resumed.session.getSessionStats();
		expect(statsBefore.cost).toBeCloseTo(0.2);
		expect(statsAfter.cost).toBeCloseTo(statsBefore.cost);
		expect(statsAfter.tokens.total).toBe(statsBefore.tokens.total + replyUsage!.totalTokens);
	});

	it("omits a navigated branch's truncated attempt without editing the branch it left", async () => {
		let probes = 0;
		const probe: AgentTool = {
			name: "probe",
			label: "probe",
			description: "Must not run from a truncated call",
			parameters: Type.Object({}),
			execute: async () => {
				probes++;
				return { content: [{ type: "text", text: "probed" }], details: {} };
			},
		};
		const harness = await createHarness({
			models,
			settings: { compaction: { enabled: true } },
			tools: [probe],
			initialActiveToolNames: ["probe"],
			extensionFactories: [summarizeCompaction],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "length" }),
			fauxAssistantMessage("natural continuation"),
		]);
		await harness.session.prompt("start");

		const original = structuredClone(harness.sessionManager.getEntries());
		const originalMessages = messageEntries(original);
		const truncatedIndex = originalMessages.findIndex((entry) => isLengthStop(entry.message));
		const truncatedId = originalMessages[truncatedIndex]!.id;
		const truncatedResultId = originalMessages[truncatedIndex + 1]!.id;
		const abandonedLeafId = harness.sessionManager.getLeafId()!;

		await harness.session.navigateTree(truncatedResultId);
		let request: Message[] = [];
		harness.setResponses([
			(context) => {
				request = context.messages;
				return fauxAssistantMessage("retried");
			},
		]);
		await harness.session.prompt("retry from here");

		expect(probes).toBe(0);
		expect(unpairedResults(request)).toEqual([]);
		expect(request.some(isLengthStop)).toBe(false);
		expect(resultTexts(request)).toEqual([]);
		const entries = harness.sessionManager.getEntries();
		expect(entries.slice(0, original.length)).toEqual(original);
		expect(contextEditTargets(harness.sessionManager.getBranch()).sort()).toEqual(
			[truncatedId, truncatedResultId].sort(),
		);

		const abandoned = buildSessionProjection(entries, abandonedLeafId).messages;
		expect(abandoned.some(isLengthStop)).toBe(true);
		expect(abandoned.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(getMessageText(abandoned.at(-1))).toBe("natural continuation");
	});

	it("keeps earlier receipts and truncated pairs while a background run settles during recovery compaction", async () => {
		const finished = Promise.withResolvers<void>();
		const counts = { runs: 0, commits: 0, probes: 0 };
		let deliveredDuringCompaction: number | undefined;
		const completions = (harness: Harness) =>
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "test-background",
			);
		const extension = (pi: ExtensionAPI) => {
			// Codemode's background option starts its script through this same ctx.runInBackground() path.
			pi.registerTool({
				name: "deferred_run",
				label: "deferred_run",
				description: "Starts a background run the test finishes",
				parameters: Type.Object({}),
				execute: async (_id, _params, _signal, _onUpdate, ctx) => {
					counts.runs++;
					ctx.runInBackground("test-background", async () => {
						await finished.promise;
						return {
							content: [{ type: "text", text: "work output" }],
							details: undefined,
							usage: usage(40, 0.4),
							commit: () => {
								counts.commits++;
							},
						};
					});
					return { content: [{ type: "text", text: "started" }], details: undefined };
				},
			});
			pi.registerTool({
				name: "probe",
				label: "probe",
				description: "Must not run from a truncated call",
				parameters: Type.Object({}),
				execute: async () => {
					counts.probes++;
					return { content: [{ type: "text", text: "probed" }], details: undefined };
				},
			});
			pi.on("session_before_compact", async (event) => {
				finished.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
				deliveredDuringCompaction = completions(harness).length;
				const firstUser = event.branchEntries.find(
					(entry) => entry.type === "message" && entry.message.role === "user",
				);
				return {
					compaction: {
						summary: "recovery summary",
						// Keep the whole turn so the retry shows which earlier results recovery left in place.
						firstKeptEntryId: firstUser!.id,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		};
		const harness = await createHarness({
			models,
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			initialActiveToolNames: ["deferred_run", "probe"],
			extensionFactories: [extension],
		});
		harnesses.push(harness);
		let retryRequest: Message[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("deferred_run", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "length" }),
			fauxAssistantMessage("partial answer", { stopReason: "length" }),
			(context) => {
				retryRequest = context.messages;
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("go");
		await vi.waitFor(() => {
			expect(completions(harness)).toHaveLength(1);
			expect(harness.session.isIdle).toBe(true);
		});

		// Delivery waits for compaction, then steers the completion into the retried request once.
		expect(deliveredDuringCompaction).toBe(0);
		expect(harness.faux.state.callCount).toBe(4);
		expect(getMessageText(retryRequest.at(-1))).toContain("work output");
		expect(counts).toEqual({ runs: 1, commits: 1, probes: 0 });
		const entries = harness.sessionManager.getEntries();
		const partial = messageEntries(entries).find((entry) => getMessageText(entry.message) === "partial answer")!;
		expect(contextEditTargets(entries)).toEqual([partial.id]);
		expect(unpairedResults(retryRequest)).toEqual([]);
		expect(resultTexts(retryRequest)).toEqual(["started", expect.stringContaining("may be truncated")]);
		expect(JSON.stringify(retryRequest)).not.toContain("partial answer");
		const usageEntries = entries.filter((entry) => entry.type === "usage");
		expect(usageEntries).toHaveLength(1);
		expect(usageEntries[0]).toMatchObject({ usage: { totalTokens: 40 } });
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.4);
	});
});
