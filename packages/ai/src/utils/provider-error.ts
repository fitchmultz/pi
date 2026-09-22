import type { AssistantMessage } from "../types.ts";
import { isMonitoringBlocked } from "./retry.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** OpenAI HTTP errors, stream events, and SDK WebSocket error envelopes. */
export function getProviderError(error: unknown): AssistantMessage["providerError"] {
	const outer = asRecord(error);
	const nested = asRecord(outer?.error);
	const inner = asRecord(nested?.error);
	const result: NonNullable<AssistantMessage["providerError"]> = {};
	for (const source of [outer, nested, inner]) {
		if (!source) continue;
		if (typeof source.code === "string") result.code = source.code;
		// Stream event type "error" is an envelope, not the provider's error type.
		if (typeof source.type === "string" && source.type !== "error") result.type = source.type;
		if (typeof source.status === "number") result.status = source.status;
		const headers = source.headers;
		const requestId =
			source.requestId ??
			source.request_id ??
			(headers instanceof Headers ? headers.get("x-request-id") : asRecord(headers)?.["x-request-id"]);
		const responseId = source.responseId ?? source.response_id;
		if (typeof requestId === "string") result.requestId = requestId;
		if (typeof responseId === "string") result.responseId = responseId;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function captureProviderError(output: AssistantMessage, error: unknown, requestId?: string): void {
	const details = getProviderError(error);
	if (!details) return;
	output.providerError = details;
	output.providerError.requestId ??= requestId;
	output.providerError.responseId ??= output.responseId;
	if (isMonitoringBlocked(output)) {
		output.errorMessage = [
			output.errorMessage,
			`Monitoring block: ${details.code}`,
			details.requestId ? `Request ID: ${details.requestId}` : undefined,
			details.responseId ? `Response ID: ${details.responseId}` : undefined,
			"Review prior actions; this stop did not undo them. Do not automatically retry this conversation.",
		]
			.filter(Boolean)
			.join("\n");
	}
}
