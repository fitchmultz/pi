import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ResponsesClientEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { streamSimple as streamCodex } from "../../../ai/src/api/openai-codex-responses.ts";
import { streamSimple as streamResponses } from "../../../ai/src/api/openai-responses.ts";
import { cleanupSessionResources } from "../../../ai/src/session-resources.ts";
import {
	createResponsesServer,
	type LocalResponsesRequest,
	replyWithOutput,
	textOutput,
} from "../../../ai/test/responses-websocket-server.ts";
import { createHarness } from "./harness.ts";

const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url")}.x`;
const parentUsage = {
	input_tokens: 400_000,
	output_tokens: 100_000,
	total_tokens: 500_000,
	input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
	output_tokens_details: { reasoning_tokens: 0 },
};
const reasoning = { type: "reasoning", id: "rs_parent", encrypted_content: "opaque-test", summary: [] };

afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
});

it.each([
	{ api: "openai-responses", omitInput: false },
	{ api: "openai-codex-responses", omitInput: false },
	{ api: "openai-responses", omitInput: true },
	{ api: "openai-codex-responses", omitInput: true },
] as const)(
	"retains the measured $api successor without restoring hook-omitted input ($omitInput)",
	async ({ api, omitInput }) => {
		vi.stubGlobal("WebSocket", WebSocket);
		let parent: LocalResponsesRequest | undefined;
		const fixture = await createResponsesServer((request) => {
			const body = request.body as ResponsesClientEvent;
			if (body.type === "response.steer") {
				request.send({ type: "response.steer.accepted", steer: { id: "steer", previous_response_id: "parent" } });
				parent!.send({
					type: "response.incomplete",
					response: {
						id: "parent",
						status: "incomplete",
						incomplete_details: { reason: "steered" },
						output: [reasoning],
						usage: parentUsage,
					},
				});
				replyWithOutput(request, "successor", [textOutput("successor", "answer")], {
					usage: {
						input_tokens: 500_000,
						output_tokens: 10_000,
						total_tokens: 510_000,
						input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				});
			} else {
				parent = request;
				request.send({ type: "response.created", response: { id: "parent", status: "in_progress" } });
				request.send({ type: "response.output_item.added", output_index: 0, item: reasoning });
				request.send({ type: "response.output_item.done", output_index: 0, item: reasoning });
			}
		});
		const starts = vi.fn();
		const contexts = vi.fn();
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						starts();
						return { systemPrompt: "s".repeat(400) };
					});
					pi.on("context", (event) => {
						contexts();
						return omitInput
							? { messages: event.messages.filter((message) => message.role !== "user") }
							: undefined;
					});
				},
			],
		});
		const session = harness.session;
		const model = {
			...harness.getModel(),
			api,
			id: "gpt-6-astra",
			baseUrl: fixture.baseUrl,
			contextWindow: 600_000,
			compat: { supportsSteering: true },
		};
		session.agent.state.model = model;
		session.agent.streamFunction = (_selected, context, options) =>
			api === "openai-responses"
				? streamResponses({ ...model, api }, context, {
						...options,
						apiKey: "local",
						transport: "websocket",
						timeoutMs: 1500,
					})
				: streamCodex({ ...model, api }, context, {
						...options,
						apiKey: token,
						transport: "websocket",
						timeoutMs: 1500,
					});
		try {
			const run = session.prompt("original");
			await vi.waitFor(() =>
				expect(
					harness
						.eventsOfType("message_update")
						.some((event) => event.assistantMessageEvent.type === "thinking_end"),
				).toBe(true),
			);
			await session.steer("steering input");
			await run;
			expect(fixture.errors).toEqual([]);
			expect(starts).toHaveBeenCalledOnce();
			expect(contexts).toHaveBeenCalledOnce();
			expect(fixture.requests.map((request) => request.body.type)).toEqual(["response.create", "response.steer"]);
			expect(
				session.messages
					.filter((message) => message.role === "assistant")
					.map((message) => message.usage.totalTokens),
			).toEqual([500_000, 510_000]);
			if (omitInput) {
				expect(session.getContextUsage()).toMatchObject({ source: "estimated" });
				expect(session.getContextUsage()!.tokens!).toBeLessThan(10_000);
			} else {
				expect(session.getContextUsage()).toMatchObject({ tokens: 510_000, source: "reported" });
			}
			session.extensionRunner.createCommandContext().getSystemPromptOptions().forceSystemPrompt = "s".repeat(800);
			if (omitInput) expect(session.getContextUsage()!.tokens!).toBeLessThan(10_000);
			else expect(session.getContextUsage()).toMatchObject({ tokens: 510_100, source: "estimated" });
		} finally {
			await session.abort();
			harness.cleanup();
			await fixture.close();
		}
	},
);

it("keeps opaque usage through late admission and detach snapshots, but rejects provider-visible edits", async () => {
	const call = {
		type: "function_call",
		id: "fc_work",
		call_id: "work",
		name: "work",
		arguments: "{}",
		async: true,
		status: "completed",
	};
	const fixture = await createResponsesServer((request) => {
		replyWithOutput(request, "opaque-parent", [reasoning, call], { usage: parentUsage });
	});
	let releasePreflight!: () => void;
	const preflight = new Promise<void>((resolve) => {
		releasePreflight = resolve;
	});
	const execute = vi.fn<AgentTool["execute"]>(async (_id, _args, signal) => {
		if (!signal!.aborted)
			await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
		return { content: [], details: undefined, pending: true };
	});
	const harness = await createHarness({
		tools: [{ name: "work", label: "Work", description: "Work", async: true, parameters: Type.Object({}), execute }],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", async () => {
					await preflight;
				});
			},
		],
	});
	const session = harness.session;
	const model = {
		...harness.getModel(),
		api: "openai-responses" as const,
		id: "gpt-6-astra",
		baseUrl: fixture.baseUrl,
		contextWindow: 600_000,
		compat: { supportsAsyncTools: true, supportsSteering: true },
	};
	session.agent.state.model = model;
	session.agent.streamFunction = (_selected, context, options) =>
		streamResponses(model, context, { ...options, apiKey: "local", transport: "websocket", timeoutMs: 1500 });
	try {
		const run = session.prompt("original");
		await vi.waitFor(() =>
			expect(harness.eventsOfType("message_end").some((event) => event.message.role === "assistant")).toBe(true),
		);
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_000, source: "reported" });
		releasePreflight();
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_000, source: "reported" });
		await session.abort();
		await run;
		expect(session.getPendingToolCalls()).toMatchObject([{ state: "detached" }]);
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_000, source: "reported" });
		session.refreshContext();
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_000, source: "reported" });
		expect(session.getSessionStats()).toMatchObject({ assistantMessages: 1, tokens: { total: 500_000 } });
		const saved = structuredClone(session.messages);
		for (const change of [
			"clone",
			"undefined namespace",
			"arguments",
			"wire item",
			"reasoning",
			"namespace",
			"deleted input",
		]) {
			session.agent.state.messages = structuredClone(saved);
			const response = session.messages.find(
				(message): message is AssistantMessage => message.role === "assistant",
			)!;
			const toolCall = response.content.find((block) => block.type === "toolCall")!;
			if (change === "undefined namespace") toolCall.namespace = undefined;
			if (change === "arguments") toolCall.arguments = { changed: true };
			if (change === "wire item" && toolCall.responsesItem?.type === "function_call")
				toolCall.responsesItem.arguments = '{"changed":true}';
			if (change === "reasoning")
				response.content.find((block) => block.type === "thinking")!.thinkingSignature = "changed opaque data";
			if (change === "namespace") toolCall.namespace = "different";
			if (change === "deleted input")
				session.agent.state.messages = session.messages.filter((message) => message.role !== "user");
			if (change === "clone" || change === "undefined namespace")
				expect(session.getContextUsage(), change).toMatchObject({ tokens: 500_000, source: "reported" });
			else {
				expect(session.getContextUsage(), change).toMatchObject({ source: "estimated" });
				expect(session.getContextUsage()!.tokens!, change).toBeLessThan(500_000);
			}
		}
	} finally {
		releasePreflight();
		await session.abort();
		harness.cleanup();
		await fixture.close();
	}
});
