import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponsesClientEvent,
	ResponsesServerEvent,
} from "openai/resources/responses/responses.js";
import { ResponsesWS } from "openai/resources/responses/ws";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { AssistantMessage, Model, ProviderResponse } from "../types.ts";
import { headersToRecord } from "../utils/headers.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import type { OpenAIResponsesOptions } from "./openai-responses.ts";
import { convertResponsesMessages } from "./openai-responses-shared.ts";

const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const IDLE_RETENTION_MS = 5 * 60 * 1000;

interface Connection {
	socket: ResponsesWS;
	identity: string;
	sessionId?: string;
	busy: boolean;
	cancelled?: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	handshake?: ProviderResponse;
	continuation?: { request: string; input: string[]; responseId: string };
}

const sessions = new Map<string, Connection>();
const connections = new Set<Connection>();

function closeConnection(connection: Connection): void {
	if (!connections.delete(connection)) return;
	clearTimeout(connection.idleTimer);
	connection.continuation = undefined;
	if (connection.sessionId && sessions.get(connection.sessionId) === connection) sessions.delete(connection.sessionId);
	connection.socket.close();
	connection.socket.socket.platformSocket.terminate();
}

registerSessionResourceCleanup((sessionId) => {
	for (const connection of connections) {
		if (sessionId === undefined || connection.sessionId === sessionId) {
			connection.cancelled = true;
			closeConnection(connection);
		}
	}
});

/** The SDK owns framing, send buffering and iteration; Pi owns current-window continuation. */
export async function* streamResponsesWebSocket(
	client: OpenAI,
	params: ResponseCreateParamsStreaming,
	model: Model<"openai-responses">,
	output: AssistantMessage,
	options: OpenAIResponsesOptions,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	onStart: () => void,
): AsyncGenerator<ResponsesServerEvent> {
	if (options.signal?.aborted) throw new OpenAI.APIUserAbortError();
	// Resolve auth, custom/env headers and null suppressions through the same SDK as HTTP.
	const { req, url } = await client.buildRequest({
		method: "get",
		path: "/responses",
		...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
	});
	const idleTimeoutMs = options.timeoutMs ?? client.timeout;
	const headers = new Headers(req.headers);
	const proxy = resolveHttpProxyUrlForTarget(url, options.env);
	const identity = JSON.stringify([url, [...headers], proxy?.href]);
	const sessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
	let connection = sessionId ? sessions.get(sessionId) : undefined;
	if (connection && (connection.identity !== identity || connection.socket.socket.readyState !== 1)) {
		if (!connection.busy) closeConnection(connection);
		if (sessionId) sessions.delete(sessionId);
		connection = undefined;
	}
	const reused = connection !== undefined && !connection.busy;
	const cacheConnection = sessionId !== undefined && !connection?.busy;
	if (!reused) {
		const socket = new ResponsesWS(client, {
			headers: headersToRecord(headers),
			handshakeTimeout: options.websocketConnectTimeoutMs ?? 15_000,
			...(proxy
				? { agent: new (new URL(url).protocol === "https:" ? HttpsProxyAgent : HttpProxyAgent)(proxy) }
				: {}),
			finishRequest(request) {
				// The native adapter adds these defaults itself. Honor explicit SDK null suppressions.
				for (const name of ["authorization", "user-agent"]) {
					if (!headers.has(name)) request.removeHeader(name);
				}
				request.end();
			},
		});
		const created: Connection = { socket, identity, sessionId: options.sessionId, busy: true };
		connections.add(created);
		socket.socket.platformSocket.once("upgrade", (response) => {
			if (response.statusCode === undefined) return;
			created.handshake = {
				status: response.statusCode,
				headers: Object.fromEntries(
					Object.entries(response.headers).flatMap(([name, value]) =>
						value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
					),
				),
			};
		});
		// SDK errors must have a listener even while a completed connection is idle.
		socket.on("error", () => {
			if (!created.busy) closeConnection(created);
		});
		socket.on("close", () => closeConnection(created));
		connection = created;
		if (cacheConnection && sessionId) sessions.set(sessionId, created);
	}
	const active = connection!;
	active.busy = true;
	clearTimeout(active.idleTimer);
	const events = active.socket.stream();
	const onAbort = () => closeConnection(active);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let keep = false;
	try {
		if (options.signal?.aborted) throw new OpenAI.APIUserAbortError();
		const next = async () => {
			let timedOut = false;
			const timeout =
				active.socket.socket.readyState === 1 && idleTimeoutMs > 0
					? setTimeout(() => {
							timedOut = true;
							closeConnection(active);
						}, idleTimeoutMs)
					: undefined;
			const event = await events.next().finally(() => clearTimeout(timeout));
			if (options.signal?.aborted || active.cancelled) throw new OpenAI.APIUserAbortError();
			if (timedOut)
				throw new OpenAI.APIConnectionTimeoutError({
					message: `Responses WebSocket idle timeout after ${idleTimeoutMs}ms`,
				});
			if (event.done)
				throw new OpenAI.APIConnectionError({ message: "Responses WebSocket ended before completion" });
			if (event.value.type === "error") throw event.value.error;
			if (event.value.type === "close") {
				throw new OpenAI.APIConnectionError({
					message: `Responses WebSocket closed (${event.value.code}) before completion`,
				});
			}
			if (event.value.type === "raw")
				throw new OpenAI.APIConnectionError({ message: "Invalid Responses WebSocket event" });
			return event.value;
		};
		while (active.socket.socket.readyState !== 1) await next();
		if (!reused && active.handshake) await options.onResponse?.(active.handshake, model);
		if (options.signal?.aborted || active.cancelled) throw new OpenAI.APIUserAbortError();

		const { stream: _stream, input, ...body } = params;
		const request = JSON.stringify(body);
		const fullInput = Array.isArray(input) ? input.map((item) => JSON.stringify(item)) : undefined;
		const previous = active.continuation;
		const event: ResponsesClientEvent.ResponseCreate = { ...body, input, type: "response.create" };
		const incremental = options.transport !== "websocket" && !body.previous_response_id && !body.conversation;
		if (
			incremental &&
			previous &&
			fullInput &&
			Array.isArray(input) &&
			request === previous.request &&
			fullInput.length >= previous.input.length &&
			previous.input.every((item, index) => item === fullInput[index])
		) {
			event.previous_response_id = previous.responseId;
			event.input = input.slice(previous.input.length);
		}
		active.continuation = undefined;
		active.socket.send(event);
		let started = false;
		let replayable = false;
		while (true) {
			const event = await next();
			if (event.type !== "message") continue;
			if (!started) {
				started = true;
				onStart();
			}
			yield event.message;
			if (event.message.type === "response.completed" || event.message.type === "response.incomplete") {
				// A cached reply must contain only items Pi can replay in the current logical window.
				// Otherwise keep the socket, but start the next request with full input.
				replayable =
					event.message.type === "response.completed" &&
					Array.isArray(event.message.response.output) &&
					event.message.response.output.every((item) =>
						["reasoning", "message", "function_call", "custom_tool_call"].includes(item.type),
					);
				break;
			}
		}
		keep = !options.signal?.aborted;
		if (keep && replayable && incremental && fullInput && output.responseId) {
			const replay = convertResponsesMessages(model, { messages: [output] }, TOOL_CALL_PROVIDERS, {
				includeSystemPrompt: false,
				grammarToolInputProperties,
			}).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
			active.continuation = {
				request,
				input: [...fullInput, ...replay.map((item) => JSON.stringify(item))],
				responseId: output.responseId,
			};
		}
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		await events.return?.();
		active.busy = false;
		if (keep && sessionId && sessions.get(sessionId) === active && active.socket.socket.readyState === 1) {
			active.idleTimer = setTimeout(() => closeConnection(active), IDLE_RETENTION_MS);
			active.idleTimer.unref();
		} else {
			closeConnection(active);
		}
	}
}
