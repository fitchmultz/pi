import { GoogleGenAI, type HttpOptions } from "@google/genai";
import type { AnyModel, BaseModel, FetchFunction, ProviderHeaders, ProviderRequestOptions } from "../types.ts";
import { headersToRecord, providerHeadersToRecord, removedProviderHeaderNames } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

const MAX_HEADER_TIMEOUT_MS = 0x7fffffff;

const CLOUDFLARE_AI_GATEWAY_GOOGLE_AI_STUDIO_URL_PATTERN =
	/^https:\/\/(?:gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+|workers-binding\.ai\/ai-gateway\/gateways\/[^/]+)\/google-ai-studio(?:\/|$)/;

/** Whether `baseUrl` targets a Cloudflare AI Gateway `/google-ai-studio` passthrough (HTTPS or Workers AI binding). */
export function isCloudflareGoogleAiStudioUrl(baseUrl: string | undefined): boolean {
	return baseUrl !== undefined && CLOUDFLARE_AI_GATEWAY_GOOGLE_AI_STUDIO_URL_PATTERN.test(baseUrl);
}

/**
 * Whether requests for `model` target the Gemini Developer API (rather than Vertex AI or an
 * unrelated third-party endpoint). Without a base URL the SDK sends to generativelanguage.googleapis.com.
 */
export function sendsToGeminiApi(model: Pick<BaseModel<string>, "api" | "provider" | "baseUrl">): boolean {
	return (
		(model.api === "google-generative-ai" || model.api === "google-interactions" || model.api === "google-images") &&
		(model.provider === "google" ||
			!model.baseUrl ||
			(URL.canParse(model.baseUrl) && new URL(model.baseUrl).hostname === "generativelanguage.googleapis.com") ||
			isCloudflareGoogleAiStudioUrl(model.baseUrl))
	);
}

/**
 * Resolve the SDK `apiKey` for `@google/genai`:
 * - Explicit `options.apiKey` or `x-goog-api-key` header takes precedence.
 * - For Cloudflare AI Gateway `/google-ai-studio` passthroughs (BYOK / Unified Billing) without a
 *   Google key, pass the `cf-aig-authorization` token directly as `apiKey` per Cloudflare's
 *   `@google/genai` guide.
 */
export function resolveGoogleApiKey(
	model: Pick<BaseModel<string>, "baseUrl" | "headers">,
	apiKey: string | undefined,
	optionsHeaders: ProviderHeaders | undefined,
): string | undefined {
	if (apiKey) return apiKey;
	const merged = providerHeadersToRecord(model.headers, optionsHeaders);
	if (!merged) return undefined;
	const headers = new Headers(merged);
	const explicitHeaderKey = headers.get("x-goog-api-key")?.trim();
	if (explicitHeaderKey) return explicitHeaderKey;
	if (!isCloudflareGoogleAiStudioUrl(model.baseUrl)) return undefined;
	const gatewayAuth = headers.get("cf-aig-authorization")?.trim();
	if (!gatewayAuth) return undefined;
	return gatewayAuth.replace(/^Bearer\s+/i, "").trim() || undefined;
}

export function createGoogleClient(
	model: AnyModel,
	apiKey: string | undefined,
	optionsHeaders: ProviderHeaders | undefined,
	identity: ClientIdentity | undefined,
	fetch?: FetchFunction,
): GoogleGenAI {
	// Always pass fetch: without one, @google/genai adds a per-request dispatcher that disables
	// undici's header and body timeouts, bypassing the idle timeouts of the global dispatcher.
	const httpOptions: HttpOptions = { fetch: fetch ?? globalThis.fetch };
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	const headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders);
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({ apiKey, httpOptions });
}

export function createGoogleFetch<TModel extends AnyModel>(
	providerLabel: string,
	model: TModel,
	options: ProviderRequestOptions<TModel> | undefined,
	onFailedHeaders: (headers: Headers | undefined) => void,
): FetchFunction {
	const baseFetch = options?.fetch ?? globalThis.fetch;
	const timeoutMs = options?.timeoutMs;
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
		throw new RangeError(`Invalid timeoutMs: ${String(timeoutMs)}`);
	}
	// The header timeout bounds only the wait for response headers; active streams stay governed
	// by the HTTP client's idle bodyTimeout so long responses are never cut off mid-stream.
	const effectiveHeaderTimeoutMs =
		timeoutMs !== undefined && timeoutMs < MAX_HEADER_TIMEOUT_MS ? Math.floor(timeoutMs) : undefined;
	const removedHeaders = removedProviderHeaderNames(model.headers, options?.headers);

	return async (input, init) => {
		onFailedHeaders(undefined);
		let requestInput = input;
		let requestInit = init;
		if (removedHeaders.size > 0) {
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			for (const name of removedHeaders) {
				headers.delete(name);
			}
			if (input instanceof Request) {
				requestInput = new Request(input, { ...init, headers });
				requestInit = undefined;
			} else {
				requestInit = { ...init, headers };
			}
		}
		let response: Response;
		if (effectiveHeaderTimeoutMs !== undefined) {
			const headerTimeoutController = new AbortController();
			const existingSignal =
				requestInit?.signal ?? (requestInput instanceof Request ? requestInput.signal : undefined);
			const signal = existingSignal
				? AbortSignal.any([existingSignal, headerTimeoutController.signal])
				: headerTimeoutController.signal;
			const timer = setTimeout(() => headerTimeoutController.abort(), effectiveHeaderTimeoutMs);
			timer.unref?.();
			try {
				response = await baseFetch(requestInput, { ...requestInit, signal });
			} catch (error) {
				if (headerTimeoutController.signal.aborted && !existingSignal?.aborted) {
					throw new Error(`${providerLabel} response headers timed out after ${effectiveHeaderTimeoutMs}ms`);
				}
				throw error;
			} finally {
				clearTimeout(timer);
			}
		} else {
			response = await baseFetch(requestInput, requestInit);
		}

		if (!response.ok) {
			onFailedHeaders(new Headers(response.headers));
		}
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		return response;
	};
}

/**
 * Run a Google GenAI SDK request with the shared provider retry policy
 * (408/409/429/5xx with backoff, honoring retry-after). The SDK's ApiError has a `status`
 * property without `headers`, and `retryProviderRequest` only retries errors carrying both,
 * so attach captured failure headers before rethrowing. Failed attempts reach `options.onResponse`
 * when supplied; callers using `createGoogleFetch` omit `onResponse` here because `createGoogleFetch`
 * already reports every HTTP response with its real headers.
 */
export function retryGoogleRequest<T, TModel extends AnyModel = AnyModel>(
	request: () => Promise<T>,
	model: TModel,
	options?: Pick<ProviderRequestOptions<TModel>, "maxRetries" | "maxRetryDelayMs" | "signal" | "onResponse">,
	getFailureHeaders?: () => Headers | undefined,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = getFailureHeaders?.();
				}
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
			onErrorResponse: options?.onResponse
				? (errorResponse) => options.onResponse?.(errorResponse, model)
				: undefined,
		},
	);
}
