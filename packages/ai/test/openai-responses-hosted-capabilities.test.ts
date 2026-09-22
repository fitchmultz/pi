import type { ResponseInputItem } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import { createResponsesControl } from "../src/api/openai-responses-control.ts";
import { convertResponsesMessages, convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../src/types.ts";
import { mergeAssistantCheckpoint, normalizeContext, toToolDeclaration } from "../src/utils/transcript.ts";
import { createResponsesServer, replyWithOutput, textOutput } from "./responses-websocket-server.ts";

const providers = new Set(["openai"]);
const program = {
	type: "program",
	id: "prog_1",
	call_id: "program_1",
	code: "text(await tools.read({}));",
	fingerprint: "opaque-program",
};
const caller = { type: "program", caller_id: "program_1" };
const toolCall = {
	type: "function_call",
	id: "fc_1",
	call_id: "call_1",
	name: "read",
	arguments: "{}",
	status: "completed",
	caller,
};
const result: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call_1|fc_1",
	toolName: "read",
	content: [{ type: "text", text: '{"value":3}' }],
	isError: false,
	timestamp: 1,
};
const prompt = { role: "user" as const, content: "go", timestamp: 1 };
const options = { apiKey: "local-fixture", transport: "sse" as const, maxRetries: 0 };

describe("hosted Responses state", () => {
	it("does not reinject results already delivered by a steering continuation", () => {
		const model = getBuiltinModel("openai", "gpt-6-astra");
		const sent: unknown[] = [];
		const controller = createResponsesControl(
			{ ...model, compat: { supportsSteering: true } },
			{ model: model.id, multi_agent: { enabled: true } },
			(event) => {
				sent.push(event);
			},
			() => {},
			() => {},
		);
		const handle = (event: unknown) => controller.handle(event as Parameters<typeof controller.handle>[0]);
		handle({ type: "response.created", response: { id: "first" } });
		handle({ type: "response.output_item.done", output_index: 0, item: toolCall });
		controller.control.steer(prompt);
		handle({ type: "response.steer.accepted", steer: { id: "steer", previous_response_id: "first" } });
		handle({ type: "response.completed", response: { id: "first", status: "completed", output: [toolCall] } });
		handle({
			type: "response.steer.pending",
			steer: { id: "steer", previous_response_id: "first" },
			required_input: [{ type: "function_call_output", call_id: "call_1" }],
		});
		controller.control.submitToolResults([result]);
		handle({ type: "response.created", response: { id: "second" } });
		controller.control.submitToolResults([result]);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatchObject({
			type: "response.create",
			previous_response_id: "first",
			input: [{ type: "function_call_output", caller }],
		});
		expect(controller.control.deliveredToolCallIds.has(result.toolCallId)).toBe(true);
	});

	it("reports response_not_found as an injection protocol failure without marking the result delivered", () => {
		const model = getBuiltinModel("openai", "gpt-6-astra");
		const controller = createResponsesControl(
			model,
			{ model: model.id, multi_agent: { enabled: true } },
			() => {},
			() => {},
			() => {},
		);
		const handle = (event: unknown) => controller.handle(event as Parameters<typeof controller.handle>[0]);
		handle({ type: "response.created", response: { id: "active" } });
		handle({ type: "response.output_item.done", output_index: 0, item: toolCall });
		controller.control.submitToolResults([result]);
		expect(() =>
			handle({
				type: "response.inject.failed",
				response_id: "active",
				input: [{ type: "function_call_output", call_id: "call_1", output: "saved" }],
				error: { code: "response_not_found", message: "gone" },
			}),
		).toThrow("response_not_found");
		expect(controller.control.deliveredToolCallIds.size).toBe(0);
	});

	it("uses HTTP for hosted multi-agent clients without live control and normalizes unsupported request fields", async () => {
		const server = await createResponsesServer((request) => replyWithOutput(request, "resp", [textOutput("final")]));
		try {
			const model = { ...server.model, compat: { supportsReasoningEffortUpdates: true, supportsAsyncTools: true } };
			const first = await stream(model, normalizeContext({ messages: [prompt] }), {
				...options,
				reasoningEffort: "low",
			}).result();
			const answer = await stream(
				model,
				normalizeContext({
					messages: [prompt, first, prompt],
					tools: [{ name: "read", description: "Read", parameters: Type.Object({}), async: true }],
				}),
				{
					...options,
					transport: "websocket",
					reasoningEffort: "high",
					onPayload(payload) {
						Object.assign(payload as object, {
							multi_agent: { enabled: true },
							max_tool_calls: 10,
							parallel_tool_calls: true,
						});
					},
				},
			).result();
			expect(answer.stopReason).toBe("stop");
			expect(server.requests[1].transport).toBe("sse");
			expect(server.requests[1].body.parallel_tool_calls).toBe(false);
			expect(server.requests[1].body.max_tool_calls).toBeUndefined();
			expect(server.requests[1].body.reasoning).toEqual({ effort: "high" });
			expect(
				(server.requests[1].body.input as ResponseInputItem[]).some((item) => item.type === "configuration_update"),
			).toBe(false);
		} finally {
			await server.close();
		}
	});

	it.each(["completed", "incomplete", "failed"] as const)(
		"only continues successful commentary-only hosted output (%s)",
		async (status) => {
			const item = { ...textOutput("comment", "working"), phase: "commentary" };
			const server = await createResponsesServer((request) => {
				request.send({ type: "response.created", response: { id: "resp", status: "in_progress" } });
				request.send({
					type: `response.${status}`,
					response: {
						id: "resp",
						status,
						output: [item],
						...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
						...(status === "failed" ? { error: { code: "server_error", message: "fixture failure" } } : {}),
					},
				});
				request.end();
			});
			try {
				const answer = await stream(server.model, normalizeContext({ messages: [prompt] }), {
					...options,
					samplingParams: { tools: [{ type: "programmatic_tool_calling" }] },
				}).result();
				expect(answer.needsContinuation === true).toBe(status === "completed");
				expect(answer.stopReason).toBe(
					status === "completed" ? "stop" : status === "incomplete" ? "length" : "error",
				);
			} finally {
				await server.close();
			}
		},
	);

	it("replays authoritative ordered items once after JSON restart and preserves same-family state", async () => {
		const items = [
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-reasoning" },
			program,
			toolCall,
			{
				type: "multi_agent_call",
				id: "ma_1",
				call_id: "spawn",
				action: "spawn_agent",
				arguments: "{}",
				agent: { agent_name: "/root" },
			},
			{
				type: "agent_message",
				id: "am_1",
				author: "/root/child",
				recipient: "/root",
				content: [{ type: "encrypted_content", encrypted_content: "encrypted-message" }],
				agent: { agent_name: "/root" },
			},
			{
				type: "compaction",
				id: "cmp_1",
				encrypted_content: "encrypted-window",
				agent: { agent_name: "/root/child" },
			},
			{ ...textOutput("child", "child answer"), agent: { agent_name: "/root/child" } },
			{ ...textOutput("root", "root answer"), phase: "final_answer", agent: { agent_name: "/root" } },
		];
		const server = await createResponsesServer((request) => {
			request.send({ type: "response.created", response: { id: "resp", status: "in_progress" } });
			// Out-of-order completion and terminal-only items must retain wire order.
			for (const index of [2, 1])
				request.send({ type: "response.output_item.done", output_index: index, item: items[index] });
			request.send({ type: "response.completed", response: { id: "resp", status: "completed", output: items } });
			request.end();
		});
		try {
			const answer = await stream(server.model, normalizeContext({ messages: [prompt] }), {
				...options,
				samplingParams: { multi_agent: { enabled: true } },
			}).result();
			expect(answer.stopReason).toBe("toolUse");
			expect(answer.content.filter((part) => part.type === "text")).toEqual([
				expect.objectContaining({ text: "root answer" }),
			]);
			expect(answer.responsesOutput).toEqual(items);
			const restarted = JSON.parse(JSON.stringify(answer)) as AssistantMessage;
			for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
				const replay = convertResponsesMessages(
					{ ...server.model, id },
					normalizeContext({ messages: [restarted, result] }),
					providers,
				);
				expect(replay.slice(0, -1)).toEqual(items);
				expect(replay.at(-1)).toEqual({
					type: "function_call_output",
					call_id: "call_1",
					output: '{"value":3}',
					caller,
				});
			}
			const foreign = convertResponsesMessages(
				{ ...server.model, id: "gpt-5.5" },
				normalizeContext({ messages: [restarted, result] }),
				providers,
			);
			expect(
				foreign.some((item) => item.type === "reasoning" || item.type === "compaction" || item.type === "program"),
			).toBe(false);
			expect(server.requests[0].headers["openai-beta"]).toContain("responses_multi_agent=v1");
		} finally {
			await server.close();
		}
	});

	it("continues program-only successes but not commentary, truncation or failures as final answers", async () => {
		const server = await createResponsesServer((request) => replyWithOutput(request, "resp", [program]));
		try {
			const answer = await stream(server.model, normalizeContext({ messages: [prompt] }), {
				...options,
				samplingParams: { tools: [{ type: "programmatic_tool_calling" }] },
			}).result();
			expect(answer.needsContinuation).toBe(true);
			expect(answer.responsesOutput).toEqual([program]);
		} finally {
			await server.close();
		}
	});

	it("preserves caller for custom calls independently of today's grammar declaration", async () => {
		const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "read", input: "raw", caller };
		const server = await createResponsesServer((request) => replyWithOutput(request, "resp", [program, call]));
		try {
			const answer = await stream(server.model, normalizeContext({ messages: [prompt] }), options).result();
			const replay = convertResponsesMessages(
				server.model,
				normalizeContext({ messages: [answer, { ...result, toolCallId: "call_1|ctc_1" }] }),
				providers,
			);
			expect(replay).toEqual([
				program,
				call,
				{ type: "custom_tool_call_output", call_id: "call_1", output: '{"value":3}', caller },
			]);
		} finally {
			await server.close();
		}
	});

	it.each(["error", "pending"] as const)(
		"does not resurrect unadmitted calls from a %s raw prefix",
		async (status) => {
			const extra = { ...toolCall, id: "fc_2", call_id: "call_2" };
			const server = await createResponsesServer((request) =>
				replyWithOutput(request, "resp", [program, extra, toolCall]),
			);
			try {
				const answer = await stream(server.model, normalizeContext({ messages: [prompt] }), options).result();
				answer.stopReason = status;
				const admitted = answer.content.find(
					(part): part is ToolCall => part.type === "toolCall" && part.id === result.toolCallId,
				)!;
				admitted.executionStarted = true;
				if (status === "pending") answer.content = [admitted];
				const replay = convertResponsesMessages(
					server.model,
					normalizeContext({ messages: [answer, result] }),
					providers,
				);
				expect(replay.filter((item) => item.type === "function_call")).toEqual([toolCall]);
				expect(replay[0]).toEqual(program);
			} finally {
				await server.close();
			}
		},
	);

	it("round trips eligibility/schema and rejects programmatic async tools", () => {
		const tool = {
			name: "read",
			description: "Read",
			parameters: Type.Object({}),
			allowedCallers: ["programmatic" as const],
			outputSchema: { type: "object", properties: { value: { type: "number" } } },
		};
		const declaration = toToolDeclaration(tool);
		expect(declaration).toMatchObject(tool);
		expect(convertResponsesTools([declaration], { toolSearchResult: true })[0]).toMatchObject({
			allowed_callers: ["programmatic"],
			output_schema: tool.outputSchema,
			defer_loading: true,
		});
		expect(() => convertResponsesTools([{ ...tool, async: true }], { supportsAsyncTools: true })).toThrow(
			"cannot combine",
		);
	});

	it("retains program and compaction state when replacing a search-loaded tool set", async () => {
		const searchItem = {
			type: "tool_search_call",
			id: "search_item",
			agent: { agent_name: "/root/child" },
			call_id: "search_call",
			execution: "client",
			status: "completed",
			arguments: {},
		};
		const compaction = { type: "compaction", id: "cmp", encrypted_content: "window" };
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, "resp", [searchItem, program, toolCall, compaction]),
		);
		try {
			const model = { ...server.model, compat: { supportsToolSearch: true } };
			const tools = [
				{ name: "search", description: "Search", parameters: Type.Object({}), toolSearch: true as const },
			];
			const answer = await stream(model, normalizeContext({ messages: [prompt], tools }), options).result();
			const replay = convertResponsesMessages(
				model,
				normalizeContext({
					tools,
					messages: [
						answer,
						{
							...result,
							toolCallId: "search_call|search_item",
							toolName: "search",
							toolCallKind: "toolSearch",
							toolsAdded: [],
						},
						result,
						{ role: "system", content: "", toolsRemoved: [{ name: "search" }], timestamp: 2 },
					],
				}),
				providers,
				{ supportsToolSearch: true },
			);
			expect(replay).toContainEqual(program);
			expect(replay).toContainEqual(compaction);
			expect(replay).toContainEqual(toolCall);
			expect(replay.find((item) => item.type === "function_call" && item.call_id === "search_call")).toMatchObject({
				name: "search",
				agent: { agent_name: "/root/child" },
			});
			expect(replay.some((item) => item.type === "tool_search_call" || item.type === "tool_search_output")).toBe(
				false,
			);
		} finally {
			await server.close();
		}
	});

	it("keeps complete native state when an older admission checkpoint arrives", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, "resp", [program, toolCall, textOutput("final")]),
		);
		try {
			const answer = await stream(server.model, normalizeContext({ messages: [prompt] }), options).result();
			const checkpoint = structuredClone(answer);
			checkpoint.stopReason = "pending";
			checkpoint.responsesOutput = checkpoint.responsesOutput?.slice(0, 2);
			checkpoint.content = checkpoint.content.filter((part) => part.type === "toolCall");
			(checkpoint.content[0] as ToolCall).executionStarted = true;
			const merged = mergeAssistantCheckpoint(answer, checkpoint);
			expect(merged.responsesOutput).toEqual(answer.responsesOutput);
			expect(merged.content.find((part) => part.type === "toolCall")).toHaveProperty("executionStarted", true);
		} finally {
			await server.close();
		}
	});

	it("restores effort after native compaction and strips positional updates for automatic windows", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, "resp", [
				{ type: "compaction", id: "cmp", encrypted_content: "window" },
				textOutput("final"),
			]),
		);
		try {
			const model = { ...server.model, compat: { supportsReasoningEffortUpdates: true } };
			const first = await stream(model, normalizeContext({ messages: [prompt] }), {
				...options,
				reasoningEffort: "low",
				onPayload(payload) {
					(payload as { input: ResponseInputItem[] }).input.push({ type: "compaction_trigger" });
				},
			}).result();
			expect((server.requests[0].body.input as ResponseInputItem[]).at(-1)).toEqual({ type: "compaction_trigger" });
			const context = normalizeContext({ messages: [first, prompt] });
			const replay = convertResponsesMessages(model, context, providers, { reasoningEffort: "high" });
			const userIndex = replay.findIndex((item) => "role" in item && item.role === "user");
			expect(replay[userIndex - 1]).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
			await stream(model, context, {
				...options,
				reasoningEffort: "high",
				samplingParams: { context_management: [{ type: "compaction", compact_threshold: 200000 }] },
			}).result();
			expect(
				(server.requests[1].body.input as ResponseInputItem[]).some((item) => item.type === "configuration_update"),
			).toBe(false);
		} finally {
			await server.close();
		}
	});
});
