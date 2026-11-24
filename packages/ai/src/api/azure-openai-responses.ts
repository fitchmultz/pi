import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel, getMidConvoToolSupport } from "../models.ts";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools } from "../utils/transcript.ts";
import { type AzureEndpointOptions, resolveAzureConfig, resolveDeploymentName } from "./azure-openai-config.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import {
	applyOpenAISessionAffinityHeaders,
	clampOpenAIPromptCacheKey,
	getOpenAIPromptCacheOptions,
	getOpenAIPromptCacheRetention,
	resolveOpenAICacheRetention,
} from "./openai-prompt-cache.ts";
import {
	getOpenAIProviderSummaryBlock,
	OPENAI_CONFIGURATION_UPDATE_REQUEST_EFFORT,
	OPENAI_RESPONSES_TOOL_CALL_PROVIDERS,
	prepareResponsesPrompt,
	processResponsesStream,
	resolveOpenAIConfigurationUpdateEffort,
	resolveOpenAIResponsesContext,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function formatAzureOpenAIError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "Azure OpenAI API error");
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends AzureEndpointOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

/**
 * Generate function for Azure OpenAI Responses API
 */
export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveOpenAIResponsesContext(
		model,
		context,
		model.compat?.supportsMidConvoSystemMessages,
	);

	// Start async processing
	(async () => {
		const deploymentName = resolveDeploymentName(model, options);
		const configurationUpdateEffort = resolveOpenAIConfigurationUpdateEffort(
			model,
			options?.reasoningEffort,
			model.compat?.supportsMidConvoEffort === true,
		);

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "azure-openai-responses" as Api,
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
			// Create Azure OpenAI client
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const cacheRetention = resolveOpenAICacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(model, apiKey, options, cacheSessionId);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				deploymentName,
				grammarToolInputProperties,
				configurationUpdateEffort,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				grammarToolInputProperties,
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Azure OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatAzureOpenAIError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
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
	} satisfies AzureOpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
		...(options?.reasoningSummary !== undefined ? { reasoningSummary: options.reasoningSummary } : {}),
	} satisfies AzureOpenAIResponsesOptions);
};

function createClient(
	model: Model<"azure-openai-responses">,
	apiKey: string,
	options?: AzureOpenAIResponsesOptions,
	sessionId?: string,
) {
	const headers = { ...getIdentityHeaders(model, options?.identity), ...model.headers };
	applyOpenAISessionAffinityHeaders(headers, sessionId, model.compat?.sessionAffinityFormat ?? "openai");

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		fetch: options?.fetch,
		defaultHeaders: headers,
		baseURL: baseUrl,
	});
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
	configurationUpdateEffort?: string,
) {
	const toolSupport = getMidConvoToolSupport(model);
	const { input, requestTools } = prepareResponsesPrompt(model, context, OPENAI_RESPONSES_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		toolSupport,
		toolOptions: {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		},
		configurationUpdateEffort,
		summaryBlock: getOpenAIProviderSummaryBlock(model, context.messages),
		compactionTrigger: options?.providerSummary !== undefined,
	});

	const cacheRetention = resolveOpenAICacheRetention(options?.cacheRetention, options?.env);
	const sendPromptCacheKey = cacheRetention !== "none" && model.compat?.promptCacheKeyMode !== "disabled";
	const cacheCompat = {
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
	};
	const params: ResponseCreateParamsStreaming = {
		model: deploymentName,
		input,
		stream: true,
		prompt_cache_key: sendPromptCacheKey ? clampOpenAIPromptCacheKey(options?.sessionId) : undefined,
		prompt_cache_retention: getOpenAIPromptCacheRetention(cacheCompat, cacheRetention),
		prompt_cache_options: getOpenAIPromptCacheOptions(cacheCompat, cacheRetention),
		store: false,
	};

	// OpenAI rejects `compaction_trigger` when `max_output_tokens` is specified below 20,000.
	if (options?.maxTokens && options?.providerSummary === undefined) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && (model.compat?.supportsTemperature ?? true)) {
		params.temperature = options?.temperature;
	}

	if (requestTools.length > 0) params.tools = requestTools;
	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (reasoningEffort) {
			const requestedEffort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			const effort =
				configurationUpdateEffort === undefined ? requestedEffort : OPENAI_CONFIGURATION_UPDATE_REQUEST_EFFORT;
			const summary = options?.reasoningSummary === undefined ? "auto" : options.reasoningSummary;
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				...(summary !== null ? { summary } : {}),
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}
