import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "../src/api/openai-codex-responses.ts";
import { getModel, normalizeContext, completeSimple as runSimple } from "../src/compat.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	ThinkingLevel,
} from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const codexToken = await resolveApiKey("openai-codex");

interface Target {
	name: string;
	// GPT-6.2 is the first model that removes reasoning after edits of earlier input.
	model: Model<Api>;
	apiKey: string | undefined;
	options?: SimpleStreamOptions;
}

const targets: Target[] = [
	{ name: "OpenAI", model: getModel("openai", "gpt-6.2-sol"), apiKey: process.env.OPENAI_API_KEY },
	{
		name: "Codex over SSE",
		model: getModel("openai-codex", "gpt-6.2-sol"),
		apiKey: codexToken,
		options: { transport: "sse" },
	},
	{
		// WebSocket continuation sends only the new input after previous_response_id.
		name: "Codex over WebSocket",
		model: getModel("openai-codex", "gpt-6.2-sol"),
		apiKey: codexToken,
		options: { transport: "websocket", sessionId: "pi-e2e-reasoning-replay" },
	},
];

const lookup = {
	name: "lookup",
	description: "Look up a numeric value by key.",
	parameters: Type.Object({ key: Type.String() }),
};

const customLookup = {
	name: "custom_lookup",
	description: "Look up a tag using a lowercase ASCII word.",
	parameters: Type.Object({ tag: Type.String() }),
	constrainedSampling: {
		type: "grammar" as const,
		variants: {
			openai_lark: "start: /[a-z]+/",
		},
	},
};

function reasoningIds(message: AssistantMessage): string[] {
	return message.content.flatMap((block) =>
		block.type === "thinking" && block.thinkingSignature
			? [(JSON.parse(block.thinkingSignature) as { id: string }).id]
			: [],
	);
}

function removals(message: AssistantMessage): unknown[] {
	return (message.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "openai_input_transformations")
		.flatMap((diagnostic) => diagnostic.details?.transformations as unknown[]);
}

describe.each(targets)("$name reasoning replay conformance", (target) => {
	async function request(context: Context, reasoning: ThinkingLevel): Promise<AssistantMessage> {
		const result = await runSimple(target.model, context, {
			...target.options,
			apiKey: target.apiKey,
			reasoning,
			maxTokens: 4000,
		});
		expect(result.stopReason, result.errorMessage).not.toBe("error");
		return result;
	}

	it.skipIf(!target.apiKey)(
		"replays reasoning without removals until earlier input is edited",
		{ timeout: 300000 },
		async () => {
			const context: Context = {
				systemPrompt: "You are a terse assistant.",
				tools: [lookup],
				messages: [
					{
						role: "user",
						content:
							"First think about which prime factors 982451653 has, then call the lookup tool with key 'alpha'. Then reply with the looked-up value multiplied by 961748941, only the integer.",
						timestamp: 1,
					},
				],
			};
			const toolUse = await request(context, "medium");
			expect(toolUse.stopReason).toBe("toolUse");
			const call = toolUse.content.find((block) => block.type === "toolCall");
			if (call?.type !== "toolCall") throw new Error("Expected a lookup tool call");
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: "lookup",
				content: [{ type: "text", text: "7919" }],
				isError: false,
				timestamp: 2,
			};

			// Same turn after the tool result.
			context.messages.push(toolUse, toolResult);
			const answer = await request(context, "medium");
			expect(removals(answer)).toEqual([]);

			// Next turn with a thinking level change, which goes out as a configuration_update item.
			context.messages.push(answer, {
				role: "user",
				content: "Multiply that by 982451653. Only the integer.",
				timestamp: 3,
			});
			const higherEffort = await request(context, "high");
			expect(removals(higherEffort)).toEqual([]);

			// Next turn after a mid-conversation system update.
			context.messages.push(
				higherEffort,
				{ role: "system", content: "From now on, answer in German words.", timestamp: 4 },
				{
					role: "user",
					content: "Compute the digit sum of that number, then square it. Only the integer.",
					timestamp: 5,
				},
			);
			const afterSystemUpdate = await request(context, "high");
			expect(removals(afterSystemUpdate)).toEqual([]);

			// Editing the tool result removes the reasoning that followed it, and only that.
			const toolResultIndex = context.messages.indexOf(toolResult);
			context.messages[toolResultIndex] = { ...toolResult, content: [{ type: "text", text: "7907" }] };
			context.messages.push(afterSystemUpdate, { role: "user", content: "Say ok.", timestamp: 6 });
			const afterEdit = await request(context, "high");
			const followingReasoning = [answer, higherEffort, afterSystemUpdate].flatMap(reasoningIds);
			expect(followingReasoning.length).toBeGreaterThan(0);
			expect(removals(afterEdit)).toEqual(
				followingReasoning.map((id) => ({ type: "reasoning", id, action: "removed", reason: "prefix_mismatch" })),
			);
		},
	);
});

describe("Codex WebSocket to full-replay tool call status conformance", () => {
	it.skipIf(!codexToken)(
		"preserves reasoning when switching from WebSocket continuation to full replay after function and custom tool calls",
		{ timeout: 300000 },
		async () => {
			const model = getModel("openai-codex", "gpt-6.2-sol");
			const sessionId = `pi-e2e-ws-full-replay-${Date.now()}`;
			resetOpenAICodexWebSocketDebugStats(sessionId);
			const context: Context = {
				systemPrompt: "You are a terse assistant.",
				tools: [lookup, customLookup],
				messages: [
					{
						role: "user",
						content:
							"Call both lookup with key 'alpha' and custom_lookup with tag 'beta' in this turn, then after results reply with only their sum.",
						timestamp: 1,
					},
				],
			};

			const seenTools = new Set<string>();
			let wsAnswer: AssistantMessage | undefined;
			for (let turn = 0; turn < 4; turn++) {
				const reply = await runSimple(model, context, {
					apiKey: codexToken,
					transport: "websocket-cached",
					sessionId,
					reasoning: "medium",
					maxTokens: 4000,
				});
				expect(reply.stopReason, reply.errorMessage).not.toBe("error");
				if (turn > 0) expect(removals(reply)).toEqual([]);
				context.messages.push(reply);
				const calls = reply.content.filter((block) => block.type === "toolCall");
				if (calls.length === 0) {
					wsAnswer = reply;
					break;
				}
				for (const [index, call] of calls.entries()) {
					seenTools.add(call.name);
					context.messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: call.name === "lookup" ? "17" : "25" }],
						isError: false,
						timestamp: 2 + turn * 10 + index,
					});
				}
			}
			expect(seenTools.has("lookup")).toBe(true);
			expect(seenTools.has("custom_lookup")).toBe(true);
			expect(wsAnswer).toBeDefined();
			const wsStats = getOpenAICodexWebSocketDebugStats(sessionId);
			expect(wsStats?.deltaRequests ?? 0).toBeGreaterThanOrEqual(1);
			expect(wsStats?.lastPreviousResponseId).toBeTruthy();

			// Next turn switches to SSE with the same sessionId, forcing full input replay without previous_response_id.
			context.messages.push({
				role: "user",
				content: "Multiply that sum by 3. Only the integer.",
				timestamp: 100,
			});
			let fullReplayPreviousResponseId: string | undefined = "sentinel";
			const fullReplay = await runSimple(model, context, {
				apiKey: codexToken,
				transport: "sse",
				sessionId,
				reasoning: "medium",
				maxTokens: 4000,
				onPayload: (payload) => {
					fullReplayPreviousResponseId = (payload as { previous_response_id?: string }).previous_response_id;
				},
			});
			expect(fullReplayPreviousResponseId).toBeUndefined();
			expect(fullReplay.stopReason, fullReplay.errorMessage).not.toBe("error");
			expect(removals(fullReplay)).toEqual([]);
		},
	);
});

describe("Codex providerSummary compaction conformance", () => {
	it.skipIf(!codexToken)(
		"preserves kept GPT-6.2 reasoning across compaction_trigger with zero prefix_mismatch",
		{ timeout: 180000 },
		async () => {
			const model = getModel("openai-codex", "gpt-6.2-sol");
			const base = normalizeContext({
				systemPrompt: "You are a careful math assistant.",
				tools: [lookup],
				messages: [
					{
						role: "user",
						content:
							"First think about which prime factors 982451653 has, then call lookup with key 'alpha'. After getting the result, multiply it by 961748941 and reply with only the integer.",
						timestamp: 1,
					},
				],
			});
			const turn1 = await runSimple(model, base, {
				apiKey: codexToken,
				transport: "sse",
				reasoning: "high",
				maxTokens: 4000,
			});
			expect(turn1.stopReason, turn1.errorMessage).toBe("toolUse");
			const call = turn1.content.find((block) => block.type === "toolCall");
			if (call?.type !== "toolCall") throw new Error("Expected lookup tool call");
			const tr1: Message = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: "lookup",
				content: [{ type: "text", text: "7919" }],
				isError: false,
				timestamp: 2,
			};

			const beforeTurn2 = { ...base, messages: [...base.messages, turn1, tr1] };
			const turn2 = await runSimple(model, beforeTurn2, {
				apiKey: codexToken,
				transport: "sse",
				reasoning: "high",
				maxTokens: 4000,
			});
			expect(turn2.stopReason, turn2.errorMessage).not.toBe("error");
			expect(reasoningIds(turn2).length).toBeGreaterThan(0);

			const summaryReply = await runSimple(model, beforeTurn2, {
				apiKey: codexToken,
				transport: "auto",
				reasoning: "high",
				disableContinuation: true,
				providerSummary: {},
				maxTokens: 4000,
			});
			expect(summaryReply.stopReason, summaryReply.errorMessage).toBe("stop");
			expect(summaryReply.providerSummary?.block).toMatchObject({ type: "compaction" });

			const leadWithBlock: SystemMessage = {
				...(base.messages[0] as SystemMessage),
				providerSummary: { ...summaryReply.providerSummary!, timestamp: 10 },
			};
			const compactedReply = await runSimple(
				model,
				{
					...base,
					messages: [
						leadWithBlock,
						turn2,
						{ role: "user", content: "Divide that previous answer by 7919. Only the integer.", timestamp: 11 },
					],
				},
				{
					apiKey: codexToken,
					transport: "sse",
					reasoning: "low",
					maxTokens: 4000,
				},
			);
			expect(compactedReply.stopReason, compactedReply.errorMessage).not.toBe("error");
			expect(removals(compactedReply)).toEqual([]);
		},
	);
});
