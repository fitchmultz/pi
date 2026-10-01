import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { closeOpenAICodexWebSocketSessions, stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

type Body = { input: { content: { text: string }[] }[]; previous_response_id?: string };

async function fixture() {
	vi.stubGlobal("WebSocket", WebSocket);
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server");
	const model: Model<"openai-codex-responses"> = {
		id: "fixture",
		name: "Fixture",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: `http://127.0.0.1:${address.port}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 1000,
	};
	const options = {
		apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`,
		sessionId: "immutable-continuation",
		transport: "websocket-cached" as const,
		timeoutMs: 1000,
		maxRetries: 0,
	};
	return { server, model, options };
}

it("sends a bounded encoded delta while preserving the sent snapshot after payload-hook mutation", async () => {
	const { server, model, options } = await fixture();
	const requests: Body[] = [];
	let captured: Body | undefined;
	server.on("connection", (socket) =>
		socket.on("message", (data) => {
			requests.push(JSON.parse(data.toString()) as Body);
			if (requests.length === 1) captured!.input[0].content[0].text = "mutation after send";
			socket.send(
				JSON.stringify({
					type: "response.completed",
					response: { id: `r${requests.length}`, status: "completed", output: [] },
				}),
			);
		}),
	);
	try {
		const context = normalizeContext({
			messages: Array.from({ length: 64 }, (_, index) => ({
				role: "user" as const,
				content: `history-${index}: ${"x".repeat(8000)}`,
				timestamp: index,
			})),
		});
		const first = await stream(model, context, {
			...options,
			onPayload: (body) => {
				captured = body as Body;
			},
		}).result();
		expect(first.stopReason, first.errorMessage).toBe("stop");
		context.messages.push(first, { role: "user", content: "next", timestamp: 100 });
		const stringify = vi.spyOn(JSON, "stringify");
		const second = await stream(model, context, options).result();
		const largestEncoding = Math.max(
			...stringify.mock.results.map((result) =>
				result.type === "return" && typeof result.value === "string" ? result.value.length : 0,
			),
		);
		stringify.mockRestore();
		expect(second.stopReason, second.errorMessage).toBe("stop");
		expect(requests[1].previous_response_id).toBe("r1");
		expect(requests[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "next" }] }]);
		// Prefix validation may encode individual items, never the entire unchanged transcript.
		expect(largestEncoding).toBeLessThan(16_000);
	} finally {
		closeOpenAICodexWebSocketSessions();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("keeps fallback input detached from retained payload-hook references", async () => {
	const { server, model, options } = await fixture();
	let captured: Body | undefined;
	let sent: Body | undefined;
	let fallback: Body | undefined;
	server.on("connection", (socket) =>
		socket.on("message", (data) => {
			sent = JSON.parse(data.toString()) as Body;
			captured!.input[0].content[0].text = "mutation after send";
			socket.close();
		}),
	);
	try {
		const message = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "original request", timestamp: 1 }] }),
			{
				...options,
				onPayload: (body) => {
					captured = body as Body;
				},
				fetch: async (_url, init) => {
					const headers = new Headers(init?.headers);
					const json =
						headers.get("content-encoding") === "zstd"
							? zstdDecompressSync(init!.body as Uint8Array).toString()
							: String(init?.body);
					fallback = JSON.parse(json) as Body;
					return new Response(
						`data: ${JSON.stringify({ type: "response.completed", response: { id: "fallback", status: "completed", output: [] } })}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			},
		).result();
		expect(message.stopReason, message.errorMessage).toBe("stop");
		expect(sent?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "original request" }] }]);
		expect(fallback?.input).toEqual(sent!.input);
	} finally {
		closeOpenAICodexWebSocketSessions();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
