import { calculateCost } from "../models.ts";
import type { ClassifierApi, ClassifierModel, ClassifierOptions, Usage } from "../types.ts";
import { isRecord, type JsonHttpError, postJsonRequest } from "./json-request.ts";

export { isRecord };

/** An HTTP failure in the shape `retryProviderRequest` and `normalizeProviderError` understand. */
export type ClassifierHttpError = JsonHttpError;

export function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

/**
 * Posts one JSON classifier request with bearer auth, or with the credential header the caller
 * already set, `onPayload`/`onResponse` hooks, a fresh timeout per attempt, and provider retries.
 * Returns the parsed response body; throws on failure.
 * `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
 */
export function postClassifierRequest(
	label: string,
	url: URL,
	model: ClassifierModel<ClassifierApi>,
	body: unknown,
	options: ClassifierOptions | undefined,
	noRetryStatuses?: readonly number[],
	authHeaders?: Record<string, string>,
): Promise<unknown> {
	return postJsonRequest(label, url, model, body, options, noRetryStatuses, authHeaders);
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Usage from `{ input_tokens, output_tokens }` or `{ total_input_tokens, total_output_tokens }`,
 * priced from the model catalog like chat usage. A missing or malformed usage object leaves the
 * result without usage instead of failing it. `input_tokens_details.cached_tokens` and
 * `cache_write_tokens` are included in `input_tokens`, as in the Responses API, so they are split
 * out of `input`.
 */
export function parseClassifierUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const rawInput = value.input_tokens ?? value.total_input_tokens;
	const rawOutput = value.output_tokens ?? value.total_output_tokens;
	if (rawInput === undefined && rawOutput === undefined) return undefined;
	const totalInput = tokenCount(rawInput);
	const output = tokenCount(rawOutput);
	const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = Math.min(tokenCount(details?.cached_tokens), totalInput);
	const cacheWrite = Math.min(tokenCount(details?.cache_write_tokens), totalInput - cacheRead);
	const usage: Usage = {
		input: totalInput - cacheRead - cacheWrite,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: totalInput + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
