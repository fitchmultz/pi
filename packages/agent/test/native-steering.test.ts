import type { ResponsesClientEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { streamSimple } from "../../ai/src/api/openai-responses.ts";
import { cleanupSessionResources } from "../../ai/src/session-resources.ts";
import {
	createResponsesServer,
	type LocalResponsesRequest,
	replyWithOutput,
	textOutput,
} from "../../ai/test/responses-websocket-server.ts";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentTool } from "../src/types.ts";

it.each(["pending", "disconnect", "fresh"] as const)(
	"normal Agent completes native steer %s without repeating accepted input or effects",
	async (mode) => {
		let parent: LocalResponsesRequest | undefined;
		let releaseAsync!: () => void;
		const work = new Promise<void>((resolve) => {
			releaseAsync = resolve;
		});
		const calls = [
			{
				type: "function_call",
				id: "fc_async",
				call_id: "async",
				name: "work",
				arguments: '{"kind":"async"}',
				async: true,
				status: "completed",
			},
			...(mode !== "disconnect"
				? [
						{
							type: "function_call",
							id: "fc_sync",
							call_id: "sync",
							name: "work",
							arguments: '{"kind":"sync"}',
							status: "completed",
						},
					]
				: []),
		];
		const usage = {
			input_tokens: 10,
			output_tokens: 2,
			total_tokens: 12,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		};
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
						output: calls,
						usage,
					},
				});
				if (mode === "disconnect") request.socket!.close();
				else
					request.send({
						type: "response.steer.pending",
						steer: { id: "steer", previous_response_id: "parent" },
						required_input: calls.map((call) => ({ type: "function_call_output", call_id: call.call_id })),
					});
			} else if (body.type === "response.create" && parent) {
				if (mode === "pending") {
					expect(body.previous_response_id).toBe("parent");
					expect(body.input).toEqual(
						calls.map((call) => ({
							type: "function_call_output",
							call_id: call.call_id,
							output: `actual ${call.call_id}`,
						})),
					);
				} else {
					expect(request.connection).not.toBe(parent.connection);
					expect(body.previous_response_id).toBeUndefined();
					const input = Array.isArray(body.input) ? body.input : [];
					expect(
						input.filter(
							(item) =>
								"role" in item && item.role === "user" && JSON.stringify(item).includes("steering input"),
						),
					).toHaveLength(1);
					expect(input.filter((item) => item.type === "function_call")).toHaveLength(mode === "fresh" ? 0 : 1);
					expect(input.filter((item) => item.type === "function_call_output")).toHaveLength(
						mode === "fresh" ? 0 : 1,
					);
					if (mode === "fresh") expect(JSON.stringify(input)).toContain("fresh handoff");
				}
				replyWithOutput(request, "successor", [textOutput("successor", "done")]);
			} else {
				parent = request;
				request.send({ type: "response.created", response: { id: "parent", status: "in_progress" } });
				for (const [output_index, item] of calls.entries()) {
					request.send({ type: "response.output_item.added", output_index, item });
					request.send({ type: "response.output_item.done", output_index, item });
				}
			}
		});
		try {
			const execute = vi.fn<AgentTool["execute"]>(async (_id, args) => {
				const kind = (args as { kind: string }).kind;
				if (kind === "sync") releaseAsync();
				if (mode !== "disconnect" && kind === "async") await work;
				return {
					content: [{ type: "text", text: `actual ${kind}` }],
					details: undefined,
					...(mode === "fresh" && kind === "sync" ? { newContext: { handoff: "fresh handoff" } } : {}),
				};
			});
			const tool: AgentTool = {
				name: "work",
				label: "Work",
				description: "Work",
				parameters: Type.Object({ kind: Type.String() }),
				async: true,
				execute,
			};
			const events: AgentEvent[] = [];
			const agent = new Agent({
				initialState: {
					model: { ...fixture.model, compat: { supportsSteering: true, supportsAsyncTools: true } },
					tools: [tool],
				},
				prepareNextTurnWithContext: ({ newContext, context }) =>
					newContext
						? {
								context: {
									...context,
									messages: [
										{ role: "user", content: newContext.handoff ?? "", timestamp: 3 },
										...context.messages.filter(
											(message) => message.role === "user" && message.content === "steering input",
										),
									],
								},
							}
						: undefined,
				sessionId: `steer-${mode}`,
				streamFn: (_model, context, options) =>
					streamSimple(
						{ ...fixture.model, compat: { supportsSteering: true, supportsAsyncTools: true } },
						context,
						{ ...options, apiKey: "local", timeoutMs: 1500 },
					),
			});
			agent.subscribe((event) => {
				events.push(structuredClone(event));
			});
			const run = agent.prompt("go");
			await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
			agent.steer({ role: "user", content: "steering input", timestamp: 2 });
			await run;
			expect(fixture.errors).toEqual([]);
			expect(execute).toHaveBeenCalledTimes(calls.length);
			expect(
				events.filter((event) => event.type === "message_end" && event.message.role === "toolResult"),
			).toHaveLength(calls.length);
			if (mode === "fresh")
				expect(
					events.some(
						(event) =>
							event.type === "message_end" &&
							event.message.role === "assistant" &&
							event.message.stopReason === "error",
					),
				).toBe(false);
			expect(
				agent.state.messages.filter((message) => message.role === "user" && message.content === "steering input"),
			).toHaveLength(1);
			expect(
				events.filter(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						event.message.responseId === "parent",
				),
			).toHaveLength(1);
			expect(fixture.requests).toHaveLength(3);
		} finally {
			cleanupSessionResources();
			await fixture.close();
		}
	},
);
