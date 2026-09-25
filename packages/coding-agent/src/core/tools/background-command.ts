import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { resolvePath } from "../../utils/paths.ts";
import {
	type BackgroundCommandJob,
	type BackgroundCommandOwner,
	backgroundCommandDirectory,
	backgroundCommandFinished,
	backgroundCommandOutputTail,
	cancelBackgroundCommand,
	listBackgroundCommands,
	readBackgroundCommand,
	startBackgroundCommand,
	summarizeBackgroundCommand,
} from "../background-command.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, resolveSpawnContext } from "./bash.ts";
import { backgroundCommandRenderers } from "./renderers/background-command.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const backgroundCommandSchema = Type.Object({
	action: StringEnum(["start", "status", "cancel"] as const),
	command: Type.Optional(Type.String({ minLength: 1, description: "Shell command; required for start" })),
	cwd: Type.Optional(
		Type.String({ minLength: 1, description: "Absolute, ~, or relative to the current Bash working directory" }),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds; no default" })),
	id: Type.Optional(
		Type.String({
			pattern: "^[a-f0-9-]{36}$",
			description: "Job ID from this session; required for cancel. Omit to list jobs",
		}),
	),
	activeOnly: Type.Optional(
		Type.Boolean({ description: "Status lists only: show starting/running jobs; default false" }),
	),
	offset: Type.Optional(Type.Integer({ description: "List offset after filtering; up to 20 jobs, newest first" })),
});

export type BackgroundCommandToolInput = Static<typeof backgroundCommandSchema>;
export type BackgroundCommandToolDetails =
	| (BackgroundCommandJob & { cancelRequested?: boolean; outputTail: string; guidance?: string })
	| { jobs: ReturnType<typeof summarizeBackgroundCommand>[]; total: number; nextOffset: number | null };

export interface BackgroundCommandToolOptions
	extends Pick<BashToolOptions, "shellPath" | "commandPrefix" | "spawnHook" | "exposeSessionEnvironment"> {
	/** Required for standalone factories; AgentSession supplies its native owner. */
	sessionManager?: BackgroundCommandOwner;
	/** Artifact storage fallback for owners without a journal directory. */
	sessionDir?: string;
	/** Native print/JSON hosts exit at idle rather than waiting for external jobs. */
	isOneShot?: () => boolean;
	/** Called when a job is launched so its owning session can monitor completion. */
	onStart?: () => void;
}

export function createBackgroundCommandToolDefinition(
	cwd: string,
	options?: BackgroundCommandToolOptions,
): ToolDefinition<typeof backgroundCommandSchema, BackgroundCommandToolDetails> {
	return {
		name: "background_command",
		label: "Background command",
		description:
			"Start a detached shell command, inspect status/output, or cancel it. Jobs and raw logs survive Pi exit/restart. Completion with up to 16KB/100 lines of output is delivered after the foreground tool batch or when this session is idle or resumed.",
		promptSnippet: "Run long commands without blocking; receive completion automatically, including after restart",
		promptGuidelines: [
			"Use background_command for long tests, builds, and watches such as gh pr checks --watch. Do not add & or poll repeatedly; read logFile for full output.",
			"Do independent work or end the turn while waiting. Completion resumes live sessions unless the user cancelled the agent.",
			"Print sessions may exit before a job finishes. Use bash if the same print invocation must wait for its result; otherwise resume the saved session later.",
		],
		parameters: backgroundCommandSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_callId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const owner = options?.sessionManager ?? ctx?.sessionManager;
			if (!owner) throw new Error("background_command requires a sessionManager or native session context");
			const root = backgroundCommandDirectory(owner, options?.sessionDir);
			let details: BackgroundCommandToolDetails;
			if (params.action === "status" && !params.id) {
				const jobs = listBackgroundCommands(root).filter(
					(job) => !params.activeOnly || !backgroundCommandFinished(job),
				);
				const offset = params.offset ?? 0;
				details = {
					jobs: jobs.slice(offset, offset + 20).map(summarizeBackgroundCommand),
					total: jobs.length,
					nextOffset: offset + 20 < jobs.length ? offset + 20 : null,
				};
			} else {
				let job: BackgroundCommandJob;
				if (params.action === "start") {
					if (!params.command?.trim()) throw new Error("start requires command");
					const command = options?.commandPrefix ? `${options.commandPrefix}\n${params.command}` : params.command;
					const context = resolveSpawnContext(
						command,
						ctx?.cwd || cwd,
						options?.spawnHook,
						options?.exposeSessionEnvironment ?? true,
						ctx,
					);
					context.cwd = resolvePath(params.cwd ?? ".", context.cwd);
					if (!statSync(context.cwd).isDirectory()) throw new Error(`Not a directory: ${context.cwd}`);
					job = await startBackgroundCommand(root, params.command, context, {
						shellPath: options?.shellPath,
						timeout: params.timeout,
						signal,
					});
					options?.onStart?.();
				} else {
					if (!params.id) throw new Error(`${params.action} requires id`);
					job =
						params.action === "cancel"
							? await cancelBackgroundCommand(root, params.id, signal)
							: readBackgroundCommand(root, params.id);
				}
				details = {
					...job,
					...(params.action === "cancel" && !backgroundCommandFinished(job) ? { cancelRequested: true } : {}),
					outputTail: backgroundCommandOutputTail(job),
					...(params.action === "start" && options?.isOneShot?.()
						? {
								guidance:
									"This is a one-shot print/JSON invocation. It will not wait automatically for this job after the agent ends. Report a still-running job as pending, with its ID and logFile; do not promise a later reply from this invocation. Do not rerun this command to wait for it. For future commands, use bash when this invocation must wait for a result. A saved session can be resumed later; an unsaved session has only its job files.",
							}
						: {}),
				};
			}
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
		},
		...backgroundCommandRenderers,
	};
}

export function createBackgroundCommandTool(
	cwd: string,
	options?: BackgroundCommandToolOptions,
): AgentTool<typeof backgroundCommandSchema> {
	const definition = createBackgroundCommandToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, { promptSnippet: definition.promptSnippet, promptGuidelines: definition.promptGuidelines });
	return tool;
}
