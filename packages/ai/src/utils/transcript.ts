import type {
	AssistantMessage,
	Context,
	Message,
	SystemMessage,
	Tool,
	ToolCall,
	ToolReference,
	ToolResultMessage,
	TranscriptContext,
} from "../types.ts";
import { contentText, getSystemMessageText } from "./text.ts";
import { toolKey } from "./tool-identity.ts";

export type { TranscriptContext } from "../types.ts";

/** Coalesce provider frames and execution checkpoints without losing final content or admitted calls. */
export function mergeAssistantCheckpoint(message: AssistantMessage, checkpoint: AssistantMessage): AssistantMessage {
	const latest =
		checkpoint.stopReason === "pending" &&
		(message.stopReason !== "pending" || message.content.length > checkpoint.content.length)
			? message
			: checkpoint;
	const executions = new Map<
		string,
		Pick<ToolCall, "executionStarted" | "executionArguments" | "executionDetached">
	>();
	for (const frame of [message, checkpoint]) {
		for (const call of frame.content) {
			if (call.type !== "toolCall" || call.executionStarted === undefined) continue;
			executions.set(call.id, {
				...executions.get(call.id),
				executionStarted: call.executionStarted,
				...(call.executionArguments === undefined ? {} : { executionArguments: call.executionArguments }),
				...(call.executionDetached === undefined ? {} : { executionDetached: call.executionDetached }),
			});
		}
	}
	return {
		...latest,
		content: latest.content.map((block) =>
			block.type === "toolCall" && executions.has(block.id) ? { ...block, ...executions.get(block.id) } : block,
		),
	};
}

/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: Tool[] | undefined,
): SystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};
}

/**
 * Fold `Context.systemPrompt` and `Context.tools` into a leading system message.
 * This is the only entry point that produces a {@link TranscriptContext}; every
 * provider-facing function expects the result.
 */
export function normalizeContext(context: Context): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages } as TranscriptContext;
}

/**
 * Any message list. The replay helpers only read entries whose role is `"system"`, so
 * agent transcripts that carry custom message roles can be passed without filtering.
 */
export type TranscriptMessages = readonly { role: string }[];

function isSystemMessage(message: { role: string }): message is SystemMessage {
	return message.role === "system";
}

function isToolStateMessage(message: { role: string }): message is SystemMessage | ToolResultMessage {
	return message.role === "system" || message.role === "toolResult";
}

/** Return the leading system message, if the transcript starts with one. */
export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const first = messages[0];
	return first && isSystemMessage(first) ? first : undefined;
}

/** Drop the leading system message for APIs that carry the prompt outside the message list. */
export function withoutInitialSystemMessage(messages: Message[]): Message[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isToolStateMessage(message)) continue;
		if (message.role === "system") {
			if (message.replace) tools.clear();
			for (const tool of message.toolsRemoved ?? []) tools.delete(toolKey(tool));
		}
		for (const tool of message.toolsAdded ?? []) tools.set(toolKey(tool), tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, a `replace` message starts over, and tools are resolved with
 * {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		if (message.replace) {
			content.length = 0;
			sections.clear();
		}
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}

/** Project retained history behind a complete tool-state checkpoint without replaying old search deltas. */
export function withoutToolSearchState<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.map((message) => {
		if (message.role === "toolResult") {
			const result = message as T & ToolResultMessage;
			if (result.toolsAdded === undefined && result.toolCallKind === undefined) return message;
			return { ...message, toolsAdded: undefined, toolCallKind: undefined };
		}
		if (message.role === "assistant") {
			const assistant = message as T & AssistantMessage;
			if (!assistant.content.some((block) => block.type === "toolCall" && block.kind === "toolSearch"))
				return message;
			return {
				...message,
				content: assistant.content.map((block) =>
					block.type === "toolCall" && block.kind === "toolSearch" ? { ...block, kind: undefined } : block,
				),
			};
		}
		return message;
	});
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const messages = withoutToolSearchState(context.messages.filter((message) => message.role !== "system"));
	return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

/**
 * Keep later system messages in place when the model accepts them; otherwise collapse them.
 * A replacement after the leading message always collapses: no provider can retract the
 * prompt it already received, so the replayed state must become the leading prompt.
 */
export function resolveTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	const lateReplacement = context.messages.some(
		(message, index) => index > 0 && isSystemMessage(message) && message.replace === true,
	);
	return supportsMidConvoSystemMessages && !lateReplacement ? context : collapseSystemMessages(context);
}

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
		...(tool.toolSearch === undefined ? {} : { toolSearch: tool.toolSearch }),
		...(tool.async === undefined ? {} : { async: tool.async }),
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined
			? {}
			: { constrainedSampling: structuredClone(tool.constrainedSampling) }),
	};
}

/**
 * Whether two tools declare the same interface to the model.
 *
 * Both sides go through {@link toToolDeclaration} first: its JSON round-trip drops the
 * typebox symbol keys and `undefined` fields that a structural comparison would see, and
 * builds both objects with the same key order, so comparing the serialized declarations
 * is exact. This avoids a deep-equal dependency in a browser-safe package.
 */
export function declarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [toolKey(tool), tool]));
	const currentTools = new Map(current.map((tool) => [toolKey(tool), tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(toolKey(tool));
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(toolKey(tool));
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name, ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }) })),
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order. */
export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
	const definitions = new Map<string, Tool>();
	for (const message of messages) {
		if (!isToolStateMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) definitions.set(toolKey(tool), tool);
	}
	return [...definitions.values()];
}

/**
 * Whether a tool name was declared twice with different definitions. Transports that
 * reference tools by name (Anthropic `tool_addition`/`tool_removal`) cannot express that.
 */
export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
	const declared = new Map<string, Tool>();
	for (const message of messages) {
		if (!isToolStateMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) {
			const previous = declared.get(toolKey(tool));
			if (previous !== undefined && !declarationsEqual(previous, tool)) return true;
			declared.set(toolKey(tool), tool);
		}
	}
	return false;
}

/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
	const declared = new Map<string, Tool>();
	for (const message of messages) {
		if (!isToolStateMessage(message)) continue;
		if (message.role === "system" && (message.toolsRemoved?.length ?? 0) > 0) return true;
		for (const tool of message.toolsAdded ?? []) {
			const previous = declared.get(toolKey(tool));
			if (previous && (message.role === "system" || !declarationsEqual(previous, tool))) return true;
			declared.set(toolKey(tool), tool);
		}
	}
	return false;
}

export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	requestTools: Tool[];
	/**
	 * Whether later system messages carry their own `toolsAdded` as in-place additions.
	 * When false, `requestTools` already holds the complete current tool set.
	 */
	anchorsAdditions: boolean;
}

/**
 * Split tool declarations between the top-level request field and in-place additions.
 * Transports that can anchor additions at a system message keep the initial tools at the
 * top and load later ones where they appear; that only works when no tool was removed or
 * redeclared, so everything else sends the current tool list.
 */
export function resolveTranscriptTools(messages: TranscriptMessages, supportsToolAdditions: boolean): TranscriptTools {
	const anchorsAdditions = supportsToolAdditions && !hasNonAdditiveToolChanges(messages);
	return {
		requestTools: anchorsAdditions
			? (getInitialSystemMessage(messages)?.toolsAdded ?? [])
			: getCurrentTools(messages),
		anchorsAdditions,
	};
}
