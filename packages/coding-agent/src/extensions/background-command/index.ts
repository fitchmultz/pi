import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import lockfile from "proper-lockfile";
import type {
	BoundaryState,
	CustomMessageEntryDraft,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.ts";
import { type FileEntry, parseSessionEntries } from "../../core/session-manager.ts";
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
import {
	type BackgroundCommandJob,
	backgroundCommandDirectory,
	backgroundCommandFinished,
	backgroundCommandOutputTail,
	cancelBackgroundCommand,
	listBackgroundCommands,
	summarizeBackgroundCommand,
} from "./jobs.ts";
import { createBackgroundCommandTool } from "./tool.ts";

export const BACKGROUND_COMMAND_NOTICE = "background-command-complete";
const RUN_STATE = "background-command-run-state";
/** First line of every notice. The card's summary row says the same, so the preview leaves it out. */
const NOTICE_HEADING = "Background commands finished:\n";
/** Rows of a notice before it is expanded: the row count of collapsed bash output. */
const NOTICE_PREVIEW_LINES = 5;

interface BackgroundCommandNoticeDetails {
	jobIds: string[];
	/** Absent from notices recorded before compact rows. */
	jobs?: Pick<BackgroundCommandJob, "id" | "status">[];
}

/** Idle completion polling with the latest context a session event or tool call supplied; absent when stopped. */
interface Monitor {
	context: ExtensionContext;
	timer: NodeJS.Timeout;
}

export interface BackgroundCommandExtensionOptions {
	/**
	 * The host keeps a run open until `AgentSession.getBackgroundWork()` is empty, so a print or JSON
	 * run does not end before a job's completion. The tool then omits its one-shot guidance.
	 */
	hostWaits?: boolean;
}

export function createBackgroundCommandExtension(options: BackgroundCommandExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		let monitor: Monitor | undefined;
		let release: (() => void) | undefined;
		let recovery: Promise<void> | undefined;
		let recoveryController: AbortController | undefined;
		let root: string | undefined;
		let ownerKey: string | undefined;
		let wakeSuppressed = false;
		let saving = false;
		const seen = new Set<string>();
		const pending = new Set<string>();
		const acknowledged = new Set<string>();

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
			if (monitor) clearInterval(monitor.timer);
			monitor = undefined;
			recoveryController?.abort();
			recoveryController = undefined;
			recovery = undefined;
			release?.();
			release = undefined;
		}
		async function recoverReceipts(journal: string, signal: AbortSignal): Promise<void> {
			const input = createReadStream(journal, { encoding: "utf8", signal });
			const lines = createInterface({ input, crlfDelay: Infinity });
			try {
				// ponytail: One JSONL entry must fit in a string; larger entries need a streaming JSON parser.
				for await (const line of lines) {
					signal.throwIfAborted();
					receipts(parseSessionEntries(line));
				}
			} finally {
				lines.close();
				input.destroy();
			}
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
				acknowledged.clear();
			}
			if (monitor) monitor.context = ctx;
			else monitor = { context: ctx, timer: setInterval(() => inspect(), 1000).unref() };
			return root;
		}
		async function completion(ctx: ExtensionContext): Promise<CustomMessageEntryDraft | undefined> {
			if (!monitor || saving || !root || !existsSync(root) || ctx.hasPendingMessages()) return;
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
				recoveryController = new AbortController();
				recovery =
					journal && existsSync(journal) ? recoverReceipts(journal, recoveryController.signal) : Promise.resolve();
			}
			const controller = recoveryController;
			try {
				await recovery;
			} catch (error) {
				if (controller?.signal.aborted) return;
				stop();
				throw error;
			}
			if (!monitor || saving || controller?.signal.aborted || ctx.hasPendingMessages()) return;
			receipts(ctx.sessionManager.getEntries());
			const jobs = listBackgroundCommands(root, acknowledged);
			for (const job of jobs) {
				// Unknown outcomes can resolve later; only acknowledged final records are immutable.
				if (seen.has(job.id) && backgroundCommandFinished(job) && job.status !== "unknown")
					acknowledged.add(job.id);
			}
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
				details: {
					jobIds: completed.map((job) => job.id),
					jobs: completed.map(({ id, status }) => ({ id, status })),
				} satisfies BackgroundCommandNoticeDetails,
				content: `${NOTICE_HEADING}${completed
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
		async function inspect(): Promise<void> {
			if (!monitor || saving) return;
			const ctx = monitor.context;
			try {
				if (!ctx.isIdle()) return;
				const notice = await completion(ctx);
				if (notice) pi.sendMessage(notice, { deliverAs: "steer", triggerTurn: !wakeSuppressed && !!ctx.model });
			} catch (error) {
				stop();
				// Disposed extension contexts also reach here; cleanup must not keep a session alive.
				try {
					ctx.ui.notify(
						`Background command monitoring stopped: ${String(error)}. Job files remain in ${root}.`,
						"error",
					);
				} catch {
					/* Context already disposed. */
				}
			}
		}
		function suppressWake(): void {
			if (!wakeSuppressed) pi.appendEntry(RUN_STATE, true);
			wakeSuppressed = true;
		}
		async function boundary(event: BoundaryState, ctx: ExtensionContext) {
			const signal = ctx.signal;
			if (event.outcome === "aborted" || signal?.aborted) {
				suppressWake();
				return;
			}
			start(ctx);
			const notice = await completion(ctx);
			if (signal?.aborted) suppressWake();
			if (notice)
				return {
					entries: [...event.entries, notice],
					continue: event.continue || (!wakeSuppressed && !!ctx.model),
				};
		}
		pi.registerTool(createBackgroundCommandTool(pi, start, options));
		pi.registerMessageRenderer<BackgroundCommandNoticeDetails>(
			BACKGROUND_COMMAND_NOTICE,
			(message, options, theme) => {
				// Expanded, Pi draws its default card: the label and the whole notice.
				if (options.expanded) return;
				const jobs = message.details?.jobs;
				const count = jobs?.length ?? message.details?.jobIds.length ?? 0;
				const unsuccessful = new Map<BackgroundCommandJob["status"], number>();
				for (const { status } of jobs ?? []) {
					if (status !== "succeeded") unsuccessful.set(status, (unsuccessful.get(status) ?? 0) + 1);
				}
				const summary = [
					theme.fg("muted", `${count} background ${count === 1 ? "command" : "commands"} finished`),
					...[...unsuccessful].map(([status, n]) =>
						theme.fg(
							status === "failed" || status === "timed_out" ? "error" : "warning",
							`${n} ${status.replace("_", " ")}`,
						),
					),
				].join(theme.fg("muted", ", "));
				if (options.compactView) {
					const line = " ".repeat(options.outputPad) + summary;
					return { render: (width: number) => [truncateToWidth(line, width)], invalidate() {} };
				}
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n");
				const body = text.startsWith(NOTICE_HEADING) ? text.slice(NOTICE_HEADING.length) : text;
				const card = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line));
				card.addChild(new Text(summary, 0, 0));
				// A failed job's output is last in the notice and ends with its error, so the preview keeps
				// the end, like collapsed bash output.
				card.addChild(
					new VisualLinePreview({
						text: body
							.trimEnd()
							.split("\n")
							.map((line) => theme.fg("customMessageText", line))
							.join("\n"),
						maxVisualLines: NOTICE_PREVIEW_LINES,
						keep: "end",
						formatHint: (hidden) =>
							`${theme.fg("muted", `... (${hidden} earlier lines,`)} ${options.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					}),
				);
				return card;
			},
		);
		pi.on("session_start", (_event, ctx) => {
			start(ctx);
			const state = ctx.sessionManager
				.getEntries()
				.findLast((entry) => entry.type === "custom" && entry.customType === RUN_STATE);
			wakeSuppressed = state?.type === "custom" && state.data === true;
		});
		pi.on("before_agent_start", (event, ctx) => {
			start(ctx);
			// Only user input clears wake suppression; extension messages also start runs.
			if (event.messageType !== "user") return;
			if (wakeSuppressed) pi.appendEntry(RUN_STATE, false);
			wakeSuppressed = false;
		});
		pi.on("turn_end", boundary);
		pi.on("agent_before_settle", boundary);
		pi.on("agent_settled", () => pending.clear());
		pi.on("background_work", (_event, ctx) => {
			// A stopped monitor sends no notice, and another process that holds the lease sends them
			// to its own copy of the session. Without a lease of its own, the monitor takes a free one
			// on its next pass.
			if (!monitor || !root || (!release && lockfile.checkSync(root, { realpath: false }))) return;
			const directory = root;
			receipts(ctx.sessionManager.getEntries());
			return {
				work: listBackgroundCommands(directory, seen).map((job) => ({
					id: job.id,
					description: summarizeBackgroundCommand(job).commandPreview.replace(/\s+/g, " "),
					cancel: async () => {
						await cancelBackgroundCommand(directory, job.id);
					},
				})),
			};
		});
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
