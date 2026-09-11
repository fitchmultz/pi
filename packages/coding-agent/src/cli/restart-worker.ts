import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, InlineExtension } from "../core/extensions/types.ts";
import type { SessionManager } from "../core/session-manager.ts";
import { parseArgs } from "./args.ts";
import { getRestartRuntimeWorker } from "./launcher.ts";
import {
	MANAGED_CLI_ENV,
	MAX_RESTART_BYTES,
	parseRestartRequest,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartRequest,
	type RestartWorkerMessage,
} from "./restart-protocol.ts";

/** Capture options through the real parser, so extension flag values cannot become replayed prompts. */
export function getRestartArgs(args: string[], keepApiKey = false): string[] {
	const result: string[] = [];
	const replaced = new Set([
		"--session",
		"--session-cwd",
		"--session-id",
		"--no-session",
		"--continue",
		"-c",
		"--resume",
		"-r",
		"--fork",
		"--name",
		"-n",
		"--provider",
		"--model",
		"--thinking",
		"--extension",
		"-e",
	]);
	if (!keepApiKey) replaced.add("--api-key");
	parseArgs(args, (option, tokens) => {
		if (!replaced.has(option)) result.push(...tokens);
	});
	return result;
}

export function restoreRestartSession(sessionManager: SessionManager, handoff: RestartHandoff): void {
	if (sessionManager.getSessionId() !== handoff.checkpoint.sessionId)
		throw new Error("Restart session identity mismatch");
	if (handoff.checkpoint.leafId === null) sessionManager.resetLeaf();
	else sessionManager.branch(handoff.checkpoint.leafId);
}

export function createRestartControl(options: {
	args: string[];
	handoff?: RestartHandoff;
	send: (message: RestartWorkerMessage) => Promise<void>;
}) {
	let startupComplete = false;
	let closing = false;
	let restored = false;
	let currentContext: ExtensionContext | undefined;
	let extensions: string[] = [];
	let initialProvider: string | undefined;
	let attempt: (() => void) | undefined;
	let cancelRestart: ((source: "user" | "extension" | "signal") => void) | undefined;
	const extension: InlineExtension = {
		name: "restart",
		hidden: true,
		factory(pi) {
			let server: Server | undefined;
			let directory: string | undefined;
			let socketPath: string | undefined;
			let pending: RestartRequest | undefined;
			let committed: RestartRequest | undefined;
			let timer: NodeJS.Timeout | undefined;
			const sockets = new Set<Socket>();

			const cleanup = () => {
				clearTimeout(timer);
				attempt = undefined;
				cancelRestart = undefined;
				currentContext = undefined;
				pending = undefined;
				for (const socket of sockets) socket.destroy();
				sockets.clear();
				server?.close();
				server = undefined;
				if (process.env[RESTART_SOCKET_ENV] === socketPath) delete process.env[RESTART_SOCKET_ENV];
				if (directory) rmSync(directory, { recursive: true, force: true });
			};
			const tryRestart = () => {
				const ctx = currentContext;
				if (!pending || !ctx || committed || closing) return;
				if (!startupComplete || !ctx.isIdle() || ctx.isBashRunning() || ctx.getPendingInputCount() > 0) {
					clearTimeout(timer);
					timer = setTimeout(tryRestart, 100);
					return;
				}
				if (ctx.getPendingNextTurnCount() > 0 || ctx.ui.getEditorText().length > 0) {
					pending = undefined;
					ctx.ui.notify(
						"Restart cancelled: unsent editor text or next-turn messages must be handled first.",
						"warning",
					);
					return;
				}
				committed = pending;
				pending = undefined;
				ctx.ui.notify("Restarting Pi after saving this session.", "info");
				ctx.shutdown();
			};
			const queue = (value: unknown) => {
				const request = parseRestartRequest(value);
				const ctx = currentContext;
				if (!ctx || closing) throw new Error("Pi is not ready for restart requests");
				if (pending || committed) throw new Error("A restart is already queued");
				if (request.sessionId && request.sessionId !== ctx.sessionManager.getSessionId()) {
					throw new Error("Restart request belongs to a different session");
				}
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile || !existsSync(sessionFile)) throw new Error("Restart requires a saved session");
				if (request.runtime) getRestartRuntimeWorker(request.runtime);
				for (const path of request.extensions ?? []) {
					if (!existsSync(path)) throw new Error(`Restart extension does not exist: ${path}`);
				}
				if (ctx.getPendingNextTurnCount() > 0 || ctx.ui.getEditorText().length > 0) {
					throw new Error("Handle unsent editor text and next-turn messages before restarting");
				}
				pending = request;
				clearTimeout(timer);
				// Return the shell result before considering shutdown. Final idle, not tool completion, is the gate.
				timer = setTimeout(tryRestart, 100);
				return "Restart queued. Pi will wait for final idle, then resume the same session.";
			};

			pi.on("session_start", async (_event, ctx) => {
				if (ctx.mode !== "tui") return;
				currentContext = ctx;
				attempt = tryRestart;
				cancelRestart = (source) => {
					clearTimeout(timer);
					pending = undefined;
					if (source !== "extension") committed = undefined;
				};
				if (!restored && options.handoff) {
					restored = true;
					const previous = options.handoff.checkpoint;
					const added = pi.getActiveTools().filter((name) => !previous.knownTools.includes(name));
					pi.setActiveTools([...new Set([...previous.activeTools, ...added])]);
					if (options.handoff.failure) ctx.ui.notify(options.handoff.failure, "warning");
				}
				directory = mkdtempSync(join(tmpdir(), "pi-restart-"));
				socketPath =
					process.platform === "win32" ? `\\\\.\\pipe\\pi-restart-${randomUUID()}` : join(directory, "s");
				server = createServer((socket) => {
					sockets.add(socket);
					socket.on("close", () => sockets.delete(socket));
					socket.on("error", () => {});
					socket.setTimeout(5000, () => socket.destroy());
					socket.setEncoding("utf8");
					let input = "";
					let handled = false;
					socket.on("data", (chunk: string) => {
						if (handled) return;
						input += chunk;
						if (Buffer.byteLength(input) > MAX_RESTART_BYTES) {
							handled = true;
							socket.end(`${JSON.stringify({ ok: false, message: "Restart request is too large" })}\n`);
							return;
						}
						if (!input.includes("\n")) return;
						handled = true;
						try {
							socket.end(
								`${JSON.stringify({ ok: true, message: queue(JSON.parse(input.slice(0, input.indexOf("\n")))) })}\n`,
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
						server!.listen(socketPath, () => resolve());
					});
					process.env[RESTART_SOCKET_ENV] = socketPath;
				} catch (error) {
					cleanup();
					throw error;
				}
			});
			pi.on("agent_settled", tryRestart);
			pi.on("auto_retry_end", (event, ctx) => {
				if (pending && !event.success) {
					pending = undefined;
					clearTimeout(timer);
					ctx.ui.notify("Restart cancelled because retries were cancelled or exhausted.", "warning");
				}
			});
			pi.on("message_end", (event, ctx) => {
				if (pending && event.message.role === "assistant" && event.message.stopReason === "aborted") {
					pending = undefined;
					clearTimeout(timer);
					ctx.ui.notify("Restart cancelled because the agent run was interrupted.", "warning");
				}
			});
			pi.on("before_agent_start", (event) => ({
				systemPrompt: `${event.systemPrompt}\n\nTo activate changed extension or runtime code, use bash: pi restart --message "what to continue after restarting". Keep the working runtime and extension files intact; activate staged paths for rollback. Run pi restart --help for options. This queues a restart after final idle; it does not replay completed commands.`,
			}));
			pi.registerCommand("restart", {
				description: "Restart Pi and resume this session; optional text continues the agent afterward",
				handler: async (message, ctx) => {
					try {
						ctx.ui.notify(queue(message.trim() ? { message } : {}), "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				},
			});
			pi.on("session_shutdown", async (event, ctx) => {
				const request = committed;
				committed = undefined;
				cleanup();
				if (!request || event.reason !== "quit") return;
				// The TUI has stopped accepting input. Earlier extension shutdown hooks have persisted their state.
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Cannot restart an ephemeral session");
				await options.send({
					type: "pi:restart",
					request,
					// A CLI key was resolved for the startup provider, not for a later model selection.
					args: getRestartArgs(
						options.args,
						initialProvider !== undefined && initialProvider === ctx.model?.provider,
					),
					extensions,
					checkpoint: {
						sessionFile,
						sessionId: ctx.sessionManager.getSessionId(),
						cwd: ctx.cwd,
						leafId: ctx.sessionManager.getLeafId(),
						model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
						thinkingLevel: pi.getThinkingLevel(),
						activeTools: pi.getActiveTools(),
						knownTools: pi.getAllTools().map((tool) => tool.name),
					},
				});
			});
		},
	};
	return {
		extension,
		handoff: options.handoff,
		setExtensions(paths: string[]) {
			extensions = paths;
		},
		setInitialProvider(provider: string | undefined) {
			initialProvider = provider;
		},
		shutdownRequested(source: "user" | "extension" | "signal") {
			closing = true;
			cancelRestart?.(source);
		},
		async ready() {
			if (closing) return false;
			if (!currentContext) throw new Error("Pi restart control failed to initialize");
			await options.send({ type: "pi:ready" });
			if (closing) return false;
			startupComplete = true;
			attempt?.();
			return !closing;
		},
	};
}

export function createManagedRestart(args: string[]) {
	if (process.env[MANAGED_CLI_ENV] !== "1" || !process.send || !process.connected) return undefined;
	const encoded = process.env[RESTART_HANDOFF_ENV];
	delete process.env[RESTART_HANDOFF_ENV];
	// A killed launcher must not leave an invisible worker and its tools running.
	process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
	process.channel?.unref();
	return createRestartControl({
		args,
		handoff: encoded ? (JSON.parse(encoded) as RestartHandoff) : undefined,
		send: (message) =>
			new Promise<void>((resolve, reject) => {
				if (!process.send || !process.connected) return reject(new Error("Pi restart supervisor disconnected"));
				process.send(message, (error) => (error ? reject(error) : resolve()));
			}),
	});
}
