import type {
	ResponseCreateParamsStreaming as BetaResponseCreateParamsStreaming,
	BetaResponseInputItem,
	BetaResponsesClientEvent,
	BetaResponsesServerEvent,
} from "openai/resources/beta/responses/responses.js";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseSteerRequiredInput,
	ResponsesServerEvent,
} from "openai/resources/responses/responses.js";
import type {
	AssistantMessageEvent,
	Model,
	ResponseControl,
	SteeringStatus,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { convertResponsesToolResult } from "./openai-responses-shared.ts";

/** One native WebSocket request and its successors; the agent still owns every tool execution. */
export function createResponsesControl(
	model: Model<"openai-responses" | "openai-codex-responses">,
	params: Omit<BetaResponseCreateParamsStreaming | ResponseCreateParamsStreaming, "stream"> & {
		stream?: boolean;
		multi_agent?: BetaResponseCreateParamsStreaming["multi_agent"];
	},
	send: (event: BetaResponsesClientEvent) => void,
	emit: (event: Extract<AssistantMessageEvent, { type: "steering" }>) => void,
	retire: () => void,
	grammarToolInputProperties?: Map<string, string>,
) {
	type Submission = {
		message: UserMessage;
		input: UserMessage;
		parentId: string;
		status: SteeringStatus;
		id?: string;
	};
	const { input: _input, stream: _stream, previous_response_id: _previous, ...continuationParams } = params;
	const toolOptions = {
		strict: model.api === "openai-codex-responses" ? null : undefined,
		supportsStrictMode: model.compat?.supportsStrictMode ?? model.api === "openai-codex-responses",
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools,
		supportsAsyncTools: model.compat?.supportsAsyncTools,
	};
	const submissions: Submission[] = [];
	const results = new Map<string, ToolResultMessage>();
	const continuations = new Set<string>();
	const deliveredToolCallIds = new Set<string>();
	const hosted = params.multi_agent?.enabled === true;
	const calls = new Map<string, ToolCall["responsesItem"]>();
	const submittedInjections = new Set<string>();
	const injections: {
		responseId: string;
		result: ToolResultMessage;
		input: BetaResponseInputItem[];
		afterOutputIndex: number;
	}[] = [];
	let injectedInput: { afterOutputIndex: number; items: BetaResponseInputItem[] } | undefined;
	let lastOutputIndex = -1;
	let activeResponseId: string | undefined;
	let lastResponseId: string | undefined;
	let terminal = false;
	let successorExpected = false;
	let required: { parentId: string; inputs: ResponseSteerRequiredInput[]; sent?: ToolResultMessage[] } | undefined;
	let closed = false;
	let retired = false;

	const update = (submission: Submission, status: SteeringStatus, errorMessage?: string): void => {
		submission.status = status;
		emit({
			type: "steering",
			message: submission.message,
			status,
			steeringId: submission.id,
			responseId: submission.parentId,
			...(errorMessage ? { errorMessage } : {}),
		});
	};
	const continueWithResults = (): void => {
		if (!required || continuations.has(required.parentId) || closed) return;
		const input: ResponseInput = [];
		const submitted: ToolResultMessage[] = [];
		for (const stub of required.inputs) {
			if (
				stub.type !== "function_call_output" &&
				stub.type !== "custom_tool_call_output" &&
				stub.type !== "tool_search_output"
			) {
				throw new Error(`Unsupported steering continuation input: ${stub.type}`);
			}
			const result = results.get(stub.call_id);
			if (!result) return;
			submitted.push(structuredClone(result));
			if (stub.type === "tool_search_output" && result.toolCallKind !== "toolSearch")
				throw new Error(`Steering tool search result has no native search identity: ${stub.call_id}`);
			input.push(
				...convertResponsesToolResult(
					model,
					result,
					calls.get(stub.call_id),
					toolOptions,
					stub.type === "custom_tool_call_output",
				),
			);
		}
		continuations.add(required.parentId);
		send({
			...continuationParams,
			type: "response.create",
			previous_response_id: required.parentId,
			input,
		} as BetaResponsesClientEvent);
		required.sent = submitted;
		for (const stub of required.inputs) {
			if ("call_id" in stub) {
				const result = results.get(stub.call_id);
				if (result) deliveredToolCallIds.add(result.toolCallId);
			}
		}
	};
	const control: ResponseControl = {
		deliveredToolCallIds,
		get retired() {
			return retired;
		},
		retire() {
			retired = true;
			closed = true;
			retire();
		},
		get waitingForSuccessor() {
			return (
				successorExpected ||
				submissions.some(
					(submission) =>
						submission.status === "queued" || submission.status === "accepted" || submission.status === "pending",
				)
			);
		},
		steer(message) {
			if (!activeResponseId || closed || model.compat?.supportsSteering !== true) return false;
			const submission: Submission = {
				message,
				input: structuredClone(message),
				parentId: activeResponseId,
				status: "queued",
			};
			submissions.push(submission);
			update(submission, "queued");
			try {
				send({
					type: "response.steer",
					previous_response_id: activeResponseId,
					input: [
						{
							type: "message",
							role: "user",
							content:
								typeof submission.input.content === "string"
									? submission.input.content
									: submission.input.content.map((part) =>
											part.type === "text"
												? { type: "input_text", text: part.text }
												: {
														type: "input_image",
														image_url: `data:${part.mimeType};base64,${part.data}`,
														detail: "auto",
													},
										),
						},
					],
				});
			} catch (error) {
				update(submission, "unknown", error instanceof Error ? error.message : String(error));
			}
			return true;
		},
		submitToolResults(saved) {
			for (const result of saved) {
				results.set(result.toolCallId.split("|")[0], result);
				if (grammarToolInputProperties && result.toolsAdded) {
					for (const [key, property] of createGrammarToolInputProperties(
						result.toolsAdded,
						model.compat?.supportsOpenAIGrammarTools ?? false,
					))
						grammarToolInputProperties.set(key, property);
				}
			}
			if (hosted && activeResponseId && !closed) {
				for (const result of saved) {
					const id = result.toolCallId.split("|")[0];
					if (!calls.has(id) || submittedInjections.has(id) || deliveredToolCallIds.has(result.toolCallId))
						continue;
					const input = convertResponsesToolResult(model, result, calls.get(id), toolOptions);
					const batch = { responseId: activeResponseId, result, input, afterOutputIndex: lastOutputIndex };
					submittedInjections.add(id);
					injections.push(batch);
					send({ type: "response.inject", response_id: activeResponseId, input });
				}
			}
			continueWithResults();
		},
	};
	return {
		control,
		get used(): boolean {
			return submissions.length > 0 || submittedInjections.size > 0;
		},
		get waiting(): boolean {
			return control.waitingForSuccessor;
		},
		get finished(): boolean {
			return terminal && !this.waiting && injections.length === 0;
		},
		takeInjectedInput(): { afterOutputIndex: number; items: BetaResponseInputItem[] } | undefined {
			const input = injectedInput;
			injectedInput = undefined;
			return input;
		},
		handle(event: ResponsesServerEvent | BetaResponsesServerEvent): (UserMessage | ToolResultMessage)[] | undefined {
			if ("output_index" in event) lastOutputIndex = Math.max(lastOutputIndex, event.output_index);
			if (
				event.type === "response.output_item.done" &&
				(event.item.type === "function_call" ||
					event.item.type === "custom_tool_call" ||
					(event.item.type === "tool_search_call" && event.item.execution === "client")) &&
				event.item.call_id
			)
				calls.set(event.item.call_id, event.item);
			if (event.type === "response.inject.created" || event.type === "response.inject.failed") {
				const index =
					event.type === "response.inject.failed"
						? injections.findIndex((batch) =>
								event.input.some(
									(item) => "call_id" in item && item.call_id === batch.result.toolCallId.split("|")[0],
								),
							)
						: 0;
				const batch = index < 0 ? undefined : injections.splice(index, 1)[0];
				if (!batch || batch.responseId !== event.response_id)
					throw new Error("Unexpected response.inject acknowledgement");
				if (event.type === "response.inject.created") {
					deliveredToolCallIds.add(batch.result.toolCallId);
					injectedInput = { afterOutputIndex: batch.afterOutputIndex, items: batch.input };
				} else if (event.error.code !== "response_already_completed") {
					throw new Error(`Response injection failed: ${event.error.code}: ${event.error.message}`);
				} else {
					// The returned input is canonical for the next request, after the completed response.
					injectedInput = { afterOutputIndex: Number.MAX_SAFE_INTEGER, items: event.input };
				}
				// Late rejection leaves the saved result undelivered for the ordinary next request.
				return;
			}
			if (event.type === "response.created") {
				const continuationInput: (UserMessage | ToolResultMessage)[] | undefined = terminal ? [] : undefined;
				if (continuationInput) {
					for (const submission of submissions) {
						if (
							submission.parentId === lastResponseId &&
							(submission.status === "accepted" || submission.status === "pending")
						) {
							continuationInput.push(submission.input);
							update(submission, "applied");
						}
					}
				}
				if (required && required.parentId === lastResponseId) continuationInput?.push(...(required.sent ?? []));
				activeResponseId = event.response.id;
				lastOutputIndex = -1;
				lastResponseId = activeResponseId;
				terminal = false;
				successorExpected = false;
				required = undefined;
				return continuationInput;
			} else if (event.type === "response.completed" || event.type === "response.incomplete") {
				terminal = true;
				activeResponseId = undefined;
				lastResponseId = event.response.id;
				successorExpected = event.response.incomplete_details?.reason === "steered";
			} else if (event.type === "response.steer.accepted") {
				const submission = submissions.find(
					(candidate) =>
						candidate.parentId === event.steer.previous_response_id &&
						candidate.status === "queued" &&
						!candidate.id,
				);
				if (submission) {
					submission.id = event.steer.id;
					update(submission, "accepted");
				}
			} else if (event.type === "response.steer.pending") {
				const submission = submissions.find((candidate) => candidate.id === event.steer.id);
				if (submission) update(submission, "pending");
				required = {
					parentId: event.steer.previous_response_id,
					inputs: event.required_input,
					sent: required?.parentId === event.steer.previous_response_id ? required.sent : undefined,
				};
				continueWithResults();
			} else if (event.type === "response.steer.failed") {
				const submission = submissions.find((candidate) =>
					event.steer.id
						? candidate.id === event.steer.id
						: candidate.parentId === event.steer.previous_response_id && candidate.status === "queued",
				);
				if (submission) update(submission, "failed", event.error.message);
				if (
					!submissions.some(
						(candidate) =>
							candidate.status === "accepted" || candidate.status === "queued" || candidate.status === "pending",
					)
				)
					successorExpected = false;
			}
		},
		close(): void {
			closed = true;
			for (const submission of submissions) {
				if (submission.status === "queued" || submission.status === "accepted" || submission.status === "pending")
					update(submission, "unknown", "Connection ended before steering application was observed");
			}
		},
	};
}
