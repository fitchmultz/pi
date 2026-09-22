import type OpenAI from "openai";
import type {
	BetaResponseInputItem,
	BetaResponseOutputItem,
	BetaResponseStreamEvent,
	BetaResponsesServerEvent,
} from "openai/resources/beta/responses/responses.js";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponsesServerEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	JsonObject,
	Model,
	StopReason,
	SystemMessage,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolReference,
	ToolResultMessage,
	TranscriptContext,
	Usage,
	UserMessage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderError } from "../utils/provider-error.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { toolKey, toToolReference } from "../utils/tool-identity.ts";
import {
	getCurrentSystemMessage,
	getCurrentTools,
	getInitialSystemMessage,
	hasNonAdditiveToolChanges,
	normalizeContext,
	resolveTranscript,
	resolveTranscriptTools,
	snapshotResponsesContent,
	withoutToolSearchState,
} from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { type ResponsesDiagnostics, recordResponsesEvent } from "./openai-responses-diagnostics.ts";
import { canReplayResponses, transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

export function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	const textResult = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = content.filter((c): c is ImageContent => c.type === "image");
	const hasText = textResult.length > 0;

	if (images.length === 0 || !model.input.includes("image")) {
		return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	}

	const output: ToolResultOutputContent = [];
	if (hasText) {
		output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	for (const image of images) {
		output.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return output;
}

/** Transport-local snapshots travel with the frame, never through a mutable live controller. */
export type ResponsesEvent = (
	| ResponseStreamEvent
	| ResponsesServerEvent
	| BetaResponseStreamEvent
	| BetaResponsesServerEvent
) & {
	continuationInput?: readonly (UserMessage | ToolResultMessage)[];
	injectedInput?: { afterOutputIndex: number; items: BetaResponseInputItem[] };
	/** Terminal backfill from a failed/truncated response must never trigger early execution. */
	incompleteItem?: boolean;
};

export interface OpenAIResponsesStreamOptions {
	hosted?: boolean;
	streamingTools?: boolean;
	continuesResponse?: () => boolean;
	wasRetired?: () => boolean;
	onResponseStart?: (message: AssistantMessage) => void;
	onResponseEnd?: (message: AssistantMessage) => void;
	responseError?: (response: Extract<ResponseStreamEvent, { type: "response.failed" }>["response"]) => Error;
	/** The single active callback corresponding to the nameless native search declaration. */
	toolSearchTool?: ToolReference;
	diagnostics?: ResponsesDiagnostics;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	/** Whether later system messages are sent in place; otherwise they are folded into the leading prompt. */
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	toolOptions?: ConvertResponsesToolsOptions;
	/** Initial request effort remains stable; changes are inserted at their historical position. */
	reasoningEffort?: string;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	toolSearchResult?: boolean;
	supportsAsyncTools?: boolean;
	toolSearchTool?: ToolReference;
}

/** A native search declaration has no name, so multiple callbacks remain ordinary functions. */
export function getNativeToolSearch(tools: readonly Tool[], supported: boolean | undefined): Tool | undefined {
	if (!supported) return undefined;
	const searches = tools.filter((tool) => tool.toolSearch);
	return searches.length === 1 ? searches[0] : undefined;
}

/** Tool-search additions can remain in place even when later instruction text must be folded. */
export function resolveResponsesTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
	supportsToolSearch: boolean | undefined,
): TranscriptContext {
	const nonAdditive = hasNonAdditiveToolChanges(context.messages);
	if (
		nonAdditive &&
		context.messages.some((message) => message.role === "toolResult" && message.toolsAdded !== undefined)
	) {
		const normalized = resolveTranscript(context, supportsMidConvoSystemMessages);
		const initial = getInitialSystemMessage(normalized.messages);
		const head: SystemMessage = {
			...(initial ?? { role: "system", content: "", timestamp: 0 }),
			toolsAdded: getCurrentTools(context.messages),
			toolsRemoved: undefined,
		};
		return normalizeContext({
			messages: [
				head,
				...withoutToolSearchState(normalized.messages.slice(initial ? 1 : 0)).map((message) =>
					message.role === "system" ? { ...message, toolsAdded: undefined, toolsRemoved: undefined } : message,
				),
			],
		});
	}
	if (
		supportsMidConvoSystemMessages ||
		!supportsToolSearch ||
		nonAdditive ||
		context.messages.some((message, index) => index > 0 && message.role === "system" && message.replace)
	) {
		return resolveTranscript(context, supportsMidConvoSystemMessages);
	}
	const head = getCurrentSystemMessage(context.messages);
	if (!head) return context;
	const initial = getInitialSystemMessage(context.messages);
	return normalizeContext({
		messages: [
			{ ...head, toolsAdded: initial?.toolsAdded },
			...context.messages
				.slice(initial ? 1 : 0)
				.map((message) => (message.role === "system" ? { ...message, content: "", sections: undefined } : message)),
		],
	});
}

/** Serialize registered search declarations identically for replay and live steering continuations. */
export function convertResponsesToolSearchOutput(
	model: Model<Api>,
	result: ToolResultMessage,
	options?: ConvertResponsesToolsOptions,
): ResponseInput {
	const messages: ResponseInput = [
		{
			type: "tool_search_output",
			call_id: result.toolCallId.split("|")[0],
			execution: "client",
			status: result.isError ? "incomplete" : "completed",
			tools: convertResponsesTools(result.toolsAdded ?? [], {
				...options,
				toolSearchResult: true,
				toolSearchTool: undefined,
			}),
		},
	];
	// Search outputs only carry declarations; retain callback text/images as ordinary model context.
	if (result.content.length > 0) {
		const output = convertToolResultOutput(model, result.content);
		messages.push({
			role: "user",
			content: [
				{
					type: "input_text",
					text: `Tool search result from ${toolKey({ name: result.toolName, namespace: result.namespace })}:`,
				},
				...(typeof output === "string" ? [{ type: "input_text" as const, text: output }] : output),
			],
		});
	}
	return messages;
}

// =============================================================================
// Message conversion
// =============================================================================

/** Shared serializer for stateless replay, steering, and hosted result injection. */
export function convertResponsesToolResult(
	model: Model<Api>,
	result: ToolResultMessage,
	call?: ToolCall["responsesItem"],
	options?: ConvertResponsesToolsOptions,
	custom = call?.type === "custom_tool_call",
): ResponseInput {
	if (result.toolCallKind === "toolSearch") return convertResponsesToolSearchOutput(model, result, options);
	return [
		{
			type: custom ? "custom_tool_call_output" : "function_call_output",
			call_id: result.toolCallId.split("|")[0],
			output: convertToolResultOutput(model, result.content),
			...(call && "caller" in call && call.caller ? { caller: call.caller } : {}),
		},
	];
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const normalizedContext = resolveResponsesTranscript(
		context,
		options?.supportsMidConvoSystemMessages,
		options?.supportsToolSearch,
	);
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const supportsAsyncTools = model.compat && "supportsAsyncTools" in model.compat && model.compat.supportsAsyncTools;
	const replayMessages = normalizedContext.messages.map((message) => {
		if (message.role !== "assistant" || !message.responsesOutput) return message;
		if (
			message.responsesContent &&
			JSON.stringify(message.responsesContent) === JSON.stringify(snapshotResponsesContent(message.content))
		)
			return message;
		// A content replacement may redact data also present in programs or encrypted items.
		// Reconstruct this message solely from edited content; never forward its old native state.
		return {
			...message,
			responsesOutput: undefined,
			responsesContent: undefined,
			content: message.content.flatMap((block): AssistantMessage["content"] => {
				if (block.type === "text") return [{ type: "text", text: block.text }];
				if (block.type === "thinking") return block.thinking ? [{ type: "text", text: block.thinking }] : [];
				const { responsesItem: _item, thoughtSignature: _signature, ...call } = block;
				return [call];
			}),
		};
	});
	const transformedMessages = transformMessages(replayMessages, model, normalizeToolCallId);
	const injectedCallIds = new Set(
		transformedMessages.flatMap((message) =>
			message.role === "assistant" && canReplayResponses(message, model)
				? (message.responsesOutput ?? []).flatMap((item) =>
						item.type === "function_call_output" ||
						item.type === "custom_tool_call_output" ||
						(item.type === "tool_search_output" &&
							options?.supportsToolSearch &&
							message.content.some(
								(block) =>
									block.type === "toolCall" &&
									block.kind === "toolSearch" &&
									block.id.split("|")[0] === item.call_id,
							))
							? [item.call_id]
							: [],
					)
				: [],
		),
	);
	const originalCalls = new Map(
		transformedMessages.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((block) =>
						block.type === "toolCall" &&
						block.responsesItem &&
						message.provider === model.provider &&
						message.api === model.api &&
						(canReplayResponses(message, model) || (supportsAsyncTools && block.async))
							? [[block.id, block.responsesItem] as const]
							: [],
					)
				: [],
		),
	);
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		(options?.supportsAdditionalTools ?? false) || (options?.supportsToolSearch ?? false),
	);
	const appendSystemToolAdditions = (message: Pick<SystemMessage, "toolsAdded">, seed: string): void => {
		const tools = transcriptTools.anchorsAdditions ? (message.toolsAdded ?? []) : [];
		if (tools.length === 0) return;
		if (options?.supportsAdditionalTools) {
			messages.push({
				type: "additional_tools",
				role: "developer",
				tools: convertResponsesTools(tools, options.toolOptions),
			} satisfies ResponseInputItem);
			return;
		}
		if (!options?.supportsToolSearch) return;
		const names = tools.map(toolKey);
		const callId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
		messages.push({
			type: "tool_search_call",
			call_id: callId,
			execution: "client",
			status: "completed",
			arguments: { query: names.join(" "), limit: names.length },
		} satisfies ResponseInputItem);
		messages.push({
			type: "tool_search_output",
			call_id: callId,
			execution: "client",
			status: "completed",
			tools: convertResponsesTools(tools, { ...options.toolOptions, toolSearchResult: true }),
		} satisfies ResponseToolSearchOutputItemParam);
	};
	const includeInitialSystemMessage = options?.includeSystemPrompt ?? true;
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";

	let activeEffort =
		options?.reasoningEffort === undefined
			? undefined
			: getInitialResponsesEffort(model, context, options.reasoningEffort);
	const updateEffort = (effort: string): void => {
		if (effort === activeEffort) return;
		const update: ResponseInputItem = {
			type: "configuration_update",
			reasoning: { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" },
		};
		if (messages.at(-1)?.type === "configuration_update") messages[messages.length - 1] = update;
		else messages.push(update);
		activeEffort = effort;
	};
	let msgIndex = 0;
	let sourceIndex = 0;
	for (const msg of transformedMessages) {
		const isLeadingSystemMessage = sourceIndex++ === 0 && msg.role === "system";
		if (msg.role === "system") {
			if (!isLeadingSystemMessage) appendSystemToolAdditions(msg, `system:${msgIndex}`);
			if (!isLeadingSystemMessage || includeInitialSystemMessage) {
				const text = isLeadingSystemMessage ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
				if (text.length > 0) {
					messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
				}
			}
		} else if (msg.role === "user") {
			if (activeEffort === "" && options?.reasoningEffort !== undefined) updateEffort(options.reasoningEffort);
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
			if (canReplayResponses(assistantMsg, model) && assistantMsg.responsesOutput) {
				if (activeEffort !== undefined && assistantMsg.providerThinkingLevel !== undefined)
					updateEffort(assistantMsg.providerThinkingLevel);
				// Beta extends the standard wire union; Responses adapters share this serializer.
				for (const item of assistantMsg.responsesOutput) {
					if (item.type === "function_call" || item.type === "custom_tool_call") {
						// Checkpoints/context edits select executable calls; raw buffered siblings are not admissions.
						if (
							!assistantMsg.content.some(
								(block) => block.type === "toolCall" && block.id.split("|")[0] === item.call_id,
							)
						)
							continue;
					}
					// A replaced tool loadout turns old client searches into ordinary transcript calls.
					const call =
						(item.type === "tool_search_call" && item.execution === "client") ||
						item.type === "tool_search_output"
							? assistantMsg.content.find(
									(block): block is ToolCall =>
										block.type === "toolCall" && block.id.split("|")[0] === item.call_id,
								)
							: undefined;
					if (item.type === "tool_search_call" && item.execution === "client" && !call) continue;
					if (call && (call.kind !== "toolSearch" || !options?.supportsToolSearch)) {
						if (item.type === "tool_search_output") continue;
						messages.push({
							type: "function_call",
							call_id: call.id.split("|")[0],
							name: call.name,
							arguments: JSON.stringify(call.arguments),
							...(call.namespace === undefined ? {} : { namespace: call.namespace }),
							...("agent" in item && item.agent ? { agent: item.agent } : {}),
						});
					} else messages.push(item as ResponseInputItem);
				}
				if (activeEffort !== undefined && assistantMsg.responsesOutput.some((item) => item.type === "compaction"))
					activeEffort = "";
				continue;
			}
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const original = originalCalls.get(toolCall.id);
					if (
						original &&
						original.type !== "tool_search_call" &&
						(canReplayResponses(assistantMsg, model) || (toolCall.async && supportsAsyncTools))
					) {
						output.push(original);
						continue;
					}
					const [callId, itemIdRaw] = toolCall.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(toolKey(toolCall));
					if (toolCall.kind === "toolSearch" && options?.supportsToolSearch) {
						output.push({
							type: "tool_search_call",
							call_id: callId,
							execution: "client",
							status: "completed",
							arguments: toolCall.arguments,
						});
						continue;
					}
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					// Item IDs are optional, but their prefix must match the emitted tool kind.
					// Keep call_id unchanged so saved results still pair after conversion.
					if (
						(isDifferentModel && itemId?.startsWith("fc_")) ||
						!itemId?.startsWith(customInputProperty === undefined ? "fc_" : "ctc_")
					) {
						itemId = undefined;
					}

					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
							...(toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
						} satisfies ResponseOutputItem);
					} else {
						output.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
							...(toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
						});
					}
				}
			}
			if (output.length === 0) continue;
			if (activeEffort !== undefined && isSameModel && assistantMsg.providerThinkingLevel !== undefined)
				updateEffort(assistantMsg.providerThinkingLevel);
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const [callId] = msg.toolCallId.split("|");
			if (injectedCallIds.has(callId)) {
				if (msg.toolCallKind !== "toolSearch") appendSystemToolAdditions(msg, `result:${msg.toolCallId}`);
				continue;
			}

			if (msg.toolCallKind === "toolSearch" && options?.supportsToolSearch) {
				messages.push(...convertResponsesToolSearchOutput(model, msg, options.toolOptions));
				continue;
			}

			const original = originalCalls.get(msg.toolCallId);
			const custom = original
				? original.type === "custom_tool_call"
				: options?.grammarToolInputProperties?.has(toolKey({ name: msg.toolName, namespace: msg.namespace }));
			messages.push(...convertResponsesToolResult(model, msg, original, options?.toolOptions, custom));
			appendSystemToolAdditions(msg, `result:${msg.toolCallId}`);
		}
		if (!isLeadingSystemMessage) msgIndex++;
	}

	if (options?.reasoningEffort !== undefined) updateEffort(options.reasoningEffort);
	return messages;
}

/** Raw and simple entry points share the same unsupported-level clamping. */
export function resolveResponsesEffort(
	model: Model<"openai-responses" | "openai-codex-responses">,
	requested?: ThinkingLevel | "none",
): string | undefined {
	if (!model.reasoning) return undefined;
	if (requested !== undefined) {
		const level = clampThinkingLevel(model, requested === "none" ? "off" : requested);
		return model.thinkingLevelMap?.[level] ?? (level === "off" ? "none" : level);
	}
	return model.thinkingLevelMap?.off === null ? "medium" : (model.thinkingLevelMap?.off ?? "none");
}

export function getInitialResponsesEffort(model: Model<Api>, context: TranscriptContext, current: string): string {
	for (const message of context.messages) {
		if (
			message.role === "assistant" &&
			message.api === model.api &&
			message.provider === model.provider &&
			message.model === model.id &&
			message.providerThinkingLevel !== undefined
		)
			return message.providerThinkingLevel;
	}
	return current;
}

/** Positional effort is supported only in standard single-agent requests with explicit compaction triggers. */
export function supportsPositionalResponsesEffort(
	model: Model<"openai-responses" | "openai-codex-responses">,
	params?: Record<string, unknown>,
): boolean {
	const reasoning = params?.reasoning as { mode?: string } | undefined;
	return (
		model.compat?.supportsReasoningEffortUpdates === true &&
		(!reasoning?.mode || reasoning.mode === "standard") &&
		!params?.context_management &&
		params?.truncation !== "auto" &&
		!params?.multi_agent &&
		!params?.agent &&
		!params?.agents
	);
}

/** A transport failure between successors must not mutate or charge the response already committed. */
export function createResponsesSuccessor(message: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: message.api,
		provider: message.provider,
		model: message.model,
		providerThinkingLevel: message.providerThinkingLevel,
		stopReason: "pending",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	const converted: OpenAITool[] = [];
	const namespaces = new Map<string, Extract<OpenAITool, { type: "namespace" }>>();
	const append = (tool: Tool, declaration: Extract<OpenAITool, { type: "function" | "custom" }>): void => {
		if (tool.namespace === undefined) {
			converted.push(declaration);
			return;
		}
		let namespace = namespaces.get(tool.namespace);
		if (!namespace) {
			namespace = { type: "namespace", name: tool.namespace, description: tool.namespace, tools: [] };
			namespaces.set(tool.namespace, namespace);
			converted.push(namespace);
		}
		namespace.tools.push(declaration);
	};
	for (const tool of tools) {
		if (tool.async && tool.allowedCallers?.includes("programmatic"))
			throw new Error(`Tool ${toolKey(tool)} cannot combine async and programmatic callers`);
		if (tool.toolSearch && options?.toolSearchTool && toolKey(tool) === toolKey(options.toolSearchTool)) {
			converted.push({
				type: "tool_search",
				execution: "client",
				description: tool.description,
				parameters: tool.parameters,
			});
			continue;
		}
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			append(tool, {
				type: "custom",
				...(tool.allowedCallers ? { allowed_callers: tool.allowedCallers } : {}),
				...(options?.supportsAsyncTools && tool.async !== undefined ? { async: tool.async } : {}),
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.toolSearchResult ? { defer_loading: true } : {}),
			} satisfies OpenAITool);
			continue;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
		} = {
			type: "function",
			...(tool.allowedCallers ? { allowed_callers: tool.allowedCallers } : {}),
			...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
			...(options?.supportsAsyncTools && tool.async !== undefined ? { async: tool.async } : {}),
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as Record<string, unknown>,
			...(options?.toolSearchResult ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = strict;
		}
		append(tool, functionTool as Extract<OpenAITool, { type: "function" }>);
	}
	return converted;
}

// =============================================================================
// Stream processing
// =============================================================================

type StreamingToolCall = ToolCall & {
	partialJson?: string;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
};

function getCustomToolCallInput(block: StreamingToolCall): string {
	const property = block.customInput?.property;
	if (property === undefined) return "";
	const value = block.arguments[property];
	return typeof value === "string" ? value : "";
}

function appendCustomToolCallInput(block: StreamingToolCall, nextInput: string, close: boolean): string | undefined {
	const customInput = block.customInput;
	if (!customInput) return undefined;
	const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
	block.arguments = { [customInput.property]: nextInput };
	return delta;
}

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

/** Some gateways send completed items only in the terminal frame. Project each item exactly once. */
async function* completedResponseItems(
	events: AsyncIterable<ResponsesEvent>,
	onClose: () => void,
): AsyncGenerator<ResponsesEvent> {
	const completed = new Set<string>();
	try {
		for await (const event of events) {
			if (event.type === "response.created") completed.clear();
			if (event.type === "response.output_item.done")
				completed.add(event.item.id ?? `${event.output_index}:${event.item.type}`);
			if (
				event.type === "response.completed" ||
				event.type === "response.incomplete" ||
				event.type === "response.failed"
			) {
				for (const [index, item] of (event.response.output ?? []).entries()) {
					if (!completed.has(item.id ?? `${index}:${item.type}`))
						yield {
							type: "response.output_item.done",
							output_index: index,
							item,
							sequence_number: event.sequence_number,
							incompleteItem: event.type !== "response.completed",
						};
				}
			}
			yield event;
		}
	} finally {
		onClose();
	}
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponsesEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	const nativeItems = new Map<number, BetaResponseOutputItem>();
	const injections: { index: number; input: BetaResponseInputItem[] }[] = [];
	const saveNativeItems = (): void => {
		const history: NonNullable<AssistantMessage["responsesOutput"]> = [];
		const returnedResults = new Set(
			[...nativeItems.values()].flatMap((item) =>
				item.type === "function_call_output" ||
				item.type === "custom_tool_call_output" ||
				item.type === "tool_search_output"
					? [item.call_id]
					: [],
			),
		);
		const appendInjection = (input: BetaResponseInputItem[]): void => {
			history.push(
				...input.filter(
					(item) =>
						!(
							item.type === "function_call_output" ||
							item.type === "custom_tool_call_output" ||
							item.type === "tool_search_output"
						) || !returnedResults.has(item.call_id ?? undefined),
				),
			);
		};
		for (const [index, item] of [...nativeItems].sort(([a], [b]) => a - b)) {
			history.push(item);
			for (const injection of injections) if (injection.index === index) appendInjection(injection.input);
		}
		for (const injection of injections)
			if (injection.index === Number.MAX_SAFE_INTEGER) appendInjection(injection.input);
		output.responsesOutput = history;
	};
	// Keep hosted results outside content: they are not calls for the local agent to execute.
	const recordWebSearchItem = (item: BetaResponseOutputItem): void => {
		if (item.type === "web_search_call") {
			output.webSearch ??= {};
			output.webSearch.calls ??= [];
			const calls = output.webSearch.calls;
			const index = calls.findIndex((call) => call.id === item.id);
			if (index < 0) calls.push(item);
			else calls[index] = item;
		} else if (item.type === "message") {
			const citations = (item.content ?? []).flatMap((part, contentIndex) =>
				part.type === "output_text"
					? (part.annotations ?? [])
							.filter((annotation) => annotation.type === "url_citation")
							.map((annotation) => ({ itemId: item.id, contentIndex, annotation }))
					: [],
			);
			if (citations.length === 0) return;
			output.webSearch ??= {};
			const metadata = output.webSearch;
			metadata.citations = [
				...(metadata.citations ?? []).filter((citation) => citation.itemId !== item.id),
				...citations,
			];
		}
	};
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const applyMessagePhaseStopReason = (item: BetaResponseOutputItem): void => {
		if (
			item.type === "message" &&
			(!("agent" in item) || !item.agent || item.agent.agent_name === "/root") &&
			item.phase === "final_answer"
		) {
			output.stopReason = "stop";
		}
	};
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
		if (delta === undefined) return;
		stream.push({
			type: "toolcall_delta",
			contentIndex: slot.contentIndex,
			delta,
			partial: output,
		});
	};
	const createSlot = (outputIndex: number, item: BetaResponseOutputItem): ResponsesOutputSlot | undefined => {
		if ((item.type === "message" || item.type === "reasoning") && item.agent && item.agent.agent_name !== "/root")
			return undefined;
		if (item.type === "reasoning" || item.type === "compaction") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot = {
				type: "thinking",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "message") {
			applyMessagePhaseStopReason(item);
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "tool_search_call" && item.execution === "client") {
			if (!options?.toolSearchTool || !item.call_id)
				throw new Error("Client tool search has no unique active callback or call ID");
			const block: StreamingToolCall = {
				type: "toolCall",
				kind: "toolSearch",
				id: `${item.call_id}|${item.id}`,
				...toToolReference(options.toolSearchTool),
				arguments: {},
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "function_call") {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "custom_tool_call") {
			const inputProperty = options?.grammarToolInputProperties?.get(toolKey(item)) ?? "input";
			const input = item.input || "";
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: { [inputProperty]: input },
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				customInput: {
					property: inputProperty,
					jsonBuffer: { input: "", started: false, closed: false },
				},
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		return undefined;
	};
	const getOrCreateSlot = (outputIndex: number, item: BetaResponseOutputItem): ResponsesOutputSlot | undefined => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	// Azure OpenAI can omit reasoning.encrypted_content from response.output_item.done
	// and provide it only in response.completed.response.output. Backfill the
	// persisted reasoning signature from the terminal response to keep store:false
	// multi-turn replay stateless. See https://github.com/earendil-works/pi/issues/6409.
	const backfillReasoningSignatures = (responseOutput: BetaResponseOutputItem[]): void => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({
				...storedItem,
				encrypted_content: item.encrypted_content,
			});
		}
	};
	const finalizeResponse = (
		response: Extract<
			BetaResponseStreamEvent | ResponseStreamEvent,
			{ type: "response.completed" | "response.incomplete" }
		>["response"],
	): void => {
		sawTerminalResponseEvent = true;
		const endTurn = (response as { end_turn?: unknown }).end_turn;
		if (typeof endTurn === "boolean") output.endTurn = endTurn;
		backfillReasoningSignatures(response.output ?? []);
		for (const [index, item] of (response.output ?? []).entries()) {
			const previous = nativeItems.get(index);
			// Azure's existing replay contract keeps completed ciphertext, backfilling only when absent.
			nativeItems.set(
				index,
				model.api === "azure-openai-responses" &&
					item.type === "reasoning" &&
					previous?.type === "reasoning" &&
					previous.encrypted_content
					? { ...item, encrypted_content: previous.encrypted_content }
					: item,
			);
		}
		saveNativeItems();
		for (const item of response.output ?? []) recordWebSearchItem(item);
		if (response?.id) {
			output.responseId = response.id;
		}
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details as
				| { cached_tokens?: number; cache_write_tokens?: number }
				| undefined;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			output.usage = {
				// OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
				input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
				output: response.usage.output_tokens || 0,
				cacheRead: cachedTokens,
				cacheWrite: cacheWriteTokens,
				reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
				totalTokens: response.usage.total_tokens || 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		calculateCost(model, output.usage);
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		// Map status to stop reason. For incomplete responses, retain the provider's
		// specific reason so max-output truncation and content filtering stay distinct.
		const status = response?.status;
		const incompleteDetails = response?.incomplete_details as { reason?: unknown } | null | undefined;
		const incompleteReason = typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
		output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
		const mappedStop = mapStopReason(status, incompleteReason);
		output.stopReason = mappedStop.stopReason;
		if (mappedStop.errorMessage === undefined) delete output.errorMessage;
		else output.errorMessage = mappedStop.errorMessage;
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
		if (options?.hosted && status === "completed")
			output.needsContinuation = !(response.output ?? []).some(
				(item) =>
					item.type === "message" &&
					(!("agent" in item) || !item.agent || item.agent.agent_name === "/root") &&
					item.phase !== "commentary",
			);
		output.responsesContent = snapshotResponsesContent(output.content);
	};

	for await (const event of completedResponseItems(openaiStream, () => {
		if (output.responsesOutput) output.responsesContent = snapshotResponsesContent(output.content);
	})) {
		if (options?.diagnostics) recordResponsesEvent(options.diagnostics, event);
		if (event.injectedInput) {
			injections.push({ index: event.injectedInput.afterOutputIndex, input: event.injectedInput.items });
			saveNativeItems();
		}
		if (event.type === "response.created") {
			if (sawTerminalResponseEvent) {
				output = createResponsesSuccessor(output);
				output.responseId = event.response.id;
				outputSlots.clear();
				reasoningBlocksById.clear();
				nativeItems.clear();
				injections.length = 0;
				sawTerminalResponseEvent = false;
				options?.onResponseStart?.(output);
				stream.push({ type: "start", partial: output, continuationInput: event.continuationInput });
			}
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			createSlot(event.output_index, event.item);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.reasoning_summary_part.done") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: "\n\n",
				partial: output,
			});
		} else if (event.type === "response.reasoning_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.output_text.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.refusal.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			pushToolCallDelta(slot, event.delta);
		} else if (event.type === "response.function_call_arguments.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) pushToolCallDelta(slot, delta);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(
				slot,
				appendCustomToolCallInput(slot.block, getCustomToolCallInput(slot.block) + event.delta, false),
			);
		} else if (event.type === "response.custom_tool_call_input.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true));
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			nativeItems.set(event.output_index, item);
			saveNativeItems();
			recordWebSearchItem(item);
			applyMessagePhaseStopReason(item);
			const slot = getOrCreateSlot(event.output_index, item);

			if ((item.type === "reasoning" || item.type === "compaction") && slot?.type === "thinking") {
				const summaryText = item.type === "reasoning" ? item.summary?.map((s) => s.text).join("\n\n") || "" : "";
				const contentText = item.type === "reasoning" ? item.content?.map((c) => c.text).join("\n\n") || "" : "";
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				reasoningBlocksById.set(item.id, slot.block);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				slot.block.text = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "tool_search_call" && item.execution === "client" && slot?.type === "toolCall") {
				if (typeof item.arguments !== "object" || item.arguments === null || Array.isArray(item.arguments)) {
					throw new Error("Client tool search arguments must be an object");
				}
				slot.block.arguments = item.arguments as JsonObject;
				slot.block.responsesItem = item;
				if (options?.streamingTools && !event.incompleteItem) slot.block.streaming = true;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (
				item.type === "function_call" &&
				slot?.type === "toolCall" &&
				slot.block.partialJson !== undefined
			) {
				slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
				slot.block.responsesItem = item;
				if (options?.streamingTools && !event.incompleteItem) slot.block.streaming = true;
				if (item.async !== undefined && !event.incompleteItem) slot.block.async = item.async;
				if (!event.incompleteItem && (item.async || options?.streamingTools || item.caller?.type === "program"))
					slot.block.arguments = JSON.parse(item.arguments);
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				// Finalize in-place and strip the scratch buffer so replay only
				// carries parsed arguments.
				delete slot.block.partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
				pushToolCallDelta(
					slot,
					appendCustomToolCallInput(slot.block, item.input ?? getCustomToolCallInput(slot.block), true),
				);
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				slot.block.responsesItem = item;
				if (options?.streamingTools && !event.incompleteItem) slot.block.streaming = true;
				if (item.async !== undefined && !event.incompleteItem) slot.block.async = item.async;
				const inputProperty = options?.grammarToolInputProperties?.get(toolKey(slot.block));
				if (inputProperty !== undefined) slot.block.arguments = { [inputProperty]: item.input };
				delete slot.block.customInput;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			}
			output.responsesContent = snapshotResponsesContent(output.content);
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			finalizeResponse(event.response);
			if (options?.continuesResponse?.()) {
				stream.push({ type: "response_end", message: output });
				options.onResponseEnd?.(output);
			}
		} else if (event.type === "error") {
			const error = "error" in event ? event.error : event;
			throw Object.assign(new Error(`Error Code ${error.code}: ${error.message}`), getProviderError(event));
		} else if (event.type === "response.failed") {
			finalizeResponse(event.response);
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw Object.assign(
				options?.responseError?.(
					event.response as Extract<ResponseStreamEvent, { type: "response.failed" }>["response"],
				) ?? new Error(msg),
				getProviderError(event.response.error),
				{ responseId: event.response.id },
			);
		}
	}
	if (options?.wasRetired?.()) {
		if (!sawTerminalResponseEvent) {
			output.stopReason = "stop";
			output.rawStopReason = "context_replaced";
		}
		options.onResponseStart?.(output);
		return;
	}
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}

function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "steered") return { stopReason: "stop" };
			if (incompleteReason === "max_output_tokens") {
				return { stopReason: "length" };
			}
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
