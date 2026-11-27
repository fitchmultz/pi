import type { Interactions } from "@google/genai";
import type { AssistantMessage, ImageContent, Model, TextContent, ToolCall, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { contentText, getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getCurrentTools,
	getInitialSystemMessage,
	resolveTranscript,
	withoutInitialSystemMessage,
} from "../utils/transcript.ts";
import {
	isValidThoughtSignature,
	needsGoogleThoughtSignatureSkip,
	SKIP_THOUGHT_SIGNATURE_VALIDATOR,
} from "./google-shared.ts";
import { canReplayGoogleThoughtSignature, transformMessages } from "./transform-messages.ts";

type ModelStep = Exclude<Interactions.Step, { type: "user_input" | "function_result" }>;

export interface GoogleInteractionsReplay {
	/** Verify Pi has not edited the portable content before reusing signed steps. */
	contentHash: string;
	steps: ModelStep[];
}

function toContent(block: TextContent | ImageContent): Interactions.TextContent | Interactions.ImageContent {
	return block.type === "text"
		? { type: "text", text: sanitizeSurrogates(block.text) }
		: { type: "image", mime_type: block.mimeType, data: block.data };
}

export function replayMetadata(output: AssistantMessage, steps: ModelStep[]): GoogleInteractionsReplay {
	return { contentHash: shortHash(JSON.stringify(output.content)), steps };
}

/** Project the request transcript using the system and step formats of the destination route. */
export function projectTranscript(model: Model<"google-interactions">, context: TranscriptContext) {
	const plan = model.provider === "google-ai-plan";
	const transcript = resolveTranscript(context, !plan);
	const steps: Interactions.Step[] = [];
	const conversation = withoutInitialSystemMessage(transcript.messages).map((message) => {
		if (message.role !== "assistant" || !message.googleInteractionsReplay) return message;
		const { googleInteractionsReplay, ...portable } = message;
		// Compare before transformMessages normalizes portable blocks for the destination API.
		if (
			message.api === model.api &&
			message.provider === model.provider &&
			message.model === model.id &&
			googleInteractionsReplay.contentHash === shortHash(JSON.stringify(message.content))
		) {
			return message;
		}
		// Signatures from native steps also appear on the portable blocks. Once the native
		// replay fails its provenance or edit check, do not replay those copies either.
		return {
			...portable,
			content: portable.content.flatMap<AssistantMessage["content"][number]>((block) => {
				if (block.type === "thinking") return [];
				if (block.type === "text") return [{ type: "text", text: block.text }];
				const { thoughtSignature: _signature, ...call } = block;
				return [call];
			}),
		};
	});
	const messages = transformMessages(conversation, model, (id) =>
		/^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : `call_${shortHash(id)}`,
	);
	const needsSkipSignature = needsGoogleThoughtSignatureSkip(model);
	for (const message of messages) {
		switch (message.role) {
			case "system": {
				const text = renderSystemMessageUpdate(message);
				if (text) {
					steps.push({
						type: "user_input",
						content: [{ type: "text", text: `<system_update>\n${sanitizeSurrogates(text)}\n</system_update>` }],
					});
				}
				break;
			}
			case "user": {
				const content = (
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content
				).map(toContent);
				if (!plan || content.length > 0) steps.push({ type: "user_input", content });
				break;
			}
			case "toolResult":
				steps.push({
					type: "function_result",
					call_id: message.toolCallId,
					name: message.toolName,
					result: plan ? planToolResult(message.content) : message.content.map(toContent),
					...(message.isError ? { is_error: true } : {}),
				});
				break;
			case "assistant": {
				const replay = message.googleInteractionsReplay;
				// The quota route must group text and mark unsigned calls even when replaying its own output.
				if (!plan && replay) {
					steps.push(...replay.steps);
					break;
				}
				const canReplaySignature = canReplayGoogleThoughtSignature(message, model);
				let firstCall = true;
				let signedThought = false;
				for (const block of message.content) {
					if (block.type === "text") {
						// GenerateContent can end a tool call with an empty text part. Interactions rejects it.
						if (!block.text) continue;
						const text = toContent(block);
						const previous = steps.at(-1);
						if (plan && previous?.type === "model_output" && previous.content) previous.content.push(text);
						else steps.push({ type: "model_output", content: [text] });
					} else if (block.type === "thinking" && canReplaySignature) {
						const signature =
							plan || isValidThoughtSignature(block.thinkingSignature) ? block.thinkingSignature : undefined;
						const summary = plan ? block.thinking.trim() : block.thinking;
						if (signature || summary) {
							signedThought ||= Boolean(signature);
							steps.push({
								type: "thought",
								signature,
								summary: summary ? [{ type: "text", text: sanitizeSurrogates(block.thinking) }] : undefined,
							});
						}
					} else if (block.type === "toolCall") {
						// Interactions accepts a GenerateContent tool-call signature in the
						// documented thought step immediately before the corresponding call.
						const signature =
							canReplaySignature && isValidThoughtSignature(block.thoughtSignature)
								? block.thoughtSignature
								: undefined;
						if (signature) {
							steps.push({ type: "thought", signature });
							signedThought = true;
						} else if (plan && !signedThought) {
							steps.push({ type: "thought", signature: SKIP_THOUGHT_SIGNATURE_VALIDATOR });
							signedThought = true;
						}
						const call = {
							type: "function_call" as const,
							id: block.id,
							name: block.name,
							arguments: block.arguments,
							...(!plan && !signature && firstCall && needsSkipSignature
								? { signature: SKIP_THOUGHT_SIGNATURE_VALIDATOR }
								: {}),
						};
						steps.push(call);
						firstCall = false;
					}
				}
				break;
			}
		}
	}
	const initial = getInitialSystemMessage(transcript.messages);
	return {
		steps,
		instruction: initial ? sanitizeSurrogates(getSystemMessageText(initial)) : "",
		tools: getCurrentTools(transcript.messages),
	};
}

function planToolResult(content: (TextContent | ImageContent)[]) {
	const text = sanitizeSurrogates(contentText(content));
	const images = content.filter((block) => block.type === "image");
	return images.length > 0 ? [...(text ? [{ type: "text" as const, text }] : []), ...images.map(toContent)] : text;
}

function isModelStep(step: Interactions.Step): step is ModelStep {
	return step.type !== "user_input" && step.type !== "function_result";
}

type OpenBlock =
	| { type: "text"; index: number; block: TextContent }
	| { type: "thinking"; index: number; block: Extract<AssistantMessage["content"][number], { type: "thinking" }> }
	| { type: "toolCall"; index: number; block: ToolCall };

interface OpenStep {
	step: ModelStep;
	blocks: OpenBlock[];
	argumentsJson?: string;
}

/** Accumulate one hop's indexed SSE steps and expose their portable blocks as they arrive. */
export class InteractionSteps {
	private readonly steps = new Map<number, OpenStep>();
	private readonly events: AssistantMessageEventStream;
	private readonly output: AssistantMessage;

	constructor(events: AssistantMessageEventStream, output: AssistantMessage) {
		this.events = events;
		this.output = output;
	}

	start(index: number, step: Interactions.Step): void {
		if (!isModelStep(step)) return;
		const entry: OpenStep = { step, blocks: [] };
		this.steps.set(index, entry);
		switch (step.type) {
			case "model_output":
				for (const content of step.content ?? []) {
					if (content.type === "text") this.appendText(this.startText(entry), content.text);
				}
				break;
			case "thought": {
				const block = this.startThinking(entry);
				block.block.thinkingSignature = step.signature;
				for (const content of step.summary ?? []) {
					if (content.type === "text") this.appendThinking(block, content.text);
				}
				break;
			}
			case "function_call": {
				const block: ToolCall = { type: "toolCall", id: step.id, name: step.name, arguments: step.arguments ?? {} };
				if ("signature" in step && typeof step.signature === "string") block.thoughtSignature = step.signature;
				const contentIndex = this.output.content.push(block) - 1;
				entry.blocks.push({ type: "toolCall", index: contentIndex, block });
				this.events.push({ type: "toolcall_start", contentIndex, partial: this.output });
				break;
			}
		}
	}

	delta(index: number, delta: Interactions.StepDelta["delta"]): void {
		const entry = this.steps.get(index);
		if (!entry) return;
		const { step } = entry;
		const block = entry.blocks.at(-1);
		switch (delta.type) {
			case "text": {
				if (step.type !== "model_output") break;
				step.content ??= [];
				const last = step.content.at(-1);
				if (last?.type === "text") last.text += delta.text;
				else step.content.push({ type: "text", text: delta.text });
				this.appendText(block?.type === "text" ? block : this.startText(entry), delta.text);
				break;
			}
			case "thought_summary": {
				if (step.type !== "thought" || block?.type !== "thinking" || !delta.content) break;
				const content = delta.content;
				if (content.type !== "text" && content.type !== "image") break;
				step.summary ??= [];
				const last = step.summary.at(-1);
				if (last?.type === "text" && content.type === "text") last.text += content.text;
				else step.summary.push({ ...content });
				if (content.type === "text") this.appendThinking(block, content.text);
				break;
			}
			case "thought_signature":
				if (step.type === "thought" && block?.type === "thinking") {
					step.signature = delta.signature;
					block.block.thinkingSignature = delta.signature;
				} else if (step.type === "function_call" && block?.type === "toolCall") {
					Object.assign(step, { signature: delta.signature });
					block.block.thoughtSignature = delta.signature;
				}
				break;
			case "arguments_delta":
				if (step.type !== "function_call" || block?.type !== "toolCall" || !delta.arguments) break;
				entry.argumentsJson = (entry.argumentsJson ?? "") + delta.arguments;
				block.block.arguments = parseStreamingJson<ToolCall["arguments"]>(entry.argumentsJson);
				this.events.push({
					type: "toolcall_delta",
					contentIndex: block.index,
					delta: delta.arguments,
					partial: this.output,
				});
				break;
			case "tool_search_call":
				if (step.type === "tool_search_call") {
					if (delta.arguments !== undefined) step.arguments = delta.arguments;
					if (delta.signature !== undefined) step.signature = delta.signature;
				}
				break;
			case "tool_search_result":
				if (step.type === "tool_search_result") {
					if (delta.result !== undefined) {
						step.result ??= [];
						step.result.push(...delta.result);
					}
					if (delta.signature !== undefined) step.signature = delta.signature;
				}
				break;
		}
	}

	stop(index: number): void {
		const entry = this.steps.get(index);
		if (!entry) return;
		for (const { type, block, index: contentIndex } of entry.blocks) {
			switch (type) {
				case "text":
					this.events.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
					break;
				case "thinking":
					this.events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
					break;
				case "toolCall":
					if (entry.step.type === "function_call" && entry.argumentsJson !== undefined) {
						Object.assign(block, parseToolCallArguments(entry.argumentsJson));
						entry.step.arguments = block.arguments;
					}
					this.events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.output });
					break;
			}
		}
		entry.blocks.length = 0;
	}

	finish(completeSteps?: Interactions.Step[]): ModelStep[] {
		const finalSteps = completeSteps?.filter(isModelStep);
		if (this.steps.size === 0 && finalSteps) {
			for (const [index, step] of finalSteps.entries()) this.start(index, step);
		}
		const streamed: ModelStep[] = [];
		for (const [index, entry] of [...this.steps].sort(([left], [right]) => left - right)) {
			this.stop(index);
			streamed.push(entry.step);
		}
		return finalSteps?.length ? finalSteps : streamed;
	}

	private startText(entry: OpenStep): Extract<OpenBlock, { type: "text" }> {
		const block: TextContent = { type: "text", text: "" };
		const index = this.output.content.push(block) - 1;
		const active = { type: "text" as const, block, index };
		entry.blocks.push(active);
		this.events.push({ type: "text_start", contentIndex: index, partial: this.output });
		return active;
	}

	private startThinking(entry: OpenStep): Extract<OpenBlock, { type: "thinking" }> {
		const block: Extract<AssistantMessage["content"][number], { type: "thinking" }> = {
			type: "thinking",
			thinking: "",
		};
		const index = this.output.content.push(block) - 1;
		const active = { type: "thinking" as const, block, index };
		entry.blocks.push(active);
		this.events.push({ type: "thinking_start", contentIndex: index, partial: this.output });
		return active;
	}

	private appendText({ block, index }: Extract<OpenBlock, { type: "text" }>, delta: string): void {
		if (!delta) return;
		block.text += delta;
		this.events.push({ type: "text_delta", contentIndex: index, delta, partial: this.output });
	}

	private appendThinking({ block, index }: Extract<OpenBlock, { type: "thinking" }>, delta: string): void {
		if (!delta) return;
		block.thinking += delta;
		this.events.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.output });
	}
}
