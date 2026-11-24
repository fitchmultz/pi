import type OpenAI from "openai";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai/error";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { AssistantMessage, Model, ProviderEnv } from "../types.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { normalizeContext } from "../utils/transcript.ts";
import type { OpenAIResponsesOptions } from "./openai-responses.ts";
import { convertResponsesMessages, OPENAI_RESPONSES_TOOL_CALL_PROVIDERS } from "./openai-responses-shared.ts";

const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const SESSION_WEBSOCKET_IDLE_TTL_MS = 5 * 60 * 1000;
// OpenAI closes Responses WebSocket connections after 60 minutes; rotate proactively at 55 minutes.
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

const WEBSOCKET_STRIPPED_HEADERS = new Set(["accept", "content-type", "x-stainless-retry-count"]);

type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
	readyState?: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: WebSocketListener): void;
	removeEventListener(type: string, listener: WebSocketListener): void;
}

type WebSocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;

interface ContinuationState {
	request: string;
	input: string[];
	responseId: string;
}

interface CachedConnection {
	socket: WebSocketLike;
	identity: string;
	sessionId?: string;
	createdAt: number;
	busy: boolean;
	cancelled?: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: ContinuationState;
}

interface ServerErrorPayload {
	code?: string;
	message?: string;
	type?: string;
	param?: string;
	headers?: Record<string, string>;
}

export class OpenAIResponsesWebSocketServerError extends Error {
	readonly status?: number;
	readonly code?: string;
	readonly errorPayload?: ServerErrorPayload;

	constructor(message: string, options?: { status?: number; code?: string; errorPayload?: ServerErrorPayload }) {
		super(message);
		this.name = "OpenAIResponsesWebSocketServerError";
		this.status = options?.status;
		this.code = options?.code;
		this.errorPayload = options?.errorPayload;
	}
}

const sessionConnections = new Map<string, CachedConnection>();
const activeConnections = new Set<CachedConnection>();
const sseFallbackSessions = new Set<string>();

let cachedBunWebSocket: WebSocketConstructor | null = null;

function getWebSocketConstructor(env?: ProviderEnv): WebSocketConstructor | null {
	if (typeof process !== "undefined" && process.versions?.bun) {
		if (!env && cachedBunWebSocket) return cachedBunWebSocket;
		const BaseWebSocket = globalThis.WebSocket as unknown as new (
			url: string | URL,
			options?: Record<string, unknown>,
		) => WebSocketLike;
		if (typeof BaseWebSocket !== "function") return null;
		const BunProxyWebSocket = class extends BaseWebSocket {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				const proxyUrl = resolveHttpProxyUrlForTarget(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), env);
				super(url, { ...options, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) });
			}
		};
		if (!env) cachedBunWebSocket = BunProxyWebSocket;
		return BunProxyWebSocket;
	}

	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	return typeof ctor === "function" ? (ctor as WebSocketConstructor) : null;
}

function isSocketOpen(socket: WebSocketLike): boolean {
	return socket.readyState === undefined || socket.readyState === 1;
}

function isConnectionExpired(connection: CachedConnection): boolean {
	return Date.now() - connection.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function closeConnection(connection: CachedConnection, reason = "done"): void {
	if (!activeConnections.delete(connection)) return;
	if (connection.idleTimer) {
		clearTimeout(connection.idleTimer);
		connection.idleTimer = undefined;
	}
	connection.continuation = undefined;
	if (connection.sessionId && sessionConnections.get(connection.sessionId) === connection) {
		sessionConnections.delete(connection.sessionId);
	}
	closeSocketSilently(connection.socket, 1000, reason);
}

registerSessionResourceCleanup((sessionId) => {
	for (const connection of activeConnections) {
		if (sessionId === undefined || connection.sessionId === sessionId) {
			connection.cancelled = true;
			closeConnection(connection, "session_cleanup");
		}
	}
	if (sessionId === undefined) {
		sseFallbackSessions.clear();
	} else {
		sseFallbackSessions.delete(sessionId);
	}
});

export function isOpenAIResponsesWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return Boolean(sessionId && sseFallbackSessions.has(sessionId));
}

export function recordOpenAIResponsesWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	sseFallbackSessions.add(sessionId);
}

function toWebSocketUrl(httpUrl: string): string {
	const parsed = new URL(httpUrl);
	if (parsed.protocol === "https:") parsed.protocol = "wss:";
	else if (parsed.protocol === "http:") parsed.protocol = "ws:";
	return parsed.toString();
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) return new Error(message);
		const nested = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nested instanceof Error && nested.message.length > 0) return nested;
		if (nested && typeof nested === "object" && "message" in nested) {
			const nestedMessage = (nested as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) return new Error(nestedMessage);
		}
	}
	return new Error("WebSocket error");
}

function extractWebSocketCloseMessage(event: unknown): string {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const codePart = typeof code === "number" ? ` (${code})` : "";
		const reasonPart = typeof reason === "string" && reason.length > 0 ? `: ${reason}` : "";
		return `Responses WebSocket closed${codePart}${reasonPart} before completion`;
	}
	return "Responses WebSocket closed before completion";
}

async function decodeMessageData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const buf = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(buf));
	}
	return null;
}

function connectSocket(
	wsUrl: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number,
	env: ProviderEnv | undefined,
): Promise<WebSocketLike> {
	const WebSocketCtor = getWebSocketConstructor(env);
	if (!WebSocketCtor) {
		return Promise.reject(
			new APIConnectionError({ message: "WebSocket transport is not available in this runtime" }),
		);
	}
	if (signal?.aborted) {
		return Promise.reject(new APIUserAbortError());
	}

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;

		try {
			socket = new WebSocketCtor(wsUrl, { headers });
		} catch (cause) {
			reject(
				new APIConnectionError({
					message: cause instanceof Error ? cause.message : String(cause),
					cause: cause instanceof Error ? cause : undefined,
				}),
			);
			return;
		}

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};

		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) closeSocketSilently(socket, 1000, closeReason);
			reject(error);
		};

		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			const cause = extractWebSocketError(event);
			fail(new APIConnectionError({ message: cause.message, cause }));
		};
		const onClose: WebSocketListener = (event) => {
			fail(new APIConnectionError({ message: extractWebSocketCloseMessage(event) }));
		};
		const onAbort = () => {
			fail(new APIUserAbortError(), "aborted");
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });

		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(
					new APIConnectionTimeoutError({
						message: `Responses WebSocket connect timeout after ${connectTimeoutMs}ms`,
					}),
					"connect_timeout",
				);
			}, connectTimeoutMs);
			timeout.unref?.();
		}

		// Re-check after attaching listeners in case a synchronous or custom WebSocket opened immediately.
		if (socket.readyState === 1) {
			onOpen(undefined);
		}
	});
}

function parseServerErrorFrame(parsed: Record<string, unknown>): OpenAIResponsesWebSocketServerError {
	const status = typeof parsed.status === "number" ? parsed.status : undefined;
	const nested =
		parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : undefined;
	const source = nested ?? parsed;
	const code = typeof source.code === "string" ? source.code : undefined;
	const message =
		typeof source.message === "string" && source.message.length > 0
			? source.message
			: (code ?? "Responses WebSocket error");
	const payload: ServerErrorPayload = {
		...(code ? { code } : {}),
		message,
		...(typeof source.type === "string" ? { type: source.type } : {}),
		...(typeof source.param === "string" ? { param: source.param } : {}),
		...(source.headers && typeof source.headers === "object"
			? { headers: source.headers as Record<string, string> }
			: {}),
	};
	return new OpenAIResponsesWebSocketServerError(message, { status, code, errorPayload: payload });
}

function isReplayableCompletedOutput(event: ResponseStreamEvent): boolean {
	if (event.type !== "response.completed") return false;
	const items = event.response.output;
	if (!Array.isArray(items)) return false;
	return items.every((item) =>
		item.type === "message"
			? typeof item.id === "string" &&
				item.id.length > 0 &&
				Array.isArray(item.content) &&
				item.content.every((part) => part.type === "output_text")
			: item.type === "reasoning" ||
				item.type === "function_call" ||
				item.type === "custom_tool_call" ||
				item.type === "tool_search_call",
	);
}

/**
 * Normalize an `OpenAIResponsesWebSocketServerError` with an HTTP-like status into an OpenAI SDK
 * `APIError` so `retryProviderRequest` and `formatProviderError` treat it identically to HTTP SSE.
 */
export function toOpenAIResponsesApiError(error: OpenAIResponsesWebSocketServerError): Error {
	if (error.status === undefined) return error;
	const headers = new Headers(error.errorPayload?.headers);
	return APIError.generate(
		error.status,
		{ error: error.errorPayload ?? { message: error.message } },
		error.message,
		headers,
	);
}

export async function* streamOpenAIResponsesWebSocket(
	client: OpenAI,
	params: ResponseCreateParamsStreaming,
	model: Model<"openai-responses">,
	output: AssistantMessage,
	options: OpenAIResponsesOptions,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	if (options.signal?.aborted) throw new APIUserAbortError();

	// Resolve auth, org/project env vars, default headers, and explicit null suppressions via the SDK.
	const { req, url } = await client.buildRequest({
		method: "get",
		path: "/responses",
		...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
	});
	const wsUrl = toWebSocketUrl(url);
	const wsHeaders: Record<string, string> = {};
	for (const [name, value] of new Headers(req.headers).entries()) {
		if (!WEBSOCKET_STRIPPED_HEADERS.has(name.toLowerCase())) {
			wsHeaders[name] = value;
		}
	}
	const identity = JSON.stringify([wsUrl, Object.entries(wsHeaders).sort(([a], [b]) => a.localeCompare(b))]);
	const sessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
	const connectTimeoutMs = options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
	const idleTimeoutMs = options.timeoutMs ?? client.timeout;

	let connection = sessionId ? sessionConnections.get(sessionId) : undefined;
	if (
		connection &&
		(connection.identity !== identity || !isSocketOpen(connection.socket) || isConnectionExpired(connection))
	) {
		if (!connection.busy) closeConnection(connection, "stale_connection");
		if (sessionId && sessionConnections.get(sessionId) === connection) sessionConnections.delete(sessionId);
		connection = undefined;
	}

	const canReuse = connection !== undefined && !connection.busy;
	const shouldCache = sessionId !== undefined && !connection?.busy;
	if (!canReuse) {
		const socket = await connectSocket(wsUrl, wsHeaders, options.signal, connectTimeoutMs, options.env);
		const created: CachedConnection = {
			socket,
			identity,
			sessionId,
			createdAt: Date.now(),
			busy: true,
		};
		activeConnections.add(created);
		socket.addEventListener("error", () => {
			if (!created.busy) closeConnection(created, "idle_error");
		});
		socket.addEventListener("close", () => {
			if (!created.busy) closeConnection(created, "idle_close");
		});
		connection = created;
		if (shouldCache && sessionId) sessionConnections.set(sessionId, created);
	}

	const active = connection!;
	active.busy = true;
	if (active.idleTimer) {
		clearTimeout(active.idleTimer);
		active.idleTimer = undefined;
	}

	const { stream: _stream, input, ...body } = params;
	const bodyRecord = body as Record<string, unknown>;
	const incremental =
		options.transport !== "websocket" &&
		options.disableContinuation !== true &&
		!bodyRecord.previous_response_id &&
		!bodyRecord.conversation;
	const requestKey = JSON.stringify(bodyRecord);
	const fullInput = Array.isArray(input) ? input.map((item) => JSON.stringify(item)) : undefined;

	const previous = active.continuation;
	const payload: Record<string, unknown> = {
		type: "response.create",
		...bodyRecord,
		input,
	};
	if (
		incremental &&
		previous &&
		fullInput &&
		Array.isArray(input) &&
		requestKey === previous.request &&
		fullInput.length >= previous.input.length &&
		previous.input.every((item, index) => item === fullInput[index])
	) {
		payload.previous_response_id = previous.responseId;
		payload.input = input.slice(previous.input.length);
	}
	if (options.disableContinuation !== true) {
		active.continuation = undefined;
	}

	const queue: ResponseStreamEvent[] = [];
	let head = 0;
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawTerminal = false;
	let replayable = false;
	let keep = false;

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				const text = await decodeMessageData((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				if (parsed.type === "error") {
					failed = parseServerErrorFrame(parsed);
					done = true;
					wake();
					return;
				}
				const streamEvent = parsed as unknown as ResponseStreamEvent;
				if (
					streamEvent.type === "response.completed" ||
					streamEvent.type === "response.incomplete" ||
					streamEvent.type === "response.failed"
				) {
					sawTerminal = true;
					replayable = isReplayableCompletedOutput(streamEvent);
					done = true;
				}
				queue.push(streamEvent);
				wake();
			} catch (cause) {
				failed = new APIConnectionError({
					message: `Invalid Responses WebSocket event: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause: cause instanceof Error ? cause : undefined,
				});
				done = true;
				wake();
			}
		})();
	};

	const onError: WebSocketListener = (event) => {
		if (!failed) {
			const cause = extractWebSocketError(event);
			failed = new APIConnectionError({ message: cause.message, cause });
		}
		done = true;
		wake();
	};

	const onClose: WebSocketListener = (event) => {
		if (!sawTerminal && !failed) {
			failed = new APIConnectionError({ message: extractWebSocketCloseMessage(event) });
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new APIUserAbortError();
		done = true;
		closeConnection(active, "aborted");
		wake();
	};

	active.socket.addEventListener("message", onMessage);
	active.socket.addEventListener("error", onError);
	active.socket.addEventListener("close", onClose);
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (options.signal?.aborted || active.cancelled) throw new APIUserAbortError();
		try {
			active.socket.send(JSON.stringify(payload));
		} catch (cause) {
			throw new APIConnectionError({
				message: cause instanceof Error ? cause.message : String(cause),
				cause: cause instanceof Error ? cause : undefined,
			});
		}

		let started = false;
		while (true) {
			if (options.signal?.aborted || active.cancelled) throw new APIUserAbortError();
			if (head < queue.length) {
				const nextEvent = queue[head++]!;
				if (head === queue.length) {
					queue.length = 0;
					head = 0;
				}
				if (!started) {
					started = true;
					onStart();
				}
				yield nextEvent;
				continue;
			}
			if (done) break;

			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve, reject) => {
				pending = resolve;
				if (idleTimeoutMs > 0) {
					idleTimer = setTimeout(() => {
						const timeoutError = new APIConnectionTimeoutError({
							message: `Responses WebSocket idle timeout after ${idleTimeoutMs}ms`,
						});
						failed = timeoutError;
						done = true;
						pending = null;
						closeConnection(active, "idle_timeout");
						reject(timeoutError);
					}, idleTimeoutMs);
					idleTimer.unref?.();
				}
			}).finally(() => {
				if (idleTimer) clearTimeout(idleTimer);
			});
		}

		if (options.signal?.aborted || active.cancelled) throw new APIUserAbortError();
		if (failed) throw failed;
		if (!sawTerminal) {
			throw new APIConnectionError({ message: "Responses WebSocket ended before completion" });
		}

		keep = !options.signal?.aborted && !active.cancelled;
		if (keep && replayable && incremental && fullInput && output.responseId) {
			const replayItems: ResponseInput = convertResponsesMessages(
				model,
				normalizeContext({ messages: [output] }),
				OPENAI_RESPONSES_TOOL_CALL_PROVIDERS,
				{ grammarToolInputProperties, toolSupport: "none" },
			).filter(
				(item) =>
					item.type !== "function_call_output" &&
					item.type !== "custom_tool_call_output" &&
					item.type !== "tool_search_output" &&
					!("role" in item && item.role === "user"),
			);
			active.continuation = {
				request: requestKey,
				input: [...fullInput, ...replayItems.map((item) => JSON.stringify(item))],
				responseId: output.responseId,
			};
		}
	} finally {
		active.socket.removeEventListener("message", onMessage);
		active.socket.removeEventListener("error", onError);
		active.socket.removeEventListener("close", onClose);
		options.signal?.removeEventListener("abort", onAbort);
		active.busy = false;
		if (keep && sessionId && sessionConnections.get(sessionId) === active && isSocketOpen(active.socket)) {
			active.idleTimer = setTimeout(() => closeConnection(active, "idle_timeout"), SESSION_WEBSOCKET_IDLE_TTL_MS);
			active.idleTimer.unref?.();
		} else {
			closeConnection(active, keep ? "done" : "failed");
		}
	}
}
