import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAI } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Model, StreamOptions } from "../src/types.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { createResponsesServer, textOutput } from "./responses-websocket-server.ts";

const code = "misalignment_policy_violation";
const providerError = {
	code,
	type: "invalid_request_error",
	message: "Service unavailable; please retry your request",
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const apiKey = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } }))}.test`;
const servers: Awaited<ReturnType<typeof createResponsesServer>>[] = [];

function request(model: Model<"openai-responses">, route: "openai" | "azure" | "codex", options: StreamOptions) {
	if (route === "codex")
		return streamCodex({ ...model, api: "openai-codex-responses", provider: "openai-codex" }, context, options);
	if (route === "azure")
		return streamAzure(
			{ ...model, api: "azure-openai-responses", provider: "azure-openai-responses" },
			context,
			options,
		);
	return streamOpenAI(model, context, options);
}

afterEach(async () => {
	cleanupSessionResources();
	for (const server of servers.splice(0)) {
		await server.close();
		expect(server.errors).toEqual([]);
	}
});

describe("OpenAI monitoring blocks", () => {
	it.each(["event", "http"])(
		"preserves monitoring metadata through pi-messages %s serialization",
		async (boundary) => {
			const details = {
				code,
				type: "invalid_request_error",
				status: 403,
				requestId: "req_gateway",
				responseId: "resp_gateway",
			};
			const server = await createResponsesServer((req) => {
				if (boundary === "http") {
					req.response!.writeHead(403, { "content-type": "application/json", "x-request-id": "req_gateway" });
					req.response!.end(JSON.stringify({ error: { ...providerError, response_id: "resp_gateway" } }));
					return;
				}
				req.send({
					type: "error",
					reason: "error",
					providerError: details,
					errorMessage: providerError.message,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				req.end();
			});
			servers.push(server);
			const result = await streamPiMessages({ ...server.model, api: "pi-messages", compat: undefined }, context, {
				apiKey,
			}).result();
			expect(result.providerError).toEqual(details);
			expect(result.errorMessage).toContain(providerError.message);
			expect(isRetryableAssistantError(result)).toBe(false);
		},
	);

	for (const route of ["openai", "azure", "codex"] as const) {
		it.each([403, 429])(`preserves ${route} HTTP %s errors without retrying`, async (status) => {
			const server = await createResponsesServer((req) => {
				req.response!.writeHead(status, {
					"content-type": "application/json",
					"x-request-id": "req_http",
					"x-should-retry": "true",
					"retry-after-ms": "0",
				});
				req.response!.end(JSON.stringify({ error: { ...providerError, response_id: "resp_http" } }));
			});
			servers.push(server);
			const result = await request(server.model, route, { apiKey, transport: "sse", maxRetries: 1 }).result();
			expect(result.providerError).toEqual({
				code,
				type: "invalid_request_error",
				status,
				requestId: "req_http",
				responseId: "resp_http",
			});
			expect(result.errorMessage).toContain(providerError.message);
			expect(result.errorMessage).toContain(code);
			expect(result.errorMessage).toContain("Request ID: req_http");
			expect(result.errorMessage).toContain("Response ID: resp_http");
			expect(result.errorMessage).toContain("Review prior actions; this stop did not undo them");
			expect(result.stopReason).toBe("error");
			expect(server.requests).toHaveLength(1);
		});

		for (const transport of route === "azure" ? (["sse"] as const) : (["sse", "websocket"] as const)) {
			it.each(["response.failed", "error"])(
				`preserves ${route} ${transport} %s after partial output`,
				async (type) => {
					const server = await createResponsesServer((req) => {
						req.send({ type: "response.created", response: { id: "resp_stream", status: "in_progress" } });
						req.send({ type: "response.output_item.added", output_index: 0, item: textOutput("partial", "") });
						req.send({ type: "response.output_text.delta", output_index: 0, delta: "Partial output" });
						req.send(
							type === "response.failed"
								? { type, response: { id: "resp_stream", status: "failed", error: providerError } }
								: {
										type,
										status: 403,
										request_id: "req_event",
										response_id: "resp_stream",
										...(transport === "sse" && route !== "codex"
											? { code, message: providerError.message }
											: { error: providerError }),
									},
						);
						req.end();
					});
					servers.push(server);
					const result = await request(server.model, route, {
						apiKey,
						transport,
						maxRetries: 1,
						env: { NO_PROXY: "*", no_proxy: "*" },
					}).result();
					expect(result.stopReason).toBe("error");
					expect(result.providerError).toMatchObject({ code, responseId: "resp_stream" });
					if (type === "response.failed" || transport === "websocket" || route === "codex")
						expect(result.providerError?.type).toBe("invalid_request_error");
					if (type === "error") expect(result.providerError?.requestId).toBe("req_event");
					else if (transport === "sse" || route === "openai")
						expect(result.providerError?.requestId).toBe(transport === "sse" ? "local-http" : "local-websocket");
					expect(result.errorMessage).toContain(providerError.message);
					expect(result.errorMessage).toContain(code);
					expect(result.errorMessage).toContain("Response ID: resp_stream");
					expect(result.errorMessage).toContain("Review prior actions; this stop did not undo them");
					expect(result.content[0]).toMatchObject({ type: "text", text: "Partial output" });
					expect(isRetryableAssistantError(result)).toBe(false);
					expect(server.requests).toHaveLength(1);
				},
			);
		}
	}

	it("does not retry a provider block even when retry headers and status request it", async () => {
		const error = Object.assign(new Error("Service unavailable"), {
			code,
			status: 503,
			headers: new Headers({ "x-should-retry": "true", "retry-after-ms": "0" }),
		});
		const produce = vi.fn().mockRejectedValue(error);
		await expect(retryProviderRequest(produce, { maxRetries: 1 })).rejects.toBe(error);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it.each(["openai", "codex"] as const)(
		"does not reconnect or fall back after a pre-output %s WebSocket block",
		async (route) => {
			const server = await createResponsesServer((req) => {
				req.send({
					type: "error",
					status: 503,
					request_id: "req_pre_output",
					response_id: "resp_pre_output",
					error: { ...providerError, headers: { "x-should-retry": "true", "retry-after-ms": "0" } },
				});
			});
			servers.push(server);
			const result = await request(server.model, route, {
				apiKey,
				maxRetries: 1,
				env: { NO_PROXY: "*", no_proxy: "*" },
			}).result();
			expect(result.providerError).toEqual({
				code,
				type: "invalid_request_error",
				status: 503,
				requestId: "req_pre_output",
				responseId: "resp_pre_output",
			});
			expect(result.errorMessage).toContain(providerError.message);
			expect(server.requests).toHaveLength(1);
			expect(server.connections).toHaveLength(1);
		},
	);

	it("does not retry a structured assistant block but does not infer a block from text", async () => {
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "test",
			content: [],
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Service unavailable",
			providerError: { code },
		};
		const produce = vi.fn().mockResolvedValue(message);
		expect(await retryAssistantCall(produce, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined)).toBe(
			message,
		);
		expect(produce).toHaveBeenCalledTimes(1);
		expect(
			isRetryableAssistantError({
				...message,
				providerError: undefined,
				errorMessage: `${code}: Service unavailable`,
			}),
		).toBe(true);
	});
});
