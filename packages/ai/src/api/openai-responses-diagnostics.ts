import type { AssistantMessage } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";

// New exports live here so adapters can load even when an older shared parser is already cached.
export type ResponsesDiagnostics = {
	startedAt: number;
	details: {
		timingOrigin: "adapter_start";
		transport?: "websocket" | "sse";
		requestedServiceTier: ReturnType<typeof diagnosticServiceTier>;
		returnedServiceTier: ReturnType<typeof diagnosticServiceTier>;
		prepareMs?: number;
		onPayloadMs?: number;
		requestReadyMs?: number;
		lastAttemptStartMs?: number;
		headersMs?: number;
		firstApplicationEventMs?: number;
		firstContentDeltaMs?: number;
		lastApplicationEventMs?: number;
		lastApplicationEventAgeMs?: number;
		terminalEventMs?: number;
		finishedMs?: number;
		applicationEvents: number;
		sseAttempts: number;
		websocketAttempts: number;
		fullBodyBytes?: number;
		sseSendBytes?: number;
		sseCompressed?: boolean;
		websocketSendBytes?: number;
		websocketSendMs?: number;
		websocketRequestMode?: "full" | "delta";
		socketReused?: boolean;
		socketAgeMs?: number;
		connectStartMs?: number;
		connectMs?: number;
		websocketConnectTimeoutMs?: number;
		websocketIdleTimeoutMs?: number;
		fallbackReason?: "session_disabled" | "before_stream_start";
		connectionLimitRetries?: number;
		missingContinuationRetries?: number;
		closeCode?: number;
		closeWasClean?: boolean;
		closeMs?: number;
		localTimeout?: "websocket_connect" | "websocket_idle" | "sse_headers" | "sdk_request";
		localTimeoutMs?: number;
	};
};

export function diagnosticServiceTier(
	value: unknown,
): "auto" | "default" | "flex" | "scale" | "priority" | "fast" | "unknown" {
	return value === "auto" ||
		value === "default" ||
		value === "flex" ||
		value === "scale" ||
		value === "priority" ||
		value === "fast"
		? value
		: "unknown";
}

export function createResponsesDiagnostics(output: AssistantMessage): ResponsesDiagnostics {
	const diagnostics: ResponsesDiagnostics = {
		startedAt: performance.now(),
		details: {
			timingOrigin: "adapter_start",
			requestedServiceTier: "unknown",
			returnedServiceTier: "unknown",
			applicationEvents: 0,
			sseAttempts: 0,
			websocketAttempts: 0,
		},
	};
	appendAssistantMessageDiagnostic(output, {
		type: "provider_request",
		timestamp: Date.now(),
		details: diagnostics.details,
	});
	return diagnostics;
}

/** Observe parsed application events, not socket packets, control frames, or backend timing. */
export function recordResponsesEvent(
	diagnostics: ResponsesDiagnostics,
	event: { type?: unknown; delta?: unknown; response?: unknown },
): void {
	const elapsed = performance.now() - diagnostics.startedAt;
	const details = diagnostics.details;
	details.applicationEvents++;
	details.firstApplicationEventMs ??= elapsed;
	details.lastApplicationEventMs = elapsed;
	if (
		(event.type === "response.output_text.delta" ||
			event.type === "response.refusal.delta" ||
			event.type === "response.reasoning_text.delta" ||
			event.type === "response.reasoning_summary_text.delta" ||
			event.type === "response.function_call_arguments.delta" ||
			event.type === "response.custom_tool_call_input.delta") &&
		typeof event.delta === "string" &&
		event.delta.length > 0
	) {
		details.firstContentDeltaMs ??= elapsed;
	}
	if (
		event.type === "response.completed" ||
		event.type === "response.done" ||
		event.type === "response.incomplete" ||
		event.type === "response.failed"
	) {
		details.terminalEventMs = elapsed;
		const response = event.response as { service_tier?: unknown } | undefined;
		details.returnedServiceTier = diagnosticServiceTier(response?.service_tier);
	}
}

export function finishResponsesDiagnostics(diagnostics: ResponsesDiagnostics): void {
	const details = diagnostics.details;
	details.finishedMs = performance.now() - diagnostics.startedAt;
	if (details.lastApplicationEventMs !== undefined) {
		details.lastApplicationEventAgeMs = details.finishedMs - details.lastApplicationEventMs;
	}
}
