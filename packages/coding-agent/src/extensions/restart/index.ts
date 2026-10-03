import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { SystemMessage } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { getRestartRuntimeWorker } from "../../cli/launcher.ts";
import {
	MANAGED_CLI_ENV,
	MAX_RESTART_BYTES,
	parseRestartHandoff,
	parseRestartRequest,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartRequest,
	type RestartWorkerMessage,
} from "../../cli/restart-protocol.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { writeWorkingSession } from "../../core/working-session.ts";

const guidance =
	'Use /reload to apply changed extension source and resources. For core/runtime or clean-process changes, use bash: pi restart --message "what to continue after restarting". Keep the working runtime and extension files intact; activate staged paths for rollback. Run pi restart --help for options. Restart waits for final idle and does not replay completed commands.';

export interface RestartInputState {
	busy: boolean;
	pendingInput: boolean;
}

export interface ManagedRestart {
	bindInput(check: () => RestartInputState): void;
	ready(): Promise<void>;
	start(): void;
	interrupt(reason?: string): void;
	beginShutdown(source: "user" | "extension" | "signal"): boolean;
	completeShutdown(): Promise<void>;
	captureFinal(session: AgentSession): Promise<boolean>;
}

let install: ((pi: ExtensionAPI) => void) | undefined;

/** Unix socket limits include the directory; Android's writable short temp root is next to its runtime. */
export function getRestartSocketFallback(
	directory: string,
	platform = process.platform,
	execPath = process.execPath,
): string | undefined {
	const maxBytes = platform === "linux" || platform === "android" ? 107 : 103;
	if (platform === "win32" || Buffer.byteLength(join(directory, "s")) <= maxBytes) return undefined;
	return platform === "android" ? posix.resolve(posix.dirname(execPath), "../tmp") : "/tmp";
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
	delete process.env[MANAGED_CLI_ENV];
	if (!managed || !process.send || !process.connected) return undefined;
	let handoff: RestartHandoff | undefined;
	try {
		handoff = encoded ? parseRestartHandoff(encoded) : undefined;
	} catch (error) {
		// Startup error, not a crash: print the relaunch instruction without a stack trace.
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exit(1);
	}
	process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
	process.channel?.unref();
	let input = (): RestartInputState => ({ busy: true, pendingInput: false });
	let ctx: ExtensionContext | undefined;
	let api: ExtensionAPI | undefined;
	let started = false;
	let closing = false;
	let pending: RestartRequest | undefined;
	let committed: Extract<RestartWorkerMessage, { type: "pi:restart" }> | undefined;
	let timer: NodeJS.Timeout | undefined;
	let server: Server | undefined;
	let directory: string | undefined;
	let socketPath: string | undefined;
	let startupWarning: (() => void) | undefined;
	const sockets = new Set<Socket>();

	const cancel = (reason?: string) => {
		const requested = pending !== undefined || committed !== undefined;
		pending = undefined;
		committed = undefined;
		clearTimeout(timer);
		if (requested && reason && ctx) ctx.ui.notify(`Restart cancelled: ${reason}`, "warning");
	};
	const cleanup = () => {
		startupWarning = undefined;
		clearTimeout(timer);
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		server?.close();
		server = undefined;
		if (process.env[RESTART_SOCKET_ENV] === socketPath) delete process.env[RESTART_SOCKET_ENV];
		if (directory) rmSync(directory, { recursive: true, force: true });
		ctx = undefined;
	};
	const attempt = () => {
		if (!pending || !ctx || closing) return;
		const state = input();
		if (state.pendingInput || ctx.ui.getEditorText().length > 0) {
			cancel("handle unsent editor text or pending input first.");
			return;
		}
		if (!started || !ctx.isIdle() || ctx.hasPendingMessages() || state.busy) {
			timer = setTimeout(attempt, 100);
			return;
		}
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) {
			cancel("the session is not saved.");
			return;
		}
		committed = {
			type: "pi:restart",
			request: pending,
			session: { sessionFile, sessionId: ctx.sessionManager.getSessionId() },
		};
		pending = undefined;
		ctx.ui.notify("Restarting Pi; resuming the same saved session.", "info");
		ctx.shutdown();
	};
	const queue = (value: unknown): string => {
		const request = parseRestartRequest(value);
		if (!ctx || closing) throw new Error("Restart control is unavailable in this session");
		if (pending || committed) throw new Error("A restart is already queued");
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
			if (event.systemPromptOptions.forceSystemPrompt !== undefined)
				event.systemPromptOptions.forceSystemPrompt += `\n\n${guidance}`;
		});
		pi.on("context_with_system", (event) => {
			if (!ctx) return;
			const first = event.messages[0];
			const head: SystemMessage =
				first?.role === "system" ? first : { role: "system", content: "", timestamp: Date.now() };
			const tail = first?.role === "system" ? event.messages.slice(1) : event.messages;
			return {
				messages: [
					{ ...head, sections: { ...head.sections, restart: `<restart>\n${guidance}\n</restart>` } },
					...tail.flatMap((message) => {
						if (message.role !== "system" || !Object.hasOwn(message.sections ?? {}, "restart")) return [message];
						const sections = { ...message.sections };
						delete sections.restart;
						const patch: SystemMessage = { ...message, sections };
						if (Object.keys(sections).length === 0) delete patch.sections;
						// Drop only empty owned patches; preserve content, tool deltas and any other fields.
						if (
							patch.content.length === 0 &&
							Object.keys(patch).every((key) => key === "role" || key === "content" || key === "timestamp")
						)
							return [];
						return [patch];
					}),
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
		bindInput(check) {
			input = check;
		},
		async ready() {
			if (handoff && !ctx) throw new Error("Managed restart extension did not initialize");
			if (handoff && ctx?.sessionManager.getSessionId() !== handoff.sessionId)
				throw new Error("Restart session identity mismatch");
			await send({ type: "pi:ready" });
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
			return committed !== undefined;
		},
		async completeShutdown() {
			if (committed) await send(committed);
		},
		async captureFinal(session) {
			if (!committed) return false;
			if (!session.isIdle || session.isSettling || session.workingSessionGate.busy)
				throw new Error("Managed restart still has admitted work");
			const hold = await session.acquireWorkingSession();
			try {
				// Detached jobs survive worker replacement. Sleep readiness belongs to whole-compute exit.
				const path = join(
					realpathSync(session.sessionManager.getSessionDir()),
					`restart-${session.sessionId}.json`,
				);
				writeWorkingSession(path, hold.state);
				hold.assertHeld();
				committed.session.workingSession = path;
				return true;
			} finally {
				await hold.release();
			}
		},
	};
}
