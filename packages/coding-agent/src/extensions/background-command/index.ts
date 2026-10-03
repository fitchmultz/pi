import { existsSync, readFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import type {
	BoundaryState,
	CustomMessageEntryDraft,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.ts";
import { type FileEntry, parseSessionEntries } from "../../core/session-manager.ts";
import {
	backgroundCommandDirectory,
	backgroundCommandFinished,
	backgroundCommandOutputTail,
	listBackgroundCommands,
	summarizeBackgroundCommand,
} from "./jobs.ts";
import { createBackgroundCommandTool } from "./tool.ts";

export const BACKGROUND_COMMAND_NOTICE = "background-command-complete";
const RUN_STATE = "background-command-run-state";

export function createBackgroundCommandExtension(): ExtensionFactory {
	return (pi) => {
		let timer: NodeJS.Timeout | undefined;
		let context: ExtensionContext | undefined;
		let release: (() => void) | undefined;
		let root: string | undefined;
		let ownerKey: string | undefined;
		let wakeSuppressed = false;
		let stopped = false;
		let saving = false;
		const seen = new Set<string>();
		const pending = new Set<string>();

		function receipts(entries: readonly FileEntry[]): void {
			for (const entry of entries) {
				if (entry.type === "custom_message" && entry.customType === BACKGROUND_COMMAND_NOTICE) {
					const details = entry.details as { jobIds?: string[] } | undefined;
					for (const id of details?.jobIds ?? []) {
						seen.add(id);
						pending.delete(id);
					}
				}
				if (
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "background_command" &&
					!entry.message.isError
				) {
					const details = entry.message.details as
						| { id?: string; status?: string; jobs?: { id: string; status: string }[] }
						| undefined;
					for (const job of details?.jobs ??
						(details?.id && details.status ? [{ id: details.id, status: details.status }] : [])) {
						if (job.status !== "starting" && job.status !== "running") seen.add(job.id);
					}
				}
			}
		}
		function stop(): void {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = undefined;
			release?.();
			release = undefined;
		}
		function start(ctx: ExtensionContext): string {
			const owner = ctx.sessionManager;
			const key = `${owner.getSessionDir()}\0${owner.getSessionId()}`;
			if (ownerKey !== key || !root) {
				stop();
				ownerKey = key;
				root = backgroundCommandDirectory(owner);
				seen.clear();
				pending.clear();
			}
			stopped = false;
			context = ctx;
			if (!timer) timer = setInterval(() => inspect(), 1000).unref();
			return root;
		}
		function completion(ctx: ExtensionContext): CustomMessageEntryDraft | undefined {
			if (stopped || !root || !existsSync(root) || ctx.hasPendingMessages()) return;
			if (!release) {
				try {
					// One live session process owns delivery. After a crash the lease expires;
					// the replacement reads durable notices before sending anything.
					release = lockfile.lockSync(root, {
						realpath: false,
						onCompromised: () => {
							release = undefined;
							stop();
						},
					});
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ELOCKED") return;
					throw error;
				}
				const journal = ctx.sessionManager.getSessionFile();
				if (journal && existsSync(journal)) receipts(parseSessionEntries(readFileSync(journal, "utf8")));
			}
			receipts(ctx.sessionManager.getEntries());
			const jobs = listBackgroundCommands(root);
			const running = jobs.filter((job) => !backgroundCommandFinished(job)).length;
			ctx.ui.setStatus("background-command", running ? `background: ${running} running` : undefined);
			const completed = jobs
				.filter((job) => backgroundCommandFinished(job) && !seen.has(job.id) && !pending.has(job.id))
				.slice(0, 20);
			if (!completed.length) return;
			for (const job of completed) pending.add(job.id);
			return {
				type: "custom_message",
				customType: BACKGROUND_COMMAND_NOTICE,
				display: true,
				details: { jobIds: completed.map((job) => job.id) },
				content: `Background commands finished:\n${completed
					.map((job) => {
						const { id, status, exitCode, commandPreview, logFile, error } = summarizeBackgroundCommand(job);
						const summary = JSON.stringify({ id, status, exitCode, commandPreview, logFile, error });
						return status === "succeeded"
							? summary
							: `${summary}\nOutput tail:\n${backgroundCommandOutputTail(job, { maxLines: 20, maxBytes: 2048 })}`;
					})
					.join("\n\n")}`,
			};
		}
		function inspect(): void {
			if (!context || saving) return;
			try {
				if (!context.isIdle()) return;
				const notice = completion(context);
				if (notice) pi.sendMessage(notice, { deliverAs: "steer", triggerTurn: !wakeSuppressed && !!context.model });
			} catch (error) {
				stop();
				// Disposed extension contexts also reach here; cleanup must not keep a session alive.
				try {
					context.ui.notify(
						`Background command monitoring stopped: ${String(error)}. Job files remain in ${root}.`,
						"error",
					);
				} catch {
					/* Context already disposed. */
				}
			}
		}
		function boundary(event: BoundaryState, ctx: ExtensionContext) {
			if (event.outcome === "aborted") {
				if (!wakeSuppressed) pi.appendEntry(RUN_STATE, true);
				wakeSuppressed = true;
				return;
			}
			start(ctx);
			const notice = completion(ctx);
			if (notice)
				return {
					entries: [...event.entries, notice],
					continue: event.continue || (!wakeSuppressed && !!ctx.model),
				};
		}
		pi.registerTool(createBackgroundCommandTool(pi, start));
		pi.on("session_start", (_event, ctx) => {
			start(ctx);
			const state = ctx.sessionManager
				.getEntries()
				.findLast((entry) => entry.type === "custom" && entry.customType === RUN_STATE);
			wakeSuppressed = state?.type === "custom" && state.data === true;
		});
		pi.on("before_agent_start", (_event, ctx) => {
			start(ctx);
			if (wakeSuppressed) pi.appendEntry(RUN_STATE, false);
			wakeSuppressed = false;
		});
		pi.on("turn_end", boundary);
		pi.on("agent_before_settle", boundary);
		pi.on("agent_settled", () => pending.clear());
		pi.on("working_session_save", (event) => {
			saving = true;
			event.signal.addEventListener(
				"abort",
				() => {
					saving = false;
				},
				{ once: true },
			);
			const jobs = root ? listBackgroundCommands(root) : [];
			return {
				blockers: jobs
					.filter((job) => !backgroundCommandFinished(job))
					.map((job) => `Background command ${job.id} is ${job.status}`),
			};
		});
		pi.on("session_shutdown", stop);
	};
}

export default createBackgroundCommandExtension();
