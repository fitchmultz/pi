import type * as NodeZlib from "node:zlib";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFailedEvent,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { clampThinkingLevel, getMidConvoToolSupport } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { getDeclaredTools, normalizeContext, resolveTranscriptTools } from "../utils/transcript.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	applyServiceTierPricing,
	convertResponsesMessages,
	convertResponsesTools,
	getOpenAIProviderSummaryBlock,
	OPENAI_RESPONSES_TOOL_CALL_PROVIDERS,
	processResponsesStream,
	resolveOpenAIResponsesContext,
} from "./openai-responses-shared.ts";
import {
	buildWebSocketContinuationBody,
	ResponsesWebSocketPool,
	ResponsesWebSocketProtocolError,
	recordWebSocketContinuationState,
	streamResponsesWebSocketTurn,
} from "./openai-responses-websocket.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
// The Codex backend accepts zstd-compressed request bodies on the SSE responses
// endpoint (the same endpoint the official Codex client compresses against).
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
const SERVICE_TIER_NOT_ALLOWED_CODE = "service_tier_not_allowed";
// The Responses API rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const MIN_OUTPUT_TOKENS = 16;
// Fixed reasoning.effort while configuration_update items carry the thinking level.
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// Types
// ============================================================================

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}

type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	previous_response_id?: string;
	input?: ResponseInput;
	max_output_tokens?: number;
	tools?: OpenAITool[];
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

function assertSuccessfulOutput(output: AssistantMessage): asserts output is SuccessfulAssistantMessage {
	if (output.stopReason === "pending") {
		throw new Error("Codex stream ended without a stop reason");
	}
	if (output.stopReason === "error" || output.stopReason === "aborted") {
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
}

// ============================================================================
// Retry Helpers
// ============================================================================

function isTerminalRateLimitError(errorText: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		errorText,
	);
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 && isTerminalRateLimitError(errorText)) {
		return false;
	}
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function isNonStandardServiceTier(tier: RequestBody["service_tier"]) {
	return tier != null && tier !== "default" && tier !== "auto";
}

function getRetryAfterDelayMs(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) {
			return Math.max(0, millis);
		}
	}

	const retryAfter = headers.get("retry-after");
	if (!retryAfter) {
		return undefined;
	}

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}

	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}

	return undefined;
}

class RetryDelayExceededError extends Error {}

function validateRetryDelayMs(delayMs: number, options?: StreamOptions): number {
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
		throw new RetryDelayExceededError(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
		);
	}
	return delayMs;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}

// ============================================================================
// Request Compression
// ============================================================================

type ProcessWithBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

function loadNodeZlib(): typeof NodeZlib | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithBuiltinModule).getBuiltinModule?.("node:zlib") ?? null;
}

// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
function compressRequestBodyZstd(bodyJson: string): Uint8Array<ArrayBuffer> | null {
	const zlib = loadNodeZlib();
	if (!zlib || typeof zlib.zstdCompressSync !== "function") {
		return null;
	}
	try {
		const compressed = zlib.zstdCompressSync(bodyJson, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
		});
		// A copy owns a plain ArrayBuffer, which fetch accepts as a body under every lib.
		return new Uint8Array(compressed);
	} catch {
		return null;
	}
}

function encodeSSERequest(url: string, headers: Headers, bodyJson: string): Pick<RequestInit, "headers" | "body"> {
	// Only the canonical Codex endpoint is known to accept compressed requests.
	const compressed = url === `${DEFAULT_CODEX_BASE_URL}/codex/responses` ? compressRequestBodyZstd(bodyJson) : null;
	if (!compressed) return { headers, body: bodyJson };

	const compressedHeaders = new Headers(headers);
	compressedHeaders.set("content-encoding", "zstd");
	return { headers: compressedHeaders, body: compressed };
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveOpenAIResponsesContext(
		model,
		context,
		model.compat?.supportsMidConvoSystemMessages,
	);

	(async () => {
		const configurationUpdateEffort = getConfigurationUpdateEffort(model, options);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			...(configurationUpdateEffort === undefined ? {} : { providerThinkingLevel: configurationUpdateEffort }),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
			const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
			let body = buildRequestBody(
				model,
				normalizedContext,
				options,
				codexSessionId,
				grammarToolInputProperties,
				configurationUpdateEffort,
			);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as RequestBody;
			}
			const websocketRequestId = codexSessionId || uuidv7();
			// Codex expects an originator on every request; it is not attribution.
			const identityHeaders = { originator: "pi", ...getIdentityHeaders(model, options?.identity) };
			const sseHeaders = buildSSEHeaders(
				identityHeaders,
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				codexSessionId,
			);
			const websocketHeaders = buildWebSocketHeaders(
				identityHeaders,
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			let bodyJson = JSON.stringify(body);
			const fallBackToStandardTier = (error: CodexApiError): boolean => {
				if (
					error.code !== SERVICE_TIER_NOT_ALLOWED_CODE ||
					!isNonStandardServiceTier(body.service_tier) ||
					options?.signal?.aborted ||
					output.content.length > 0
				) {
					return false;
				}
				appendAssistantMessageDiagnostic(
					output,
					createAssistantMessageDiagnostic("service_tier_fallback", error, { rejectedTier: body.service_tier }),
				);
				// Keep the hook's payload intact. The omitted tier also prevents a second fallback.
				const { service_tier: _rejectedTier, ...standardBody } = body;
				body = standardBody;
				bodyJson = JSON.stringify(body);
				delete output.responseId;
				return true;
			};
			const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			const transport = options?.transport || "auto";
			let startEmitted = false;
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(cacheSessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession && options?.providerSummary === undefined) {
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				let retriedMissingWebSocketContinuation = false;
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							resolveCodexWebSocketUrl(model.baseUrl),
							body,
							websocketHeaders,
							output,
							stream,
							model,
							() => {
								websocketStarted = true;
								if (!startEmitted) {
									startEmitted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							httpTimeoutMs,
							websocketConnectTimeoutMs,
							cacheSessionId,
							accountId,
							grammarToolInputProperties,
							options,
						);

						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						assertSuccessfulOutput(output);
						stream.push({
							type: "done",
							reason: output.stopReason,
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						if (error instanceof CodexApiError && fallBackToStandardTier(error)) {
							continue;
						}
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						const previousResponseNotFound = isPreviousResponseNotFoundError(error);
						if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
							retriedMissingWebSocketContinuation = true;
							continue;
						}
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								...(websocketStarted ? {} : { fallbackTransport: "sse" }),
								eventsEmitted: websocketStarted,
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						recordWebSocketFailure(cacheSessionId, error);
						if (websocketStarted) {
							throw error;
						}
						recordWebSocketSseFallback(cacheSessionId);
						break;
					}
				}
			}

			const sseUrl = resolveCodexUrl(model.baseUrl);
			let sseRequest = encodeSSERequest(sseUrl, sseHeaders, bodyJson);

			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
			// A tier rejection does not consume the retry budget for transient errors.
			for (let attempt = 0; attempt <= maxRetries; ) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				let response: Response;
				try {
					const headerTimeoutSignal =
						httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
					const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
					try {
						response = await (options?.fetch ?? globalThis.fetch)(sseUrl, {
							method: "POST",
							...sseRequest,
							signal: combinedSignal.signal,
						});
					} catch (error) {
						if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
							throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
						}
						throw error;
					} finally {
						combinedSignal.cleanup();
					}
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (!response.ok) {
						const errorText = await response.text();
						if (response.status !== 400 && attempt < maxRetries && isRetryableError(response.status, errorText)) {
							const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
							const delayMs =
								retryAfterDelayMs === undefined
									? BASE_DELAY_MS * 2 ** attempt
									: validateRetryDelayMs(retryAfterDelayMs, options);

							await sleep(delayMs, options?.signal);
							attempt++;
							continue;
						}

						const info = parseErrorResponse(response, errorText);
						const message = info.friendlyMessage || info.message;
						if (response.status === 400) {
							throw new CodexApiError(message, { code: info.code });
						}
						throw new Error(message);
					}
				} catch (error) {
					if (error instanceof CodexApiError) {
						if (!fallBackToStandardTier(error)) throw error;
						sseRequest = encodeSSERequest(sseUrl, sseHeaders, bodyJson);
						continue;
					}
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					const lastError = error instanceof Error ? error : new Error(String(error));
					// Network errors are retryable
					if (
						attempt < maxRetries &&
						!(lastError instanceof RetryDelayExceededError) &&
						!lastError.message.includes("usage limit")
					) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						attempt++;
						continue;
					}
					throw lastError;
				}
				if (!response.body) {
					throw new Error("No response body");
				}
				if (!startEmitted) {
					startEmitted = true;
					stream.push({ type: "start", partial: output });
				}
				try {
					await processStream(
						response,
						output,
						stream,
						model,
						body.service_tier,
						grammarToolInputProperties,
						options,
					);
				} catch (error) {
					if (!(error instanceof CodexApiError) || !fallBackToStandardTier(error)) throw error;
					sseRequest = encodeSSERequest(sseUrl, sseHeaders, bodyJson);
					continue;
				}

				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				assertSuccessfulOutput(output);
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
				return;
			}
			throw new Error("Failed after retries");
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICodexResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
	// Off is sent as effort none, so with configuration_update items switching to it keeps the cache.
	const reasoningEffort = clampedReasoning !== "off" ? clampedReasoning : model.reasoning ? "none" : undefined;

	return stream(model, context, {
		...base,
		reasoningEffort,
		...(options?.reasoningSummary !== undefined ? { reasoningSummary: options.reasoningSummary } : {}),
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Request Building
// ============================================================================

/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
function getConfigurationUpdateEffort(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
): string | undefined {
	if (!model.compat?.supportsMidConvoEffort || options?.reasoningEffort === undefined) return undefined;
	return resolveReasoningEffort(model, options.reasoningEffort) ?? undefined;
}

/** Provider-native effort for a requested level; null when the model takes no reasoning field for it. */
function resolveReasoningEffort(
	model: Model<"openai-codex-responses">,
	reasoningEffort: NonNullable<OpenAICodexResponsesOptions["reasoningEffort"]>,
): string | null {
	if (reasoningEffort === "none") {
		return model.thinkingLevelMap?.off === undefined ? "none" : model.thinkingLevelMap.off;
	}
	return model.thinkingLevelMap?.[reasoningEffort] ?? reasoningEffort;
}

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options: OpenAICodexResponsesOptions | undefined,
	cacheSessionId: string | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	configurationUpdateEffort: string | undefined,
): RequestBody {
	const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	const toolSupport = getMidConvoToolSupport(model);
	const transcriptTools = resolveTranscriptTools(context.messages, toolSupport);
	// The system prompt goes into a leading developer item, not top-level `instructions`, as in Codex.
	// From GPT-6.2 on, the backend appends `instructions` after `input`, so every new turn changed the
	// prompt before the system prompt and it was never served from the prompt cache (#12273).
	const messages = convertResponsesMessages(model, context, OPENAI_RESPONSES_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		toolSupport,
		toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
		configurationUpdateEffort,
		summaryBlock: getOpenAIProviderSummaryBlock(model, context.messages),
		compactionTrigger: options?.providerSummary !== undefined,
	});

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: cacheSessionId,
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};

	// OpenAI rejects `compaction_trigger` when `max_output_tokens` is specified below 20,000.
	if (
		options?.maxTokens &&
		(model.compat?.supportsMaxOutputTokens ?? true) &&
		options?.providerSummary === undefined
	) {
		body.max_output_tokens = Math.max(options.maxTokens, MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && (model.compat?.supportsTemperature ?? true)) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		body.tools = convertResponsesTools(transcriptTools.requestTools, {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		});
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			configurationUpdateEffort === undefined
				? resolveReasoningEffort(model, options.reasoningEffort)
				: CONFIGURATION_UPDATE_REQUEST_EFFORT;
		if (effort !== null) {
			const summary = options.reasoningSummary === undefined ? "auto" : options.reasoningSummary;
			body.reasoning = {
				effort: configurationUpdateEffort === undefined ? effort : CONFIGURATION_UPDATE_REQUEST_EFFORT,
				...(summary !== null ? { summary } : {}),
			};
		}
	} else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
		body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingThinkingLevel =
		options?.reasoningEffort === undefined || options.reasoningEffort === "none" ? "off" : options.reasoningEffort;
	const samplingParams = resolveSamplingParams(model, samplingThinkingLevel, options?.samplingParams);
	if (samplingParams) {
		Object.assign(body, samplingParams);
	}

	return body;
}

function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (
		responseServiceTier === "default" &&
		(requestServiceTier === "flex" || requestServiceTier === "priority" || requestServiceTier === "fast")
	) {
		return requestServiceTier;
	}
	// Ultrafast must be confirmed by the terminal response.
	return responseServiceTier ?? (requestServiceTier === "ultrafast" ? undefined : requestServiceTier);
}

function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	requestServiceTier: RequestBody["service_tier"],
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	await processResponsesStream(
		mapCodexEvents(
			parseSSE(response, options?.signal),
			output,
			model,
			requestServiceTier,
			options?.onProviderStreamEvent,
		),
		output,
		stream,
		model,
		{
			serviceTier: requestServiceTier,
			grammarToolInputProperties,
			resolveServiceTier: resolveCodexServiceTier,
			applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			failedResponseError: codexFailedResponseError,
		},
	);
}

class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: unknown;

	constructor(message: string, options?: { code?: string; payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

class ProviderStreamEventCallbackError extends Error {
	constructor(cause: unknown) {
		super(formatThrownValue(cause));
		this.name = "ProviderStreamEventCallbackError";
		this.cause = cause;
	}
}

function isCodexNonTransportError(error: unknown): boolean {
	return (
		error instanceof CodexApiError ||
		error instanceof CodexProtocolError ||
		error instanceof ProviderStreamEventCallbackError
	);
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

/** The typed error for a failed response; transport recovery reads its code. */
function codexFailedResponseError(event: ResponseFailedEvent): CodexApiError {
	const error = event.response?.error;
	const message = error?.message || "Codex response failed";
	return new CodexApiError(error?.code ? `${error.code}: ${message}` : message, {
		code: error?.code,
		payload: event,
	});
}

function extractCodexEventError(event: Record<string, unknown>): { code?: string; message?: string } {
	const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
	return {
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
		message:
			typeof event.message === "string"
				? event.message
				: typeof nested?.message === "string"
					? nested.message
					: undefined,
	};
}

async function* mapCodexEvents(
	events: AsyncIterable<Record<string, unknown>>,
	output: AssistantMessage,
	model: Model<"openai-codex-responses">,
	requestServiceTier: RequestBody["service_tier"],
	onProviderStreamEvent: StreamOptions["onProviderStreamEvent"] | undefined,
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		try {
			await onProviderStreamEvent?.(event, model);
		} catch (error) {
			// Keep callback failures out of Codex's WebSocket retry and SSE fallback path.
			throw new ProviderStreamEventCallbackError(error);
		}
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const { code, message } = extractCodexEventError(event);
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event,
			});
		}

		if (type === "response.failed" && isNonStandardServiceTier(requestServiceTier) && output.content.length === 0) {
			const error = codexFailedResponseError(event as unknown as ResponseFailedEvent);
			if (error.code === SERVICE_TIER_NOT_ALLOWED_CODE) {
				// Do not record rejected-attempt metadata before a Standard retry.
				throw error;
			}
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as { response?: { status?: unknown; end_turn?: unknown } }).response;
			if (typeof response?.end_turn === "boolean") {
				output.endTurn = response.end_turn;
			}
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}

// ============================================================================
// SSE Parsing
// ============================================================================

async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { done, value } = await reader.read();
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// Treat EOF as terminating the residual SSE frame.
			if (done && buffer.trim()) buffer += "\n\n";

			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				const dataLines = chunk
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as Record<string, unknown>;
						} catch (cause) {
							throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
								cause,
								payload: data,
							});
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}

			if (done) break;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

const codexWebSocketPool = new ResponsesWebSocketPool({ cleanupCloseReason: "debug_close" });
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		codexWebSocketPool.clearSseFallback(sessionId);
		return;
	}
	websocketDebugStats.clear();
	codexWebSocketPool.clearSseFallback();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	codexWebSocketPool.closeConnections(sessionId, "debug_close");
}

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return codexWebSocketPool.isSseFallbackActive(sessionId);
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	codexWebSocketPool.recordSseFallback(sessionId);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<ResponseStreamEvent>,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
		}
		yield event;
	}
}

async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	idleTimeoutMs: number | undefined,
	websocketConnectTimeoutMs: number | undefined,
	cacheSessionId: string | undefined,
	accountId: string,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	const fullBody = structuredClone(body);
	const wsHeaders = headersToRecord(headers);
	const { ws, entry, reused, release } = await codexWebSocketPool.acquire({
		url,
		headers: wsHeaders,
		sessionId: cacheSessionId,
		identity: accountId,
		signal: options?.signal,
		connectTimeoutMs: websocketConnectTimeoutMs,
		env: options?.env,
	});
	let keepConnection = true;
	const useCachedContext =
		options?.disableContinuation !== true &&
		options?.providerSummary === undefined &&
		(options?.transport === "websocket-cached" || options?.transport === "auto");
	// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
	// WebSocket continuation still works via connection-scoped previous_response_id state.
	const { body: requestBody } = buildWebSocketContinuationBody(entry, fullBody, useCachedContext);
	const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}
	try {
		if (options?.signal?.aborted) {
			throw new Error("Request was aborted");
		}
		const codexTurnEvents = async function* (): AsyncGenerator<Record<string, unknown>> {
			try {
				yield* streamResponsesWebSocketTurn(ws, requestBody as unknown as Record<string, unknown>, {
					signal: options?.signal,
					idleTimeoutMs,
				});
			} catch (error) {
				if (error instanceof ResponsesWebSocketProtocolError) {
					throw new CodexProtocolError(
						`Invalid Codex WebSocket JSON: ${formatThrownValue(error.cause ?? error)}`,
						{ cause: error.cause, payload: error.payload },
					);
				}
				throw error;
			}
		};
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapCodexEvents(codexTurnEvents(), output, model, requestBody.service_tier, options?.onProviderStreamEvent),
				onStart,
			),
			output,
			stream,
			model,
			{
				serviceTier: requestBody.service_tier,
				grammarToolInputProperties,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
				failedResponseError: codexFailedResponseError,
			},
		);
		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertResponsesMessages(
				model,
				normalizeContext({ messages: [output] }),
				OPENAI_RESPONSES_TOOL_CALL_PROVIDERS,
				{ grammarToolInputProperties, toolSupport: "none" },
			).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
			recordWebSocketContinuationState(
				entry,
				fullBody as unknown as Record<string, unknown>,
				output.responseId,
				structuredClone(responseItems),
			);
		}
	} catch (error) {
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

// ============================================================================
// Error Handling
// ============================================================================

function parseErrorResponse(
	response: Response,
	raw: string,
): { message: string; code?: string; friendlyMessage?: string } {
	let message = raw || response.statusText || "Request failed";
	let code: string | undefined;
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		const err = parsed?.error;
		if (err) {
			code = err.code || err.type;
			if (
				/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code ?? "") ||
				response.status === 429
			) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {}

	return { message, code, friendlyMessage };
}

// ============================================================================
// Auth & Headers
// ============================================================================

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function buildBaseCodexHeaders(
	defaultHeaders: Record<string, string>,
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	// Defaults first so model and caller headers can override them, matching the other providers.
	const headers = new Headers(defaultHeaders);
	for (const [key, value] of Object.entries(initHeaders || {})) {
		headers.set(key, value);
	}
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) {
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	return headers;
}

function buildSSEHeaders(
	defaultHeaders: Record<string, string>,
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function buildWebSocketHeaders(
	defaultHeaders: Record<string, string>,
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}
