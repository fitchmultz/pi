import OpenAI from "openai";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai/error";
import type { ResponseCreateParamsStreaming as BetaResponseCreateParamsStreaming } from "openai/resources/beta/responses/responses.js";
import { WebSocketError } from "openai/resources/responses/internal-base";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	ResponseControl,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { captureProviderError, getProviderError } from "../utils/provider-error.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getCurrentTools, getDeclaredTools, resolveTranscriptTools } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	createResponsesDiagnostics,
	diagnosticServiceTier,
	finishResponsesDiagnostics,
} from "./openai-responses-diagnostics.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	createResponsesSuccessor,
	getInitialResponsesEffort,
	getNativeToolSearch,
	processResponsesStream,
	resolveResponsesEffort,
	resolveResponsesTranscript,
	supportsPositionalResponsesEffort,
} from "./openai-responses-shared.ts";
import { streamResponsesWebSocket } from "./openai-responses-websocket.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { withToolNamespaces } from "./tool-namespaces.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsAsyncTools: model.compat?.supportsAsyncTools ?? false,
		supportsSteering: model.compat?.supportsSteering ?? false,
		supportsReasoningEffortUpdates: model.compat?.supportsReasoningEffortUpdates ?? false,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): { mode?: "explicit"; ttl?: "30m" } | undefined {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
const streamRaw: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveResponsesTranscript(
		context,
		getCompat(model).supportsMidConvoSystemMessages,
		getCompat(model).supportsToolSearch,
	);

	// Start async processing
	(async () => {
		let output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
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

		const diagnostics = createResponsesDiagnostics(output);
		const details = diagnostics.details;
		let requestId: string | undefined;

		try {
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.fetch,
				cacheSessionId,
			);
			const request = buildParams(model, normalizedContext, options, compat, grammarToolInputProperties);
			let params = request.params as BetaResponseCreateParamsStreaming;
			if (compat.supportsReasoningEffortUpdates) output.providerThinkingLevel = request.effort;
			const initialRequestEffort = params.reasoning?.effort;
			details.prepareMs = performance.now() - diagnostics.startedAt;
			const hookStartedAt = performance.now();
			try {
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== undefined) {
					params = nextParams as BetaResponseCreateParamsStreaming;
				}
			} finally {
				details.onPayloadMs = performance.now() - hookStartedAt;
			}
			const multiAgent = params.multi_agent?.enabled === true;
			if (
				!supportsPositionalResponsesEffort(model, params as unknown as Record<string, unknown>) &&
				Array.isArray(params.input)
			) {
				params.input = params.input.filter((item) => item.type !== "configuration_update");
				if (
					output.providerThinkingLevel !== undefined &&
					supportsPositionalResponsesEffort(model, options?.samplingParams) &&
					params.reasoning?.effort === initialRequestEffort
				) {
					params.reasoning = {
						...params.reasoning,
						effort: output.providerThinkingLevel as NonNullable<typeof params.reasoning>["effort"],
					};
				}
			}
			if (multiAgent) {
				if (params.reasoning) delete params.reasoning.summary;
				delete params.max_tool_calls;
				if (
					params.tools?.some(
						(tool) =>
							("async" in tool && tool.async) ||
							(tool.type === "namespace" && tool.tools.some((nested) => "async" in nested && nested.async)),
					)
				)
					params.parallel_tool_calls = false;
			}
			details.requestedServiceTier = diagnosticServiceTier(params.service_tier);
			details.requestReadyMs = performance.now() - diagnostics.startedAt;
			let liveControl: ResponseControl | undefined;
			let retired = false;
			const streamOptions = {
				hosted: multiAgent || params.tools?.some((tool) => tool.type === "programmatic_tool_calling"),
				streamingTools: false,
				continuesResponse: () => liveControl?.waitingForSuccessor ?? false,
				wasRetired: () => retired || liveControl?.retired === true,
				onResponseStart: (message: AssistantMessage) => {
					output = message;
				},
				onResponseEnd: (message: AssistantMessage) => {
					output = createResponsesSuccessor(message);
				},
				toolSearchTool: getNativeToolSearch(getCurrentTools(normalizedContext.messages), compat.supportsToolSearch),
				diagnostics,
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage: Usage, serviceTier: OpenAIResponsesOptions["serviceTier"]) =>
					applyServiceTierPricing(usage, serviceTier, model),
			};
			let websocketCompleted = false;
			let started = false;
			if (
				(model.provider === "openai" || compat.supportsSteering) &&
				(!multiAgent || options?.onResponseControl !== undefined) &&
				options?.transport !== "sse" &&
				!params.background
			) {
				let recovered = false;
				let callbackFailed = false;
				const websocketOptions: OpenAIResponsesOptions = {
					...options,
					cacheRetention,
					onResponseControl: (control) => {
						retired ||= liveControl?.retired === true;
						liveControl = control;
						options?.onResponseControl?.(control);
					},
					onResponse: async (response, responseModel) => {
						requestId = response.headers["x-request-id"];
						details.headersMs = performance.now() - diagnostics.startedAt;
						try {
							await options?.onResponse?.(response, responseModel);
						} catch (error) {
							callbackFailed = true;
							throw error;
						}
					},
				};
				try {
					websocketCompleted = await retryProviderRequest(
						async () => {
							while (true) {
								const websocketStream = streamResponsesWebSocket(
									client,
									params,
									model,
									output,
									websocketOptions,
									grammarToolInputProperties,
									() => {
										started = true;
										stream.push({ type: "start", partial: output });
									},
									diagnostics,
									stream,
								);
								if (!websocketStream) return false;
								try {
									streamOptions.streamingTools = multiAgent;
									await processResponsesStream(websocketStream, output, stream, model, streamOptions);
									return true;
								} catch (error) {
									if (started || options?.signal?.aborted || callbackFailed) throw error;
									const event = error instanceof WebSocketError ? error.error : undefined;
									const details = event && ("error" in event ? event.error : event);
									if (
										!recovered &&
										(details?.code === "websocket_connection_limit_reached" ||
											(details?.code === "previous_response_not_found" && !params.previous_response_id))
									) {
										// A new native connection has no cached response IDs. Retry full current input once.
										recovered = true;
										continue;
									}
									if (event && details && "status" in event && typeof event.status === "number") {
										throw Object.assign(
											APIError.generate(
												event.status,
												{ error: details },
												details.message,
												new Headers("headers" in details ? details.headers : undefined),
											),
											getProviderError(error),
										);
									}
									throw error;
								}
							}
						},
						{
							maxRetries: options?.maxRetries,
							maxRetryDelayMs: options?.maxRetryDelayMs,
							signal: options?.signal,
							shouldRetry: (error) =>
								!started && !callbackFailed && error instanceof APIError && error.status !== undefined,
						},
					);
				} catch (error) {
					const transportError =
						error instanceof APIConnectionError || (error instanceof WebSocketError && !error.error);
					if (started || options?.signal?.aborted || callbackFailed || !transportError) throw error;
					details.fallbackReason = "before_stream_start";
					appendAssistantMessageDiagnostic(
						output,
						createAssistantMessageDiagnostic("provider_transport_failure", error, {
							configuredTransport: options?.transport ?? "auto",
							fallbackTransport: "sse",
							eventsEmitted: false,
						}),
					);
				}
			}
			if (!websocketCompleted) {
				streamOptions.streamingTools = false;
				const requestOptions = {
					...(options?.signal ? { signal: options.signal } : {}),
					...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
					maxRetries: 0,
				};
				const { data: openaiStream, response } = await retryProviderRequest(
					async () => {
						details.transport = "sse";
						details.sseAttempts++;
						details.lastAttemptStartMs = performance.now() - diagnostics.startedAt;
						try {
							return multiAgent
								? await client.beta.responses
										.create({ ...params, betas: ["responses_multi_agent=v1"] }, requestOptions)
										.withResponse()
								: await client.responses
										.create(params as ResponseCreateParamsStreaming, requestOptions)
										.withResponse();
						} catch (error) {
							if (error instanceof APIConnectionTimeoutError) {
								details.localTimeout = "sdk_request";
								if (options?.timeoutMs !== undefined) details.localTimeoutMs = options.timeoutMs;
							}
							throw error;
						}
					},
					{
						maxRetries: options?.maxRetries,
						maxRetryDelayMs: options?.maxRetryDelayMs,
						signal: options?.signal,
					},
				);
				details.headersMs = performance.now() - diagnostics.startedAt;
				requestId = response.headers.get("x-request-id") ?? undefined;
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				stream.push({ type: "start", partial: output });
				await processResponsesStream(openaiStream, output, stream, model, streamOptions);
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			finishResponsesDiagnostics(diagnostics);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted || error instanceof APIUserAbortError ? "aborted" : "error";
			output.errorMessage = formatProviderError(
				normalizeProviderError(error),
				`${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
			);
			captureProviderError(output, error, requestId);
			finishResponsesDiagnostics(diagnostics);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (model, context, options) =>
	withToolNamespaces(
		model,
		context,
		(mapped, mapControl) =>
			streamRaw(model, mapped, {
				...options,
				onResponseControl: options?.onResponseControl
					? (control) => options.onResponseControl?.(control ? mapControl(control) : undefined)
					: undefined,
			}),
		options?.signal,
	);

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	);
	const reasoningOverride = options?.samplingParams?.reasoning as ResponseCreateParamsStreaming["reasoning"];
	const isGpt6 = model.id.startsWith("gpt-6-");
	const managesEffort = compat.supportsReasoningEffortUpdates || isGpt6;
	const effort = resolveResponsesEffort(
		model,
		(managesEffort ? reasoningOverride?.effort : undefined) ?? options?.reasoningEffort,
	);
	const positional = supportsPositionalResponsesEffort(model, options?.samplingParams);
	const toolSearchTool = getNativeToolSearch(getCurrentTools(context.messages), compat.supportsToolSearch);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		reasoningEffort: positional ? effort : undefined,
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			toolSearchTool,
			supportsAsyncTools: compat.supportsAsyncTools,
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			toolSearchTool,
			supportsAsyncTools: compat.supportsAsyncTools,
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary || compat.supportsReasoningEffortUpdates) {
			params.reasoning = {
				effort: (positional && effort ? getInitialResponsesEffort(model, context, effort) : effort) as NonNullable<
					typeof params.reasoning
				>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = { effort: effort as NonNullable<typeof params.reasoning>["effort"] };
		}
		// store:false has no server-side history: retain opaque reasoning even when effort was omitted.
		params.include = ["reasoning.encrypted_content"];
	}

	// Last so custom keys override the named request fields.
	if (options?.samplingParams) {
		Object.assign(params, options.samplingParams);
	}

	if (managesEffort && params.reasoning && effort) {
		params.reasoning = {
			...params.reasoning,
			effort: (positional ? getInitialResponsesEffort(model, context, effort) : effort) as NonNullable<
				typeof params.reasoning
			>["effort"],
		};
	}

	if (isGpt6 && effort !== "none") {
		delete params.temperature;
		delete params.top_p;
		delete params.top_logprobs;
		if (params.include) params.include = params.include.filter((item) => item !== "message.output_text.logprobs");
	}
	return { params, effort };
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "fast":
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
