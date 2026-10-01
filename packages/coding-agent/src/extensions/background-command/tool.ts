import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { resolvePath } from "../../utils/paths.ts";
import { getShellEnv } from "../../utils/shell.ts";
import {
	type BackgroundCommandJob,
	backgroundCommandFinished,
	backgroundCommandOutputTail,
	cancelBackgroundCommand,
	listBackgroundCommands,
	readBackgroundCommand,
	startBackgroundCommand,
	summarizeBackgroundCommand,
} from "./jobs.ts";

const schema = Type.Object({
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
export type BackgroundCommandInput = Static<typeof schema>;
type Details =
	| (BackgroundCommandJob & { cancelRequested?: boolean; outputTail: string; guidance?: string })
	| { jobs: ReturnType<typeof summarizeBackgroundCommand>[]; total: number; nextOffset: number | null };

export function createBackgroundCommandTool(
	pi: ExtensionAPI,
	storage: (ctx: ExtensionContext) => string,
): ToolDefinition<typeof schema, Details> {
	return {
		name: "background_command",
		label: "Background command",
		description:
			"Start a detached shell command, inspect status/output, or cancel it. Jobs and raw logs survive Pi exit/restart. Automatic completion reports status and logFile, with no output on success and up to 2KB/20 lines otherwise. Delivered after the foreground tool batch or when this session is idle or resumed. Explicit status includes up to 16KB/100 lines; read logFile for full output.",
		promptSnippet: "Run long commands without blocking; receive completion automatically, including after restart",
		promptGuidelines: [
			"Use background_command for long tests, builds, and watches such as gh pr checks --watch. Do not add & or poll repeatedly; read logFile for full output.",
			"Do independent work or end the turn while waiting. Completion resumes live sessions unless the user cancelled the agent.",
			"Print sessions may exit before a job finishes. Use bash if the same print invocation must wait for its result; otherwise resume the saved session later.",
		],
		parameters: schema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if ((params.offset ?? 0) < 0) throw new Error("offset must be >= 0");
			const root = storage(ctx);
			let details: Details;
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
					const request: { sessionManager: ExtensionContext["sessionManager"]; result?: unknown } = {
						sessionManager: ctx.sessionManager,
					};
					pi.events.emit("pi-change-working-dir:resolve-execution-cwd", request);
					let baseCwd = ctx.cwd;
					if (request.result !== undefined) {
						const invalid =
							"pi-change-working-dir returned an invalid execution directory. Update the extension and restart Pi.";
						const result = request.result;
						if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(invalid);
						if ("error" in result && result.error !== undefined) {
							throw new Error(
								typeof result.error === "string" && result.error.length > 0 ? result.error : invalid,
							);
						}
						if (
							!("cwd" in result) ||
							typeof result.cwd !== "string" ||
							!isAbsolute(result.cwd) ||
							result.cwd.includes("\0")
						)
							throw new Error(invalid);
						baseCwd = result.cwd;
					} else if (
						pi.getAllTools().some((tool) => tool.name === "change_dir" && isDirectoryOwner(tool.sourceInfo)) ||
						pi
							.getCommands()
							.some((command) => /^cwd(?::\d+)?$/.test(command.name) && isDirectoryOwner(command.sourceInfo))
					) {
						throw new Error(
							"Update pi-change-working-dir and restart Pi before starting background commands; the loaded owner cannot resolve its execution directory.",
						);
					}
					if (!params.command?.trim()) throw new Error("start requires command");
					const cwd = resolvePath(params.cwd ?? ".", baseCwd);
					if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
					const settings = pi.getSettings();
					const env = {
						...getShellEnv(),
						PI_SESSION_ID: ctx.sessionManager.getSessionId(),
						PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
						PI_PROVIDER: ctx.model?.provider,
						PI_MODEL: ctx.model?.id,
						PI_REASONING_LEVEL: ctx.thinkingLevel,
					};
					const command = settings.shellCommandPrefix
						? `${settings.shellCommandPrefix}\n${params.command}`
						: params.command;
					job = await startBackgroundCommand(
						root,
						params.command,
						{ command, cwd, env },
						{
							shellPath: settings.shellPath ? resolvePath(settings.shellPath) : undefined,
							timeout: params.timeout,
							signal,
						},
					);
				} else {
					if (!params.id) throw new Error(`${params.action} requires id`);
					job =
						params.action === "cancel"
							? await cancelBackgroundCommand(root, params.id, signal)
							: readBackgroundCommand(root, params.id);
				}
				details = {
					...job,
					outputTail: backgroundCommandOutputTail(job),
					...(params.action === "cancel" && !backgroundCommandFinished(job) ? { cancelRequested: true } : {}),
					...(params.action === "start" && (ctx.mode === "print" || ctx.mode === "json")
						? {
								guidance:
									"This is a one-shot print/JSON invocation. It will not wait automatically for this job after the agent ends. Report a still-running job as pending, with its ID and logFile; do not promise a later reply from this invocation. Do not rerun this command to wait for it. For future commands, use bash when this invocation must wait for a result. A saved session can be resumed later; an unsaved session has only its job files.",
							}
						: {}),
				};
			}
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
		},
		renderCall(args, theme) {
			const target = args.command ?? args.id?.slice(0, 8) ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`background ${args.action ?? ""}`)) +
					(target ? ` ${theme.fg("muted", target)}` : ""),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme, context) {
			const detail = result.details;
			if (expanded || !detail || context.isError)
				return new Text(
					result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
					0,
					0,
				);
			if (!("id" in detail))
				return new Text(
					detail.total === 0
						? context.args.activeOnly
							? "No active background jobs"
							: "No background jobs"
						: `${detail.jobs.length} shown · ${detail.total} total`,
					0,
					0,
				);
			const running = !backgroundCommandFinished(detail);
			const label = detail.cancelRequested
				? "Cancellation requested"
				: !running
					? `Job ${detail.status}${detail.exitCode != null ? ` · exit ${detail.exitCode}` : ""}`
					: context.args.action === "start"
						? "Started in background"
						: `Snapshot: ${detail.status}`;
			return new Text(
				theme.fg(
					detail.status === "succeeded" ? "success" : running || detail.status === "cancelled" ? "muted" : "error",
					`${label} · ${detail.id.slice(0, 8)}`,
				),
				0,
				0,
			);
		},
	};
}

function isDirectoryOwner(source: SourceInfo): boolean {
	if (
		/^(?:npm:pi-change-working-dir|git:github\.com\/fitchmultz\/pi-change-working-dir(?:\.git)?)(?:@.+)?$/.test(
			source.source,
		)
	)
		return true;
	return [source.baseDir, isAbsolute(source.path) ? dirname(source.path) : undefined].some((directory) => {
		if (!directory || !isAbsolute(directory)) return false;
		try {
			return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === "pi-change-working-dir";
		} catch {
			return false;
		}
	});
}
