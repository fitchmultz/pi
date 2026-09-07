import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import type { Socket } from "node:net";
import type { Response as OpenAIResponse, ResponsesClientEvent } from "openai/resources/responses/responses.js";
import { type WebSocket, WebSocketServer } from "ws";
import type { Model } from "../src/types.ts";

export type ResponsesRequest = Omit<ResponsesClientEvent.ResponseCreate, "type"> & { type?: "response.create" };

export interface LocalResponsesRequest {
	transport: "websocket" | "sse";
	connection: number;
	body: ResponsesRequest;
	headers: IncomingHttpHeaders;
	url: string | undefined;
	bytes: number;
	socket?: WebSocket;
	response?: ServerResponse;
	send(event: unknown): void;
	end(): void;
}

/** The real SDK connects here; only the remote model/protocol peer is a fixture. */
export async function createResponsesServer(
	handle: (request: LocalResponsesRequest) => void | Promise<void>,
	tls?: HttpsServerOptions,
) {
	const requests: LocalResponsesRequest[] = [];
	const connections: WebSocket[] = [];
	const tcpSockets = new Set<Socket>();
	const errors: unknown[] = [];
	const dispatch = (request: LocalResponsesRequest) => {
		requests.push(request);
		Promise.resolve()
			.then(() => handle(request))
			.catch((error: unknown) => {
				errors.push(error);
				request.socket?.terminate();
				request.response?.destroy();
			});
	};
	const serveHttp = async (request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const raw = Buffer.concat(chunks);
		dispatch({
			transport: "sse",
			connection: 0,
			body: JSON.parse(raw.toString()) as ResponsesRequest,
			headers: request.headers,
			url: request.url,
			bytes: raw.byteLength,
			response,
			send(event) {
				if (!response.headersSent) {
					response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "local-http" });
				}
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			},
			end: () => response.end(),
		});
	};
	const server = tls ? createHttpsServer(tls, serveHttp) : createServer(serveHttp);
	server.on("connection", (socket) => {
		tcpSockets.add(socket);
		socket.on("close", () => tcpSockets.delete(socket));
	});
	const webSockets = new WebSocketServer({ noServer: true });
	webSockets.on("headers", (headers) => headers.push("x-request-id: local-websocket"));
	server.on("upgrade", (request, socket, head) => {
		webSockets.handleUpgrade(request, socket, head, (webSocket) => {
			connections.push(webSocket);
			const connection = connections.length;
			webSocket.on("message", (raw) => {
				const text = raw.toString();
				dispatch({
					transport: "websocket",
					connection,
					body: JSON.parse(text) as ResponsesRequest,
					headers: request.headers,
					url: request.url,
					bytes: Buffer.byteLength(text),
					socket: webSocket,
					send: (event) => webSocket.send(JSON.stringify(event)),
					end: () => {},
				});
			});
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a local TCP address");
	const baseUrl = `${tls ? "https" : "http"}://127.0.0.1:${address.port}/v1`;
	const model: Model<"openai-responses"> = {
		id: "gpt-6-astra",
		name: "Local Responses fixture",
		api: "openai-responses",
		provider: "openai",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
		contextWindow: 400_000,
		maxTokens: 32_000,
	};
	return {
		server,
		webSockets,
		baseUrl,
		model,
		requests,
		connections,
		errors,
		async close() {
			for (const socket of webSockets.clients) socket.terminate();
			for (const socket of tcpSockets) socket.destroy();
			await Promise.all([
				new Promise<void>((resolve) => webSockets.close(() => resolve())),
				new Promise<void>((resolve) => server.close(() => resolve())),
			]);
		},
	};
}

export function replyWithOutput(
	request: LocalResponsesRequest,
	id: string,
	output: Record<string, unknown>[],
	responseOverrides: Partial<OpenAIResponse> = {},
) {
	request.send({ type: "response.created", response: { id, status: "in_progress" } });
	for (const [output_index, item] of output.entries()) {
		request.send({ type: "response.output_item.added", output_index, item });
		request.send({ type: "response.output_item.done", output_index, item });
	}
	request.send({
		type: "response.completed",
		response: {
			id,
			status: "completed",
			output,
			service_tier: "priority",
			usage: {
				input_tokens: 100,
				output_tokens: 10,
				total_tokens: 110,
				input_tokens_details: { cached_tokens: 30, cache_write_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 5 },
			},
			...responseOverrides,
		},
	});
	request.end();
}

export function textOutput(id: string, text = "done") {
	return {
		type: "message",
		id: `msg_${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
}
