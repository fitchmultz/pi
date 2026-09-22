import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/** Opaque Responses state is portable only on the same route/model or the verified direct GPT-6 family. */
export function canReplayResponses(message: AssistantMessage, model: Model<Api>): boolean {
	if (message.provider !== model.provider || message.api !== model.api) return false;
	return (
		message.model === model.id ||
		(model.provider === "openai" &&
			model.api === "openai-responses" &&
			/^gpt-6-(astra|sol|luna)$/.test(message.model) &&
			/^gpt-6-(astra|sol|luna)$/.test(model.id))
	);
}

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const nativeAsync =
		(model.api === "openai-responses" || model.api === "openai-codex-responses") &&
		model.compat &&
		"supportsAsyncTools" in model.compat &&
		model.compat.supportsAsyncTools;
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		// System and user messages pass through unchanged
		if (msg.role === "system" || msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;
			const compatibleResponses = model.api === "openai-responses" && canReplayResponses(assistantMsg, model);

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if ((isSameModel || compatibleResponses) && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel || compatibleResponses) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					const preserveAsyncIdentity =
						nativeAsync &&
						toolCall.async &&
						assistantMsg.provider === model.provider &&
						assistantMsg.api === model.api;
					if (!isSameModel && !compatibleResponses && !preserveAsyncIdentity && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Synchronous calls and routes require adjacency even when steering or async history spans turns.
	const completed = new Map(
		transformed.flatMap((message) => (message.role === "toolResult" ? [[message.toolCallId, message] as const] : [])),
	);
	const relocated = new Set<string>();
	const ordered = transformed.flatMap((message): Message[] => {
		if (message.role !== "assistant") return [message];
		// Hosted histories contain interleaved calls and injected results, not adjacent pairs.
		if (message.responsesOutput && canReplayResponses(message, model)) return [message];
		const results = message.content.flatMap((call) => {
			if (
				call.type !== "toolCall" ||
				(call.async && nativeAsync && message.provider === model.provider && message.api === model.api)
			)
				return [];
			const result = completed.get(call.id);
			if (!result) return [];
			relocated.add(call.id);
			return [result];
		});
		return [message, ...results];
	});
	const emittedResults = new Set<string>();

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	// System messages are transparent to tool-call accounting: one that lands between a tool
	// call and its results is held back and emitted after the results (synthetic ones
	// included), so it never causes a duplicate result for a call that is answered later.
	const heldSystemMessages: Message[] = [];
	const closePendingToolCalls = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						...(tc.namespace === undefined ? {} : { namespace: tc.namespace }),
						...(tc.kind === undefined ? {} : { toolCallKind: tc.kind }),
						content: [
							{
								type: "text",
								text: tc.async
									? "Asynchronous tool execution has no recorded result; its outcome is unknown."
									: "No result provided",
							},
						],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
		result.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};

	for (const msg of ordered) {
		if (msg.role === "toolResult" && relocated.has(msg.toolCallId)) {
			if (emittedResults.has(msg.toolCallId)) continue;
			emittedResults.add(msg.toolCallId);
		}

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			closePendingToolCalls();

			// Skip errored/aborted assistant messages unless they contain committed tool calls.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			let assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				// A streamed call may already have committed a local side effect. Preserve its
				// authoritative item even when the remainder of the response was interrupted.
				const committed = assistantMsg.content.filter((block) =>
					block.type === "toolCall"
						? block.executionStarted ||
							completed.has(block.id) ||
							(!!block.responsesItem && (block.async || !assistantMsg.responsesOutput))
						: block.type === "text"
							? !!block.textSignature
							: !!block.thinkingSignature,
				);
				// Signatures alone are not tool obligations and may leave reasoning without a following item.
				if (!committed.some((block) => block.type === "toolCall")) continue;
				// Reasoning after the last completed output belongs to the interrupted suffix.
				while (committed.at(-1)?.type === "thinking") committed.pop();
				assistantMsg = { ...assistantMsg, content: committed };
				if (assistantMsg.responsesOutput) {
					const calls = new Set(
						committed.flatMap((block) => (block.type === "toolCall" ? [block.id.split("|")[0]] : [])),
					);
					let lastCall = -1;
					for (const [index, item] of assistantMsg.responsesOutput.entries())
						if (
							(item.type === "function_call" ||
								item.type === "custom_tool_call" ||
								item.type === "tool_search_call") &&
							item.call_id &&
							calls.has(item.call_id)
						)
							lastCall = index;
					assistantMsg.responsesOutput = assistantMsg.responsesOutput
						.slice(0, lastCall + 1)
						.filter(
							(item) =>
								(item.type !== "function_call" && item.type !== "custom_tool_call") || calls.has(item.call_id),
						);
				}
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls.filter(
					(call) =>
						!(
							(assistantMsg.responsesOutput &&
								completed.has(call.id) &&
								canReplayResponses(assistantMsg, model)) ||
							(call.async &&
								nativeAsync &&
								assistantMsg.provider === model.provider &&
								assistantMsg.api === model.api)
						),
				);
				existingToolResultIds = new Set();
			}

			result.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "system") {
			if (pendingToolCalls.length > 0) {
				heldSystemMessages.push(msg);
			} else {
				result.push(msg);
			}
		} else if (msg.role === "user") {
			// A new user turn interrupts tool flow - insert synthetic results for orphaned calls
			closePendingToolCalls();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	closePendingToolCalls();

	return result;
}
