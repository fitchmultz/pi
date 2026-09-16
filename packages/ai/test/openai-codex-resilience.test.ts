import { Agent, WebSocket } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model } from "../src/types.ts";
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

	it("does not replay output when a missing-continuation error arrives after output starts", async () => {
		const server = await createResponsesServer((request) => {
			request.send({ type: "response.output_item.added", output_index: 0, item: textOutput("partial") });
			request.send({
				type: "error",
				error: { code: "previous_response_not_found", message: "Missing continuation" },
			});
		});
		const result = await stream(codexModel(server), context, options).result();
		expect(result.stopReason).toBe("error");
		expect(server.requests).toHaveLength(1);
	});

	it("does not reconnect or fall back when cancelled after metadata", async () => {
		const controller = new AbortController();
		const server = await createResponsesServer((request) => {
			request.send({ type: "response.created", response: { id: "resp_cancelled" } });
			controller.abort();
		});
		const result = await stream(codexModel(server), context, { ...options, signal: controller.signal }).result();
		expect(result.stopReason).toBe("aborted");
		expect(server.requests).toHaveLength(1);
		expect(result.diagnostics?.some((entry) => entry.type === "provider_transport_failure")).toBe(false);
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
