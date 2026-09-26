import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseSteerRequiredInput,
	ResponsesClientEvent,
	ResponsesServerEvent,
} from "openai/resources/responses/responses.js";
import type {
	AssistantMessageEvent,
	Model,
	ResponseControl,
	SteeringStatus,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { convertResponsesToolSearchOutput, convertToolResultOutput } from "./openai-responses-shared.ts";

/** One native WebSocket request and its successors; the agent still owns every tool execution. */
export function createResponsesControl(
	model: Model<"openai-responses" | "openai-codex-responses">,
	params: Omit<ResponseCreateParamsStreaming, "stream"> & { stream?: boolean },
	send: (event: ResponsesClientEvent) => void,
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
	const submissions: Submission[] = [];
	const results = new Map<string, ToolResultMessage>();
	const continuations = new Set<string>();
	const deliveredToolCallIds = new Set<string>();
	let activeResponseId: string | undefined;
	let lastResponseId: string | undefined;
	let terminal = false;
	let successorExpected = false;
	let required: { parentId: string; inputs: ResponseSteerRequiredInput[]; sent?: ToolResultMessage[] } | undefined;
	let closed = false;
	let retired = false;
	let modelContent: ((result: ToolResultMessage) => ToolResultMessage["content"] | undefined) | undefined;

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
			const saved = results.get(stub.call_id);
			if (!saved) return;
			submitted.push(structuredClone(saved));
			const result = { ...saved, content: modelContent?.(saved) ?? saved.content };
			if (stub.type === "tool_search_output") {
				if (result.toolCallKind !== "toolSearch")
					throw new Error(`Steering tool search result has no native search identity: ${stub.call_id}`);
				input.push(
					...convertResponsesToolSearchOutput(model, result, {
						strict: model.api === "openai-codex-responses" ? null : undefined,
						supportsStrictMode: model.compat?.supportsStrictMode ?? model.api === "openai-codex-responses",
						supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools,
						supportsAsyncTools: model.compat?.supportsAsyncTools,
					}),
				);
			} else {
				input.push({
					type: stub.type,
					call_id: stub.call_id,
					output: convertToolResultOutput(model, result.content),
				});
			}
		}
		continuations.add(required.parentId);
		send({ ...continuationParams, type: "response.create", previous_response_id: required.parentId, input });
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
		submitToolResults(saved, content) {
			modelContent = content;
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
			continueWithResults();
		},
	};
	return {
		control,
		get used(): boolean {
			return submissions.length > 0;
		},
		get waiting(): boolean {
			return control.waitingForSuccessor;
		},
		get finished(): boolean {
			return terminal && !this.waiting;
		},
		handle(event: ResponsesServerEvent): (UserMessage | ToolResultMessage)[] | undefined {
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
