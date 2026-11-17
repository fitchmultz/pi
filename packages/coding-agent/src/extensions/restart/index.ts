import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import chalk from "chalk";
import { getRestartRuntimeWorker } from "../../cli/launcher.ts";
import {
	MANAGED_CLI_ENV,
	MANAGED_PROTOCOL_ENV,
	MANAGED_PROTOCOL_VERSION,
	MAX_RESTART_BYTES,
	parseRestartHandoff,
	parseRestartRequest,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartLauncherMessage,
	type RestartRequest,
	type RestartSession,
	type RestartWorkerMessage,
} from "../../cli/restart-protocol.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext, ManagedHost, ShutdownDisposition } from "../../core/extensions/types.ts";
import type { StaleSource } from "../../core/loaded-sources.ts";
import { getGitUpdateMarkerPath } from "../../core/package-manager.ts";
import { writeWorkingSession } from "../../core/working-session.ts";

const guidance =
	'Use /reload to apply changed extension source and resources. For core/runtime or clean-process changes, use bash: pi restart --message "what to continue after restarting". Keep the working runtime and extension files intact; activate staged paths for rollback. Run pi restart --help for options. Restart waits for final idle and does not replay completed commands.';

/**
 * How long a session waits between comparing its loaded extension code with the disk. Each comparison
 * starts one `git` process per loaded git package; with 26 installed packages it took 0.1 s of CPU when
 * measured. Once a minute, that is about 0.17% of one core for each open session, and an idle session
 * notices a change within a minute. A session that is used also checks after every agent run.
 */
const STALE_CHECK_INTERVAL_MS = 60_000;

/**
 * How long loaded code must have been stale, with nothing changing further, before a session restarts
 * itself for it (`restartWhenStale`), and how long it waits to look again while something postpones the
 * restart. A package update moves the commit first and installs dependencies after. `pi update` marks
 * that span and the marker postpones the restart; a `git pull` and an install by hand have only this wait.
 * Measured on the installed packages: an install of their dependencies took 0.2 to 4.0 s, and the commits
 * that one update run moved were at most 14 s apart (943 moves in 116 days of reflogs).
 */
const STALE_QUIET_MS = 30_000;

export interface RestartInputState {
	busy: boolean;
	pendingInput: boolean;
}

/** Whether a session can hand over to a replacement worker now. */
type Readiness = { kind: "ready"; sessionFile: string } | { kind: "wait" } | { kind: "refuse"; reason: string };

type WorkerPhase =
	| { kind: "starting"; inherited: boolean }
	| { kind: "accepted" }
	| { kind: "committed"; request: RestartRequest; session: Omit<RestartSession, "workingSession"> };

export interface ManagedRestart {
	/** Present only under a launcher that acknowledges readiness. */
	readonly host: ManagedHost | undefined;
	bindInput(check: () => RestartInputState): void;
	/** Supplies the session whose loaded extension code is compared with the disk; it changes on `/new`, `/resume` and `/fork`. */
	bindSession(current: () => AgentSession): void;
	ready(): Promise<void>;
	start(): void;
	interrupt(reason?: string): void;
	/** An unready replacement declares a user or extension exit here, before drain and shutdown hooks can outlast its deadline. */
	beginShutdown(source: "user" | "extension" | "signal"): boolean;
	/**
	 * Derived when the quit event is built, so a signal or cancel after commit releases instead.
	 * Undefined without {@link host}: older launchers neither acknowledge readiness nor honor exit intent.
	 */
	disposition(): ShutdownDisposition | undefined;
	completeShutdown(): Promise<void>;
	captureFinal(session: AgentSession): Promise<boolean>;
}

let install: ((pi: ExtensionAPI) => void) | undefined;

/** Unix socket limits include the directory; Termux's short temp root is under its prefix. */
export function getRestartSocketFallback(
	directory: string,
	platform = process.platform,
	execPath = process.execPath,
): string | undefined {
	const maxBytes = platform === "linux" || platform === "android" ? 107 : 103;
	if (platform === "win32" || Buffer.byteLength(join(directory, "s")) <= maxBytes) return undefined;
	if (platform === "android") {
		const prefix = process.env.PREFIX || posix.resolve(posix.dirname(execPath), "..");
		return posix.join(prefix, "tmp");
	}
	return "/tmp";
}

/** Builtin factory; SDK, non-interactive modes and standalone binaries never initialize control. */
export default function restartExtension(pi: ExtensionAPI): void {
	install?.(pi);
}

function send(message: RestartWorkerMessage): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send || !process.connected) return reject(new Error("Pi restart launcher disconnected"));
		process.send(message, (error) => (error ? reject(error) : resolve()));
	});
}

/** Called only by the managed Node CLI, not by SDK hosts. */
export function createManagedRestart(): ManagedRestart | undefined {
	const encoded = process.env[RESTART_HANDOFF_ENV];
	delete process.env[RESTART_HANDOFF_ENV];
	delete process.env[RESTART_SOCKET_ENV];
	const managed = process.env[MANAGED_CLI_ENV] === "1";
	const acknowledged = process.env[MANAGED_PROTOCOL_ENV] === MANAGED_PROTOCOL_VERSION;
	delete process.env[MANAGED_CLI_ENV];
	delete process.env[MANAGED_PROTOCOL_ENV];
	if (!managed || !process.send || !process.connected) return undefined;
	let handoff: RestartHandoff | undefined;
	try {
		handoff = encoded ? parseRestartHandoff(encoded) : undefined;
	} catch (error) {
		// Startup error, not a crash: print the relaunch instruction without a stack trace.
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exit(1);
	}
	let phase: WorkerPhase = { kind: "starting", inherited: handoff !== undefined };
	let shutdownSource: "user" | "extension" | "signal" | undefined;
	let exitNotice: Promise<void> | undefined;
	let settleReady: (accepted: boolean) => void = () => {};
	let host: ManagedHost | undefined;
	if (acknowledged) {
		// Only the IPC parent that advertised the protocol owns this worker; capture it while connected.
		const ready = new Promise<boolean>((resolve) => {
			settleReady = (accepted) => {
				settleReady = () => {};
				resolve(accepted);
			};
		});
		host = Object.freeze({ owner: Object.freeze({ pid: process.ppid }), ready });
		process.on("message", (value: RestartLauncherMessage) => {
			if (value?.type !== "pi:accepted" || phase.kind !== "starting") return;
			phase = { kind: "accepted" };
			settleReady(!closing);
		});
	}
	process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
	process.channel?.unref();
	let input = (): RestartInputState => ({ busy: true, pendingInput: false });
	let session: (() => AgentSession) | undefined;
	let ctx: ExtensionContext | undefined;
	let api: ExtensionAPI | undefined;
	let started = false;
	let closing = false;
	let pending: RestartRequest | undefined;
	let workingSession: string | undefined;
	let timer: NodeJS.Timeout | undefined;
	let staleTimer: NodeJS.Timeout | undefined;
	/** The stale code on disk as last seen, and since when it has been the same. */
	let staleSince: { key: string; at: number } | undefined;
	let server: Server | undefined;
	let directory: string | undefined;
	let socketPath: string | undefined;
	let startupWarning: (() => void) | undefined;
	let artifactDirectory: string | undefined;
	const sockets = new Set<Socket>();

	const cancel = (reason?: string) => {
		const requested = pending !== undefined || phase.kind === "committed";
		pending = undefined;
		if (phase.kind === "committed") phase = { kind: "accepted" };
		workingSession = undefined;
		clearTimeout(timer);
		if (artifactDirectory) rmSync(artifactDirectory, { recursive: true, force: true });
		artifactDirectory = undefined;
		if (requested && reason && ctx) ctx.ui.notify(`Restart cancelled: ${reason}`, "warning");
	};
	const cleanup = () => {
		startupWarning = undefined;
		clearTimeout(timer);
		clearTimeout(staleTimer);
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		server?.close();
		server = undefined;
		if (process.env[RESTART_SOCKET_ENV] === socketPath) delete process.env[RESTART_SOCKET_ENV];
		if (directory) rmSync(directory, { recursive: true, force: true });
		ctx = undefined;
	};
	const readiness = (context: ExtensionContext): Readiness => {
		const state = input();
		if (state.pendingInput || context.ui.getEditorText().length > 0)
			return { kind: "refuse", reason: "handle unsent editor text or pending input first." };
		if (!started || !context.isIdle() || context.hasPendingMessages() || state.busy) return { kind: "wait" };
		const sessionFile = context.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) return { kind: "refuse", reason: "the session is not saved." };
		return { kind: "ready", sessionFile };
	};
	const commit = (context: ExtensionContext, request: RestartRequest, sessionFile: string, notice: string) => {
		phase = {
			kind: "committed",
			request,
			session: { sessionFile, sessionId: context.sessionManager.getSessionId() },
		};
		context.ui.notify(notice, "info");
		context.shutdown();
	};
	const attempt = () => {
		if (!pending || !ctx || closing) return;
		const ready = readiness(ctx);
		if (ready.kind === "refuse") {
			cancel(ready.reason);
			return;
		}
		if (ready.kind === "wait") {
			timer = setTimeout(attempt, 100);
			return;
		}
		const request = pending;
		pending = undefined;
		commit(ctx, request, ready.sessionFile, "Restarting Pi; resuming the same saved session.");
	};
	/**
	 * Restart for `stale` code when it has been quiet on disk and nothing of the user's or the agent's
	 * would be lost. Otherwise do nothing and say nothing; the next look decides again.
	 * Returns how long to wait before that look.
	 */
	const restartWhenQuiet = async (
		context: ExtensionContext,
		current: AgentSession,
		stale: StaleSource[],
	): Promise<number> => {
		const key = JSON.stringify(stale.map((source) => [source.path, source.current]));
		if (staleSince?.key !== key) staleSince = { key, at: Date.now() };
		const quietFor = Date.now() - staleSince.at;
		if (quietFor < STALE_QUIET_MS) return STALE_QUIET_MS - quietFor;
		// `pi update` moved a package's commit and has not finished its files and dependencies.
		if (stale.some(({ kind, path }) => kind === "package" && existsSync(getGitUpdateMarkerPath(path))))
			return STALE_QUIET_MS;
		// A restart aborts background tool runs, and the idle test does not see them.
		if ((await current.getBackgroundWork()).length > 0) return STALE_QUIET_MS;
		if (ctx !== context || closing || pending || phase.kind === "committed") return STALE_QUIET_MS;
		const ready = readiness(context);
		if (ready.kind === "ready")
			commit(context, {}, ready.sessionFile, "Extensions changed on disk; restarting Pi on the same saved session.");
		return STALE_QUIET_MS;
	};
	/**
	 * Show in the footer whether loaded extension code has changed on disk, restart for it when the
	 * user's `restartWhenStale` setting asks for that, and look again later.
	 */
	const checkStale = async () => {
		const context = ctx;
		if (!context || !session) return;
		const current = session();
		const stale = await current.getStaleSources();
		// The session was replaced or shut down meanwhile; its successor runs its own check.
		if (ctx !== context) return;
		context.ui.setStatus(
			"restart",
			stale.length > 0 ? context.ui.theme.fg("warning", "extensions changed on disk: /restart") : undefined,
		);
		if (stale.length === 0) staleSince = undefined;
		const wait =
			stale.length > 0 && current.settingsManager.getRestartWhenStale()
				? await restartWhenQuiet(context, current, stale)
				: STALE_CHECK_INTERVAL_MS;
		if (ctx !== context) return;
		clearTimeout(staleTimer);
		staleTimer = setTimeout(checkStale, wait);
		// The check must not keep a process alive that is otherwise done.
		staleTimer.unref();
	};
	const queue = (value: unknown): string => {
		const request = parseRestartRequest(value);
		if (!ctx || closing) throw new Error("Restart control is unavailable in this session");
		if (pending || phase.kind === "committed") throw new Error("A restart is already queued");
		if (request.sessionId && request.sessionId !== ctx.sessionManager.getSessionId())
			throw new Error("Restart request belongs to a different session");
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile))
			throw new Error("Restart requires a saved session; ephemeral sessions cannot restart");
		if (input().pendingInput || ctx.ui.getEditorText().length > 0)
			throw new Error("Handle unsent editor text or pending input before restarting");
		if (request.runtime) getRestartRuntimeWorker(request.runtime);
		for (const path of request.extensions ?? []) {
			if (!path.startsWith("builtin:") && !existsSync(path))
				throw new Error(`Restart extension does not exist: ${path}`);
		}
		pending = request;
		// Let the requesting shell return its result before testing final idle.
		timer = setTimeout(attempt, 100);
		return "Restart queued. Pi will wait for final idle, then resume the same session.";
	};

	install = (pi) => {
		pi.on("session_start", async (_event, context) => {
			if (context.mode !== "tui") return;
			cancel();
			cleanup();
			ctx = context;
			api = pi;
			try {
				directory = mkdtempSync(join(tmpdir(), "pi-restart-"));
				const shortTmp = getRestartSocketFallback(directory);
				if (shortTmp) {
					rmSync(directory, { recursive: true, force: true });
					directory = mkdtempSync(join(shortTmp, "pi-restart-"));
				}
				socketPath =
					process.platform === "win32" ? `\\\\.\\pipe\\pi-restart-${randomUUID()}` : join(directory, "s");
				server = createServer((socket) => {
					sockets.add(socket);
					socket.on("close", () => sockets.delete(socket));
					socket.on("error", () => {});
					socket.setTimeout(5000, () => socket.destroy());
					socket.setEncoding("utf8");
					let text = "";
					let handled = false;
					socket.on("data", (chunk: string) => {
						if (handled) return;
						text += chunk;
						if (!text.includes("\n") && Buffer.byteLength(text) <= MAX_RESTART_BYTES) return;
						handled = true;
						try {
							if (Buffer.byteLength(text) > MAX_RESTART_BYTES) throw new Error("Restart request is too large");
							socket.end(
								`${JSON.stringify({ ok: true, message: queue(JSON.parse(text.slice(0, text.indexOf("\n")))) })}\n`,
							);
						} catch (error) {
							socket.end(
								`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`,
							);
						}
					});
				});
				await new Promise<void>((resolve, reject) => {
					server!.once("error", reject);
					server!.listen(socketPath, resolve);
				});
				process.env[RESTART_SOCKET_ENV] = socketPath;
			} catch (error) {
				cleanup();
				if (handoff) throw error;
				const warn = () =>
					context.ui.notify(
						`Restart control is unavailable: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				if (started) warn();
				else startupWarning = warn;
			}
			// A new session's footer starts without statuses, also when this process already ran stale code.
			void checkStale();
		});
		pi.on("agent_settled", () => {
			void checkStale();
		});
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant" && event.message.stopReason === "aborted")
				cancel("the agent run was interrupted.");
		});
		pi.on("session_compact_failed", (event) => {
			if (event.aborted) cancel("compaction was interrupted.");
		});
		pi.on("before_agent_start", (event) => {
			if (!ctx) return;
			// A recorded prompt section: a copy of this session that runs without managed control,
			// such as a forked child session, starts from the same leading system message and gets
			// the section's removal as a later one.
			event.systemPromptOptions.sections.restart = guidance;
			if (event.systemPromptOptions.forceSystemPrompt !== undefined)
				event.systemPromptOptions.forceSystemPrompt += `\n\n${guidance}`;
		});
		// Before the guidance was a recorded section, every request carried it in the leading
		// system message without recording it. A window recorded then still has no `restart` in
		// that message; keep sending the same text there so its cached prefix and thinking blocks
		// stay valid. The window's next compaction records the section and ends this.
		pi.on("context_with_system", (event) => {
			if (!ctx) return;
			const first = event.messages[0];
			if (first?.role !== "system" || first.sections?.restart !== undefined) return;
			return {
				messages: [
					{ ...first, sections: { ...first.sections, restart: `<restart>\n${guidance}\n</restart>` } },
					...event.messages.slice(1),
				],
			};
		});
		pi.registerCommand("restart", {
			description: "Restart Pi on the same saved session; optional text continues afterward",
			handler: async (message, context) => {
				try {
					context.ui.notify(queue(message.trim() ? { message } : {}), "info");
				} catch (error) {
					context.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
		pi.on("session_shutdown", (event) => {
			if (event.reason !== "quit") cancel();
			pending = undefined;
			cleanup();
		});
	};
	return {
		host,
		bindInput(check) {
			input = check;
		},
		bindSession(current) {
			session = current;
		},
		async ready() {
			if (handoff && !ctx) throw new Error("Managed restart extension did not initialize");
			if (handoff && ctx?.sessionManager.getSessionId() !== handoff.sessionId)
				throw new Error("Restart session identity mismatch");
			await send({ type: "pi:ready" });
			if (!host) {
				phase = { kind: "accepted" };
				return;
			}
			// The send callback only proves the bytes left; the launcher may already be timing out.
			// Without acceptance this worker is shutting down, so never start its continuation.
			if (!(await host.ready)) await new Promise<never>(() => {});
		},
		start() {
			if (started) return;
			started = true;
			startupWarning?.();
			startupWarning = undefined;
			if (handoff?.failure) ctx?.ui.notify(handoff.failure, "warning");
			if (handoff?.message) {
				api?.sendUserMessage(
					`[Restart continuation]\n${handoff.failure ? `${handoff.failure}\n\n` : ""}${handoff.message}`,
					{ expandPromptTemplates: false },
				);
			}
		},
		interrupt(reason = "the run was interrupted.") {
			cancel(reason);
		},
		beginShutdown(source) {
			if (source !== "extension") cancel();
			closing = true;
			shutdownSource ??= source;
			settleReady(false);
			// A disconnected launcher cannot roll back, so the exit stands without the notice.
			if (host && !exitNotice && phase.kind === "starting" && phase.inherited && shutdownSource !== "signal")
				exitNotice = send({ type: "pi:exit" }).catch(() => {});
			return phase.kind === "committed";
		},
		disposition() {
			if (!host) return undefined;
			if (phase.kind === "committed") return "handoff";
			if (phase.kind === "starting" && phase.inherited && shutdownSource === "signal") return "provisional";
			return "release";
		},
		async completeShutdown() {
			if (phase.kind !== "committed") {
				await exitNotice;
				return;
			}
			try {
				if (!workingSession) throw new Error("Managed restart has no complete native working-session state");
				await send({
					type: "pi:restart",
					request: phase.request,
					session: { ...phase.session, workingSession },
				});
				artifactDirectory = undefined;
			} catch (error) {
				cancel();
				throw error;
			}
		},
		async captureFinal(session) {
			if (phase.kind !== "committed") return false;
			if (!session.workingSessionReady || !session.isIdle || session.isSettling || session.workingSessionGate.busy)
				throw new Error("Managed restart still has admitted work");
			const hold = await session.acquireWorkingSession();
			try {
				// Detached jobs survive worker replacement. Sleep readiness belongs to whole-compute exit.
				artifactDirectory = realpathSync(mkdtempSync(join(tmpdir(), "pi-restart-state-")));
				const path = join(artifactDirectory, "working-session.json");
				writeWorkingSession(path, hold.state);
				hold.assertHeld();
				workingSession = path;
				return true;
			} catch (error) {
				cancel();
				throw error;
			} finally {
				await hold.release();
			}
		},
	};
}
