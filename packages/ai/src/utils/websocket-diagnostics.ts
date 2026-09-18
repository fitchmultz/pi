import type * as AsyncHooks from "node:async_hooks";
import type * as DiagnosticsChannel from "node:diagnostics_channel";
import type { Socket } from "node:net";

export type WebSocketSocketDiagnostics = {
	connectionId: string;
	bytesRead?: number;
	bytesWritten?: number;
	readableEnded?: boolean;
	destroyed?: boolean;
	errorCode?: string;
	syscall?: string;
	endMs?: number;
	closeMs?: number;
	hadError?: boolean;
	localCloseReason?: string;
	localCloseMs?: number;
};

const sockets = new WeakMap<object, { socket: Socket; startedAt: number; details: WebSocketSocketDiagnostics }>();

/** Observe Undici's native socket without logging headers, addresses, or payloads. No-op in other runtimes. */
export function observeWebSocketConnection(connectionId: string): {
	run<T>(create: () => T): T;
	attach(websocket: object): void;
	cleanup(): void;
} {
	const getBuiltinModule = typeof process === "undefined" ? undefined : process.getBuiltinModule;
	const channels = getBuiltinModule?.("node:diagnostics_channel") as typeof DiagnosticsChannel | undefined;
	const hooks = getBuiltinModule?.("node:async_hooks") as typeof AsyncHooks | undefined;
	const context = hooks ? new hooks.AsyncLocalStorage<boolean>() : undefined;
	const channel = channels?.channel("undici:client:sendHeaders");
	const created = channels?.channel("undici:request:create");
	const requests = new WeakSet<object>();
	const onCreate = (value: unknown) => {
		const event = value as { request?: object & { upgrade?: string } };
		if (context?.getStore() && event?.request?.upgrade === "websocket") requests.add(event.request);
	};
	let websocket: object | undefined;
	let observed: { socket: Socket; startedAt: number; details: WebSocketSocketDiagnostics } | undefined;
	const onHeaders = (value: unknown) => {
		const event = value as { request?: object; socket?: Socket };
		if (!event?.request || !requests.has(event.request) || !event.socket) return;
		// Match the native request object, without changing the headers sent to the backend.
		channel?.unsubscribe(onHeaders);
		const socket = event.socket;
		const startedAt = performance.now();
		const details: WebSocketSocketDiagnostics = { connectionId };
		observed = { socket, startedAt, details };
		if (websocket) sockets.set(websocket, observed);
		socket.once("end", () => {
			details.endMs = performance.now() - startedAt;
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			// Error messages can contain URLs or proxy credentials; retain only bounded machine codes.
			if (error.code && /^[A-Z0-9_]{1,80}$/.test(error.code)) details.errorCode = error.code;
			if (error.syscall && /^[a-zA-Z0-9_]{1,40}$/.test(error.syscall)) details.syscall = error.syscall;
		});
		socket.once("close", (hadError) => {
			details.closeMs = performance.now() - startedAt;
			details.hadError = hadError;
		});
	};
	created?.subscribe(onCreate);
	channel?.subscribe(onHeaders);
	return {
		run(create) {
			return context ? context.run(true, create) : create();
		},
		attach(value) {
			websocket = value;
			if (observed) sockets.set(value, observed);
		},
		cleanup() {
			created?.unsubscribe(onCreate);
			channel?.unsubscribe(onHeaders);
			context?.disable();
		},
	};
}

export function recordWebSocketLocalClose(websocket: object, reason: string): void {
	const observed = sockets.get(websocket);
	if (!observed || observed.details.localCloseReason) return;
	observed.details.localCloseReason = reason;
	observed.details.localCloseMs = performance.now() - observed.startedAt;
}

export function snapshotWebSocketSocket(websocket: object): WebSocketSocketDiagnostics | undefined {
	const observed = sockets.get(websocket);
	if (!observed) return undefined;
	return {
		...observed.details,
		bytesRead: observed.socket.bytesRead,
		bytesWritten: observed.socket.bytesWritten,
		readableEnded: observed.socket.readableEnded,
		destroyed: observed.socket.destroyed,
	};
}
