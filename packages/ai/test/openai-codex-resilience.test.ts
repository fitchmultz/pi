import type { ResponsesClientEvent } from "openai/resources/responses/responses.js";
import { Agent, WebSocket } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessageEvent, Message, Model, ResponseControl, ToolResultMessage } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { createResponsesServer, replyWithOutput, textOutput } from "./responses-websocket-server.ts";

const servers: Awaited<ReturnType<typeof createResponsesServer>>[] = [];
const dispatcher = new Agent();
const apiKey = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url")}.test`;
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const options = { apiKey, sessionId: "recovery", transport: "auto" as const, timeoutMs: 1000 };

function codexModel(server: Awaited<ReturnType<typeof createResponsesServer>>): Model<"openai-codex-responses"> {
	// Use the same Undici client as Pi, but isolate the test from local proxies.
	class LocalWebSocket extends WebSocket {
		constructor(url: string, init: { headers: Record<string, string> }) {
			super(url, { ...init, dispatcher });
		}
	}
	vi.stubGlobal("WebSocket", LocalWebSocket);
	servers.push(server);
	return { ...server.model, api: "openai-codex-responses", provider: "openai-codex" };
}

afterEach(async () => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
	for (const server of servers.splice(0)) {
		await server.close();
		expect(server.errors).toEqual([]);
	}
});

describe("Codex connection recovery with real sockets", () => {
	it.each([false, true])(
		"rebuilds continuation after steering, retaining saved results once (required result=%s)",
		async (pending) => {
			const steering = { role: "user" as const, content: "user interruption", timestamp: 3 };
			const call = {
				type: "function_call",
				id: "fc_B",
				call_id: "call_B",
				name: "work",
				arguments: "{}",
				async: true,
				status: "completed",
			};
			const successorCall = { ...call, id: "fc_C", call_id: "call_C" };
			const savedResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_B|fc_B",
				toolName: "work",
				content: [{ type: "text", text: "already executed B" }],
				isError: false,
				timestamp: 4,
			};
			const server = await createResponsesServer((request) => {
				const body = request.body as ResponsesClientEvent;
				if (body.type === "response.steer") {
					const steer = { id: "steer_B", previous_response_id: "resp_B" };
					request.send({ type: "response.steer.accepted", steer });
					if (pending) request.send({ type: "response.output_item.done", output_index: 0, item: call });
					request.send({
						type: "response.completed",
						response: { id: "resp_B", status: "completed", output: pending ? [call] : [], end_turn: false },
					});
					if (pending)
						request.send({
							type: "response.steer.pending",
							steer,
							required_input: [{ type: "function_call_output", call_id: "call_B" }],
						});
					else replyWithOutput(request, "resp_C", [successorCall]);
				} else if (body.type === "response.create" && body.previous_response_id === "resp_B") {
					expect(body.input).toEqual([
						{ type: "function_call_output", call_id: "call_B", output: "already executed B" },
					]);
					replyWithOutput(request, "resp_C", [successorCall]);
				} else if (server.requests.length === 1) {
					replyWithOutput(request, "resp_A", [textOutput("A")]);
				} else if (server.requests.length === 2) {
					request.send({ type: "response.created", response: { id: "resp_B" } });
				} else replyWithOutput(request, "resp_D", [textOutput("D")]);
			});
			const model = { ...codexModel(server), compat: { supportsSteering: true, supportsAsyncTools: true } };
			const messages: Message[] = [...context.messages];
			const first = await stream(model, normalizeContext({ messages }), options).result();
			messages.push(first, { role: "user", content: "next", timestamp: 2 });
			let control: ResponseControl | undefined;
			let submitted = false;
			const second = stream(model, normalizeContext({ messages }), {
				...options,
				onResponseControl(value) {
					control = value;
					if (control && !submitted) {
						submitted = true;
						expect(control.steer(steering)).toBe(true);
					}
				},
			});
			const events: AssistantMessageEvent[] = [];
			for await (const event of second) {
				events.push(structuredClone(event));
				if (event.type === "response_end") messages.push(structuredClone(event.message));
				if (event.type === "start") messages.push(...(event.continuationInput ?? []));
				if (event.type === "steering" && event.status === "pending") control!.submitToolResults([savedResult]);
			}
			const successor = await second.result();
			expect(successor).toMatchObject({ responseId: "resp_C", stopReason: "toolUse" });
			expect(events.filter((event) => event.type === "steering" && event.status === "applied")).toHaveLength(1);
			messages.push(successor, {
				...savedResult,
				toolCallId: "call_C|fc_C",
				content: [{ type: "text", text: "already executed C" }],
			});
			const next = await stream(model, normalizeContext({ messages }), options).result();
			expect(next.stopReason).toBe("stop");
			const full = server.requests.at(-1)!;
			expect(full.body.previous_response_id).toBeUndefined();
			expect(full.connection).toBe(1);
			const input = full.body.input;
			if (!Array.isArray(input)) throw new Error("Expected full input items");
			expect(input.filter((item) => "id" in item && item.id === "msg_A")).toHaveLength(1);
			expect(input.filter((item) => "role" in item && item.role === "user")).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ role: "user", content: [{ type: "input_text", text: "next" }] },
				{ role: "user", content: [{ type: "input_text", text: "user interruption" }] },
			]);
			expect(input.filter((item) => item.type === "function_call_output")).toEqual([
				...(pending ? [{ type: "function_call_output", call_id: "call_B", output: "already executed B" }] : []),
				{ type: "function_call_output", call_id: "call_C", output: "already executed C" },
			]);
			messages.push(next, { role: "user", content: "cached again", timestamp: 5 });
			expect((await stream(model, normalizeContext({ messages }), options).result()).stopReason).toBe("stop");
			expect(server.requests.at(-1)?.body).toMatchObject({
				previous_response_id: "resp_D",
				input: [{ role: "user", content: [{ type: "input_text", text: "cached again" }] }],
			});
			expect(server.requests).toHaveLength(pending ? 6 : 5);
			expect(server.connections).toHaveLength(1);
		},
	);

	it.each(["bare", "rate_limits.updated", "response.created", "response.in_progress", "response.failed"] as const)(
		"retries a missing continuation once with fresh full input after %s",
		async (prefix) => {
			const server = await createResponsesServer((request) => {
				if (server.requests.length === 2) {
					if (prefix !== "bare" && prefix !== "response.failed")
						request.send({ type: prefix, response: { id: "resp_rejected" }, rate_limits: [] });
					const error = { code: "previous_response_not_found", message: "Missing continuation" };
					request.send(
						prefix === "response.failed"
							? { type: prefix, response: { id: "resp_rejected", status: "failed", output: [], error } }
							: { type: "error", error },
					);
				} else replyWithOutput(request, `resp_${server.requests.length}`, [textOutput("ok")]);
			});
			const model = { ...codexModel(server), compat: { supportsSteering: true } };
			const first = await stream(model, context, options).result();
			const history = normalizeContext({
				messages: [...context.messages, first, { role: "user", content: "continue", timestamp: 2 }],
			});
			const response = stream(model, history, options);
			const events: string[] = [];
			for await (const event of response) events.push(event.type);
			const result = await response.result();
			expect(result).toMatchObject({ stopReason: "stop", responseId: "resp_3" });
			expect(events.filter((type) => type === "start")).toHaveLength(1);
			expect(events).not.toContain("error");
			expect(server.requests[1].body.previous_response_id).toBe("resp_1");
			expect(server.requests[2].body.previous_response_id).toBeUndefined();
			expect(server.requests[2].body.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				textOutput("ok"),
				{ role: "user", content: [{ type: "input_text", text: "continue" }] },
			]);
			expect(server.requests.map((request) => request.connection)).toEqual([1, 1, 2]);
			expect(result.diagnostics?.find((entry) => entry.type === "provider_request")?.details).toMatchObject({
				missingContinuationRetries: 1,
				websocketAttempts: 2,
				sseAttempts: 0,
			});
		},
	);

	it("stops after a second missing-ID rejection and discards the rejected response metadata", async () => {
		const server = await createResponsesServer((request) => {
			if (server.requests.length === 1) request.send({ type: "response.created", response: { id: "rejected" } });
			request.send({
				type: "error",
				error: { code: "previous_response_not_found", message: "Missing continuation" },
			});
		});
		const result = await stream(
			{ ...codexModel(server), compat: { supportsSteering: true } },
			context,
			options,
		).result();
		expect(result).toMatchObject({ stopReason: "error", content: [] });
		expect(result.responseId).toBeUndefined();
		expect(server.requests.map((request) => request.connection)).toEqual([1, 2]);
	});

	it.each(["sse", "websocket"] as const)(
		"preserves streamed error codes for native retry decisions over %s",
		async (transport) => {
			for (const type of ["response.failed", "error"]) {
				for (const code of ["server_error", "invalid_request_error", "insufficient_quota", undefined]) {
					const error = { code, message: "Sorry, something went wrong." };
					const server = await createResponsesServer((request) => {
						request.send(
							type === "response.failed" ? { type, response: { status: "failed", error } } : { type, error },
						);
					});
					const result = await stream(
						codexModel(server),
						normalizeContext({
							messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
						}),
						{ ...options, transport },
					).result();
					expect(result.stopReason).toBe("error");
					if (code) expect(result.errorMessage).toContain(code);
					expect(isRetryableAssistantError(result)).toBe(code === "server_error");
					expect(server.requests).toHaveLength(1);
				}
			}
		},
	);

	it("reconnects after metadata-only loss without emitting an error or retaining the failed response ID", async () => {
		const server = await createResponsesServer((request) => {
			if (server.requests.length === 1) {
				request.send({ type: "codex.rate_limits", rate_limits: {} });
				request.send({ type: "response.created", response: { id: "resp_lost" } });
				request.send({ type: "response.in_progress", response: { id: "resp_lost" } });
				request.socket?.terminate();
			} else replyWithOutput(request, "resp_recovered", [textOutput("recovered")]);
		});
		const resultStream = stream(codexModel(server), context, options);
		const events: string[] = [];
		for await (const event of resultStream) events.push(event.type);
		const result = await resultStream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp_recovered");
		expect(events.filter((event) => event === "start")).toHaveLength(1);
		expect(events).not.toContain("error");
		expect(server.requests.map((request) => request.transport)).toEqual(["websocket", "websocket"]);
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.requests[1].body.input).toEqual(server.requests[0].body.input);
		const failure = result.diagnostics?.find((entry) => entry.type === "provider_transport_failure");
		expect(failure?.details).toMatchObject({
			responseId: "resp_lost",
			closeCode: 1006,
			eventsEmitted: false,
			socket: { connectionId: expect.stringMatching(/^[0-9a-f-]{36}$/), readableEnded: true },
		});
		expect(server.requests.map((request) => request.headers["x-client-request-id"])).toEqual([
			options.sessionId,
			options.sessionId,
		]);
		expect(failure?.details?.socket).not.toHaveProperty("localCloseReason");
		expect(JSON.stringify(failure?.details)).not.toContain(apiKey);
	});

	it("does not attribute the failed reused socket's send to a stalled reconnect", async () => {
		const server = await createResponsesServer((request) => {
			if (server.requests.length === 2) {
				server.server.removeAllListeners("upgrade");
				server.server.on("upgrade", () => {});
				request.send({ type: "response.created", response: { id: "resp_lost" } });
				request.socket?.terminate();
			} else replyWithOutput(request, "resp_ok", [textOutput("ok")]);
		});
		const model = codexModel(server);
		await stream(model, context, options).result();
		const result = await stream(model, context, { ...options, websocketConnectTimeoutMs: 30 }).result();
		expect(result.stopReason).toBe("stop");
		const failures = result.diagnostics?.filter((entry) => entry.type === "provider_transport_failure");
		expect(failures).toHaveLength(2);
		expect(failures?.[0].details).toMatchObject({ socketReused: true, closeCode: 1006 });
		expect(failures?.[0].details?.fallbackTransport).toBeUndefined();
		expect(failures?.[1].details).toMatchObject({
			localTimeout: "websocket_connect",
			fallbackTransport: "sse",
			socket: { localCloseReason: "connect_timeout" },
		});
		for (const field of [
			"socketReused",
			"socketAgeMs",
			"websocketRequestMode",
			"websocketSendBytes",
			"websocketSendMs",
		]) {
			expect(failures?.[1].details).not.toHaveProperty(field);
		}
	});

	it("bounds reconnects, falls back for one request, and returns to WebSockets", async () => {
		let drops = 2;
		const server = await createResponsesServer((request) => {
			if (request.transport === "websocket" && drops-- > 0) {
				request.send({ type: "response.created", response: { id: "resp_lost" } });
				request.socket?.terminate();
			} else replyWithOutput(request, "resp_ok", [textOutput("ok")]);
		});
		const model = codexModel(server);
		expect((await stream(model, context, options).result()).stopReason).toBe("stop");
		expect((await stream(model, context, options).result()).stopReason).toBe("stop");
		expect(server.requests.map((request) => request.transport)).toEqual([
			"websocket",
			"websocket",
			"sse",
			"websocket",
		]);
	});

	it("lets the agent retry partial output and uses HTTP after two consecutive interrupted responses", async () => {
		let drops = 2;
		const server = await createResponsesServer((request) => {
			if (request.transport === "websocket" && drops-- > 0) {
				request.send({ type: "response.created", response: { id: "resp_partial" } });
				request.send({
					type: "response.output_item.added",
					output_index: 0,
					item: textOutput("partial", "partial"),
				});
				request.socket?.terminate();
			} else replyWithOutput(request, "resp_ok", [textOutput("ok")]);
		});
		const model = codexModel(server);
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await stream(model, context, options).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("WebSocket closed 1006");
		}
		expect((await stream(model, context, options).result()).stopReason).toBe("stop");
		expect((await stream(model, context, options).result()).stopReason).toBe("stop");
		expect(server.requests.map((request) => request.transport)).toEqual([
			"websocket",
			"websocket",
			"sse",
			"websocket",
		]);
	});

	it("does not resend an oversized frame when session caching is disabled", async () => {
		const server = await createResponsesServer((request) => {
			if (request.transport === "websocket") request.socket?.close(1009);
			else replyWithOutput(request, "resp_ok", [textOutput("ok")]);
		});
		const result = await stream(codexModel(server), context, { ...options, cacheRetention: "none" }).result();
		expect(result.stopReason).toBe("stop");
		expect(server.requests.map((request) => request.transport)).toEqual(["websocket", "sse"]);
	});

	it.each(["text", "tool", "hosted-tool", "failed-output", "failed-usage"] as const)(
		"does not replay committed %s when a missing-continuation error arrives",
		async (kind) => {
			const item =
				kind === "text"
					? textOutput("partial")
					: kind === "tool"
						? {
								type: "function_call",
								id: "fc_committed",
								call_id: "committed",
								name: "work",
								arguments: "{}",
								async: true,
							}
						: { type: "web_search_call", id: "search", status: "in_progress" };
			const server = await createResponsesServer((request) => {
				const error = { code: "previous_response_not_found", message: "Missing continuation" };
				if (kind === "failed-output" || kind === "failed-usage") {
					request.send({
						type: "response.failed",
						response: {
							id: "failed",
							status: "failed",
							output: kind === "failed-output" ? [textOutput("partial")] : [],
							usage: { output_tokens: kind === "failed-usage" ? 1 : 0 },
							error,
						},
					});
					return;
				}
				request.send({ type: "response.output_item.added", output_index: 0, item });
				if (kind === "tool") request.send({ type: "response.output_item.done", output_index: 0, item });
				request.send({ type: "error", error });
			});
			const response = stream(codexModel(server), context, options);
			const events: AssistantMessageEvent[] = [];
			for await (const event of response) events.push(event);
			const result = await response.result();
			expect(result.stopReason).toBe("error");
			expect(server.requests).toHaveLength(1);
			expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(kind === "tool" ? 1 : 0);
		},
	);

	it.each([false, true])("does not replay accepted steering (successor gap=%s)", async (gap) => {
		const server = await createResponsesServer((request) => {
			if ((request.body as ResponsesClientEvent).type === "response.steer") {
				request.send({
					type: "response.steer.accepted",
					steer: { id: "accepted", previous_response_id: "parent" },
				});
				if (gap)
					request.send({
						type: "response.completed",
						response: { id: "parent", status: "completed", output: [], end_turn: false },
					});
				request.send({
					type: "error",
					error: { code: "previous_response_not_found", message: "Missing successor" },
				});
			} else request.send({ type: "response.created", response: { id: "parent" } });
		});
		const response = stream({ ...codexModel(server), compat: { supportsSteering: true } }, context, {
			...options,
			onResponseControl(control) {
				control?.steer({ role: "user", content: "accepted input", timestamp: 2 });
			},
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of response) events.push(structuredClone(event));
		expect((await response.result()).stopReason).toBe("error");
		expect(events.filter((event) => event.type === "steering").map((event) => event.status)).toEqual([
			"queued",
			"accepted",
			"unknown",
		]);
		expect(events.filter((event) => event.type === "response_end")).toHaveLength(gap ? 1 : 0);
		expect(server.requests).toHaveLength(2);
		expect(server.connections).toHaveLength(1);
	});

	it.each(["abort", "replace"] as const)("discards the socket after metadata and context %s", async (action) => {
		const controller = new AbortController();
		const server = await createResponsesServer((request) => {
			if (server.requests.length === 1)
				request.send({ type: "response.created", response: { id: "resp_cancelled" } });
			else replyWithOutput(request, "fresh", [textOutput("fresh")]);
		});
		const model = { ...codexModel(server), compat: { supportsSteering: true } };
		const result = await stream(model, context, {
			...options,
			signal: controller.signal,
			onResponseControl(control) {
				if (!control) return;
				if (action === "abort") controller.abort();
				else control.retire();
			},
		}).result();
		expect(result.stopReason).toBe(action === "abort" ? "aborted" : "stop");
		if (action === "replace") expect(result.rawStopReason).toBe("context_replaced");
		expect(server.requests).toHaveLength(1);
		expect(result.diagnostics?.some((entry) => entry.type === "provider_transport_failure")).toBe(false);
		expect((await stream(model, context, options).result()).stopReason).toBe("stop");
		expect(server.requests.map((request) => request.connection)).toEqual([1, 2]);
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.requests[1].body.input).toEqual(server.requests[0].body.input);
	});

	it("records a local idle timeout separately from a remote connection loss", async () => {
		const server = await createResponsesServer((request) => {
			if (request.transport === "sse") replyWithOutput(request, "resp_ok", [textOutput("ok")]);
		});
		const result = await stream(codexModel(server), context, { ...options, timeoutMs: 30 }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.find((entry) => entry.type === "provider_transport_failure")?.details).toMatchObject({
			localTimeout: "websocket_idle",
			socket: { localCloseReason: "idle_timeout" },
		});
	});
});
