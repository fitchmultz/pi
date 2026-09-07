import dns from "node:dns";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { APIConnectionError } from "openai/error";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/api/openai-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessageEvent, Context, ProviderResponse, SimpleStreamOptions } from "../src/types.ts";
import {
	createResponsesServer,
	type LocalResponsesRequest,
	replyWithOutput,
	textOutput,
} from "./responses-websocket-server.ts";

const servers: Awaited<ReturnType<typeof createResponsesServer>>[] = [];

beforeEach(() => {
	vi.stubEnv("NO_PROXY", "*");
	vi.stubEnv("no_proxy", "*");
});

afterEach(async () => {
	cleanupSessionResources();
	vi.unstubAllEnvs();
	for (const server of servers.splice(0)) {
		await server.close();
		expect(server.errors).toEqual([]);
	}
});

describe("native direct Responses WebSockets", () => {
	it("keeps full logical input while sending tool-result-only deltas on one connection", async () => {
		const reasoning = {
			type: "reasoning",
			id: "rs_first",
			summary: [{ type: "summary_text", text: "Need the tool." }],
			encrypted_content: "opaque-reasoning",
		};
		const call = {
			type: "function_call",
			id: "fc_first",
			call_id: "call_first",
			name: "echo",
			arguments: '{"text":"hello"}',
		};
		const server = await createResponsesServer((request) => {
			const first = server.requests.length === 1;
			replyWithOutput(
				request,
				first ? "resp_first" : "resp_second",
				first ? [reasoning, call] : [textOutput("second")],
			);
		});
		servers.push(server);
		const context: Context = {
			systemPrompt: "Stay in the current window.",
			messages: [{ role: "user", content: "Use echo", timestamp: 0 }],
			tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
		};
		const payloads: unknown[] = [];
		const responses: ProviderResponse[] = [];
		const options = {
			apiKey: "local-key",
			sessionId: "persistent-session",
			reasoning: "high" as const,
			onPayload: (payload: unknown) => {
				payloads.push(structuredClone(payload));
			},
			onResponse: (response: ProviderResponse) => {
				responses.push(response);
			},
		};
		const firstStream = streamSimple(server.model, context, options);
		const events: AssistantMessageEvent[] = [];
		for await (const event of firstStream) events.push(event);
		const first = await firstStream.result();
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toEqual([
			{ type: "thinking", thinking: "Need the tool.", thinkingSignature: JSON.stringify(reasoning) },
			{ type: "toolCall", id: "call_first|fc_first", name: "echo", arguments: { text: "hello" } },
		]);
		expect(first.usage).toMatchObject({ input: 70, output: 10, cacheRead: 30, reasoning: 5, totalTokens: 110 });
		expect(first.usage.cost.total).toBeCloseTo(((70 + 20 + 15) * 2) / 1_000_000);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_end",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);
		context.messages.push(first, {
			role: "toolResult",
			toolCallId: "call_first|fc_first",
			toolName: "echo",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: 1,
		});
		const second = await streamSimple(server.model, context, options).result();
		expect(second.stopReason).toBe("stop");
		expect(second.responseId).toBe("resp_second");
		expect(server.connections).toHaveLength(1);
		expect(server.requests.map((request) => request.transport)).toEqual(["websocket", "websocket"]);
		expect(server.requests[0].body).toMatchObject({
			type: "response.create",
			model: "gpt-6-astra",
			store: false,
			reasoning: { effort: "high" },
		});
		expect(server.requests[0].body.stream).toBeUndefined();
		expect(server.requests[0].body.previous_response_id).toBeUndefined();
		expect(server.requests[1].body).toMatchObject({
			previous_response_id: "resp_first",
			store: false,
			input: [{ type: "function_call_output", call_id: "call_first", output: "hello" }],
		});
		expect(server.requests[1].bytes).toBeLessThan(server.requests[0].bytes);
		expect(payloads[1]).toMatchObject({ input: expect.arrayContaining([reasoning, call]) });
		expect(responses).toEqual([
			{ status: 101, headers: expect.objectContaining({ "x-request-id": "local-websocket" }) },
		]);
	});

	it.each(["previous_response_not_found", "websocket_connection_limit_reached"])(
		"recovers %s with full current input on a fresh connection, without duplicate events",
		async (code) => {
			const server = await createResponsesServer((request) => {
				if (server.requests.length === 2) {
					request.send({
						type: "error",
						status: 400,
						error: {
							type: "invalid_request_error",
							code,
							message: "Lost connection state",
							param: "previous_response_id",
						},
					});
					return;
				}
				replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]);
			});
			servers.push(server);
			const context: Context = { messages: [{ role: "user", content: "current-window", timestamp: 0 }] };
			const options = { apiKey: "local-key", sessionId: "recover-session", maxRetries: 0 };
			const first = await streamSimple(server.model, context, options).result();
			context.messages.push(first, { role: "user", content: "next input", timestamp: 1 });
			let logicalPayload: unknown;
			const stream = streamSimple(server.model, context, {
				...options,
				onPayload: (payload) => {
					logicalPayload = structuredClone(payload);
				},
			});
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			expect((await stream.result()).stopReason).toBe("stop");
			expect(server.requests).toHaveLength(3);
			expect(server.connections).toHaveLength(2);
			expect(server.requests[1].body.previous_response_id).toBe("resp_1");
			expect(server.requests[2].body.previous_response_id).toBeUndefined();
			const { type: _type, ...fullRequest } = server.requests[2].body;
			expect({ ...fullRequest, stream: true }).toEqual(logicalPayload);
			expect(events.filter((event) => event.type === "start")).toHaveLength(1);
			expect(events.filter((event) => event.type === "done")).toHaveLength(1);
			expect(events.filter((event) => event.type === "error")).toHaveLength(0);
		},
	);

	it.each([false, true])(
		"honors stream idle timeout after response start=%s without replaying partial output",
		async (startResponse) => {
			const server = await createResponsesServer((request) => {
				if (request.transport === "websocket") {
					if (startResponse)
						request.send({ type: "response.created", response: { id: "resp_partial", status: "in_progress" } });
					return;
				}
				replyWithOutput(request, "resp_http", [textOutput("http")]);
			});
			servers.push(server);
			const stream = streamSimple(
				server.model,
				{ messages: [{ role: "user", content: "current input", timestamp: 0 }] },
				{
					apiKey: "local-key",
					sessionId: "idle-session",
					timeoutMs: 200,
					maxRetries: 2,
					signal: AbortSignal.timeout(3000),
				},
			);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			expect(result.stopReason).toBe(startResponse ? "error" : "stop");
			if (startResponse) expect(result.errorMessage).toContain("idle timeout");
			expect(server.requests.map((request) => request.transport)).toEqual(
				startResponse ? ["websocket"] : ["websocket", "sse"],
			);
			expect(events.filter((event) => event.type === "start")).toHaveLength(1);
			expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
		},
	);

	it("session cleanup cancels an active request rather than falling back to HTTP", async () => {
		const server = await createResponsesServer((request) => {
			if (request.transport === "websocket") cleanupSessionResources("disposed-session");
			else replyWithOutput(request, "unexpected", [textOutput("unexpected")]);
		});
		servers.push(server);
		const result = await streamSimple(
			server.model,
			{ messages: [{ role: "user", content: "current input", timestamp: 0 }] },
			{
				apiKey: "local-key",
				sessionId: "disposed-session",
				maxRetries: 2,
			},
		).result();
		expect(result.stopReason).toBe("aborted");
		expect(server.requests).toHaveLength(1);
	});

	it("uses the existing retry budget for pre-stream protocol errors with real status and retry headers", async () => {
		const server = await createResponsesServer((request) => {
			if (server.requests.length === 1) {
				request.send({
					type: "error",
					status: 429,
					error: {
						type: "rate_limit_error",
						code: "rate_limit_exceeded",
						message: "Try again",
						param: null,
						headers: { "retry-after-ms": "1" },
					},
				});
				return;
			}
			replyWithOutput(request, "resp_retry", [textOutput("retry")]);
		});
		servers.push(server);
		const stream = streamSimple(
			server.model,
			{ messages: [{ role: "user", content: "current input", timestamp: 0 }] },
			{
				apiKey: "local-key",
				sessionId: "retry-session",
				maxRetries: 1,
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		expect((await stream.result()).stopReason).toBe("stop");
		expect(server.connections).toHaveLength(2);
		expect(server.requests.map((request) => request.transport)).toEqual(["websocket", "websocket"]);
		expect(server.requests[1].body).toEqual(server.requests[0].body);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
	});

	it("rejects an excessive server retry delay instead of falling back or waiting", async () => {
		const server = await createResponsesServer((request) => {
			request.send({
				type: "error",
				status: 429,
				error: {
					type: "rate_limit_error",
					code: "rate_limit_exceeded",
					message: "Try again",
					param: null,
					headers: { "retry-after-ms": "100000" },
				},
			});
		});
		servers.push(server);
		const result = await streamSimple(
			server.model,
			{ messages: [{ role: "user", content: "current input", timestamp: 0 }] },
			{
				apiKey: "local-key",
				maxRetries: 1,
				maxRetryDelayMs: 5,
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 100s retry delay");
		expect(server.requests).toHaveLength(1);
	});

	it("does not replay a failing HTTP response hook, even when it throws a network error", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, "unexpected", [textOutput("unexpected")]),
		);
		servers.push(server);
		let calls = 0;
		const result = await streamSimple(
			server.model,
			{ messages: [{ role: "user", content: "current input", timestamp: 0 }] },
			{
				apiKey: "local-key",
				maxRetries: 2,
				onResponse() {
					calls++;
					throw new APIConnectionError({ message: "response hook rejected" });
				},
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("response hook rejected");
		expect(calls).toBe(1);
		expect(server.requests).toHaveLength(0);
	});

	it("sends a first payload larger than the SDK's nominal queue budget intact", async () => {
		const server = await createResponsesServer((request) => replyWithOutput(request, "large", [textOutput("large")]));
		servers.push(server);
		const text = "x".repeat(2 * 1024 * 1024);
		const result = await streamSimple(
			server.model,
			{ messages: [{ role: "user", content: text, timestamp: 0 }] },
			{
				apiKey: "local-key",
				sessionId: "large-session",
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(server.requests.map((request) => request.transport)).toEqual(["websocket"]);
		expect(server.requests[0].bytes).toBeGreaterThan(2 * 1024 * 1024);
		expect(server.requests[0].body.input).toEqual([{ role: "user", content: [{ type: "input_text", text }] }]);
	});

	it.each(["edited history", "fresh window", "model", "thinking", "tools", "instructions", "payload"])(
		"resets the chain for %s, then continues only the new chain",
		async (change) => {
			const server = await createResponsesServer((request) =>
				replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]),
			);
			servers.push(server);
			let model = server.model;
			const context: Context = {
				systemPrompt: "initial instructions",
				messages: [{ role: "user", content: "original input", timestamp: 0 }],
			};
			const options: SimpleStreamOptions = { apiKey: "local-key", sessionId: "reset-session", reasoning: "high" };
			const first = await streamSimple(model, context, options).result();
			context.messages.push(first, { role: "user", content: "next input", timestamp: 1 });
			switch (change) {
				case "edited history":
					context.messages[0] = { role: "user", content: "edited input", timestamp: 0 };
					break;
				case "fresh window":
					context.messages = [{ role: "user", content: "standalone handoff", timestamp: 1 }];
					break;
				case "model":
					model = { ...model, id: "gpt-5.4" };
					break;
				case "thinking":
					options.reasoning = "low";
					break;
				case "tools":
					context.tools = [{ name: "added", description: "New tool", parameters: Type.Object({}) }];
					break;
				case "instructions":
					context.systemPrompt = "revised instructions";
					break;
				case "payload":
					options.onPayload = (payload) => ({ ...(payload as object), temperature: 0.7 });
					break;
			}
			const second = await streamSimple(model, context, options).result();
			expect(second.stopReason).toBe("stop");
			expect(server.requests[1].body.previous_response_id).toBeUndefined();
			expect(JSON.stringify(server.requests[1].body.input)).toContain(
				change === "fresh window" ? "standalone handoff" : "next input",
			);
			context.messages.push(second, { role: "user", content: "after reset", timestamp: 2 });
			expect((await streamSimple(model, context, options).result()).stopReason).toBe("stop");
			expect(server.requests[2].body).toMatchObject({
				previous_response_id: "resp_2",
				input: [{ role: "user", content: [{ type: "input_text", text: "after reset" }] }],
			});
			expect(server.connections).toHaveLength(1);
		},
	);

	it.each(["credentials", "headers", "URL"])("opens a new full-context connection when %s change", async (change) => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]),
		);
		servers.push(server);
		let model = server.model;
		const context: Context = { messages: [{ role: "user", content: "original input", timestamp: 0 }] };
		const options: SimpleStreamOptions = { apiKey: "key-one", sessionId: "identity-session" };
		context.messages.push(await streamSimple(model, context, options).result(), {
			role: "user",
			content: "next input",
			timestamp: 1,
		});
		if (change === "credentials") options.apiKey = "key-two";
		if (change === "headers") options.headers = { "x-account-routing": "other-account" };
		if (change === "URL") model = { ...model, baseUrl: `${model.baseUrl}/other` };
		expect((await streamSimple(model, context, options).result()).stopReason).toBe("stop");
		expect(server.connections).toHaveLength(2);
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.requests[1].headers.authorization).toBe(
			change === "credentials" ? "Bearer key-two" : "Bearer key-one",
		);
		if (change === "headers") expect(server.requests[1].headers["x-account-routing"]).toBe("other-account");
		if (change === "URL") expect(server.requests[1].url).toBe("/v1/other/responses");
	});

	it.each(["websocket", "websocket-cached"] as const)(
		"respects explicit %s continuation behavior",
		async (transport) => {
			const server = await createResponsesServer((request) =>
				replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]),
			);
			servers.push(server);
			const context: Context = { messages: [{ role: "user", content: "original input", timestamp: 0 }] };
			const options = { apiKey: "local-key", sessionId: "explicit-session", transport };
			context.messages.push(await streamSimple(server.model, context, options).result(), {
				role: "user",
				content: "next input",
				timestamp: 1,
			});
			expect((await streamSimple(server.model, context, options).result()).stopReason).toBe("stop");
			expect(server.connections).toHaveLength(1);
			expect(server.requests[1].body.previous_response_id).toBe(transport === "websocket" ? undefined : "resp_1");
			expect(server.requests[1].body.input).toHaveLength(transport === "websocket" ? 3 : 1);
		},
	);

	it.each([{}, { sessionId: "no-cache", cacheRetention: "none" }] as const)(
		"closes one-shot sockets without a cacheable session (%j)",
		async (cacheOptions) => {
			const server = await createResponsesServer((request) =>
				replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]),
			);
			servers.push(server);
			const context: Context = { messages: [{ role: "user", content: "input", timestamp: 0 }] };
			const options = { apiKey: "local-key", ...cacheOptions };
			context.messages.push(await streamSimple(server.model, context, options).result(), {
				role: "user",
				content: "next",
				timestamp: 1,
			});
			expect((await streamSimple(server.model, context, options).result()).stopReason).toBe("stop");
			expect(server.connections).toHaveLength(2);
			expect(
				server.requests.every(
					(request) => request.body.previous_response_id === undefined && request.headers.session_id === undefined,
				),
			).toBe(true);
			await vi.waitFor(() => expect(server.webSockets.clients.size).toBe(0));
		},
	);

	it("recovers a closed cached socket with full current context before starting a new delta chain", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]),
		);
		servers.push(server);
		const context: Context = { messages: [{ role: "user", content: "input", timestamp: 0 }] };
		const options = { apiKey: "local-key", sessionId: "closed-session" };
		context.messages.push(await streamSimple(server.model, context, options).result(), {
			role: "user",
			content: "after close",
			timestamp: 1,
		});
		server.connections[0].close();
		await vi.waitFor(() => expect(server.webSockets.clients.size).toBe(0));
		context.messages.push(await streamSimple(server.model, context, options).result(), {
			role: "user",
			content: "delta",
			timestamp: 2,
		});
		expect((await streamSimple(server.model, context, options).result()).stopReason).toBe("stop");
		expect(server.connections).toHaveLength(2);
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.requests[1].body.input).toHaveLength(3);
		expect(server.requests[2].body.previous_response_id).toBe("resp_2");
	});

	it("forwards resolved headers including SDK null suppressions and uses the selected HTTP proxy", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, "proxied", [textOutput("proxied")]),
		);
		servers.push(server);
		const model = {
			...server.model,
			baseUrl: "http://unreachable.invalid/v1",
			headers: { "x-model-header": "model" },
		};
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "input", timestamp: 0 }] },
			{
				apiKey: "must-not-be-sent",
				sessionId: "proxy-session",
				headers: {
					Authorization: null,
					"User-Agent": null,
					"x-model-header": "caller",
					"x-request-header": "extra",
				},
				env: { HTTP_PROXY: server.baseUrl.replace(/\/v1$/, ""), NO_PROXY: "other.invalid" },
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(server.requests.map((request) => request.transport)).toEqual(["websocket"]);
		expect(server.requests[0].headers.authorization).toBeUndefined();
		expect(server.requests[0].headers["user-agent"]).toBeUndefined();
		expect(server.requests[0].headers).toMatchObject({
			host: "unreachable.invalid",
			"x-model-header": "caller",
			"x-request-header": "extra",
			session_id: "proxy-session",
		});
	});

	it("keeps custom fetch HTTP-only and preserves explicit SSE and compatible-provider HTTP", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]),
		);
		servers.push(server);
		let fetches = 0;
		const fetch: typeof globalThis.fetch = (...args) => {
			fetches++;
			return globalThis.fetch(...args);
		};
		const context: Context = { messages: [{ role: "user", content: "input", timestamp: 0 }] };
		expect((await streamSimple(server.model, context, { apiKey: "local-key", fetch }).result()).stopReason).toBe(
			"stop",
		);
		expect(fetches).toBe(0);
		expect(
			(await streamSimple(server.model, context, { apiKey: "local-key", fetch, transport: "sse" }).result())
				.stopReason,
		).toBe("stop");
		for (const provider of ["openrouter", "github-copilot", "proxy-provider"]) {
			expect(
				(
					await streamSimple({ ...server.model, provider }, context, {
						apiKey: "local-key",
						fetch,
						transport: "auto",
					}).result()
				).stopReason,
			).toBe("stop");
		}
		expect(fetches).toBe(4);
		expect(server.requests.map((request) => request.transport)).toEqual(["websocket", "sse", "sse", "sse", "sse"]);
	});

	it("falls back after native connect timeout using full HTTP input and the custom fetch hook", async () => {
		const server = await createResponsesServer((request) => replyWithOutput(request, "http", [textOutput("http")]));
		servers.push(server);
		server.server.removeAllListeners("upgrade");
		server.server.on("upgrade", () => {});
		let fetches = 0;
		const result = await streamSimple(
			server.model,
			{ messages: [{ role: "user", content: "full input", timestamp: 0 }] },
			{
				apiKey: "local-key",
				sessionId: "connect-timeout",
				websocketConnectTimeoutMs: 30,
				fetch: (...args) => {
					fetches++;
					return globalThis.fetch(...args);
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(fetches).toBe(1);
		expect(server.requests.map((request) => request.transport)).toEqual(["sse"]);
		expect(server.requests[0].body.previous_response_id).toBeUndefined();
		expect(JSON.stringify(server.requests[0].body.input)).toContain("full input");
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "provider_transport_failure",
				details: { configuredTransport: "auto", fallbackTransport: "sse", eventsEmitted: false },
			}),
		]);
	});

	it("does not retry or fall back after partial output and clears the failed continuation", async () => {
		const server = await createResponsesServer((request) => {
			if (server.requests.length > 1) {
				replyWithOutput(request, "recovered", [textOutput("recovered")]);
				return;
			}
			request.send({ type: "response.created", response: { id: "partial", status: "in_progress" } });
			request.send({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_partial", role: "assistant", status: "in_progress", content: [] },
			});
			request.send({ type: "response.output_text.delta", output_index: 0, delta: "partial" });
		});
		servers.push(server);
		const context: Context = { messages: [{ role: "user", content: "full input", timestamp: 0 }] };
		const options = { apiKey: "local-key", sessionId: "partial-session", maxRetries: 2 };
		const stream = streamSimple(server.model, context, options);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (event.type === "text_delta") server.connections[0].terminate();
		}
		expect((await stream.result()).stopReason).toBe("error");
		expect(server.requests).toHaveLength(1);
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "error"]);
		expect((await streamSimple(server.model, context, options).result()).stopReason).toBe("stop");
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.connections).toHaveLength(2);
	});

	it("aborts native requests without HTTP fallback and leaves no connection to reuse", async () => {
		const controller = new AbortController();
		const server = await createResponsesServer(() => controller.abort());
		servers.push(server);
		const result = await streamSimple(
			server.model,
			{ messages: [{ role: "user", content: "input", timestamp: 0 }] },
			{
				apiKey: "local-key",
				sessionId: "aborted-session",
				signal: controller.signal,
				maxRetries: 2,
			},
		).result();
		expect(result.stopReason).toBe("aborted");
		expect(server.requests).toHaveLength(1);
		await vi.waitFor(() => expect(server.webSockets.clients.size).toBe(0));
	});

	it("sends current full input when server output includes items Pi cannot replay", async () => {
		const server = await createResponsesServer((request) => {
			const output =
				server.requests.length === 1
					? [
							{
								type: "web_search_call",
								id: "ws_search",
								status: "completed",
								action: { type: "search", query: "fixture" },
							},
							textOutput("first", "search result summary"),
						]
					: [textOutput("second")];
			replyWithOutput(request, `resp_${server.requests.length}`, output);
		});
		servers.push(server);
		const context: Context = { messages: [{ role: "user", content: "current full input", timestamp: 0 }] };
		const options = {
			apiKey: "local-key",
			sessionId: "server-tool-session",
			samplingParams: { tools: [{ type: "web_search" }] },
		};
		context.messages.push(await streamSimple(server.model, context, options).result(), {
			role: "user",
			content: "next input",
			timestamp: 1,
		});
		const second = await streamSimple(server.model, context, options).result();
		expect(second.stopReason).toBe("stop");
		expect(server.connections).toHaveLength(1);
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.requests[1].body.tools).toEqual([{ type: "web_search" }]);
		expect(server.requests[1].body.input).toHaveLength(3);
		expect(JSON.stringify(server.requests[1].body.input)).toContain("search result summary");
		context.messages.push(second, { role: "user", content: "resume deltas", timestamp: 2 });
		expect((await streamSimple(server.model, context, options).result()).stopReason).toBe("stop");
		expect(server.requests[2].body).toMatchObject({
			previous_response_id: "resp_2",
			input: [{ role: "user", content: [{ type: "input_text", text: "resume deltas" }] }],
		});
		expect(server.requests[2].body.tools).toEqual([{ type: "web_search" }]);
		expect(server.connections).toHaveLength(1);
	});

	it.each(["max_output_tokens", "content_filter"])(
		"keeps the socket but resets continuation after incomplete output (%s)",
		async (reason) => {
			const item = textOutput("partial", "partial answer");
			const server = await createResponsesServer((request) => {
				if (server.requests.length === 1) {
					request.send({ type: "response.created", response: { id: "resp_partial", status: "in_progress" } });
					request.send({ type: "response.output_item.done", output_index: 0, item });
					request.send({
						type: "response.incomplete",
						response: {
							id: "resp_partial",
							status: "incomplete",
							incomplete_details: { reason },
							output: [item],
						},
					});
					return;
				}
				replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]);
			});
			servers.push(server);
			const context: Context = { messages: [{ role: "user", content: "current input", timestamp: 0 }] };
			const options = { apiKey: "local-key", sessionId: "incomplete-session" };
			const stream = streamSimple(server.model, context, options);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const partial = await stream.result();
			const isLength = reason === "max_output_tokens";
			expect(partial.stopReason).toBe(isLength ? "length" : "error");
			expect(partial.rawStopReason).toBe(`incomplete.${reason}`);
			expect(partial.errorMessage).toBe(isLength ? undefined : "Response incomplete: content_filter");
			expect(events.map((event) => event.type)).toEqual([
				"start",
				"text_start",
				"text_end",
				isLength ? "done" : "error",
			]);
			expect(events.at(-1)).toMatchObject({ reason: partial.stopReason });
			context.messages.push(partial, { role: "user", content: "finish", timestamp: 1 });
			const second = await streamSimple(server.model, context, options).result();
			expect(second.stopReason).toBe("stop");
			expect(server.requests[1].body.previous_response_id).toBeUndefined();
			expect(server.requests[1].body.input).toEqual([
				{ role: "user", content: [{ type: "input_text", text: "current input" }] },
				...(isLength ? [item] : []),
				{ role: "user", content: [{ type: "input_text", text: "finish" }] },
			]);
			expect(JSON.stringify(server.requests[1].body)).not.toContain("resp_partial");
			context.messages.push(second, { role: "user", content: "resume deltas", timestamp: 2 });
			expect((await streamSimple(server.model, context, options).result()).stopReason).toBe("stop");
			expect(server.requests[2].body).toMatchObject({
				previous_response_id: "resp_2",
				input: [{ role: "user", content: [{ type: "input_text", text: "resume deltas" }] }],
			});
			expect(server.requests.map((request) => request.transport)).toEqual(["websocket", "websocket", "websocket"]);
			expect(server.connections).toHaveLength(1);
		},
	);

	it.each([
		["localhost", "localhost."],
		["localhost.", "localhost"],
	])("bypasses the proxy for target %s and NO_PROXY=%s", async (hostname, noProxy) => {
		const target = await createResponsesServer((request) =>
			replyWithOutput(request, "direct", [textOutput("direct")]),
		);
		const proxy = await createResponsesServer((request) => replyWithOutput(request, "proxy", [textOutput("proxy")]));
		servers.push(target, proxy);
		const model = { ...target.model, baseUrl: target.baseUrl.replace("127.0.0.1", hostname) };
		// Root-dot matching must not depend on the OS resolving "localhost.".
		const lookup = dns.lookup;
		const lookupSpy = vi
			.spyOn(dns, "lookup")
			.mockImplementation((name, ...args) =>
				Reflect.apply(lookup, dns, [name === "localhost." ? "127.0.0.1" : name, ...args]),
			);
		try {
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "proxy exclusion", timestamp: 0 }] },
				{
					apiKey: "local-key",
					sessionId: "dns-dot-session",
					env: { HTTP_PROXY: proxy.baseUrl.replace(/\/v1$/, ""), NO_PROXY: noProxy },
				},
			).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.responseId).toBe("direct");
			expect(target.requests.map((request) => request.transport)).toEqual(["websocket"]);
			expect(proxy.requests).toHaveLength(0);
		} finally {
			lookupSpy.mockRestore();
		}
	});

	it("uses native HTTPS CONNECT proxying with certificate validation and separate proxy credentials", async () => {
		// Synthetic localhost-only certificate/key, never a provider credential.
		const cert = readFileSync(new URL("./fixtures/responses-localhost-cert.pem", import.meta.url), "utf8");
		const key = readFileSync(new URL("./fixtures/responses-localhost-key.pem", import.meta.url), "utf8");
		const trusted = getCACertificates("default");
		setDefaultCACertificates([...trusted, cert]);
		const proxy = createServer();
		const proxySockets = new Set<Socket>();
		const tunnels: { target: string | undefined; authorization: string | undefined }[] = [];
		proxy.on("connection", (socket) => {
			proxySockets.add(socket);
			socket.on("close", () => proxySockets.delete(socket));
		});
		try {
			const target = await createResponsesServer(
				(request) => replyWithOutput(request, "secure", [textOutput("secure")]),
				{ key, cert },
			);
			servers.push(target);
			const targetUrl = new URL(target.baseUrl);
			proxy.on("connect", (request, downstream, head) => {
				tunnels.push({ target: request.url, authorization: request.headers["proxy-authorization"] });
				const upstream = connect(Number(targetUrl.port), "127.0.0.1");
				proxySockets.add(upstream);
				upstream.on("close", () => proxySockets.delete(upstream));
				upstream.on("error", () => downstream.destroy());
				upstream.once("connect", () => {
					downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					if (head.length > 0) upstream.write(head);
					downstream.pipe(upstream).pipe(downstream);
				});
			});
			proxy.listen(0, "127.0.0.1");
			await once(proxy, "listening");
			const address = proxy.address();
			if (!address || typeof address === "string") throw new Error("Expected proxy TCP address");
			const result = await streamSimple(
				target.model,
				{ messages: [{ role: "user", content: "secure input", timestamp: 0 }] },
				{
					apiKey: "provider-key",
					sessionId: "secure-proxy",
					env: {
						HTTPS_PROXY: `http://proxy-user:proxy-password@127.0.0.1:${address.port}`,
						NO_PROXY: "other.invalid",
					},
				},
			).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(target.requests.map((request) => request.transport)).toEqual(["websocket"]);
			expect(tunnels).toEqual([
				{
					target: targetUrl.host,
					authorization: `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`,
				},
			]);
			expect(target.requests[0].headers.authorization).toBe("Bearer provider-key");
			expect(target.requests[0].headers["proxy-authorization"]).toBeUndefined();
		} finally {
			cleanupSessionResources("secure-proxy");
			for (const socket of proxySockets) socket.destroy();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
			setDefaultCACertificates(trusted);
		}
	});

	it("isolates concurrent requests without queueing or overwriting the active chain", async () => {
		let receive!: () => void;
		const received = new Promise<void>((resolve) => {
			receive = resolve;
		});
		let held: LocalResponsesRequest | undefined;
		const server = await createResponsesServer((request) => {
			if (server.requests.length === 1) {
				held = request;
				receive();
				return;
			}
			if (server.requests.length === 2) {
				replyWithOutput(request, "resp_B", [textOutput("B")]);
				if (!held) throw new Error("Missing first request");
				replyWithOutput(held, "resp_A", [textOutput("A")]);
				return;
			}
			replyWithOutput(request, "resp_A2", [textOutput("A2")]);
		});
		servers.push(server);
		const context: Context = { messages: [{ role: "user", content: "A input", timestamp: 0 }] };
		const options = { apiKey: "local-key", sessionId: "concurrent-session" };
		const first = streamSimple(server.model, context, options).result();
		await received;
		const second = streamSimple(
			server.model,
			{ messages: [{ role: "user", content: "B input", timestamp: 0 }] },
			options,
		).result();
		const [a, b] = await Promise.all([first, second]);
		expect([a.stopReason, b.stopReason]).toEqual(["stop", "stop"]);
		context.messages.push(a, { role: "user", content: "A continuation", timestamp: 1 });
		expect((await streamSimple(server.model, context, options).result()).stopReason).toBe("stop");
		expect(server.connections).toHaveLength(2);
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.requests[2].body.previous_response_id).toBe("resp_A");
		expect(JSON.stringify(server.requests[2].body.input)).not.toContain("B input");
		expect(server.requests[2].connection).toBe(server.requests[0].connection);
	});

	it("keeps sessions separate and disposes only the requested session", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, `resp_${server.requests.length}`, [textOutput(String(server.requests.length))]),
		);
		servers.push(server);
		const context: Context = { messages: [{ role: "user", content: "same input", timestamp: 0 }] };
		const a = { apiKey: "local-key", sessionId: "session-A" };
		const b = { apiKey: "local-key", sessionId: "session-B" };
		await streamSimple(server.model, context, a).result();
		const responseB = await streamSimple(server.model, context, b).result();
		cleanupSessionResources("session-A");
		await vi.waitFor(() => expect(server.webSockets.clients.size).toBe(1));
		context.messages.push(responseB, { role: "user", content: "B continuation", timestamp: 1 });
		expect((await streamSimple(server.model, context, b).result()).stopReason).toBe("stop");
		expect(server.requests[2].body.previous_response_id).toBe("resp_2");
		expect(server.requests[2].connection).toBe(server.requests[1].connection);
		await streamSimple(server.model, context, a).result();
		expect(server.requests[3].body.previous_response_id).toBeUndefined();
		expect(server.connections).toHaveLength(3);
	});

	it("continues deferred grammar tools with namespace and image results through the shared converters", async () => {
		const server = await createResponsesServer((request) => {
			const round = server.requests.length;
			const output =
				round === 1
					? [{ type: "function_call", id: "fc_load", call_id: "load_call", name: "load", arguments: "{}" }]
					: round === 2
						? [
								{
									type: "custom_tool_call",
									id: "ctc_query",
									call_id: "query_call",
									name: "query",
									input: "SELECT value",
									namespace: "dynamic_tools",
								},
							]
						: [textOutput("finished")];
			replyWithOutput(request, `resp_${round}`, output);
		});
		servers.push(server);
		const model = {
			...server.model,
			compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsStrictMode: true },
		};
		const context: Context = {
			messages: [{ role: "user", content: "load and use the query tool", timestamp: 0 }],
			tools: [{ name: "load", description: "Load a tool", parameters: Type.Object({}) }],
		};
		const options = { apiKey: "local-key", sessionId: "grammar-session", reasoning: "high" as const };
		const load = await streamSimple(model, context, options).result();
		context.tools!.push({
			name: "query",
			description: "Run a query",
			parameters: Type.Object({ query: Type.String() }),
			constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/s" } },
		});
		context.messages.push(load, {
			role: "toolResult",
			toolCallId: "load_call|fc_load",
			toolName: "load",
			content: [{ type: "text", text: "query loaded" }],
			addedToolNames: ["query"],
			isError: false,
			timestamp: 1,
		});
		const query = await streamSimple(model, context, options).result();
		expect(query.stopReason).toBe("toolUse");
		expect(query.content).toEqual([
			{
				type: "toolCall",
				id: "query_call|ctc_query",
				name: "query",
				arguments: { query: "SELECT value" },
				namespace: "dynamic_tools",
			},
		]);
		expect(server.requests[1].body).toMatchObject({
			previous_response_id: "resp_1",
			input: [
				{ type: "function_call_output", call_id: "load_call", output: "query loaded" },
				{
					type: "additional_tools",
					role: "developer",
					tools: [
						{
							type: "custom",
							name: "query",
							format: { type: "grammar", syntax: "lark", definition: "start: /.+/s" },
						},
					],
				},
			],
		});
		context.messages.push(query, {
			role: "toolResult",
			toolCallId: "query_call|ctc_query",
			toolName: "query",
			content: [
				{ type: "text", text: "query result" },
				{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
			],
			isError: false,
			timestamp: 2,
		});
		expect((await streamSimple(model, context, options).result()).stopReason).toBe("stop");
		expect(server.requests[2].body).toMatchObject({
			previous_response_id: "resp_2",
			input: [
				{
					type: "custom_tool_call_output",
					call_id: "query_call",
					output: [
						{ type: "input_text", text: "query result" },
						{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,ZmFrZQ==" },
					],
				},
			],
		});
		expect(server.connections).toHaveLength(1);
	});
});
