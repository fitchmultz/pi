import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { closeOpenAICodexWebSocketSessions, stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
});

it("snapshots a sent request before a payload hook can mutate its continuation baseline", async () => {
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
		contextWindow: 10000,
		maxTokens: 1000,
	};
	const options = {
		apiKey: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`,
		sessionId: "immutable-continuation",
		transport: "websocket-cached" as const,
		timeoutMs: 1000,
	};
	type Body = { input: { content: { text: string }[] }[]; previous_response_id?: string };
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
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		const first = await stream(model, context, {
			...options,
			onPayload: (body) => {
				captured = body as Body;
			},
		}).result();
		expect(first.stopReason, first.errorMessage).toBe("stop");
		context.messages.push(first, { role: "user", content: "next", timestamp: 2 });
		const second = await stream(model, context, options).result();
		expect(second.stopReason, second.errorMessage).toBe("stop");
		expect(requests[1].previous_response_id).toBe("r1");
		expect(requests[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "next" }] }]);
	} finally {
		closeOpenAICodexWebSocketSessions();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
