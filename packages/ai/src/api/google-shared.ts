/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import {
	BlockedReason,
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type GenerateContentConfig,
	type GenerateContentParameters,
	type GenerateContentResponse,
	type GoogleGenAI,
	ThinkingLevel as GoogleSdkThinkingLevel,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	AssistantMessage,
	FetchFunction,
	ImageContent,
	Model,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	collapseSystemMessages,
	getCurrentTools,
	getInitialSystemMessage,
	withoutInitialSystemMessage,
} from "../utils/transcript.ts";
import { prefersJsonSchemaStrictSampling, resolveStrictJsonSchema } from "./constrained-sampling.ts";
import { canReplayGoogleThoughtSignature, transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/** Request options both Google adapters accept. */
export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleApiThinkingLevel;
	};
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

const MAX_HEADER_TIMEOUT_MS = 0x7fffffff;
// 16 x 64K tokens spans Gemini 4's full 1M unified context window while bounding malformed loops.
const MAX_CONTINUATION_HOPS = 16;

const GOOGLE_STRICT_TOOL_ERROR_PATTERNS = [
	/too many states/i,
	/nesting depth/i,
	/constraint (?:is |has )?too (?:large|complex|many)/i,
	/grammar is too large/i,
	/(?:parameters_json_schema|parametersJsonSchema|function_declarations|functionDeclarations|VALIDATED)/i,
];

const GOOGLE_STRICT_TOOL_NON_SCHEMA_EXCLUSIONS = [
	/thought_signature/i,
	/input token count/i,
	/continuation token/i,
	/api key/i,
];

const sessionsOverGoogleStrictToolLimits = new Set<string>();
const MAX_SESSIONS_OVER_GOOGLE_STRICT_TOOL_LIMITS = 10_000;

function markGoogleStrictToolLimitsExceeded(sessionId: string | undefined): void {
	if (sessionId === undefined) return;
	sessionsOverGoogleStrictToolLimits.add(sessionId);
	if (sessionsOverGoogleStrictToolLimits.size > MAX_SESSIONS_OVER_GOOGLE_STRICT_TOOL_LIMITS) {
		const oldest = sessionsOverGoogleStrictToolLimits.values().next().value;
		if (oldest !== undefined) sessionsOverGoogleStrictToolLimits.delete(oldest);
	}
}

function hasExceededGoogleStrictToolLimits(sessionId: string | undefined): boolean {
	return sessionId !== undefined && sessionsOverGoogleStrictToolLimits.has(sessionId);
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId) sessionsOverGoogleStrictToolLimits.delete(sessionId);
	else sessionsOverGoogleStrictToolLimits.clear();
});

function isGoogleStrictToolRejectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const status = "status" in error ? (error as { status?: unknown }).status : undefined;
	if (status !== 400) return false;
	const message = error.message;
	if (GOOGLE_STRICT_TOOL_NON_SCHEMA_EXCLUSIONS.some((pattern) => pattern.test(message))) {
		return false;
	}
	return GOOGLE_STRICT_TOOL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function createGoogleFetch(
	api: GoogleApiType,
	model: Model<GoogleApiType>,
	options: GoogleOptions | undefined,
	onFailedHeaders: (headers: Headers | undefined) => void,
): FetchFunction {
	const baseFetch = options?.fetch ?? globalThis.fetch;
	const timeoutMs = options?.timeoutMs;
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
		throw new RangeError(`Invalid timeoutMs: ${String(timeoutMs)}`);
	}
	const providerLabel = api === "google-vertex" ? "Google Vertex" : "Google";
	// The header timeout bounds only the wait for response headers; active streams stay governed
	// by the HTTP client's idle bodyTimeout so long reasoning responses are never cut off mid-stream.
	const effectiveHeaderTimeoutMs =
		timeoutMs !== undefined && timeoutMs < MAX_HEADER_TIMEOUT_MS ? Math.floor(timeoutMs) : undefined;

	return async (input, init) => {
		onFailedHeaders(undefined);
		let response: Response;
		if (effectiveHeaderTimeoutMs !== undefined) {
			const headerTimeoutController = new AbortController();
			const existingSignal = init?.signal ?? undefined;
			const signal = existingSignal
				? AbortSignal.any([existingSignal, headerTimeoutController.signal])
				: headerTimeoutController.signal;
			const timer = setTimeout(() => headerTimeoutController.abort(), effectiveHeaderTimeoutMs);
			timer.unref?.();
			try {
				response = await baseFetch(input, { ...init, signal });
			} catch (error) {
				if (headerTimeoutController.signal.aborted && !existingSignal?.aborted) {
					throw new Error(`${providerLabel} response headers timed out after ${effectiveHeaderTimeoutMs}ms`);
				}
				throw error;
			} finally {
				clearTimeout(timer);
			}
		} else {
			response = await baseFetch(input, init);
		}

		if (!response.ok) {
			onFailedHeaders(new Headers(response.headers));
		}
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		return response;
	};
}

export function streamGoogle(
	api: GoogleApiType,
	model: Model<GoogleApiType>,
	context: TranscriptContext,
	options: GoogleOptions | undefined,
	createClient: (fetch: FetchFunction) => GoogleGenAI,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api,
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

		try {
			let lastFailedHeaders: Headers | undefined;
			const googleFetch = createGoogleFetch(api, model, options, (headers) => {
				lastFailedHeaders = headers;
			});
			const client = createClient(googleFetch);
			let disablePreferredStrictTools = hasExceededGoogleStrictToolLimits(options?.sessionId);
			let baseParams: GenerateContentParameters;
			let googleStream: AsyncGenerator<GenerateContentResponse>;
			for (;;) {
				const built = buildParams(model, normalizedContext, options, { disablePreferredStrictTools });
				baseParams = built.params;
				const nextParams = await options?.onPayload?.(baseParams, model);
				if (nextParams !== undefined) {
					baseParams = nextParams as GenerateContentParameters;
				}
				try {
					googleStream = await retryGoogleRequest(
						() => {
							lastFailedHeaders = undefined;
							return client.models.generateContentStream(baseParams);
						},
						options,
						() => lastFailedHeaders,
					);
					break;
				} catch (error) {
					// Only downgrade a rejected request before the stream starts.
					if (
						options?.signal?.aborted ||
						disablePreferredStrictTools ||
						!built.hasPreferredStrictTools ||
						!isGoogleStrictToolRejectionError(error)
					) {
						throw error;
					}
					disablePreferredStrictTools = true;
					markGoogleStrictToolLimitsExceeded(options?.sessionId);
					appendAssistantMessageDiagnostic(output, {
						type: "google_strict_tools_fallback",
						timestamp: Date.now(),
						error: { message: error instanceof Error ? error.message : String(error) },
						details: { reason: "strict_tool_schema_rejected" },
					});
				}
			}

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			let promptBlockReason: BlockedReason | undefined;
			let promptBlockMessage: string | undefined;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			const endCurrentBlock = () => {
				if (!currentBlock) return;
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
				currentBlock = null;
			};

			// Across continuation hops, prompt tokens stay anchored to Hop 1 so downstream context
			// sizing and overflow detection see the true context window, while output/reasoning
			// tokens and billed costs sum every hop.
			let initialPromptUsage: { input: number; cacheRead: number; promptTokens: number } | undefined;
			let priorOutputTokens = 0;
			let priorReasoningTokens = 0;
			const priorCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			let previousContinuationToken: string | undefined;

			for (let hopIndex = 0; hopIndex < MAX_CONTINUATION_HOPS; hopIndex++) {
				promptBlockReason = undefined;
				promptBlockMessage = undefined;
				let hopFinishReason: FinishReason | undefined;
				let hopContinuationToken: string | undefined;
				let hopUsage: Usage | undefined;

				for await (const chunk of googleStream) {
					await options?.onProviderStreamEvent?.(chunk, model);
					// @google/genai documents GenerateContentResponse.responseId as an output-only field
					// used to identify each response. Keep the first non-empty one from the stream.
					output.responseId ||= chunk.responseId;
					const blockReason = chunk.promptFeedback?.blockReason;
					if (blockReason && blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
						promptBlockReason = blockReason;
						promptBlockMessage = chunk.promptFeedback?.blockReasonMessage;
					}
					const candidate = chunk.candidates?.[0];
					if (candidate?.continuationToken) {
						hopContinuationToken = candidate.continuationToken;
					}
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							const currentSignature =
								currentBlock?.type === "thinking"
									? currentBlock.thinkingSignature
									: currentBlock?.type === "text"
										? currentBlock.textSignature
										: undefined;
							if (part.text !== undefined) {
								const isThinking = isThinkingPart(part);
								const hasDistinctSignature =
									Boolean(currentSignature) &&
									Boolean(part.thoughtSignature) &&
									part.thoughtSignature !== currentSignature;
								if (
									!currentBlock ||
									(isThinking && currentBlock.type !== "thinking") ||
									(!isThinking && currentBlock.type !== "text") ||
									hasDistinctSignature
								) {
									endCurrentBlock();
									if (isThinking) {
										currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
										output.content.push(currentBlock);
										stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
									} else {
										currentBlock = { type: "text", text: "" };
										output.content.push(currentBlock);
										stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
									}
								}
								if (currentBlock.type === "thinking") {
									currentBlock.thinking += part.text;
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else {
									currentBlock.text += part.text;
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "text_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								}
							} else if (!part.functionCall && part.thoughtSignature) {
								const isThinking = isThinkingPart(part);
								const hasDistinctSignature =
									Boolean(currentSignature) && part.thoughtSignature !== currentSignature;
								if (
									!currentBlock ||
									(isThinking && currentBlock.type !== "thinking") ||
									(!isThinking && currentBlock.type !== "text") ||
									hasDistinctSignature
								) {
									endCurrentBlock();
									if (isThinking) {
										currentBlock = {
											type: "thinking",
											thinking: "",
											thinkingSignature: part.thoughtSignature,
										};
										output.content.push(currentBlock);
										stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
									} else {
										currentBlock = { type: "text", text: "", textSignature: part.thoughtSignature };
										output.content.push(currentBlock);
										stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
									}
								} else if (currentBlock.type === "thinking") {
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
								} else {
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
								}
							}

							if (part.functionCall) {
								endCurrentBlock();

								// Generate unique ID if not provided or if it's a duplicate
								const providedId = part.functionCall.id;
								const needsNewId =
									!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
								const toolCallId = needsNewId
									? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
									: providedId;

								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: (part.functionCall.args as ToolCall["arguments"]) ?? {},
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};

								output.content.push(toolCall);
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
							}
						}
					}

					if (candidate?.finishReason) {
						hopFinishReason = candidate.finishReason;
						output.rawStopReason = candidate.finishReason;
						output.stopReason = mapStopReason(candidate.finishReason);
						if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
							output.stopReason = "toolUse";
						}
					}

					if (chunk.usageMetadata) {
						const builtUsage = buildHopUsage(api, model, chunk.usageMetadata);
						hopUsage = builtUsage.usage;
						if (hopIndex === 0 || !initialPromptUsage) {
							initialPromptUsage = {
								input: hopUsage.input,
								cacheRead: hopUsage.cacheRead,
								promptTokens: builtUsage.promptTokens,
							};
						}
						if (hopIndex === 0) {
							output.usage = hopUsage;
						} else {
							const totalOutput = priorOutputTokens + hopUsage.output;
							const totalReasoning = priorReasoningTokens + (hopUsage.reasoning ?? 0);
							output.usage = {
								input: initialPromptUsage.input,
								output: totalOutput,
								cacheRead: initialPromptUsage.cacheRead,
								cacheWrite: 0,
								reasoning: totalReasoning,
								totalTokens: initialPromptUsage.promptTokens + totalOutput,
								cost: {
									input: priorCost.input + hopUsage.cost.input,
									output: priorCost.output + hopUsage.cost.output,
									cacheRead: priorCost.cacheRead + hopUsage.cost.cacheRead,
									cacheWrite: priorCost.cacheWrite + hopUsage.cost.cacheWrite,
									total: priorCost.total + hopUsage.cost.total,
									totalFromProvider: false,
								},
							};
						}
					}
				}

				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				const shouldContinue =
					options?.disableContinuation !== true &&
					!promptBlockReason &&
					hopFinishReason !== undefined &&
					hopFinishReason === FinishReason.CONTINUATION &&
					Boolean(hopContinuationToken) &&
					hopContinuationToken !== previousContinuationToken &&
					hopIndex + 1 < MAX_CONTINUATION_HOPS;
				if (!shouldContinue) {
					break;
				}

				if (hopUsage) {
					priorOutputTokens += hopUsage.output;
					priorReasoningTokens += hopUsage.reasoning ?? 0;
					priorCost.input += hopUsage.cost.input;
					priorCost.output += hopUsage.cost.output;
					priorCost.cacheRead += hopUsage.cost.cacheRead;
					priorCost.cacheWrite += hopUsage.cost.cacheWrite;
					priorCost.total += hopUsage.cost.total;
				}
				output.stopReason = "pending";
				output.rawStopReason = undefined;
				previousContinuationToken = hopContinuationToken;
				const nextHopParams: GenerateContentParameters = {
					...baseParams,
					config: {
						...baseParams.config,
						automaticContinuation: false,
						continuationToken: hopContinuationToken,
					},
				};
				googleStream = await retryGoogleRequest(
					() => {
						lastFailedHeaders = undefined;
						return client.models.generateContentStream(nextHopParams);
					},
					options,
					() => lastFailedHeaders,
				);
			}

			endCurrentBlock();

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				if (promptBlockReason) {
					output.rawStopReason = promptBlockReason;
					output.stopReason = "error";
					throw new Error(
						promptBlockMessage
							? `Prompt blocked (${promptBlockReason}): ${promptBlockMessage}`
							: `Prompt blocked: ${promptBlockReason}`,
					);
				}
				throw new Error(
					`${api === "google-vertex" ? "Google Vertex" : "Google"} stream ended without a finish reason`,
				);
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// Published Flex/Priority cache-read multipliers, checked 2026-11-22:
// https://aistudio.google.com/docs/pricing
const GOOGLE_SERVICE_TIER_CACHE_MULTIPLIERS = new Map<string, { flex: number; priority: number }>([
	["gemini-4-neon", { flex: 0.5, priority: 1.8 }],
	["gemini-4-carbon", { flex: 0.5, priority: 1.8 }],
	["gemini-4-argon", { flex: 0.5, priority: 1.8 }],
	["gemini-4-hydrogen", { flex: 0.5, priority: 1.8 }],
	["gemini-3.8-flash", { flex: 0.5, priority: 1.8 }],
	["gemini-3.6-flash", { flex: 0.5, priority: 1.8 }],
	["gemini-3.5-flash-lite", { flex: 2 / 3, priority: 5 / 3 }],
	["gemini-3.1-flash-lite", { flex: 0.5, priority: 1.8 }],
	["gemini-3.1-pro-preview", { flex: 1, priority: 1.8 }],
	["gemini-3-flash-preview", { flex: 1, priority: 1.8 }],
	["gemini-2.5-pro", { flex: 1, priority: 1.8 }],
	["gemini-2.5-flash", { flex: 1, priority: 1.8 }],
	["gemini-2.5-flash-lite", { flex: 1, priority: 1.8 }],
]);

/**
 * Whether requests for `model` target the Gemini Developer API (rather than Vertex AI or an
 * unrelated third-party endpoint). Without a base URL the SDK sends to generativelanguage.googleapis.com.
 */
function sendsToGeminiApi(model: Model<GoogleApiType>): boolean {
	return (
		model.api === "google-generative-ai" &&
		(model.provider === "google" ||
			!model.baseUrl ||
			(URL.canParse(model.baseUrl) && new URL(model.baseUrl).hostname === "generativelanguage.googleapis.com"))
	);
}

function applyGoogleServiceTierPricing(model: Model<GoogleApiType>, usage: Usage, serviceTier: unknown): void {
	const cacheMultipliers = GOOGLE_SERVICE_TIER_CACHE_MULTIPLIERS.get(model.id);
	if (!sendsToGeminiApi(model) || !cacheMultipliers) return;

	const multiplier = serviceTier === "flex" ? 0.5 : serviceTier === "priority" ? 1.8 : 1;
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= serviceTier === "flex" ? cacheMultipliers.flex : cacheMultipliers.priority;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function buildHopUsage(
	api: GoogleApiType,
	model: Model<GoogleApiType>,
	usageMetadata: NonNullable<GenerateContentResponse["usageMetadata"]>,
): { usage: Usage; promptTokens: number } {
	const promptTokens = usageMetadata.promptTokenCount || 0;
	const cacheRead = usageMetadata.cachedContentTokenCount || 0;
	const thoughts = usageMetadata.thoughtsTokenCount || 0;
	const usage: Usage = {
		input: promptTokens - cacheRead,
		output: (usageMetadata.candidatesTokenCount || 0) + thoughts,
		cacheRead,
		cacheWrite: 0,
		reasoning: thoughts,
		totalTokens: usageMetadata.totalTokenCount || 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
	calculateCost(model, usage);
	if (api === "google-generative-ai") {
		// @google/genai 3.6.1 retains this wire field on GenerateContentResponseUsageMetadata but omits it from its type.
		const serviceTier = "serviceTier" in usageMetadata ? usageMetadata.serviceTier : undefined;
		applyGoogleServiceTierPricing(model, usage, serviceTier);
	}
	return { usage, promptTokens };
}

function buildParams(
	model: Model<GoogleApiType>,
	context: TranscriptContext,
	options: GoogleOptions = {},
	strictOptions: { disablePreferredStrictTools?: boolean } = {},
): { params: GenerateContentParameters; hasPreferredStrictTools: boolean } {
	const contents = convertMessages(model, context);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const currentTools = getCurrentTools(context.messages);

	const supportsStrictMode = supportsGoogleStrictToolSampling(model);
	const disablePreferredStrictTools = strictOptions.disablePreferredStrictTools === true;
	const hasPreferredStrictTools =
		currentTools.length > 0 &&
		currentTools.some(
			(tool) =>
				prefersJsonSchemaStrictSampling(tool) &&
				resolveGoogleToolStrictSchema(tool, supportsStrictMode, disablePreferredStrictTools) !== undefined,
		);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(
					currentTools,
					options.toolChoice,
					supportsStrictMode,
					disablePreferredStrictTools,
				)
			: undefined;
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const config: GenerateContentConfig = {
		// Pi owns retry/continuation; do not silently resume inside the SDK.
		automaticContinuation: false,
		// Opt out of Gemini Developer API request logging; @google/genai rejects `store` on Vertex.
		...(sendsToGeminiApi(model) && { store: false }),
		// gemini-4-neon intermittently omits its end-of-turn stop token and emits a raw "\nuser\n"
		// turn header followed by a fabricated user turn and tool calls.
		...(/(?:^|[-/])gemini-4-neon(?:$|-)/.test(model.id.toLowerCase()) && { stopSequences: ["\nuser\n"] }),
		...(options.temperature !== undefined &&
			supportsGoogleTemperature(model) && { temperature: options.temperature }),
		...(options.maxTokens !== undefined && { maxOutputTokens: options.maxTokens }),
		...(systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) }),
		...(currentTools.length > 0 && {
			tools: convertTools(currentTools, false, supportsStrictMode, disablePreferredStrictTools),
		}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	return { params: { model: model.id, contents, config }, hasPreferredStrictTools };
}

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "max">;

const GOOGLE_SDK_THINKING_LEVEL_MAP: Record<GoogleApiThinkingLevel, GoogleSdkThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: GoogleSdkThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: GoogleSdkThinkingLevel.MINIMAL,
	LOW: GoogleSdkThinkingLevel.LOW,
	MEDIUM: GoogleSdkThinkingLevel.MEDIUM,
	HIGH: GoogleSdkThinkingLevel.HIGH,
	XHIGH: GoogleSdkThinkingLevel.XHIGH,
};

/** Map simple reasoning options while leaving token budgets provider-specific. */
export function resolveGoogleSimpleThinking(
	model: Model<GoogleApiType>,
	reasoning: ThinkingLevel | undefined,
	getBudget: (level: ResolvedGoogleThinkingLevel) => number,
): NonNullable<GoogleOptions["thinking"]> {
	if (!reasoning) return { enabled: false };

	const clampedReasoning = clampThinkingLevel(model, reasoning);
	if (clampedReasoning === "off") return { enabled: false };

	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);
	return usesGoogleThinkingLevel(model)
		? { enabled: true, level: toGoogleThinkingLevel(resolvedLevel) }
		: { enabled: true, budgetTokens: getBudget(resolvedLevel) };
}

/** Resolve a supported pi level or model-specific Google mapping to a standard Google level. */
export function resolveGoogleThinkingLevel<T extends GoogleApiType>(
	model: Model<T>,
	level: ThinkingLevel,
): ResolvedGoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
	switch (resolvedLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return resolvedLevel;
		default:
			throw new Error(
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
			);
	}
}

/**
 * Whether this model uses Gemini's discrete `thinkingLevel` control instead of
 * the token-based `thinkingBudget` control. Supported levels come from the
 * model's `thinkingLevelMap`; this only selects the Google wire format.
 */
export function usesGoogleThinkingLevel<T extends GoogleApiType>(model: Model<T>): boolean {
	const id = model.id.toLowerCase();
	return (
		// Match Gemini 3 Pro/Flash IDs with or without a minor version, such as
		// gemini-3-flash-preview, gemini-3.1-pro-preview, and gemini-3.8-flash.
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		// Match Gemini 4 and later, such as gemini-4-argon (#10890).
		(getGeminiMajorVersion(id) ?? 0) >= 4 ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		// Match both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
		/gemma-?4/.test(id)
	);
}

export function toGoogleThinkingLevel(level: ResolvedGoogleThinkingLevel): GoogleApiThinkingLevel {
	switch (level) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
		case "xhigh":
			return "XHIGH";
	}
}

export function toGoogleSdkThinkingLevel(level: GoogleApiThinkingLevel): GoogleSdkThinkingLevel {
	return GOOGLE_SDK_THINKING_LEVEL_MAP[level];
}

export function getDisabledGoogleThinkingConfig<T extends GoogleApiType>(model: Model<T>): ThinkingConfig {
	if (!usesGoogleThinkingLevel(model)) return { thinkingBudget: 0 };

	const fallback = clampThinkingLevel(model, "off");
	if (fallback === "off") return { thinkingBudget: 0 };

	const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
	const apiLevel = toGoogleThinkingLevel(resolvedLevel);
	return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	return incoming || existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

// Google's documented `thoughtSignature` value for function calls the API did not generate, such
// as a trace from another model. The Gemini API skips thought-signature validation for it.
// See: https://aistudio.google.com/docs/thought-signatures?generate-content=true#faqs
const SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

/**
 * Put the skip value on the first function call of a model message whose function calls carry no
 * thought signature.
 *
 * Gemini 3 and later reject a request (400) when the first function call of a step in the current
 * turn has no signature. A call made by another model has none to replay, so a session that
 * switches to Gemini in the middle of a turn would fail. Every such message gets the value, not
 * only those of the current turn, so a message serializes the same way in every request and the
 * cached prompt prefix stays valid after the turn ends.
 */
function markUnsignedFunctionCalls(parts: Part[]): void {
	const functionCalls = parts.filter((part) => part.functionCall !== undefined);
	if (functionCalls.length > 0 && functionCalls.every((part) => part.thoughtSignature === undefined)) {
		functionCalls[0].thoughtSignature = SKIP_THOUGHT_SIGNATURE_VALIDATOR;
	}
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

function getGeminiVersion(modelId: string): { major: number; minor: number } | undefined {
	// Unanchored like usesGoogleThinkingLevel: some hosts prefix the ID, e.g. randomprefix-gemini-4-argon (#12321).
	const match = modelId.toLowerCase().match(/gemini(?:-live)?-(\d+)(?:\.(\d+))?/);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1], 10),
		minor: match[2] ? Number.parseInt(match[2], 10) : 0,
	};
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	return getGeminiVersion(modelId)?.major;
}

/**
 * Gemini 4 and Gemini 3.6+ deprecate custom sampling parameters (`temperature`, `top_p`, `top_k`).
 * `compat.supportsTemperature` overrides the model ID detection.
 */
export function supportsGoogleTemperature<T extends GoogleApiType>(model: Model<T>): boolean {
	if (model.compat?.supportsTemperature !== undefined) {
		return model.compat.supportsTemperature;
	}
	const version = getGeminiVersion(model.id);
	if (!version) return true;
	return !(version.major >= 4 || (version.major === 3 && version.minor >= 6));
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: TranscriptContext): Content[] {
	// Gemini has no mid-conversation system messages; the leading prompt is sent as systemInstruction.
	const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages);
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);

	// Only the Gemini API gets the skip value (provider `google` or its host), not Gemini before 3 or Deep Research.
	// Real calls proved this through a gateway route of `google`; no call went to the host itself.
	// Without a base URL the client sends to the SDK default, which is that host.
	const geminiMajorVersion = getGeminiMajorVersion(model.id);
	const sendsSkipValue =
		sendsToGeminiApi(model) &&
		(geminiMajorVersion === undefined || geminiMajorVersion >= 3) &&
		!model.id.startsWith("deep-research-");

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Keep thinking blocks and signatures for the same model, or across Gemini 4 text/coding
			// models on the same provider/API (documented cross-model thought-signature replay).
			const canReplaySignature = canReplayGoogleThoughtSignature(msg, model);

			for (const block of msg.content) {
				if (block.type === "text") {
					const thoughtSignature = resolveThoughtSignature(canReplaySignature, block.textSignature);
					// Skip empty text blocks — unless they carry a thought signature. Gemini can attach
					// the signature to a part whose visible text is empty and requires it echoed back;
					// dropping it breaks the reasoning chain and the model intermittently ends mid-task
					// turns with a thought-only STOP (empty completion, no tool call).
					if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Only keep as thinking block when signatures/reasoning are replayable on target model.
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (canReplaySignature) {
						const thoughtSignature = isValidThoughtSignature(block.thinkingSignature)
							? block.thinkingSignature
							: undefined;
						// Same rule as text blocks: an empty thinking block is dropped only when it
						// carries no signature (mirrors the anthropic converter's handling).
						if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						// Cross-provider/model: the signature is unusable, empty blocks stay dropped.
						if (!block.thinking || block.thinking.trim() === "") continue;
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(canReplaySignature, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			if (sendsSkipValue) markUnsignedFunctionCalls(parts);
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.trim().length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

/**
 * Strip meta-declarations from a schema obj
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/** Schema keywords whose values map names to subschemas, so their keys are not schema keywords. */
const JSON_SCHEMA_NAME_MAPS = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"dependencies",
]);

/** Keywords containing a subschema or an array of subschemas, not literal data. */
const JSON_SCHEMA_SUBSCHEMAS = new Set([
	"additionalProperties",
	"unevaluatedProperties",
	"propertyNames",
	"items",
	"prefixItems",
	"additionalItems",
	"unevaluatedItems",
	"contains",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"contentSchema",
]);

/**
 * Rewrite string and number `const` values to single-value `enum`s.
 * Gemini ignores `const` in `parametersJsonSchema` but honors `enum`.
 */
function rewriteConstAsEnum(schema: unknown, isNameMap = false): unknown {
	if (Array.isArray(schema)) return schema.map((item) => rewriteConstAsEnum(item));
	if (typeof schema !== "object" || schema === null) return schema;

	// fromEntries preserves names such as __proto__ as own properties.
	const result: Record<string, unknown> = Object.fromEntries(
		Object.entries(schema).map(([key, value]) => {
			if (isNameMap || JSON_SCHEMA_SUBSCHEMAS.has(key)) return [key, rewriteConstAsEnum(value)];
			if (JSON_SCHEMA_NAME_MAPS.has(key)) return [key, rewriteConstAsEnum(value, true)];
			return [key, value];
		}),
	);
	if (!isNameMap && "const" in result && result.enum === undefined) {
		const value = result.const;
		if (typeof value === "string" || typeof value === "number") {
			delete result.const;
			result.enum = [value];
		}
	}
	return result;
}

function resolveGoogleToolStrictSchema(
	tool: Tool,
	supportsStrictMode: boolean,
	disablePreferredStrictTools: boolean,
): Tool["parameters"] | undefined {
	if (disablePreferredStrictTools && prefersJsonSchemaStrictSampling(tool)) {
		return undefined;
	}
	return resolveStrictJsonSchema(tool, supportsStrictMode);
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, etc.). Gemini ignores `const` there, so string and number `const`
 * values are sent as single-value `enum`s. Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
	disablePreferredStrictTools = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				const parameters =
					resolveGoogleToolStrictSchema(tool, supportsStrictMode, disablePreferredStrictTools) ?? tool.parameters;
				return {
					name: tool.name,
					description: tool.description,
					...(useParameters
						? { parameters: sanitizeForOpenApi(parameters) }
						: { parametersJsonSchema: rewriteConstAsEnum(parameters) }),
				};
			}),
		},
	];
}

/**
 * Gemini 3+ enforces required function parameters in validated tool-calling modes.
 * `compat.supportsStrictMode` overrides the model ID detection, e.g. for Gemini models served under IDs without the version.
 */
export function supportsGoogleStrictToolSampling<T extends GoogleApiType>(model: Model<T>): boolean {
	const majorVersion = getGeminiMajorVersion(model.id);
	return model.compat?.supportsStrictMode ?? (majorVersion !== undefined && majorVersion >= 3);
}

/** Map tool choice string to Gemini FunctionCallingConfigMode. */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
	disablePreferredStrictTools = false,
): FunctionCallingConfigMode | undefined {
	const useStrictMode = tools.some(
		(tool) => resolveGoogleToolStrictSchema(tool, supportsStrictMode, disablePreferredStrictTools) !== undefined,
	);
	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}
	if (useStrictMode) {
		return FunctionCallingConfigMode.VALIDATED;
	}
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
		// Per-hop token limit reached when continuation is disabled, capped, or lacks a new token.
		case FinishReason.CONTINUATION:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.TOO_MANY_TOOL_CALLS:
		case FinishReason.NO_IMAGE:
		case FinishReason.MISSING_THOUGHT_SIGNATURE:
		case FinishReason.MALFORMED_RESPONSE:
		case FinishReason.ESCALATION:
		case FinishReason.PUP_LIMITED_DISABLED:
		case FinishReason.MODEL_ARMOR:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * Run a Google GenAI SDK request with the shared provider retry policy
 * (408/409/429/5xx with backoff, honoring retry-after), mirroring how the
 * Anthropic and OpenAI adapters wrap their initial request in
 * retryProviderRequest. The SDK's ApiError has a `status` property but no
 * `headers` property, and retryProviderRequest only retries errors that carry
 * both, so normalize the error by adding the missing `headers` before
 * rethrowing.
 */
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
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
		},
	);
}
