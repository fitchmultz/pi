/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	EventStream,
	findTool,
	getCurrentTools,
	getToolStateChanges,
	mergeAssistantCheckpoint,
	normalizeContext,
	type ResponseControl,
	type SystemMessage,
	type Tool,
	type ToolResultMessage,
	type ToolStateChanges,
	toolKey,
	toToolDeclaration,
	type UserMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { emptyUsage } from "./harness/utils/usage.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	NewContextRequest,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Unresolved native call obligations in the selected context, including detached external work. */
export function getPendingToolCalls(messages: readonly AgentMessage[]): readonly {
	toolCallId: string;
	toolName: string;
	namespace?: string;
	state: "pending" | "started" | "detached";
}[] {
	const results = new Set(messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
	return messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((call) =>
					call.type === "toolCall" && call.async && call.responsesItem && !results.has(call.id)
						? [
								{
									toolCallId: call.id,
									toolName: call.name,
									...(call.namespace === undefined ? {} : { namespace: call.namespace }),
									state: call.executionDetached
										? ("detached" as const)
										: call.executionStarted
											? ("started" as const)
											: ("pending" as const),
								},
							]
						: [],
				)
			: [],
	);
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	return createAgentStream(
		(emit, runConfig) => runAgentLoop(prompts, context, runConfig, emit, signal, streamFn),
		config,
		signal,
	);
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (
		context.messages[context.messages.length - 1].role === "assistant" &&
		getPendingToolCalls(context.messages).length === 0
	) {
		throw new Error("Cannot continue from message role: assistant");
	}

	return createAgentStream(
		(emit, runConfig) => runAgentLoopContinue(context, runConfig, emit, signal, streamFn),
		config,
		signal,
	);
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const initialMessages = declareToolChanges(context, prompts);
	const newMessages: AgentMessage[] = [...initialMessages];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...initialMessages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of initialMessages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (
		context.messages[context.messages.length - 1].role === "assistant" &&
		getPendingToolCalls(context.messages).length === 0
	) {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(
	run: (emit: AgentEventSink, config: AgentLoopConfig) => Promise<AgentMessage[]>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
	const completedMessages: AgentMessage[] = [];
	let turnOpen = false;
	const emit = (event: AgentEvent): void => {
		if (event.type === "message_end") completedMessages.push(event.message);
		if (event.type === "turn_start") turnOpen = true;
		if (event.type === "turn_end") turnOpen = false;
		stream.push(event);
	};

	let model = config.model;
	void run(emit, {
		...config,
		prepareNextTurn: async (context) => {
			const update = await config.prepareNextTurn?.(context);
			model = update?.model ?? model;
			return update;
		},
		prepareRequest: config.prepareRequest
			? async (request, signal) => {
					const update = await config.prepareRequest?.(request, signal);
					model = update?.model ?? model;
					return update ?? undefined;
				}
			: undefined,
	}).then(
		(messages) => stream.end(messages),
		(error: unknown) => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
			if (!turnOpen) emit({ type: "turn_start" });
			emit({ type: "message_start", message });
			emit({ type: "message_end", message });
			emit({ type: "turn_end", message, toolResults: [] });
			emit({ type: "agent_end", messages: completedMessages });
			stream.end(completedMessages);
		},
	);
	return stream;
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let explicitContinuation = false;
	const startedCalls = new Set<string>();
	const pendingCalls = new Map<string, { scope: object; task: Promise<ExecutedToolCallBatch> }>();
	const readyBatches: ExecutedToolCallBatch[] = [];
	let asyncFailure: unknown;
	let activeControl: ResponseControl | undefined;
	let exclusiveCall: { scope: object; task: Promise<ExecutedToolCallBatch> } | undefined;
	let pendingNewContext: NewContextRequest | undefined;
	let responseRetired = false;
	const retireForNewContext = (): void => {
		if (!activeControl) return;
		responseRetired = true;
		activeControl.retire();
	};
	const savedResults: ToolResultMessage[] = [];
	const deliveredResults = new Set<string>();
	const needsResultTurn = (batch: ExecutedToolCallBatch): boolean =>
		!!batch.newContext ||
		(!batch.terminate && batch.messages.some((message) => !deliveredResults.has(message.toolCallId)));
	const resultIds = new Set(
		currentContext.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
	);
	const pendingTasks = (scope?: object): Promise<ExecutedToolCallBatch>[] =>
		[...pendingCalls.values()]
			.filter((pending) => !scope || config.toolExecution === "sequential" || pending.scope === scope)
			.map((pending) => pending.task);
	const startAsyncCall = async (message: AssistantMessage, call: AgentToolCall, scope: object): Promise<void> => {
		if (startedCalls.has(call.id)) return;
		startedCalls.add(call.id);
		await emit({ type: "message_checkpoint", message: createToolCallCheckpoint(message, call) });
		const sequential =
			config.toolExecution === "sequential" ||
			findTool(currentContext.tools ?? [], call)?.executionMode === "sequential";
		const predecessors = sequential
			? pendingTasks(scope)
			: exclusiveCall && (config.toolExecution === "sequential" || exclusiveCall.scope === scope)
				? [exclusiveCall.task]
				: [];
		const task = Promise.all(predecessors).then(() =>
			executeToolCalls(
				currentContext,
				message,
				config,
				signal,
				async (event) => {
					if (event.type === "message_checkpoint" && event.message.responseId) {
						for (const messages of [currentContext.messages, newMessages]) {
							const index = messages.findIndex(
								(saved) => saved.role === "assistant" && saved.responseId === event.message.responseId,
							);
							const saved = messages[index];
							if (saved?.role === "assistant") messages[index] = mergeAssistantCheckpoint(saved, event.message);
						}
					}
					await emit(event);
					if (event.type === "message_end" && event.message.role === "toolResult") {
						currentContext.messages.push(event.message);
						newMessages.push(event.message);
						savedResults.push(event.message);
					}
				},
				[call],
			),
		);
		const pending = { scope, task };
		if (sequential) exclusiveCall = pending;
		pendingCalls.set(call.id, pending);
		void task
			.then(
				(batch) => {
					readyBatches.push(batch);
					pendingNewContext ??= batch.newContext;
					if (pendingNewContext) retireForNewContext();
					else activeControl?.submitToolResults(savedResults);
				},
				(error: unknown) => {
					asyncFailure = error;
				},
			)
			.catch((error: unknown) => {
				asyncFailure = error;
			})
			.finally(() => {
				pendingCalls.delete(call.id);
				if (exclusiveCall?.task === task) exclusiveCall = undefined;
			});
	};
	const joinPendingCalls = async (scope?: object): Promise<void> => {
		await Promise.allSettled(pendingTasks(scope));
		if (asyncFailure) throw asyncFailure;
	};
	try {
		for (const message of currentContext.messages.slice()) {
			if (message.role !== "assistant") continue;
			for (const call of message.content) {
				if (call.type !== "toolCall") continue;
				if (resultIds.has(call.id)) startedCalls.add(call.id);
				else if (call.executionStarted || (call.async && call.responsesItem))
					await startAsyncCall(message, call, message);
			}
		}
		// Check for steering messages at start (user may have typed while waiting)
		let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

		// Outer loop: continues when queued follow-up messages arrive after agent would stop
		while (true) {
			let hasMoreToolCalls = true;

			// Inner loop: process tool calls and steering messages
			while (hasMoreToolCalls || pendingMessages.length > 0) {
				let preparedMessages: AgentMessage[] = [];
				if (lastCompletedTurn) {
					if (config.getTools) currentContext = { ...currentContext, tools: [...config.getTools()] };
					if (pendingNewContext) {
						await joinPendingCalls();
						lastCompletedTurn.newContext ??= pendingNewContext;
						pendingNewContext = undefined;
					}
					const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
					if (nextTurnSnapshot) {
						currentContext = nextTurnSnapshot.context ?? currentContext;
						preparedMessages = nextTurnSnapshot.messages ?? [];
						config = {
							...config,
							model: nextTurnSnapshot.model ?? config.model,
							reasoning:
								nextTurnSnapshot.thinkingLevel === undefined
									? config.reasoning
									: nextTurnSnapshot.thinkingLevel === "off"
										? undefined
										: nextTurnSnapshot.thinkingLevel,
						};
					}
					// Preparation can be long-running (for example, compaction). Pick up steering
					// queued while it ran. Only poll again if the earlier poll returned nothing;
					// otherwise one-at-a-time mode would deliver two messages in this turn.
					if (pendingMessages.length === 0) {
						pendingMessages = (await config.getSteeringMessages?.()) || [];
					}
					await emit({ type: "turn_start" });
				}

				let pollAfterRequestPreparation = pendingMessages.length === 0;
				while (true) {
					// Process prepared and queued messages before request preparation.
					for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					preparedMessages = [];
					pendingMessages = [];

					const requestUpdate = await config.prepareRequest?.(
						{
							context: currentContext,
							model: config.model,
							thinkingLevel: config.reasoning ?? "off",
						},
						signal,
					);
					if (requestUpdate) {
						currentContext = requestUpdate.context ?? currentContext;
						config = {
							...config,
							model: requestUpdate.model ?? config.model,
							reasoning:
								requestUpdate.thinkingLevel === undefined
									? config.reasoning
									: requestUpdate.thinkingLevel === "off"
										? undefined
										: requestUpdate.thinkingLevel,
						};
					}
					signal?.throwIfAborted();
					if (!config.prepareRequest || !pollAfterRequestPreparation) break;

					// Pick up one steering drain that arrived during long request preparation, then
					// prepare again with those messages included.
					pendingMessages = (await config.getSteeringMessages?.()) || [];
					if (pendingMessages.length === 0) break;
					pollAfterRequestPreparation = false;
				}

				// Preparation may replace the context or executable tools (for example, after
				// compaction). Reconcile that final snapshot before sending it to the provider.
				for (const message of declareToolChanges(currentContext, [])) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}

				// Other routes require adjacent synchronous pairs, so finish outstanding work before switching.
				if (
					(config.model.api !== "openai-responses" && config.model.api !== "openai-codex-responses") ||
					!(
						config.model.compat &&
						"supportsAsyncTools" in config.model.compat &&
						config.model.compat.supportsAsyncTools
					)
				)
					await joinPendingCalls();
				// Results already in this request's context have been delivered; later completions wake another turn.
				readyBatches.length = 0;
				responseRetired = false;
				const streamed = await streamAssistantResponse(
					currentContext,
					newMessages,
					{
						...config,
						onResponseControl: (control) => {
							if (activeControl) for (const id of activeControl.deliveredToolCallIds) deliveredResults.add(id);
							activeControl = control;
							config.onResponseControl?.(control);
							if (pendingNewContext) retireForNewContext();
							else control?.submitToolResults(savedResults);
						},
					},
					signal,
					emit,
					(model, context, options) => {
						for (const message of context.messages)
							if (message.role === "toolResult") deliveredResults.add(message.toolCallId);
						return streamFunction(model, context, options);
					},
					startAsyncCall,
					async (message, scope) => {
						const calls = message.content.filter(
							(call): call is AgentToolCall => call.type === "toolCall" && !startedCalls.has(call.id),
						);
						if (calls.length === 0) return;
						if (exclusiveCall && (config.toolExecution === "sequential" || exclusiveCall.scope === scope))
							await exclusiveCall.task;
						if (
							config.toolExecution === "sequential" ||
							calls.some((call) => findTool(currentContext.tools ?? [], call)?.executionMode === "sequential")
						)
							await joinPendingCalls(scope);
						for (const call of calls) startedCalls.add(call.id);
						const batch =
							message.stopReason === "length"
								? await failToolCallsFromTruncatedMessage(calls, emit)
								: await executeToolCalls(currentContext, message, config, signal, emit, calls);
						for (const result of batch.messages) {
							currentContext.messages.push(result);
							newMessages.push(result);
							savedResults.push(result);
						}
						readyBatches.push(batch);
						pendingNewContext ??= batch.newContext;
						if (pendingNewContext) retireForNewContext();
						else activeControl?.submitToolResults(savedResults);
					},
				);
				const message = streamed.message;
				const scope = streamed.scope;
				streamed.needsContinuation ||= responseRetired;
				if (asyncFailure) throw asyncFailure;

				if ((message.stopReason === "error" && !streamed.needsContinuation) || message.stopReason === "aborted") {
					await joinPendingCalls();
					const toolResults = readyBatches.flatMap((batch) => batch.messages);
					lastCompletedTurn = { message, toolResults, context: currentContext, newMessages };
					await config.finishTurn?.(lastCompletedTurn, signal);
					await emit({ type: "turn_end", message, toolResults });
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				const toolCalls = message.content.filter(
					(c): c is AgentToolCall => c.type === "toolCall" && !startedCalls.has(c.id),
				);
				const toolResults: ToolResultMessage[] = [];
				let newContext: NewContextRequest | undefined;
				hasMoreToolCalls = streamed.needsContinuation;
				if (toolCalls.length > 0) {
					if (exclusiveCall && (config.toolExecution === "sequential" || exclusiveCall.scope === scope))
						await exclusiveCall.task;
					if (
						config.toolExecution === "sequential" ||
						toolCalls.some((call) => findTool(currentContext.tools ?? [], call)?.executionMode === "sequential")
					)
						await joinPendingCalls(scope);
					for (const call of toolCalls) startedCalls.add(call.id);
					// A length stop can leave apparently valid but truncated arguments; never execute them.
					const executedToolBatch =
						message.stopReason === "length"
							? await failToolCallsFromTruncatedMessage(toolCalls, emit)
							: await executeToolCalls(currentContext, message, config, signal, emit, toolCalls);
					toolResults.push(...executedToolBatch.messages);
					newContext = executedToolBatch.newContext;
					hasMoreToolCalls = !executedToolBatch.terminate || newContext !== undefined;
					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				if (newContext) await joinPendingCalls();
				toolResults.push(...readyBatches.flatMap((batch) => batch.messages));
				newContext ??= pendingNewContext ?? readyBatches.find((batch) => batch.newContext)?.newContext;
				hasMoreToolCalls ||= newContext !== undefined || readyBatches.some(needsResultTurn);
				lastCompletedTurn = { message, toolResults, context: currentContext, newMessages, newContext };
				const decision = await config.finishTurn?.(lastCompletedTurn, signal);
				await emit({ type: "turn_end", message, toolResults });

				if ((decision?.action === "end" && !newContext) || signal?.aborted) {
					await joinPendingCalls();
					if (!pendingNewContext || signal?.aborted) {
						await emit({ type: "agent_end", messages: newMessages });
						return;
					}
					hasMoreToolCalls = true;
				}

				explicitContinuation = decision?.action === "continue";
				pendingMessages = (await config.getSteeringMessages?.()) || [];
				while (!hasMoreToolCalls && pendingMessages.length === 0 && pendingCalls.size > 0) {
					let unsubscribe: (() => void) | undefined;
					const input = new Promise<void>((resolve) => {
						unsubscribe = config.subscribeSteering?.(resolve);
					});
					try {
						// Subscribe before polling again so an input arriving at this boundary cannot be missed.
						pendingMessages = (await config.getSteeringMessages?.()) || [];
						if (pendingMessages.length === 0) await Promise.race([...pendingTasks(), input]);
					} finally {
						unsubscribe?.();
					}
					if (asyncFailure) throw asyncFailure;
					if (pendingMessages.length === 0) pendingMessages = (await config.getSteeringMessages?.()) || [];
					hasMoreToolCalls = readyBatches.some(needsResultTurn);
				}
				if (hasMoreToolCalls || pendingMessages.length > 0) explicitContinuation = false;
			}

			const followUpMessages = (await config.getFollowUpMessages?.()) || [];
			if (followUpMessages.length > 0) {
				explicitContinuation = false;
				pendingMessages = followUpMessages;
				continue;
			}
			if (explicitContinuation) {
				explicitContinuation = false;
				continue;
			}
			break;
		}
		await joinPendingCalls();
		await emit({ type: "agent_end", messages: newMessages });
	} finally {
		await joinPendingCalls();
	}
}

/**
 * Declare tool loadout changes to the model.
 *
 * `context.tools` is what the runtime can execute; the transcript's system messages declare
 * what the model may call. Before each request the difference becomes `toolsAdded` and
 * `toolsRemoved` on a system message. When a pending system message exists, its tool fields
 * are treated as intent and replaced with the delta between the committed transcript and
 * the executable set, so replay always yields exactly `context.tools`. Otherwise a new
 * system message is inserted before the first non-system pending message.
 */
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	let systemIndex = -1;
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		if (pendingMessages[i].role === "system") {
			systemIndex = i;
			break;
		}
	}
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	const baseline = pending
		? pendingMessages.map((message, index) =>
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: pendingMessages;
	const changes = getToolStateChanges(
		getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(toToolDeclaration),
	);
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	if (pending) {
		// Keep the caller's message object when it already declares no tool changes.
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return pendingMessages;
		return baseline.map((message, index) => (index === systemIndex ? withToolChanges(pending, changes) : message));
	}
	if (unchanged) return pendingMessages;
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	startAsyncCall: (message: AssistantMessage, call: AgentToolCall, scope: object) => Promise<void>,
	finishIntermediateResponse: (message: AssistantMessage, scope: object) => Promise<void>,
): Promise<{ message: AssistantMessage; needsContinuation: boolean; scope: object }> {
	let messages = context.messages;
	if (config.transformContext) messages = await config.transformContext(messages, signal);
	const llmContext = normalizeContext({ messages: await config.convertToLlm(messages) });
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const response = await streamFunction(config.model, llmContext, { ...config, apiKey: resolvedApiKey, signal });
	let partialMessage: AssistantMessage | undefined;
	let contextIndex = -1;
	let newIndex = -1;
	let lastCommitted: AssistantMessage | undefined;
	// Local ordering belongs to this response, even when its async work outlives it.
	let scope: object = {};
	const completeContent = new Set<number>();
	const steering = new Map<UserMessage, string>();
	const committedInputs = new Set<UserMessage>();
	const commitInputs = async (): Promise<void> => {
		for (const message of steering.keys()) {
			if (committedInputs.has(message)) continue;
			committedInputs.add(message);
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			context.messages.push(message);
			newMessages.push(message);
		}
	};
	const commit = async (message: AssistantMessage): Promise<AssistantMessage> => {
		if (
			lastCommitted &&
			(lastCommitted === message || (message.responseId && lastCommitted.responseId === message.responseId))
		)
			return lastCommitted;
		const saved = context.messages[contextIndex];
		if (saved?.role === "assistant") message = mergeAssistantCheckpoint(saved, message);
		if (contextIndex >= 0) context.messages[contextIndex] = message;
		else context.messages.push(message);
		if (newIndex >= 0) newMessages[newIndex] = message;
		else newMessages.push(message);
		if (!partialMessage) await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		lastCommitted = message;
		partialMessage = undefined;
		contextIndex = newIndex = -1;
		await commitInputs();
		return message;
	};
	try {
		for await (const event of response) {
			switch (event.type) {
				case "start":
					if (lastCommitted && config.getTools) context.tools = [...config.getTools()];
					partialMessage = event.partial;
					scope = {};
					completeContent.clear();
					contextIndex = context.messages.push(partialMessage) - 1;
					newIndex = newMessages.push(partialMessage) - 1;
					await emit({
						type: "message_start",
						message: { ...partialMessage },
						...(event.continuationInput === undefined ? {} : { continuationInput: event.continuationInput }),
					});
					break;
				case "steering":
					steering.set(event.message, event.status);
					await emit(event);
					if (!partialMessage) await commitInputs();
					break;
				case "response_end":
					await finishIntermediateResponse(await commit(event.message), scope);
					break;
				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end": {
					if (!partialMessage) break;
					if (event.type === "toolcall_end") event.partial.content[event.contentIndex] = event.toolCall;
					const saved = context.messages[contextIndex];
					partialMessage =
						saved?.role === "assistant" ? mergeAssistantCheckpoint(saved, event.partial) : event.partial;
					context.messages[contextIndex] = partialMessage;
					newMessages[newIndex] = partialMessage;
					await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
					if (event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end")
						completeContent.add(event.contentIndex);
					if (event.type !== "toolcall_end") break;
					const tool = findTool(context.tools ?? [], event.toolCall);
					if (!event.toolCall.async || !tool?.async) break;
					if (
						!event.toolCall.responsesItem?.async ||
						(config.model.api !== "openai-responses" && config.model.api !== "openai-codex-responses") ||
						!(
							config.model.compat &&
							"supportsAsyncTools" in config.model.compat &&
							config.model.compat.supportsAsyncTools
						)
					)
						break;
					const checkpoint = {
						...partialMessage,
						content: partialMessage.content.filter((_block, index) => completeContent.has(index)),
					};
					await startAsyncCall(checkpoint, event.toolCall, scope);
					break;
				}
				case "done":
				case "error": {
					const message = await commit(await response.result());
					return {
						message,
						scope,
						needsContinuation: [...steering.values()].some(
							(status) => status === "failed" || status === "unknown",
						),
					};
				}
			}
		}
		const message = await commit(await response.result());
		return {
			message,
			scope,
			needsContinuation: [...steering.values()].some((status) => status === "failed" || status === "unknown"),
		};
	} finally {
		config.onResponseControl?.(undefined);
	}
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			namespace: toolCall.namespace,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	toolCalls: AgentToolCall[] = assistantMessage.content.filter((c) => c.type === "toolCall"),
): Promise<ExecutedToolCallBatch> {
	const hasSequentialToolCall = toolCalls.some(
		(tc) => findTool(currentContext.tools ?? [], tc)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	newContext?: NewContextRequest;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			namespace: toolCall.namespace,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, assistantMessage, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		finalizedCalls.push(finalized);
		if (!finalized.detached) {
			const toolResultMessage = createToolResultMessage(finalized);
			await emitToolResultMessage(toolResultMessage, emit);
			messages.push(toolResultMessage);
		}

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
		newContext: getNewContextRequest(finalizedCalls, toolCalls.length, signal),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	const errors: unknown[] = [];
	// Completed operations still need receipts when a completion listener or journal write fails.
	const emitCompletedEvent: AgentEventSink = async (event) => {
		try {
			await emit(event);
		} catch (error) {
			errors.push(error);
		}
	};

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			namespace: toolCall.namespace,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emitCompletedEvent);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, assistantMessage, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emitCompletedEvent);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const tasks = finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry)));
	const orderedFinalizedCalls: FinalizedToolCallOutcome[] = [];
	for (const outcome of await Promise.allSettled(tasks)) {
		if (outcome.status === "fulfilled") orderedFinalizedCalls.push(outcome.value);
		else errors.push(outcome.reason);
	}
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		if (finalized.detached) continue;
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emitCompletedEvent);
		messages.push(toolResultMessage);
	}
	if (errors.length > 0) throw errors[0];

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
		newContext: getNewContextRequest(orderedFinalizedCalls, toolCalls.length, signal),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	elapsedMs?: number;
	detached?: boolean;
};

type FinalizedToolCallOutcome = ExecutedToolCallOutcome & { toolCall: AgentToolCall; toolsAdded?: Tool[] };

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function getNewContextRequest(
	finalizedCalls: FinalizedToolCallOutcome[],
	expectedCount: number,
	signal: AbortSignal | undefined,
): NewContextRequest | undefined {
	if (
		signal?.aborted ||
		finalizedCalls.length !== expectedCount ||
		finalizedCalls.some((finalized) => finalized.isError)
	) {
		return undefined;
	}
	return finalizedCalls.find((finalized) => finalized.result.newContext)?.result.newContext;
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = findTool(currentContext.tools ?? [], toolCall);
	if (!tool || (toolCall.kind === "toolSearch" && !tool.toolSearch)) {
		return {
			kind: "immediate",
			result: createErrorToolResult(
				`${toolCall.executionStarted ? `${UNKNOWN_TOOL_OUTCOME} ` : ""}Tool ${toolCall.name} not found`,
			),
			isError: true,
		};
	}

	try {
		if (toolCall.executionStarted) {
			if (!tool.resume)
				return { kind: "immediate", result: createErrorToolResult(UNKNOWN_TOOL_OUTCOME), isError: true };
			const args = structuredClone(toolCall.executionArguments ?? toolCall.arguments);
			return { kind: "prepared", toolCall, tool, args };
		}
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

const UNKNOWN_TOOL_OUTCOME =
	"Previous tool execution was interrupted; its outcome is unknown. Do not assume the operation did not occur.";

/** Only this call's execution state is current; sibling snapshots may predate their admission or detachment. */
function createToolCallCheckpoint(message: AssistantMessage, toolCall: AgentToolCall): AssistantMessage {
	return structuredClone({
		...message,
		stopReason: "pending",
		content: message.content.map((block) => {
			if (block.type !== "toolCall") return block;
			if (block.id === toolCall.id) return toolCall;
			const {
				executionStarted: _started,
				executionArguments: _arguments,
				executionDetached: _detached,
				...providerCall
			} = block;
			return providerCall;
		}),
	});
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const resume = prepared.toolCall.executionStarted === true;
	await emit({
		type: "tool_execution_prepared",
		toolCallId: prepared.toolCall.id,
		toolName: prepared.toolCall.name,
		namespace: prepared.toolCall.namespace,
		args: prepared.args,
	});
	const nativeAsync =
		prepared.toolCall.async === true &&
		prepared.toolCall.responsesItem?.async === true &&
		prepared.tool.async === true;
	if (nativeAsync) {
		prepared.toolCall.executionArguments = structuredClone(prepared.args) as AgentToolCall["arguments"];
		prepared.toolCall.executionStarted = true;
		prepared.toolCall.executionDetached = false;
		await emit({
			type: "message_checkpoint",
			message: createToolCallCheckpoint(assistantMessage, prepared.toolCall),
		});
	}
	const startedAt = performance.now();
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const execute = resume ? prepared.tool.resume : prepared.tool.execute;
		const result = await execute?.(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
			if (!acceptingUpdates) return;
			updateEvents.push(
				Promise.resolve(
					emit({
						type: "tool_execution_update",
						toolCallId: prepared.toolCall.id,
						toolName: prepared.toolCall.name,
						namespace: prepared.toolCall.namespace,
						args: prepared.toolCall.arguments,
						partialResult,
					}),
				),
			);
		});
		const elapsedMs = performance.now() - startedAt;
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		if (!result) return { result: createErrorToolResult(UNKNOWN_TOOL_OUTCOME), isError: true, elapsedMs };
		if (result.pending) {
			if (!nativeAsync || !signal?.aborted)
				throw new Error("pending:true requires an aborted native async call with durable external ownership");
			prepared.toolCall.executionDetached = true;
			await emit({
				type: "message_checkpoint",
				message: createToolCallCheckpoint(assistantMessage, prepared.toolCall),
			});
			return { result, isError: false, detached: true, elapsedMs };
		}
		return { result, isError: false, elapsedMs };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(
				`${resume ? `${UNKNOWN_TOOL_OUTCOME} Reattachment failed: ` : ""}${error instanceof Error ? error.message : String(error)}`,
			),
			isError: true,
			elapsedMs: performance.now() - startedAt,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (executed.detached) return { ...executed, toolCall: prepared.toolCall };
	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	let toolsAdded: Tool[] | undefined;
	if (prepared.tool.toolSearch && !isError) {
		try {
			if (!Array.isArray(result.tools))
				throw new Error("Tool search must return a tools array of registered references");
			const available = config.getTools?.() ?? currentContext.tools ?? [];
			const resolved = new Map<string, Tool>();
			for (const reference of result.tools) {
				if (
					!reference ||
					typeof reference.name !== "string" ||
					(reference.namespace !== undefined && typeof reference.namespace !== "string")
				) {
					throw new Error("Invalid tool search reference");
				}
				const tool = findTool(available, reference);
				if (!tool) throw new Error(`Tool search reference ${toolKey(reference)} is not active or permitted`);
				resolved.set(toolKey(tool), toToolDeclaration(tool));
			}
			toolsAdded = [...resolved.values()];
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
		elapsedMs: executed.elapsedMs,
		toolsAdded,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	if (finalized.detached) {
		await emit({
			type: "tool_execution_detached",
			toolCallId: finalized.toolCall.id,
			toolName: finalized.toolCall.name,
			namespace: finalized.toolCall.namespace,
		});
		return;
	}
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		namespace: finalized.toolCall.namespace,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		...(finalized.toolCall.namespace === undefined ? {} : { namespace: finalized.toolCall.namespace }),
		...(finalized.toolCall.kind === undefined ? {} : { toolCallKind: finalized.toolCall.kind }),
		...(finalized.toolsAdded !== undefined || finalized.toolCall.kind === "toolSearch"
			? { toolsAdded: finalized.toolsAdded ?? [] }
			: {}),
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.elapsedMs === undefined ? {} : { elapsedMs: finalized.elapsedMs }),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
