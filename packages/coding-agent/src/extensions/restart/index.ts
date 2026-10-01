import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRestartRuntimeWorker } from "../../cli/launcher.ts";
import {
	MANAGED_CLI_ENV,
	MAX_RESTART_BYTES,
	parseRestartRequest,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartRequest,
	type RestartWorkerMessage,
} from "../../cli/restart-protocol.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

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
	interrupt(): void;
	beginShutdown(source: "user" | "extension" | "signal"): boolean;
	completeShutdown(): Promise<void>;
}

let install: ((pi: ExtensionAPI) => void) | undefined;

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
	if (process.env[MANAGED_CLI_ENV] !== "1" || !process.send || !process.connected) return undefined;
	const handoff = encoded ? (JSON.parse(encoded) as RestartHandoff) : undefined;
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
	const sockets = new Set<Socket>();

	const cancel = (reason?: string) => {
		const requested = pending !== undefined || committed !== undefined;
		pending = undefined;
		committed = undefined;
		clearTimeout(timer);
		if (requested && reason && ctx) ctx.ui.notify(`Restart cancelled: ${reason}`, "warning");
	};
	const cleanup = () => {
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
		if (!ctx || closing) throw new Error("Pi is not ready for restart requests");
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
			if (handoff && !started && context.sessionManager.getSessionId() !== handoff.sessionId)
				throw new Error("Restart session identity mismatch");
			directory = mkdtempSync(join(tmpdir(), "pi-restart-"));
			if (process.platform !== "win32" && Buffer.byteLength(join(directory, "s")) > 103) {
				rmSync(directory, { recursive: true, force: true });
				directory = mkdtempSync("/tmp/pi-restart-");
			}
			socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-restart-${randomUUID()}` : join(directory, "s");
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
			try {
				await new Promise<void>((resolve, reject) => {
					server!.once("error", reject);
					server!.listen(socketPath, resolve);
				});
				process.env[RESTART_SOCKET_ENV] = socketPath;
			} catch (error) {
				cleanup();
				throw error;
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
			if (event.systemPromptOptions.forceSystemPrompt !== undefined)
				event.systemPromptOptions.forceSystemPrompt += `\n\n${guidance}`;
			else event.systemPromptOptions.sections.restart = guidance;
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
			if (!ctx) throw new Error("Managed restart extension did not initialize");
			if (handoff && ctx.sessionManager.getSessionId() !== handoff.sessionId)
				throw new Error("Restart session identity mismatch");
			await send({ type: "pi:ready" });
		},
		start() {
			if (started) return;
			started = true;
			if (handoff?.failure) ctx?.ui.notify(handoff.failure, "warning");
			if (handoff?.message || handoff?.failure) {
				api?.sendUserMessage(
					`[Restart continuation]\n${handoff.failure ? `${handoff.failure}\n\n` : ""}${handoff.message ?? "Diagnose the startup failure; the previous runtime was restored."}`,
					{ expandPromptTemplates: false },
				);
			}
		},
		interrupt() {
			cancel("the run was interrupted.");
		},
		beginShutdown(source) {
			if (source !== "extension") cancel();
			closing = true;
			return committed !== undefined;
		},
		async completeShutdown() {
			if (committed) await send(committed);
		},
	};
}
