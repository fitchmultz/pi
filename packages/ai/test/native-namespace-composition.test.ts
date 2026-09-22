import type { ResponsesClientEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { openAICodexResponsesApi } from "../src/api/openai-codex-responses.lazy.ts";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import { createModels, createProvider } from "../src/models.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessageEvent, Model, ResponseControl, Tool, ToolResultMessage } from "../src/types.ts";
import { AssistantMessageFrameEncoder, reduceAssistantMessageFrames } from "../src/utils/assistant-message-frame.ts";
import { shortHash } from "../src/utils/hash.ts";
import { findTool, toolKey } from "../src/utils/tool-identity.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { createResponsesServer, type LocalResponsesRequest, replyWithOutput } from "./responses-websocket-server.ts";

afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
});

it.each([false, true])(
	"composes repeated native discovery through Models, provider and direct adapter (Codex=%s)",
	async (codex) => {
		vi.stubGlobal("WebSocket", WebSocket);
		const search: Tool = {
			name: "discover",
			namespace: "catalog",
			description: "Discover",
			parameters: Type.Object({}),
			toolSearch: true,
		};
		const bare: Tool = {
			name: "lookup",
			description: "Bare lookup",
			parameters: Type.Object({ payload: Type.String() }),
			constrainedSampling: { type: "grammar", variants: { openai_regex: ".+" } },
		};
		const real: Tool = {
			name: "lookup",
			namespace: "pi_loaded_real",
			description: "Real namespace",
			parameters: Type.Object({}),
		};
		const wireNamespace = `pi_loaded_${shortHash(toolKey(bare))}`;
		const searchCall = (round: number) => ({
			type: "tool_search_call",
			id: `ts_${round}`,
			call_id: `search_${round}`,
			execution: "client",
			status: "completed",
			arguments: {},
		});
		const grammarCall = (round: number) => ({
			type: "custom_tool_call",
			id: `ctc_${round}`,
			call_id: `call_${round}`,
			name: bare.name,
			namespace: wireNamespace,
			input: `value-${round}`,
			status: "completed",
		});
		let active!: LocalResponsesRequest;
		let control: ResponseControl | undefined;
		const events: AssistantMessageEvent[] = [];
		const fixture = await createResponsesServer((request) => {
			const body = request.body as ResponsesClientEvent;
			if (body.type === "response.steer") {
				const round = body.previous_response_id === "response_1" ? 1 : 2;
				const steer = { id: `steer_${round}`, previous_response_id: body.previous_response_id };
				request.send({ type: "response.steer.accepted", steer });
				active.send({
					type: "response.incomplete",
					response: {
						id: body.previous_response_id,
						status: "incomplete",
						incomplete_details: { reason: "steered" },
						output: [],
						end_turn: false,
					},
				});
				request.send({
					type: "response.steer.pending",
					steer,
					required_input: [{ type: "tool_search_output", call_id: `search_${round}` }],
				});
				return;
			}
			if (body.type !== "response.create") throw new Error("Unexpected event");
			active = request;
			if (!body.previous_response_id) {
				request.send({ type: "response.created", response: { id: "response_1", status: "in_progress" } });
				request.send({ type: "response.output_item.added", output_index: 0, item: searchCall(1) });
				request.send({ type: "response.output_item.done", output_index: 0, item: searchCall(1) });
				return;
			}
			const round = body.previous_response_id === "response_1" ? 1 : 2;
			expect(body.input).toMatchObject([
				{
					type: "tool_search_output",
					call_id: `search_${round}`,
					status: "incomplete",
					tools: [
						{ type: "namespace", name: wireNamespace, tools: [{ type: "custom", name: "lookup" }] },
						{ type: "namespace", name: "pi_loaded_real", tools: [{ type: "function", name: "lookup" }] },
					],
				},
				{
					role: "user",
					content: [
						{ type: "input_text", text: expect.stringContaining("discover") },
						{ type: "input_text", text: "registry service is unavailable" },
						{ type: "input_image", image_url: "data:image/png;base64,ZmFrZQ==" },
					],
				},
			]);
			if (round === 2) {
				replyWithOutput(request, "response_3", [grammarCall(2)], { status: "completed", ...{ end_turn: true } });
				return;
			}
			request.send({ type: "response.created", response: { id: "response_2", status: "in_progress" } });
			const calls = [
				grammarCall(1),
				{
					type: "function_call",
					id: "fc_real",
					call_id: "real",
					name: "lookup",
					namespace: "pi_loaded_real",
					arguments: "{}",
				},
				{
					type: "function_call",
					id: "fc_unknown",
					call_id: "unknown",
					name: "lookup",
					namespace: "pi_loaded_unknown",
					arguments: "{}",
				},
				searchCall(2),
			];
			for (const [output_index, item] of calls.entries()) {
				request.send({ type: "response.output_item.added", output_index, item });
				request.send({ type: "response.output_item.done", output_index, item });
			}
		});
		try {
			const model: Model<"openai-responses" | "openai-codex-responses"> = {
				...fixture.model,
				api: codex ? "openai-codex-responses" : "openai-responses",
				provider: codex ? "openai-codex" : "openai",
				input: ["text", "image"],
				compat: {
					supportsToolSearch: true,
					supportsAdditionalTools: true,
					supportsSteering: true,
					supportsAsyncTools: true,
					supportsOpenAIGrammarTools: true,
				},
			};
			const models = createModels();
			models.setProvider(
				createProvider({
					id: model.provider,
					models: [model],
					api: codex ? openAICodexResponsesApi() : openAIResponsesApi(),
					auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: {} }) } },
				}),
			);
			const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url")}.x`;
			const response = models.streamSimple(
				model,
				normalizeContext({
					tools: [search],
					messages: [{ role: "user", content: "discover twice", timestamp: 1 }],
				}),
				{
					apiKey: codex ? token : "local",
					transport: "websocket",
					timeoutMs: 2000,
					onResponseControl(value) {
						control = value;
					},
				},
			);
			const consume = (async () => {
				for await (const event of response) events.push(structuredClone(event));
			})();
			const results: ToolResultMessage[] = [];
			for (const round of [1, 2]) {
				await vi.waitFor(() =>
					expect(
						events.some(
							(event) => event.type === "toolcall_end" && event.toolCall.id === `search_${round}|ts_${round}`,
						),
						JSON.stringify(events),
					).toBe(true),
				);
				expect(control!.steer({ role: "user", content: `steer-${round}`, timestamp: round })).toBe(true);
				await vi.waitFor(() =>
					expect(events.filter((event) => event.type === "steering" && event.status === "pending")).toHaveLength(
						round,
					),
				);
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: `search_${round}|ts_${round}`,
					toolName: search.name,
					namespace: search.namespace,
					toolCallKind: "toolSearch",
					toolsAdded: [
						{ ...bare, parameters: Type.Object({ [round === 1 ? "payload" : "queryText"]: Type.String() }) },
						real,
					],
					content: [
						{ type: "text", text: "registry service is unavailable" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					isError: true,
					timestamp: round,
				};
				results.push(result);
				control!.submitToolResults([result]);
				control!.submitToolResults([result]);
			}
			await consume;
			const final = await response.result();
			expect(fixture.errors).toEqual([]);
			expect(final.stopReason, final.errorMessage).toBe("toolUse");
			expect(fixture.connections).toHaveLength(1);
			expect(fixture.requests).toHaveLength(5);
			const calls = events.flatMap((event) => (event.type === "toolcall_end" ? [event.toolCall] : []));
			expect(calls.find((call) => call.id === "call_1|ctc_1")).toMatchObject({
				name: "lookup",
				namespace: undefined,
				arguments: { payload: "value-1" },
				responsesItem: { namespace: wireNamespace },
			});
			expect(final.content[0]).toMatchObject({
				name: "lookup",
				namespace: undefined,
				arguments: { queryText: "value-2" },
				responsesItem: { namespace: wireNamespace },
			});
			expect(calls.filter((call) => call.kind === "toolSearch")).toMatchObject([
				{ namespace: "catalog" },
				{ namespace: "catalog" },
			]);
			expect(calls.find((call) => call.id === "real|fc_real")).toMatchObject({ namespace: "pi_loaded_real" });
			expect(findTool([bare], calls.find((call) => call.id === "unknown|fc_unknown")!)).toBeUndefined();
			expect(results.every((result) => result.toolsAdded?.[0].namespace === undefined)).toBe(true);
			expect(events.filter((event) => event.type === "response_end")).toHaveLength(2);
			const starts = events.filter((event) => event.type === "start");
			expect(starts[0]).not.toHaveProperty("continuationInput");
			for (const round of [1, 2]) {
				expect(starts[round].continuationInput).toEqual([
					{ role: "user", content: `steer-${round}`, timestamp: round },
					results[round - 1],
				]);
			}
			expect(events.filter((event) => event.type === "steering").map((event) => event.message.content)).toEqual([
				...Array<string>(4).fill("steer-1"),
				...Array<string>(4).fill("steer-2"),
			]);
			let encoder = new AssistantMessageFrameEncoder();
			let frames = [] as NonNullable<ReturnType<AssistantMessageFrameEncoder["encode"]>>[];
			for (const event of events) {
				if (event.type === "steering") continue;
				if (event.type === "start") {
					encoder = new AssistantMessageFrameEncoder();
					frames = [];
				}
				const frame = encoder.encode(event);
				if (frame) frames.push(frame);
				if (event.type === "done" || event.type === "response_end")
					expect(reduceAssistantMessageFrames(frames)?.content).toEqual(event.message.content);
			}
		} finally {
			await fixture.close();
		}
	},
);
