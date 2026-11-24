import OpenAI from "openai";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai/error";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { ResponsesWSBase } from "openai/resources/responses/ws-base";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { AssistantMessage, Model, ProviderEnv } from "../types.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { normalizeContext } from "../utils/transcript.ts";
import type { OpenAIResponsesOptions } from "./openai-responses.ts";
import { convertResponsesMessages, OPENAI_RESPONSES_TOOL_CALL_PROVIDERS } from "./openai-responses-shared.ts";

export const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
export const SESSION_WEBSOCKET_IDLE_TTL_MS = 5 * 60 * 1000;
// OpenAI closes Responses WebSocket connections after 60 minutes, even mid-response.
// Rotate at 45 minutes to leave a 15-minute margin for long responses.
export const SESSION_WEBSOCKET_MAX_AGE_MS = 45 * 60 * 1000;
export const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

const WEBSOCKET_STRIPPED_HEADERS = new Set(["accept", "content-type", "x-stainless-retry-count"]);

type DOMWebSocketListener = (event: unknown) => void;

interface RawNativeWebSocket {
	readyState?: number;
	send(data: string | ArrayBufferLike | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: DOMWebSocketListener): void;
	removeEventListener(type: string, listener: DOMWebSocketListener): void;
}

type NativeWebSocketConstructor = new (
	url: string,
	options?: { headers?: Record<string, string> },
) => RawNativeWebSocket;

export class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

export class ResponsesWebSocketProtocolError extends Error {
	readonly payload?: string | null;

	constructor(message: string, options?: { cause?: unknown; payload?: string | null }) {
		super(message, { cause: options?.cause });
		this.name = "ResponsesWebSocketProtocolError";
		this.payload = options?.payload;
	}
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

export interface ResponsesWebSocketContinuationState {
	requestKey: string;
	baselineItems: string[];
	responseId: string;
}

export interface PooledResponsesWebSocketConnection {
	ws: NativeResponsesWS;
	identity: string;
	sessionId?: string;
	createdAt: number;
	occupancy: { kind: "leased" } | { kind: "idle"; timer: ReturnType<typeof setTimeout> };
	continuation?: ResponsesWebSocketContinuationState;
}

export interface ResponsesWebSocketLease {
	ws: NativeResponsesWS;
	entry?: PooledResponsesWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}

let cachedBunWebSocket: NativeWebSocketConstructor | null = null;

function getNativeWebSocketConstructor(env?: ProviderEnv): NativeWebSocketConstructor | null {
	if (typeof process !== "undefined" && process.versions?.bun) {
		if (!env && cachedBunWebSocket) return cachedBunWebSocket;
		const BaseWebSocket = globalThis.WebSocket as unknown as new (
			url: string | URL,
			options?: Record<string, unknown>,
		) => RawNativeWebSocket;
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
	return typeof ctor === "function" ? (ctor as NativeWebSocketConstructor) : null;
}

function extractNativeWebSocketError(event: unknown): Error {
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

function createWebSocketCloseError(code?: number, reason?: string, wasClean?: boolean): WebSocketCloseError {
	const codeText = typeof code === "number" ? ` ${code}` : "";
	let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
	if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
		reasonText = " message too big";
	}
	return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
		code,
		reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
		wasClean,
	});
}

function decodeSyncWebSocketPayload(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}
	return undefined;
}

/**
 * Adapts a native `globalThis.WebSocket` (Node 22+, Bun, browsers) to the OpenAI SDK's
 * platform-neutral `WebSocketLike` contract used by `ResponsesWSBase`, without requiring the
 * optional Node-only `ws` peer dependency or `node:async_hooks`.
 */
class NativeWebSocketAdapter {
	private readonly _ws: RawNativeWebSocket;
	private readonly _listenerMap = new Map<string, Map<(...args: any[]) => void, DOMWebSocketListener[]>>();
	private _opened = false;
	private _closed = false;
	private _lastCloseEvent?: { code?: number; reason?: string; wasClean?: boolean };
	private _blobQueue: Promise<void> | undefined;

	constructor(ws: RawNativeWebSocket) {
		this._ws = ws;
		this._registerInternal("open", () => {
			this._opened = true;
		});
		this._registerInternal("close", (event) => {
			this._closed = true;
			if (event && typeof event === "object") {
				const raw = event as { code?: unknown; reason?: unknown; wasClean?: unknown };
				this._lastCloseEvent = {
					code: typeof raw.code === "number" ? raw.code : undefined,
					reason: typeof raw.reason === "string" ? raw.reason : undefined,
					wasClean: typeof raw.wasClean === "boolean" ? raw.wasClean : undefined,
				};
			}
		});
	}

	get readyState(): number {
		if (this._closed) return 3;
		const underlying = this._ws.readyState;
		if (underlying === 2 || underlying === 3) return underlying;
		return this._opened ? 1 : 0;
	}

	get lastCloseEvent(): { code?: number; reason?: string; wasClean?: boolean } | undefined {
		return this._lastCloseEvent;
	}

	send(data: string | ArrayBufferLike | ArrayBufferView): void {
		this._ws.send(data);
	}

	close(code?: number, reason?: string): void {
		this._closed = true;
		try {
			this._ws.close(code, reason);
		} catch {}
	}

	on(event: "open", listener: () => void): void;
	on(event: "message", listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void): void;
	on(event: "close", listener: (code: number, reason: string) => void): void;
	on(event: "error", listener: (err: Error) => void): void;
	on(event: string, listener: (...args: any[]) => void): void;
	on(event: string, listener: (...args: any[]) => void): void {
		const wrapped = this._wrapListener(event, listener);
		this._addListener(event, listener, wrapped);
	}

	off(event: string, listener: (...args: any[]) => void): void {
		const wrappedListeners = this._listenerMap.get(event)?.get(listener);
		const wrapped = wrappedListeners?.[wrappedListeners.length - 1];
		if (!wrapped) return;
		this._removeListener(event, listener, wrapped);
	}

	once(event: string, listener: (...args: any[]) => void): void {
		let fired = false;
		const wrapped = this._wrapListener(event, (...args: any[]) => {
			if (fired) return;
			fired = true;
			this._removeListener(event, listener, wrapped);
			listener(...args);
		});
		this._addListener(event, listener, wrapped);
	}

	/** Detaches every DOM listener registered through this adapter from the underlying socket. */
	dispose(): void {
		for (const [event, byListener] of this._listenerMap.entries()) {
			for (const wrappedList of byListener.values()) {
				for (const wrapped of wrappedList) {
					this._ws.removeEventListener(event, wrapped);
				}
			}
		}
		this._listenerMap.clear();
	}

	private _registerInternal(event: string, wrapped: DOMWebSocketListener): void {
		this._addListener(event, wrapped, wrapped);
	}

	private _addListener(event: string, listener: (...args: any[]) => void, wrapped: DOMWebSocketListener): void {
		this._ws.addEventListener(event, wrapped);
		let byListener = this._listenerMap.get(event);
		if (!byListener) {
			byListener = new Map();
			this._listenerMap.set(event, byListener);
		}
		const wrappedListeners = byListener.get(listener);
		if (!wrappedListeners) {
			byListener.set(listener, [wrapped]);
		} else if (!wrappedListeners.includes(wrapped)) {
			wrappedListeners.push(wrapped);
		}
	}

	private _removeListener(event: string, listener: (...args: any[]) => void, wrapped: DOMWebSocketListener): void {
		const byListener = this._listenerMap.get(event);
		const wrappedListeners = byListener?.get(listener);
		const index = wrappedListeners?.lastIndexOf(wrapped) ?? -1;
		if (!byListener || !wrappedListeners || index === -1) return;
		this._ws.removeEventListener(event, wrapped);
		wrappedListeners.splice(index, 1);
		if (wrappedListeners.length === 0) byListener.delete(listener);
		if (byListener.size === 0) this._listenerMap.delete(event);
	}

	private _wrapListener(event: string, listener: (...args: any[]) => void): DOMWebSocketListener {
		switch (event) {
			case "open":
				return () => listener();
			case "message":
				return (ev) => {
					if (!ev || typeof ev !== "object" || !("data" in ev)) return;
					const data = (ev as { data?: unknown }).data;
					const decoded = decodeSyncWebSocketPayload(data);
					if (decoded !== undefined) {
						if (this._blobQueue) {
							this._blobQueue = this._blobQueue.then(() => {
								if (!this._closed) listener(decoded, false);
							});
						} else {
							listener(decoded, false);
						}
						return;
					}
					if (data && typeof data === "object" && "arrayBuffer" in data) {
						const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
						const prev = this._blobQueue ?? Promise.resolve();
						this._blobQueue = prev
							.then(() => blobLike.arrayBuffer())
							.then((buffer) => {
								const text = new TextDecoder().decode(new Uint8Array(buffer));
								listener(text, false);
							})
							.catch(() => {});
					}
				};
			case "close":
				return (ev) => {
					const raw = ev && typeof ev === "object" ? (ev as { code?: unknown; reason?: unknown }) : undefined;
					const code = typeof raw?.code === "number" ? raw.code : 1006;
					const reason = typeof raw?.reason === "string" ? raw.reason : "";
					listener(code, reason);
				};
			case "error":
				return (ev) => {
					listener(extractNativeWebSocketError(ev));
				};
			default:
				return listener;
		}
	}
}

/**
 * Browser- and Node/Bun-safe `ResponsesWSBase` subclass backed by `globalThis.WebSocket`.
 * Delegates JSON framing, `SendQueue`, `ResponsesEmitter`, and `stream()` async iteration to the
 * official OpenAI SDK's `ResponsesWSBase` / `WebSocketConnection`.
 */
export class NativeResponsesWS extends ResponsesWSBase<NativeWebSocketAdapter> {
	private readonly _targetUrl?: string;
	private readonly _headers: Record<string, string>;
	private readonly _env?: ProviderEnv;
	onIdleFailure?: () => void;

	constructor(client: OpenAI, options: { targetUrl?: string; headers: Record<string, string>; env?: ProviderEnv }) {
		super(client);
		this._targetUrl = options.targetUrl;
		this._headers = options.headers;
		this._env = options.env;
		// Keep an error listener attached for the lifetime of the socket so ResponsesEmitter._onError
		// never turns handshake or idle socket errors into unhandled Promise rejections.
		this.on("error", () => {
			this.onIdleFailure?.();
		});
		this.on("close", () => {
			this.onIdleFailure?.();
		});
		this._connectInitial();
	}

	protected _createSocket(url: URL): NativeWebSocketAdapter {
		const WebSocketCtor = getNativeWebSocketConstructor(this._env);
		if (!WebSocketCtor) {
			throw new Error("WebSocket transport is not available in this runtime");
		}
		const target = this._targetUrl ?? url.toString();
		return new NativeWebSocketAdapter(new WebSocketCtor(target, { headers: this._headers }));
	}

	dispose(code = 1000, reason = "done"): void {
		this.onIdleFailure = undefined;
		try {
			this.close({ code, reason });
		} catch {}
		this.socket?.dispose();
	}
}

function createResponsesWSClient(baseUrl: string): OpenAI {
	const httpBase = baseUrl
		.replace(/^wss:/i, "https:")
		.replace(/^ws:/i, "http:")
		.replace(/\/responses\/?$/i, "");
	return new OpenAI({
		apiKey: "responses-ws",
		baseURL: httpBase,
		dangerouslyAllowBrowser: true,
	});
}

function waitForResponsesWSOpen(
	ws: NativeResponsesWS,
	signal?: AbortSignal,
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
): Promise<void> {
	if (signal?.aborted) {
		ws.dispose(1000, "aborted");
		return Promise.reject(new Error("Request was aborted"));
	}
	if (ws.socket.readyState === 1) return Promise.resolve();

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			ws.socket.off("open", onOpen);
			ws.socket.off("error", onError);
			ws.socket.off("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			ws.dispose(1000, closeReason ?? "connect_failed");
			reject(error);
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			fail(error);
		};
		const onClose = (code: number, reason: string) => {
			const raw = ws.socket.lastCloseEvent;
			fail(createWebSocketCloseError(raw?.code ?? code, raw?.reason ?? reason, raw?.wasClean));
		};
		const onAbort = () => {
			fail(new Error("Request was aborted"), "aborted");
		};

		ws.socket.on("open", onOpen);
		ws.socket.on("error", onError);
		ws.socket.on("close", onClose);
		signal?.addEventListener("abort", onAbort);

		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
			}, connectTimeoutMs);
		}
	});
}

/**
 * Shared session-scoped Responses WebSocket connection pool and SSE fallback registry used by
 * both `openai-responses` and `openai-codex-responses`.
 */
export class ResponsesWebSocketPool {
	private readonly _sessions = new Map<string, Map<string, PooledResponsesWebSocketConnection>>();
	private readonly _sseFallbackSessions = new Set<string>();
	private readonly _cleanupCloseReason: string;

	constructor(options?: { cleanupCloseReason?: string }) {
		this._cleanupCloseReason = options?.cleanupCloseReason ?? "session_cleanup";
		registerSessionResourceCleanup((sessionId) => {
			this.closeConnections(sessionId, this._cleanupCloseReason);
			this.clearSseFallback(sessionId);
		});
	}

	isSseFallbackActive(sessionId: string | undefined): boolean {
		return Boolean(sessionId && this._sseFallbackSessions.has(sessionId));
	}

	recordSseFallback(sessionId: string | undefined): void {
		if (!sessionId) return;
		this._sseFallbackSessions.add(sessionId);
	}

	clearSseFallback(sessionId?: string): void {
		if (sessionId === undefined) {
			this._sseFallbackSessions.clear();
		} else {
			this._sseFallbackSessions.delete(sessionId);
		}
	}

	closeConnections(sessionId?: string, reason = "session_cleanup"): void {
		if (sessionId !== undefined) {
			const entries = this._sessions.get(sessionId);
			if (!entries) return;
			for (const entry of entries.values()) {
				this._disposeEntry(entry, reason);
			}
			this._sessions.delete(sessionId);
			return;
		}
		for (const entries of this._sessions.values()) {
			for (const entry of entries.values()) {
				this._disposeEntry(entry, reason);
			}
		}
		this._sessions.clear();
	}

	async acquire(params: {
		client?: OpenAI;
		url: string;
		headers: Record<string, string>;
		sessionId?: string;
		identity: string;
		signal?: AbortSignal;
		connectTimeoutMs?: number;
		env?: ProviderEnv;
	}): Promise<ResponsesWebSocketLease> {
		const { url, headers, sessionId, identity, signal, connectTimeoutMs, env } = params;
		const client = params.client ?? createResponsesWSClient(url);

		if (!sessionId) {
			const ws = await this._connect(client, url, headers, signal, connectTimeoutMs, env);
			return {
				ws,
				reused: false,
				release: () => ws.dispose(1000, "done"),
			};
		}

		const cached = this._sessions.get(sessionId)?.get(identity);
		if (cached) {
			if (cached.occupancy.kind === "leased") {
				const ws = await this._connect(client, url, headers, signal, connectTimeoutMs, env);
				return {
					ws,
					reused: false,
					release: () => ws.dispose(1000, "done"),
				};
			}
			clearTimeout(cached.occupancy.timer);
			cached.ws.onIdleFailure = undefined;
			if (this._isExpired(cached)) {
				this._evict(sessionId, identity, cached, "connection_age_limit");
			} else if (cached.ws.socket.readyState === 1) {
				cached.occupancy = { kind: "leased" };
				return this._lease(sessionId, identity, cached, true);
			} else {
				this._evict(sessionId, identity, cached, "done");
			}
		}

		const ws = await this._connect(client, url, headers, signal, connectTimeoutMs, env);
		const entry: PooledResponsesWebSocketConnection = {
			ws,
			identity,
			sessionId,
			createdAt: Date.now(),
			occupancy: { kind: "leased" },
		};
		let identityEntries = this._sessions.get(sessionId);
		if (!identityEntries) {
			identityEntries = new Map();
			this._sessions.set(sessionId, identityEntries);
		}
		identityEntries.set(identity, entry);
		return this._lease(sessionId, identity, entry, false);
	}

	private async _connect(
		client: OpenAI,
		url: string,
		headers: Record<string, string>,
		signal?: AbortSignal,
		connectTimeoutMs?: number,
		env?: ProviderEnv,
	): Promise<NativeResponsesWS> {
		const ws = new NativeResponsesWS(client, { targetUrl: url, headers, env });
		await waitForResponsesWSOpen(ws, signal, connectTimeoutMs);
		return ws;
	}

	private _isExpired(entry: PooledResponsesWebSocketConnection): boolean {
		return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
	}

	private _disposeEntry(entry: PooledResponsesWebSocketConnection, reason: string): void {
		if (entry.occupancy.kind === "idle") {
			clearTimeout(entry.occupancy.timer);
		}
		entry.continuation = undefined;
		entry.ws.dispose(1000, reason);
	}

	private _evict(
		sessionId: string,
		identity: string,
		entry: PooledResponsesWebSocketConnection,
		reason = "done",
	): void {
		this._disposeEntry(entry, reason);
		const identityEntries = this._sessions.get(sessionId);
		if (identityEntries?.get(identity) === entry) identityEntries.delete(identity);
		if (identityEntries?.size === 0) this._sessions.delete(sessionId);
	}

	private _lease(
		sessionId: string,
		identity: string,
		entry: PooledResponsesWebSocketConnection,
		reused: boolean,
	): ResponsesWebSocketLease {
		return {
			ws: entry.ws,
			entry,
			reused,
			release: ({ keep } = {}) => {
				if (!keep || entry.ws.socket.readyState !== 1) {
					this._evict(sessionId, identity, entry);
					return;
				}
				entry.ws.onIdleFailure = () => {
					if (entry.occupancy.kind === "idle") {
						this._evict(sessionId, identity, entry, "idle_error");
					}
				};
				entry.occupancy = {
					kind: "idle",
					timer: setTimeout(
						() => this._evict(sessionId, identity, entry, "idle_timeout"),
						SESSION_WEBSOCKET_IDLE_TTL_MS,
					),
				};
			},
		};
	}
}

/**
 * Build an incremental `previous_response_id` payload when the current request extends the
 * connection's previous request and output items without mutating non-input fields or the prefix.
 */
export function buildWebSocketContinuationBody<TBody extends Record<string, unknown>>(
	entry: PooledResponsesWebSocketConnection | undefined,
	fullBody: TBody,
	enabled: boolean,
): { body: TBody; isDelta: boolean } {
	const continuation = entry?.continuation;
	if (!enabled || !continuation || !continuation.responseId) {
		return { body: fullBody, isDelta: false };
	}

	const { input, previous_response_id: existingPrev, ...rest } = fullBody;
	if (existingPrev || rest.conversation || !Array.isArray(input)) {
		if (entry) entry.continuation = undefined;
		return { body: fullBody, isDelta: false };
	}

	const requestKey = JSON.stringify(rest);
	const serializedInput = input.map((item) => JSON.stringify(item));
	if (
		requestKey !== continuation.requestKey ||
		serializedInput.length < continuation.baselineItems.length ||
		!continuation.baselineItems.every((item, index) => item === serializedInput[index])
	) {
		if (entry) entry.continuation = undefined;
		return { body: fullBody, isDelta: false };
	}

	return {
		body: {
			...fullBody,
			previous_response_id: continuation.responseId,
			input: input.slice(continuation.baselineItems.length),
		},
		isDelta: true,
	};
}

/** Save the completed turn's request and output items on a pooled connection for delta replay. */
export function recordWebSocketContinuationState(
	entry: PooledResponsesWebSocketConnection | undefined,
	fullBody: Record<string, unknown>,
	responseId: string,
	responseItems: ResponseInput,
): void {
	if (!entry) return;
	const { input, previous_response_id: _prev, ...rest } = fullBody;
	if (!Array.isArray(input)) return;
	entry.continuation = {
		requestKey: JSON.stringify(rest),
		baselineItems: [...input, ...responseItems].map((item) => JSON.stringify(item)),
		responseId,
	};
}

/**
 * Send one `response.create` event over a `NativeResponsesWS` (SDK `ResponsesWSBase`) and yield
 * parsed server events until terminal completion, server error, abort, or idle timeout.
 */
export async function* streamResponsesWebSocketTurn(
	ws: NativeResponsesWS,
	requestPayload: Record<string, unknown>,
	options?: { signal?: AbortSignal; idleTimeoutMs?: number },
): AsyncGenerator<Record<string, unknown>> {
	const signal = options?.signal;
	const idleTimeoutMs = options?.idleTimeoutMs;
	if (signal?.aborted) {
		throw new Error("Request was aborted");
	}

	const iterator = ws.stream();
	let sawCompletion = false;
	let abortReject: ((error: Error) => void) | undefined;
	const onAbort = () => {
		abortReject?.(new Error("Request was aborted"));
	};
	signal?.addEventListener("abort", onAbort);

	const nextMessage = async () => {
		if (signal?.aborted) throw new Error("Request was aborted");
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const nextPromise = iterator.next();
		if (!signal && !(idleTimeoutMs !== undefined && idleTimeoutMs > 0)) {
			return nextPromise;
		}
		return new Promise<IteratorResult<Awaited<ReturnType<typeof iterator.next>>["value"]>>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				abortReject = undefined;
				if (timeout) {
					clearTimeout(timeout);
					timeout = undefined;
				}
				fn();
			};
			abortReject = (err) => finish(() => reject(err));
			if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
				timeout = setTimeout(() => {
					ws.dispose(1000, "idle_timeout");
					finish(() => reject(new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`)));
				}, idleTimeoutMs);
			}
			nextPromise.then(
				(result) => finish(() => resolve(result)),
				(error) => finish(() => reject(error)),
			);
		});
	};

	try {
		// Send the full Responses create payload verbatim over the SDK WebSocket transport.
		ws.send({ type: "response.create", ...requestPayload } as Parameters<NativeResponsesWS["send"]>[0]);

		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const step = await nextMessage();
			if (step.done) break;
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const item = step.value;
			if (item.type === "message") {
				const event = item.message as unknown as Record<string, unknown>;
				const eventType = typeof event.type === "string" ? event.type : "";
				if (
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete"
				) {
					sawCompletion = true;
				}
				yield event;
				if (sawCompletion || eventType === "error" || eventType === "response.failed") {
					if (eventType === "error" || eventType === "response.failed") sawCompletion = true;
					break;
				}
				continue;
			}
			if (item.type === "raw") {
				const payload = typeof item.data === "string" ? item.data : (decodeSyncWebSocketPayload(item.data) ?? null);
				throw new ResponsesWebSocketProtocolError("Invalid WebSocket JSON payload", { payload });
			}
			if (item.type === "error") {
				const err = item.error;
				// ResponsesWSBase routes `{ type: "error", ... }` wire frames through `WebSocketError.error`
				// instead of `{ type: "message" }`. Yield the wire event so callers parse server error codes.
				const serverEvent =
					err && typeof err === "object" && "error" in err ? (err as { error?: unknown }).error : undefined;
				if (
					serverEvent &&
					typeof serverEvent === "object" &&
					(serverEvent as { type?: unknown }).type === "error"
				) {
					sawCompletion = true;
					yield serverEvent as Record<string, unknown>;
					break;
				}
				throw err.cause instanceof Error ? err.cause : err;
			}
			if (item.type === "close") {
				if (sawCompletion) break;
				const raw = ws.socket.lastCloseEvent;
				throw createWebSocketCloseError(raw?.code ?? item.code, raw?.reason ?? item.reason, raw?.wasClean);
			}
		}

		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await iterator.return?.();
	}
}

// ============================================================================
// Direct OpenAI Responses WebSocket transport (`provider: "openai"`)
// ============================================================================

const openaiWebSocketPool = new ResponsesWebSocketPool();

export function isOpenAIResponsesWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return openaiWebSocketPool.isSseFallbackActive(sessionId);
}

export function recordOpenAIResponsesWebSocketSseFallback(sessionId: string | undefined): void {
	openaiWebSocketPool.recordSseFallback(sessionId);
}

export function closeOpenAIResponsesWebSocketSessions(sessionId?: string): void {
	openaiWebSocketPool.closeConnections(sessionId);
}

export function resetOpenAIResponsesWebSocketStateForTests(sessionId?: string): void {
	openaiWebSocketPool.closeConnections(sessionId, "test_reset");
	openaiWebSocketPool.clearSseFallback(sessionId);
}

function toWebSocketUrl(httpUrl: string): string {
	const parsed = new URL(httpUrl);
	if (parsed.protocol === "https:") parsed.protocol = "wss:";
	else if (parsed.protocol === "http:") parsed.protocol = "ws:";
	return parsed.toString();
}

function extractServerError(event: Record<string, unknown>): OpenAIResponsesWebSocketServerError {
	const status = typeof event.status === "number" ? event.status : undefined;
	const rawNested = event.error;
	const nested = rawNested && typeof rawNested === "object" ? (rawNested as Record<string, unknown>) : undefined;
	const code =
		typeof nested?.code === "string" ? nested.code : typeof event.code === "string" ? event.code : undefined;
	const message =
		typeof nested?.message === "string"
			? nested.message
			: typeof event.message === "string"
				? event.message
				: code || "WebSocket error event";
	const payload: ServerErrorPayload = {
		...(code ? { code } : {}),
		message,
		...(typeof nested?.type === "string" ? { type: nested.type } : {}),
		...(typeof nested?.param === "string" ? { param: nested.param } : {}),
		...(event.headers && typeof event.headers === "object"
			? { headers: event.headers as Record<string, string> }
			: {}),
	};
	return new OpenAIResponsesWebSocketServerError(message, { status, code, errorPayload: payload });
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

function wrapDirectOpenAITransportError(error: unknown, signal?: AbortSignal): Error {
	if (signal?.aborted || (error instanceof Error && error.message === "Request was aborted")) {
		return new APIUserAbortError();
	}
	if (
		error instanceof OpenAIResponsesWebSocketServerError ||
		error instanceof APIError ||
		error instanceof APIConnectionError
	) {
		return error;
	}
	if (
		error instanceof Error &&
		(error.message.includes("connect timeout") || error.message.includes("idle timeout"))
	) {
		return new APIConnectionTimeoutError({ message: error.message });
	}
	const cause = error instanceof Error ? error : new Error(String(error));
	return new APIConnectionError({ message: cause.message, cause });
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

	let lease: ResponsesWebSocketLease;
	try {
		lease = await openaiWebSocketPool.acquire({
			client,
			url: wsUrl,
			headers: wsHeaders,
			sessionId,
			identity,
			signal: options.signal,
			connectTimeoutMs,
			env: options.env,
		});
	} catch (error) {
		throw wrapDirectOpenAITransportError(error, options.signal);
	}

	const { stream: _stream, ...fullBody } = params as unknown as Record<string, unknown>;
	const incremental = options.transport !== "websocket" && options.disableContinuation !== true;
	const { body: requestBody } = buildWebSocketContinuationBody(lease.entry, fullBody, incremental);
	if (options.disableContinuation !== true && lease.entry) {
		lease.entry.continuation = undefined;
	}

	let keepConnection = true;
	let started = false;
	let completedResponseId: string | undefined;

	try {
		for await (const event of streamResponsesWebSocketTurn(lease.ws, requestBody, {
			signal: options.signal,
			idleTimeoutMs,
		})) {
			if (event.type === "error") {
				throw extractServerError(event);
			}
			if (event.type === "response.completed" || event.type === "response.incomplete") {
				const resp = event.response as { id?: unknown } | undefined;
				if (typeof resp?.id === "string" && resp.id.length > 0) {
					completedResponseId = resp.id;
				}
			}
			if (!started) {
				started = true;
				onStart();
			}
			yield event as unknown as ResponseStreamEvent;
		}

		const responseId = output.responseId || completedResponseId;
		if (!options.signal?.aborted && incremental && lease.entry && responseId) {
			const responseItems = convertResponsesMessages(
				model,
				normalizeContext({ messages: [output] }),
				OPENAI_RESPONSES_TOOL_CALL_PROVIDERS,
				{ grammarToolInputProperties, toolSupport: "none" },
			).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
			recordWebSocketContinuationState(lease.entry, fullBody, responseId, responseItems);
		}
	} catch (error) {
		if (lease.entry) lease.entry.continuation = undefined;
		keepConnection = false;
		throw wrapDirectOpenAITransportError(error, options.signal);
	} finally {
		lease.release({ keep: keepConnection && !options.signal?.aborted });
	}
}
