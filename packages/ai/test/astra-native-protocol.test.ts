import type { ResponsesClientEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { stream as responsesStream } from "../src/api/openai-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	ResponseControl,
	ToolResultMessage,
} from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	createResponsesServer,
	type LocalResponsesRequest,
	replyWithOutput,
	textOutput,
} from "./responses-websocket-server.ts";

const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url")}.x`;
const usage = {
	input_tokens: 100,
	output_tokens: 10,
	total_tokens: 110,
	input_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 },
	output_tokens_details: { reasoning_tokens: 4 },
};
const nativeModel: Model<"openai-responses"> = {
	id: "gpt-6-astra",
	name: "Astra",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
	contextWindow: 10000,
	maxTokens: 1000,
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	compat: {
		supportsAsyncTools: true,
		supportsSteering: true,
		supportsReasoningEffortUpdates: true,
		supportsExplicitPromptCacheMode: true,
	},
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
function saved(effort: string, id: string): AssistantMessage {
	return {
		role: "assistant",
		api: nativeModel.api,
		provider: nativeModel.provider,
		model: nativeModel.id,
		content: [{ type: "text", text: id }],
		stopReason: "stop",
		timestamp: 1,
		providerThinkingLevel: effort,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
});

it("clamps raw minimal, retains omitted-default encrypted reasoning and filters merged Astra sampling", async () => {
	for (const provider of ["openai", "cloudflare-ai-gateway"] as const) {
		for (const effort of [undefined, "minimal"] as const) {
			let payload: Record<string, unknown> | undefined;
			const response = responsesStream({ ...nativeModel, provider }, context, {
				apiKey: "local",
				transport: "sse",
				reasoningEffort: effort,
				temperature: 0.2,
				samplingParams: { temperature: 0.3, top_p: 0.5, top_logprobs: 3 },
				cacheRetention: "none",
				onPayload(value) {
					payload = value as Record<string, unknown>;
					throw new Error("captured before network");
				},
			});
			await response.result();
			expect(payload?.reasoning).toMatchObject({ effort: effort === undefined ? "medium" : "low" });
			expect(payload?.include).toEqual(["reasoning.encrypted_content"]);
			expect(payload?.prompt_cache_options).toEqual({ mode: "explicit" });
			for (const key of ["temperature", "top_p", "top_logprobs"]) expect(payload).not.toHaveProperty(key);
		}
	}
});

it("holds initial effort stable and emits only positional changes, including omitted medium", async () => {
	let payload: Record<string, unknown> | undefined;
	const history = normalizeContext({
		messages: [
			...context.messages,
			saved("medium", "first"),
			saved("high", "second"),
			{ role: "user", content: "next", timestamp: 2 },
		],
	});
	await responsesStream(nativeModel, history, {
		apiKey: "local",
		reasoningEffort: "max",
		onPayload(value) {
			payload = value as Record<string, unknown>;
			throw new Error("capture");
		},
	}).result();
	expect(payload?.reasoning).toMatchObject({ effort: "medium" });
	expect(
		(payload?.input as { type?: string; reasoning?: unknown }[]).filter(
			(item) => item.type === "configuration_update",
		),
	).toEqual([
		{ type: "configuration_update", reasoning: { effort: "high" } },
		{ type: "configuration_update", reasoning: { effort: "max" } },
	]);
	for (const samplingParams of [
		{ truncation: "auto" },
		{ context_management: [{ type: "compaction" }] },
		{ reasoning: { mode: "pro", effort: "max" } },
	]) {
		await responsesStream(nativeModel, history, {
			apiKey: "local",
			reasoningEffort: "max",
			samplingParams,
			onPayload(value) {
				payload = value as Record<string, unknown>;
				throw new Error("capture");
			},
		}).result();
		expect((payload?.input as { type?: string }[]).some((item) => item.type === "configuration_update")).toBe(false);
	}
});

it.each([false, true])("records failed-response usage before raising (Codex=%s)", async (codex) => {
	const options = {
		apiKey: codex ? token : "local",
		transport: "sse" as const,
		fetch: async () =>
			new Response(
				`data: ${JSON.stringify({ type: "response.failed", response: { id: "failed", status: "failed", usage, output: [], error: { code: "failed", message: "fixture" } } })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			),
	};
	const response = codex
		? codexStream({ ...nativeModel, api: "openai-codex-responses", provider: "openai-codex" }, context, options)
		: responsesStream(nativeModel, context, options);
	const message = await response.result();
	expect(message).toMatchObject({
		stopReason: "error",
		responseId: "failed",
		usage: { input: 65, output: 10, cacheRead: 30, cacheWrite: 5, reasoning: 4, totalTokens: 110 },
	});
	expect(message.usage.cost.total).toBeGreaterThan(0);
});

it("preserves opaque compaction items without manufacturing a text summary", async () => {
	const fixture = await createResponsesServer((request) =>
		replyWithOutput(request, "compact", [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-fixture" }]),
	);
	try {
		const message = await responsesStream({ ...nativeModel, baseUrl: fixture.baseUrl }, context, {
			apiKey: "local",
			transport: "sse",
		}).result();
		expect(message.content).toEqual([
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify({ type: "compaction", id: "cmp_1", encrypted_content: "opaque-fixture" }),
			},
		]);
		expect(
			convertResponsesMessages(nativeModel, normalizeContext({ messages: [message] }), new Set(["openai"])),
		).toEqual([{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-fixture" }]);
	} finally {
		await fixture.close();
	}
});

it("repairs unresolved async calls only on foreign or synchronous routes", () => {
	const message = saved("medium", "call");
	message.content = [
		{
			type: "toolCall",
			id: "call|fc_original",
			name: "work",
			arguments: {},
			async: true,
			executionStarted: true,
			responsesItem: {
				type: "function_call",
				id: "fc_original",
				call_id: "call",
				name: "work",
				arguments: "{}",
				async: true,
			},
		},
	];
	for (const target of [
		nativeModel,
		{ ...nativeModel, provider: "other" },
		{ ...nativeModel, id: "other-model", compat: {} },
	]) {
		const input = convertResponsesMessages(target, normalizeContext({ messages: [message] }), new Set(["openai"]));
		const outputs = input.filter((item) => item.type === "function_call_output");
		if (target === nativeModel) expect(outputs).toEqual([]);
		else expect(outputs).toMatchObject([{ output: expect.stringContaining("outcome is unknown") }]);
	}
});

it("replays late native results adjacently when switching to a synchronous model", () => {
	const message = saved("medium", "call");
	message.content = [
		{
			type: "toolCall",
			id: "call|ctc_original",
			name: "work",
			arguments: { input: "raw command" },
			async: true,
			responsesItem: {
				type: "custom_tool_call",
				id: "ctc_original",
				call_id: "call",
				name: "work",
				input: "raw command",
				async: true,
			},
		},
	];
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call|ctc_original",
		toolName: "work",
		content: [{ type: "text", text: "late" }],
		isError: false,
		timestamp: 3,
	};
	const input = convertResponsesMessages(
		{ ...nativeModel, id: "synchronous-model", compat: {} },
		normalizeContext({ messages: [message, saved("medium", "later answer"), result] }),
		new Set(["openai"]),
	);
	expect(input.map((item) => item.type)).toEqual(["function_call", "function_call_output", "message"]);
	expect(input[0]).not.toHaveProperty("async");
	expect(input[1]).toMatchObject({ call_id: "call", output: "late" });
});

it.each(["error", "aborted"] as const)(
	"repairs completed synchronous calls after %s without duplicating recorded results",
	(stopReason) => {
		for (const recorded of [false, true]) {
			const message = saved("medium", "failed");
			message.stopReason = stopReason;
			message.content = [
				{
					type: "toolCall",
					id: "committed|fc_committed",
					name: "work",
					namespace: "records",
					arguments: {},
					responsesItem: {
						type: "function_call",
						id: "fc_committed",
						call_id: "committed",
						name: "work",
						namespace: "records",
						arguments: "{}",
						status: "completed",
					},
				},
				{ type: "toolCall", id: "partial", name: "work", arguments: {} },
			];
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "committed|fc_committed",
				toolName: "work",
				namespace: "records",
				content: [{ type: "text", text: "actual recorded output" }],
				isError: false,
				timestamp: 2,
			};
			const input = convertResponsesMessages(
				nativeModel,
				normalizeContext({
					messages: [message, ...(recorded ? [result] : []), { role: "user", content: "next", timestamp: 3 }],
				}),
				new Set(["openai"]),
			);
			expect(input.filter((item) => item.type === "function_call")).toMatchObject([{ call_id: "committed" }]);
			expect(input.filter((item) => item.type === "function_call_output")).toEqual([
				{
					type: "function_call_output",
					call_id: "committed",
					output: recorded ? "actual recorded output" : "No result provided",
				},
			]);
		}
	},
);

describe.each([false, true])("native steering (Codex=%s)", (codex) => {
	it.each(["completed", "steered", "pending", "disconnect"] as const)(
		"handles %s parent and preserves per-response usage",
		async (mode) => {
			vi.stubGlobal("WebSocket", WebSocket);
			let parent: LocalResponsesRequest | undefined;
			let control: ResponseControl | undefined;
			const events: AssistantMessageEvent[] = [];
			const steer = { id: "steer1", previous_response_id: "parent" };
			const fixture = await createResponsesServer((request) => {
				const body = request.body as ResponsesClientEvent;
				if (body.type === "response.steer") {
					request.send({ type: "response.steer.accepted", steer });
					parent!.send({
						type: mode === "completed" ? "response.completed" : "response.incomplete",
						response: {
							id: "parent",
							status: mode === "completed" ? "completed" : "incomplete",
							incomplete_details: mode === "completed" ? null : { reason: "steered" },
							output: [],
							end_turn: false,
							usage,
						},
					});
					if (mode === "disconnect") request.socket!.close();
					else if (mode === "pending")
						request.send({
							type: "response.steer.pending",
							steer,
							required_input: [{ type: "function_call_output", call_id: "call1" }],
						});
					else
						replyWithOutput(request, "successor", [textOutput("successor")], {
							status: "completed",
							...{ end_turn: true },
						});
				} else if (body.type === "response.create" && body.previous_response_id) {
					expect(body.previous_response_id).toBe("parent");
					expect(body.input).toEqual([{ type: "function_call_output", call_id: "call1", output: "actual" }]);
					replyWithOutput(request, "successor", [textOutput("successor")], {
						status: "completed",
						...{ end_turn: true },
					});
				} else {
					parent = request;
					request.send({ type: "response.created", response: { id: "parent", status: "in_progress" } });
				}
			});
			try {
				const options = {
					apiKey: codex ? token : "local",
					sessionId: `native-${codex}-${mode}`,
					transport: "websocket" as const,
					timeoutMs: 1500,
					onResponseControl(value: ResponseControl | undefined) {
						control = value;
					},
				};
				const response = codex
					? codexStream(
							{
								...nativeModel,
								baseUrl: fixture.baseUrl,
								api: "openai-codex-responses",
								provider: "openai-codex",
							},
							context,
							options,
						)
					: responsesStream({ ...nativeModel, baseUrl: fixture.baseUrl }, context, options);
				const consume = (async () => {
					for await (const event of response) events.push(structuredClone(event));
				})();
				await vi.waitFor(() => expect(control).toBeDefined());
				const steeringInput = { role: "user" as const, content: "new input", timestamp: 2 };
				expect(control!.steer(steeringInput)).toBe(true);
				steeringInput.content = "edited after send";
				if (mode === "pending") {
					await vi.waitFor(() =>
						expect(events.some((event) => event.type === "steering" && event.status === "pending")).toBe(true),
					);
					const result: ToolResultMessage = {
						role: "toolResult",
						toolCallId: "call1|fc_1",
						toolName: "work",
						content: [{ type: "text", text: "actual" }],
						isError: false,
						timestamp: 3,
					};
					control!.submitToolResults([result, { ...result, toolCallId: "unsent|fc_2" }]);
					result.content = [{ type: "text", text: "edited after send" }];
					control!.submitToolResults([result]);
				}
				await consume;
				const message = await response.result();
				expect(fixture.errors).toEqual([]);
				expect(events.filter((event) => event.type === "response_end")).toHaveLength(1);
				expect(events.find((event) => event.type === "response_end")).toMatchObject({
					message: { endTurn: false },
				});
				expect(events.find((event) => event.type === "start")).not.toHaveProperty("continuationInput");
				if (mode !== "disconnect") {
					expect(message.endTurn).toBe(true);
					expect(events.filter((event) => event.type === "start")[1]).toMatchObject({
						continuationInput: [
							{ role: "user", content: "new input", timestamp: 2 },
							...(mode === "pending"
								? [
										{
											role: "toolResult",
											toolCallId: "call1|fc_1",
											toolName: "work",
											content: [{ type: "text", text: "actual" }],
											isError: false,
											timestamp: 3,
										},
									]
								: []),
						],
					});
				}
				const statuses = events.flatMap((event) => (event.type === "steering" ? [event.status] : []));
				expect(statuses).toEqual(
					mode === "disconnect"
						? ["queued", "accepted", "unknown"]
						: mode === "pending"
							? ["queued", "accepted", "pending", "applied"]
							: ["queued", "accepted", "applied"],
				);
				expect(message.responseId).toBe(mode === "disconnect" ? undefined : "successor");
				expect(message.usage.totalTokens).toBe(mode === "disconnect" ? 0 : 110);
				expect(fixture.requests).toHaveLength(mode === "pending" ? 3 : 2);
			} finally {
				await fixture.close();
			}
		},
	);
});
