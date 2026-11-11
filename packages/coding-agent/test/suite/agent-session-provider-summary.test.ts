import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const block: JsonObject = { type: "compaction", content: "Read the task note.", signature: "EuYBCkQY" };

const lookup: AgentTool = {
	name: "lookup",
	label: "Lookup",
	description: "Look up a value",
	parameters: Type.Object({ key: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `value of ${(params as { key: string }).key}` }],
		details: undefined,
	}),
};

const ring: AgentTool = {
	name: "ring",
	label: "Ring",
	description: "Ring the bell",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "rang" }], details: undefined }),
};

function callLookup(key: string): FauxResponseStep {
	return fauxAssistantMessage(fauxToolCall("lookup", { key }), { stopReason: "toolUse" });
}

interface SessionRequest {
	messages: Message[];
	options: SimpleStreamOptions | undefined;
}

/**
 * Give the session a model that supports summary blocks, and record its requests. They go through
 * the model runtime to the faux provider, whose queue also holds the reply to each summary request.
 */
function useSummaryModel(harness: Harness): SessionRequest[] {
	const requests: SessionRequest[] = [];
	const faux = harness.getModel();
	harness.session.agent.state.model = {
		...faux,
		api: "anthropic-messages",
		compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	} as Model<"anthropic-messages">;
	harness.session.agent.streamFunction = (model, context, options) => {
		requests.push({ messages: structuredClone(context.messages), options });
		return harness.session.modelRuntime.streamSimple(harness.getModel(model.id) ?? faux, context, options);
	};
	return requests;
}

/** Record the requests of a session whose model cannot write summary blocks. */
function recordRequests(harness: Harness): SessionRequest[] {
	const requests: SessionRequest[] = [];
	harness.session.agent.streamFunction = (model, context, options) => {
		requests.push({ messages: structuredClone(context.messages), options });
		return harness.session.modelRuntime.streamSimple(model, context, options);
	};
	return requests;
}

/** The model that the faux provider reports as the writer of its blocks. */
function writer(harness: Harness): { provider: string; api: string; model: string } {
	const { provider, api, id } = harness.getModel();
	return { provider, api, model: id };
}

/** The reply of a provider that wrote a block. */
function blockReply(harness: Harness): AssistantMessage {
	return {
		...fauxAssistantMessage([]),
		rawStopReason: "compaction",
		providerSummary: { ...writer(harness), block },
	};
}

function getCompactions(harness: Harness): CompactionEntry[] {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
}

function describeMessages(messages: Message[]): string[] {
	return messages.map((message) => {
		if (message.role === "system") {
			const added = message.toolsAdded?.map((tool) => tool.name).join(",");
			return `system${message.providerSummary ? "+block" : ""}${added ? ` +${added}` : ""}`;
		}
		if (message.role === "assistant") {
			const calls = message.content.flatMap((part) =>
				part.type === "toolCall" ? [`${part.name}(${JSON.stringify(part.arguments)})`] : [],
			);
			return `assistant: ${calls.join(" ") || getMessageText(message)}`;
		}
		return `${message.role}: ${getMessageText(message)}`;
	});
}

/** A `turn_end` handler that compacts at the listed turns of the session, keeping each of those turns. */
function compactAtTurns(turns: number[], draft: { providerSummary?: { instructions?: string } }) {
	let turn = 0;
	return (pi: ExtensionAPI) => {
		pi.on("turn_end", (event) => {
			turn++;
			if (!turns.includes(turn)) return;
			return {
				entries: [
					...event.entries,
					{
						type: "compaction",
						summary: `summary before turn ${turn}`,
						firstKeptEntryId: event.messageEntryId,
						...draft,
					},
				],
			};
		});
	};
}

describe("AgentSession provider summary block", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("asks for the block with the request that produced the first kept turn, and replays that turn after it", async () => {
		const harness = await createHarness({
			tools: [lookup],
			settings: { compaction: { enabled: false } },
			extensionFactories: [compactAtTurns([2], { providerSummary: { instructions: "One line." } })],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		harness.setResponses([callLookup("a"), callLookup("b"), blockReply(harness), fauxAssistantMessage("done")]);

		await harness.session.prompt("start");

		const [first, second, summary, third] = requests;
		expect(requests).toHaveLength(4);
		expect(summary.options).toMatchObject({
			providerSummary: { instructions: "One line." },
			disableContinuation: true,
			sessionId: first.options?.sessionId,
		});
		expect(summary.messages).toEqual(second.messages);

		const [compaction] = getCompactions(harness);
		const { provider, api, id } = harness.getModel();
		expect(compaction.providerSummary).toMatchObject({ provider, api, model: id, block });
		expect(compaction.providerSummary).not.toHaveProperty("reason");
		// The leading system message stays the one the kept turn was written under.
		expect(compaction.systemMessage).toEqual(second.messages[0]);
		expect(compaction.usage).toEqual(compaction.providerSummary?.usage);
		expect(compaction.usage?.input).toBeGreaterThan(0);

		expect(describeMessages(third.messages)).toEqual([
			"system+block +lookup",
			'assistant: lookup({"key":"b"})',
			"toolResult: value of b",
			expect.stringContaining("summary before turn 2"),
		]);
		// The kept turn reported its usage before the compaction: it is not the size of this request.
		expect(estimateContextTokens(third.messages)).toMatchObject({ usageTokens: 0, lastUsageIndex: null });
		expect(third.messages[0]).toEqual({
			...second.messages[0],
			providerSummary: { provider, api, model: id, block, timestamp: new Date(compaction.timestamp).getTime() },
		});
		expect(getMessageText(harness.session.messages.at(-1))).toBe("done");
	});

	it("declares a tool loaded in the summarized conversation once, directly after the leading system message", async () => {
		let runs = 0;
		const harness = await createHarness({
			tools: [lookup, ring],
			initialActiveToolNames: ["lookup"],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				compactAtTurns([2], { providerSummary: {} }),
				(pi) => {
					// A prompt section that changes in the conversation the block summarizes.
					pi.on("before_agent_start", (event) => {
						if (++runs === 2) event.systemPromptOptions.sections.note = "second";
					});
				},
			],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			callLookup("b"),
			blockReply(harness),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("one");
		harness.session.setActiveToolsByName(["lookup", "ring"]);
		await harness.session.prompt("two");

		const [, second, summary, third] = requests;
		expect(describeMessages(second.messages)).toEqual([
			"system +lookup",
			"user: one",
			"assistant: first",
			"system +ring",
			"user: two",
		]);
		expect(summary.messages).toEqual(second.messages);

		const [compaction] = getCompactions(harness);
		expect(compaction.systemMessage?.toolsAdded?.map((tool) => tool.name)).toEqual(["lookup"]);
		expect(compaction.providerSummary?.toolsAdded?.map((tool) => tool.name)).toEqual(["ring"]);
		expect(compaction.providerSummary).not.toHaveProperty("toolsRemoved");

		// The tool is declared before the kept turn and not again after it. The block does not carry
		// the prompt section, so it is stated again after the summary and the leading message stays.
		expect(describeMessages(third.messages)).toEqual([
			"system+block +lookup",
			"system +ring",
			'assistant: lookup({"key":"b"})',
			"toolResult: value of b",
			expect.stringContaining("summary before turn 2"),
			"system",
		]);
		expect(getCurrentTools(third.messages).map((tool) => tool.name)).toEqual(["lookup", "ring"]);
		expect(third.messages.at(-1)).toMatchObject({ sections: { note: expect.stringContaining("second") } });
		expect(third.messages[0]).toEqual({
			...second.messages[0],
			providerSummary: { ...writer(harness), block, timestamp: new Date(compaction.timestamp).getTime() },
		});
	});

	it("asks for a block on top of a compaction that stored a tool update, and keeps its leading system message", async () => {
		const harness = await createHarness({
			tools: [lookup, ring],
			initialActiveToolNames: ["lookup"],
			settings: { compaction: { enabled: false } },
			// The compaction at turn 2 asks for no block: it stores the tool loaded before it as a tool update.
			extensionFactories: [compactAtTurns([2], {}), compactAtTurns([4], { providerSummary: {} })],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			callLookup("b"),
			callLookup("c"),
			callLookup("d"),
			blockReply(harness),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("one");
		harness.session.setActiveToolsByName(["lookup", "ring"]);
		await harness.session.prompt("two");

		const [, , , fourth, summary, fifth] = requests;
		// The request that produced the kept turn starts with the first tool list and the tool update.
		expect(describeMessages(fourth.messages)).toEqual([
			"system +lookup",
			"system +ring",
			expect.stringContaining("summary before turn 2"),
			'assistant: lookup({"key":"b"})',
			"toolResult: value of b",
			'assistant: lookup({"key":"c"})',
			"toolResult: value of c",
		]);
		expect(summary.options).toMatchObject({ providerSummary: {} });
		expect(summary.messages).toEqual(fourth.messages);

		const [plain, withBlock] = getCompactions(harness);
		expect(plain.toolUpdate?.toolsAdded?.map((tool) => tool.name)).toEqual(["ring"]);
		// The kept turn was written under this leading system message: same prompt, same first tool list.
		expect(withBlock.systemMessage).toEqual(plain.systemMessage);
		expect(withBlock.systemMessage?.toolsAdded?.map((tool) => tool.name)).toEqual(["lookup"]);
		expect(withBlock).not.toHaveProperty("toolUpdate");
		expect(withBlock.providerSummary?.block).toEqual(block);
		expect(withBlock.providerSummary?.toolsAdded?.map((tool) => tool.name)).toEqual(["ring"]);

		expect(describeMessages(fifth.messages)).toEqual([
			"system+block +lookup",
			"system +ring",
			'assistant: lookup({"key":"d"})',
			"toolResult: value of d",
			expect.stringContaining("summary before turn 4"),
		]);
		expect(fifth.messages[0]).toEqual({
			...fourth.messages[0],
			providerSummary: { ...writer(harness), block, timestamp: new Date(withBlock.timestamp).getTime() },
		});
		expect(getCurrentTools(fifth.messages).map((tool) => tool.name)).toEqual(["lookup", "ring"]);
	});

	it("chains a second block on the first and keeps the first leading system message", async () => {
		const harness = await createHarness({
			tools: [lookup],
			settings: { compaction: { enabled: false } },
			extensionFactories: [compactAtTurns([2, 4], { providerSummary: {} })],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		const secondBlock = { ...block, content: "Second summary." };
		harness.setResponses([
			callLookup("a"),
			callLookup("b"),
			blockReply(harness),
			callLookup("c"),
			callLookup("d"),
			{ ...blockReply(harness), providerSummary: { ...writer(harness), block: secondBlock } },
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		const [, , , , fourth, secondSummary, fifth] = requests;
		// The second block is asked for on top of the first: block, kept turn, first summary, next turn.
		expect(describeMessages(secondSummary.messages)).toEqual([
			"system+block +lookup",
			'assistant: lookup({"key":"b"})',
			"toolResult: value of b",
			expect.stringContaining("summary before turn 2"),
			'assistant: lookup({"key":"c"})',
			"toolResult: value of c",
		]);
		expect(secondSummary.messages).toEqual(fourth.messages);

		const [first, second] = getCompactions(harness);
		expect(second.systemMessage).toEqual(first.systemMessage);
		expect(second.providerSummary?.block).toEqual(secondBlock);
		expect(describeMessages(fifth.messages)).toEqual([
			"system+block +lookup",
			'assistant: lookup({"key":"d"})',
			"toolResult: value of d",
			expect.stringContaining("summary before turn 4"),
		]);
		expect(fifth.messages[0]).toMatchObject({ providerSummary: { block: secondBlock } });
	});

	it.each([
		{ name: "the model cannot write one", reason: "model", capable: false, keep: "turn", reply: undefined },
		{
			name: "the kept part starts with a user message",
			reason: "cut",
			capable: true,
			keep: "prompt",
			reply: undefined,
		},
		{
			name: "the provider declines",
			reason: "stop: refusal",
			capable: true,
			keep: "turn",
			reply: {
				...fauxAssistantMessage([], { stopReason: "error", errorMessage: "refused" }),
				rawStopReason: "refusal",
			},
		},
		{
			name: "the request fails",
			reason: "error: overloaded",
			capable: true,
			keep: "turn",
			reply: fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
		},
	] as const)("stores the compaction without a block when $name", async ({ reason, capable, keep, reply }) => {
		let turn = 0;
		const harness = await createHarness({
			tools: [lookup],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event, ctx) => {
						turn++;
						if (turn !== 2) return;
						const prompt = ctx.sessionManager
							.getEntries()
							.findLast((entry) => entry.type === "message" && entry.message.role === "user");
						return {
							entries: [
								{
									type: "compaction",
									summary: "summary before turn 2",
									firstKeptEntryId: keep === "turn" ? event.messageEntryId : (prompt?.id ?? null),
									providerSummary: {},
								},
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const requests = capable ? useSummaryModel(harness) : recordRequests(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			callLookup("b"),
			...(reply ? [reply] : []),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const [compaction] = getCompactions(harness);
		expect(compaction.providerSummary).toMatchObject({ reason });
		expect(compaction.providerSummary).not.toHaveProperty("block");
		// No request, no usage.
		expect(compaction.providerSummary?.usage !== undefined).toBe(reply !== undefined);
		expect(requests.filter((request) => request.options?.providerSummary)).toHaveLength(reply ? 1 : 0);
		// The compaction is the one Pi stores without the opt-in: system state, summary, kept entries.
		expect(describeMessages(requests.at(-1)?.messages ?? [])).toEqual([
			"system +lookup",
			expect.stringContaining("summary before turn 2"),
			...(keep === "prompt" ? ["user: two"] : []),
			'assistant: lookup({"key":"b"})',
			"toolResult: value of b",
		]);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("done");
	});

	it("stores the compaction without a block when it keeps from the first kept turn of the block before it", async () => {
		let turn = 0;
		let firstKeptEntryId: string | undefined;
		const harness = await createHarness({
			tools: [lookup],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						turn++;
						if (turn !== 2 && turn !== 3) return;
						firstKeptEntryId ??= event.messageEntryId;
						return {
							entries: [
								...event.entries,
								{
									type: "compaction",
									summary: `summary at turn ${turn}`,
									firstKeptEntryId,
									providerSummary: {},
								},
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		harness.setResponses([
			callLookup("a"),
			callLookup("b"),
			blockReply(harness),
			callLookup("c"),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		// Only the first block stands before the kept turns of the second compaction: nothing to summarize.
		const [first, second] = getCompactions(harness);
		expect(first.providerSummary?.block).toEqual(block);
		expect(second.providerSummary).toMatchObject({ reason: "cut", seconds: 0 });
		expect(second.providerSummary).not.toHaveProperty("block");
		expect(requests.filter((request) => request.options?.providerSummary)).toHaveLength(1);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("done");
	});

	it("stores the compaction without a block in a run whose system prompt a handler replaced", async () => {
		const harness = await createHarness({
			tools: [lookup],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				compactAtTurns([2], { providerSummary: {} }),
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: "forced prompt" }));
				},
			],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		harness.setResponses([callLookup("a"), callLookup("b"), fauxAssistantMessage("done")]);

		await harness.session.prompt("start");

		// Every request of the run leads with the forced prompt, below which no block can be read.
		const [compaction] = getCompactions(harness);
		expect(compaction.providerSummary).toMatchObject({ reason: "prompt", seconds: 0 });
		expect(compaction.providerSummary).not.toHaveProperty("block");
		expect(requests.filter((request) => request.options?.providerSummary)).toHaveLength(0);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("done");
	});

	it("stores an overflow compaction without a block and sends no summary request", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							providerSummary: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		// The context did not fit the model, so the same messages cannot be summarized by it either.
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "overflow", aborted: false });
		const [compaction] = getCompactions(harness);
		expect(compaction.providerSummary).toMatchObject({ reason: "overflow", seconds: 0 });
		expect(compaction.providerSummary).not.toHaveProperty("block");
		expect(requests.filter((request) => request.options?.providerSummary)).toHaveLength(0);
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	it("asks for the block of a session_before_compact result, and Escape stops only that request", async () => {
		const harness = await createHarness({
			tools: [lookup],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						const lastReply = event.branchEntries.findLast(
							(entry) => entry.type === "message" && entry.message.role === "assistant",
						);
						if (!lastReply) throw new Error("expected an assistant message");
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: lastReply.id,
								tokensBefore: event.preparation.tokensBefore,
								providerSummary: { instructions: "One line." },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const requests = useSummaryModel(harness);
		harness.setResponses([
			callLookup("a"),
			fauxAssistantMessage("first done"),
			blockReply(harness),
			fauxAssistantMessage("second done"),
			() => {
				harness.session.abortCompaction();
				return blockReply(harness);
			},
			fauxAssistantMessage("third done"),
		]);

		await harness.session.prompt("one");
		await harness.session.compact();
		await harness.session.prompt("two");

		const [stored] = getCompactions(harness);
		expect(stored.providerSummary).toMatchObject({ block });
		expect(describeMessages(requests[3].messages)).toEqual([
			"system+block +lookup",
			"assistant: first done",
			expect.stringContaining("manual summary"),
			"user: two",
		]);
		expect(requests[2].messages).toEqual(requests[1].messages);

		await harness.session.compact();
		await harness.session.prompt("three");

		const aborted = getCompactions(harness)[1];
		expect(aborted.summary).toBe("manual summary");
		expect(aborted.providerSummary).toMatchObject({ reason: "aborted" });
		expect(aborted.providerSummary).not.toHaveProperty("block");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("third done");
	});

	it.each(["another model", "a changed conversation", "a forced system prompt"] as const)(
		"sends the summary text in place of the block with %s",
		async (reader) => {
			let changeContext = false;
			let forcePrompt = false;
			const harness = await createHarness({
				models: [{ id: "writer" }, { id: "other" }],
				tools: [lookup],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					compactAtTurns([2], { providerSummary: {} }),
					(pi) => {
						pi.on("context", (event) =>
							changeContext
								? { messages: event.messages.filter((message) => message.role !== "toolResult") }
								: undefined,
						);
						pi.on("before_agent_start", () => (forcePrompt ? { systemPrompt: "forced prompt" } : undefined));
					},
				],
			});
			harnesses.push(harness);
			useSummaryModel(harness);
			let received: Message[] = [];
			harness.setResponses([
				callLookup("a"),
				callLookup("b"),
				blockReply(harness),
				fauxAssistantMessage("done"),
				(context) => {
					received = context.messages;
					return fauxAssistantMessage("answered");
				},
			]);

			await harness.session.prompt("start");
			if (reader === "another model") {
				const other = harness.getModel("other");
				if (!other) throw new Error("missing model");
				harness.session.agent.state.model = other;
			}
			changeContext = reader === "a changed conversation";
			forcePrompt = reader === "a forced system prompt";
			await harness.session.prompt("next");

			expect(describeMessages(received)).toEqual([
				reader === "a forced system prompt" ? "system +lookup" : "system +lookup",
				"user: Summary of the earlier conversation:\n\nRead the task note.",
				'assistant: lookup({"key":"b"})',
				...(reader === "a changed conversation" ? [] : ["toolResult: value of b"]),
				expect.stringContaining("summary before turn 2"),
				"assistant: done",
				"user: next",
			]);
			expect(received[0]).not.toHaveProperty("providerSummary");
		},
	);
});
