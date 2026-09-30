import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { publishLocalFileExclusiveSync } from "@earendil-works/pi-agent-core/node";
import {
	assertCheckpointTarget,
	type CheckpointFile,
	readSessionCheckpointState,
	type SessionCheckpointState,
	validateSessionCheckpointFile,
} from "../core/checkpoint.ts";
import { execCommand } from "../core/exec.ts";
import type { ExtensionContext, InlineExtension } from "../core/extensions/types.ts";
import type { SessionManager } from "../core/session-manager.ts";
import { type Args, parseArgs } from "./args.ts";
import { getRestartRuntimeWorker } from "./launcher.ts";
import {
	MANAGED_CLI_ENV,
	MAX_RESTART_BYTES,
	parseRestartRequest,
	RESTART_HANDOFF_ENV,
	RESTART_SOCKET_ENV,
	type RestartCheckpoint,
	type RestartHandoff,
	type RestartRequest,
	type RestartWorkerMessage,
} from "./restart-protocol.ts";

export interface RestartCheckpointWriter {
	readonly path: string;
	readonly retainedRuntimeProvider?: string;
	publish(checkpoint: CheckpointFile, signal: AbortSignal): Promise<void>;
}

async function checkpointSha256(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
	signal?.throwIfAborted();
	return hash.digest("hex");
}

function syncRestartPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function assertRestartCandidate(original: SessionCheckpointState, candidate: SessionCheckpointState): void {
	const { header: _originalHeader, selection: originalSelection, ...originalWorking } = original;
	const { header: _candidateHeader, selection: candidateSelection, ...candidateWorking } = candidate;
	if (
		!isDeepStrictEqual(
			{ ...originalWorking, selection: originalSelection },
			{ ...candidateWorking, selection: { ...candidateSelection, sessionFile: originalSelection.sessionFile } },
		)
	)
		throw new Error("Restart transform changed non-entry working state");
}

async function runCheckpointProgram(
	program: string,
	mode: "transform" | "rollback",
	original: string,
	candidate: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!isAbsolute(program) || !lstatSync(program).isFile())
		throw new Error("Restart checkpoint program must be an absolute regular Node program");
	const controller = new AbortController();
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	const interrupt = () => controller.abort(new Error(`Restart checkpoint ${mode} interrupted`));
	for (const name of signals) process.on(name, interrupt);
	const owned = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		owned.throwIfAborted();
		// Fixed, quiet Node contract: no shell, detached converter, model/tool replay, or stdout protocol.
		const result = await execCommand(process.execPath, [program, mode, original, candidate], cwd, {
			signal: owned,
			timeout: 30_000,
		});
		owned.throwIfAborted();
		if (result.killed || result.code !== 0)
			throw new Error(
				`Restart checkpoint ${mode} failed (${result.killed ? "cancelled" : result.code}): ${result.stderr}`,
			);
	} finally {
		for (const name of signals) process.off(name, interrupt);
	}
}

/** Cold file selection precedes journal opening, recovery extensions, and input admission. */
export async function prepareRestartCheckpoint(handoff: RestartHandoff, args: Args): Promise<string | undefined> {
	const { files, ...selection } = handoff.checkpoint;
	if (!files) return undefined; // Already-running older workers can only produce the selection-only bootstrap.
	for (const ref of [files.original, files.candidate].filter((ref) => ref !== undefined)) {
		if (!ref || !isAbsolute(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256))
			throw new Error("Invalid restart checkpoint file reference");
	}
	if (!!files.candidate !== !!files.rollback) throw new Error("Restart transform requires prepared artifact rollback");
	const original = readSessionCheckpointState(files.original.path);
	if (
		(await checkpointSha256(files.original.path)) !== files.original.sha256 ||
		original.completedExit ||
		!original.settled ||
		original.boundary !== "settled" ||
		!isDeepStrictEqual(original.selection, selection) ||
		(handoff.toolConfiguration !== undefined &&
			!isDeepStrictEqual(handoff.toolConfiguration, original.toolConfiguration))
	)
		throw new Error("Restart original checkpoint does not match the native handoff");
	if (
		args.checkpoint ||
		args.session !== selection.sessionFile ||
		args.sessionCwd !== selection.cwd ||
		args.thinking !== selection.thinkingLevel ||
		args.provider !== selection.model?.provider ||
		args.model !== (selection.model ? `${selection.model.provider}/${selection.model.id}` : undefined) ||
		args.sessionId ||
		args.noSession ||
		args.continue ||
		args.resume ||
		args.fork ||
		args.name ||
		args.messages.length ||
		args.fileArgs.length
	)
		throw new Error("Restart arguments disagree with the original selection");
	if (handoff.failure) {
		if (files.rollback) {
			await runCheckpointProgram(
				files.rollback,
				"rollback",
				files.original.path,
				files.candidate!.path,
				selection.cwd,
			);
			if ((await checkpointSha256(files.original.path)) !== files.original.sha256)
				throw new Error("Restart rollback changed the original checkpoint");
		}
		return files.original.path;
	}
	if (!files.candidate) return files.original.path;
	if ((await checkpointSha256(files.candidate.path)) !== files.candidate.sha256)
		throw new Error("Restart candidate checkpoint changed");
	assertRestartCandidate(original, readSessionCheckpointState(files.candidate.path));
	return files.candidate.path;
}

/** Capture options through the real parser, so extension flag values cannot become replayed prompts. */
export function getRestartArgs(args: string[], keepApiKey = false): string[] {
	const result: string[] = [];
	const replaced = new Set([
		"--session",
		"--checkpoint",
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
	let toolConfiguration: RestartHandoff["toolConfiguration"];
	let committed: RestartRequest | undefined;
	let restoreTools: (() => void) | undefined;
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
			let timer: NodeJS.Timeout | undefined;
			let invalidateCheckpoint: (() => void) | undefined;
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
				// The external editor owns input while the TUI has paused stdin.
				if (
					!startupComplete ||
					(process.stdin.isTTY && process.stdin.isPaused()) ||
					!ctx.isIdle() ||
					ctx.isBashRunning() ||
					ctx.getPendingInputCount() > 0
				) {
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
				if (request.checkpointTransform && !lstatSync(request.checkpointTransform).isFile())
					throw new Error("Restart checkpoint transform must be a regular Node program");
				if (ctx.getPendingNextTurnCount() > 0 || ctx.ui.getEditorText().length > 0) {
					throw new Error("Handle unsent editor text and next-turn messages before restarting");
				}
				invalidateCheckpoint?.();
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
					const active = [...new Set([...previous.activeTools, ...added])];
					pi.setActiveTools(active);
					restoreTools = () => pi.setActiveTools(active);
					if (options.handoff.failure) ctx.ui.notify(options.handoff.failure, "warning");
				}
				directory = mkdtempSync(join(tmpdir(), "pi-restart-"));
				// Leave room for the terminating NUL in sockaddr_un.sun_path.
				const maxSocketBytes = process.platform === "linux" || process.platform === "android" ? 107 : 103;
				if (process.platform !== "win32" && Buffer.byteLength(join(directory, "s")) > maxSocketBytes) {
					rmSync(directory, { recursive: true, force: true });
					const shortTmp = process.platform === "android" ? resolve(dirname(process.execPath), "../tmp") : "/tmp";
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
			pi.on("resources_discover", () => {
				if (!options.handoff?.checkpoint.files || !restoreTools) return;
				// This native extension is last: retain later startup/discovery tool decisions
				// before ordinary checkpoint initialization reapplies its saved selection.
				const previous = options.handoff.checkpoint;
				const added = pi.getActiveTools().filter((name) => !previous.knownTools.includes(name));
				const active = [...new Set([...previous.activeTools, ...added])];
				restoreTools = () => pi.setActiveTools(active);
			});
			// An idle control socket is recreated by session_start; an accepted restart is memory-only.
			pi.on("session_checkpoint", (event) => {
				if (pending || committed || closing || !startupComplete)
					return { sleepReady: false, reason: "Native restart is pending" };
				invalidateCheckpoint = event.invalidate;
				event.signal.addEventListener(
					"abort",
					() => {
						if (invalidateCheckpoint === event.invalidate) invalidateCheckpoint = undefined;
					},
					{ once: true },
				);
				return { sleepReady: true };
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
			pi.on("before_agent_start", (event) => {
				const guidance =
					'Use /reload to apply changed extension source and resources. For core/runtime or clean-process changes, use bash: pi restart --message "what to continue after restarting". Keep the working runtime and extension files intact; activate staged paths for rollback. Run pi restart --help for options. Restart waits for final idle and does not replay completed commands.';
				if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
					event.systemPromptOptions.forceSystemPrompt += `\n\n${guidance}`;
				} else {
					event.systemPromptOptions.sections.restart = guidance;
				}
			});
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
			pi.on("session_shutdown", (event) => {
				if (event.reason !== "quit") committed = undefined;
				cleanup();
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
		setToolConfiguration(configuration: RestartHandoff["toolConfiguration"]) {
			toolConfiguration = configuration;
		},
		shutdownRequested(source: "user" | "extension" | "signal") {
			closing = true;
			if (source !== "extension") committed = undefined;
			cancelRestart?.(source);
		},
		prepareShutdownCheckpoint(): RestartCheckpointWriter | undefined {
			const request = committed;
			if (!request) return undefined;
			const directory = mkdtempSync(join(tmpdir(), "pi-restart-checkpoint-"));
			const originalPath = join(directory, "original.json");
			const candidatePath = join(directory, "candidate.json");
			return {
				path: originalPath,
				retainedRuntimeProvider: parseArgs(options.args).apiKey ? initialProvider : undefined,
				async publish(checkpoint, signal) {
					try {
						signal.throwIfAborted();
						assertCheckpointTarget(originalPath, checkpoint.selection.sessionFile);
						syncRestartPath(checkpoint.path);
						publishLocalFileExclusiveSync(checkpoint.path, originalPath);
						if (process.platform !== "win32") {
							syncRestartPath(directory);
							syncRestartPath(dirname(directory));
						}
						const original = readSessionCheckpointState(originalPath);
						const files: NonNullable<RestartCheckpoint["files"]> = {
							original: { path: originalPath, sha256: await checkpointSha256(originalPath, signal) },
						};
						if (original.completedExit || !original.settled || original.boundary !== "settled")
							throw new Error("Restart requires an unmarked final settled checkpoint");
						if (request.checkpointTransform) {
							validateSessionCheckpointFile(originalPath);
							await runCheckpointProgram(
								request.checkpointTransform,
								"transform",
								originalPath,
								candidatePath,
								original.selection.cwd,
								signal,
							);
							if ((await checkpointSha256(originalPath, signal)) !== files.original.sha256)
								throw new Error("Restart transform changed the original checkpoint");
							validateSessionCheckpointFile(originalPath);
							const candidate = validateSessionCheckpointFile(candidatePath);
							assertCheckpointTarget(candidatePath, candidate.selection.sessionFile);
							assertRestartCandidate(original, candidate);
							syncRestartPath(candidatePath);
							if (process.platform !== "win32") syncRestartPath(directory);
							files.candidate = { path: candidatePath, sha256: await checkpointSha256(candidatePath, signal) };
							files.rollback = request.checkpointTransform;
						}
						signal.throwIfAborted();
						if (committed !== request) throw new Error("Restart cancelled during final cleanup");
						await options.send({
							type: "pi:restart",
							request,
							args: getRestartArgs(
								options.args,
								initialProvider !== undefined && initialProvider === original.selection.model?.provider,
							),
							extensions,
							toolConfiguration: original.toolConfiguration ?? toolConfiguration,
							checkpoint: { ...original.selection, files },
						});
					} catch (error) {
						throw new Error(
							`${error instanceof Error ? error.message : String(error)}${existsSync(originalPath) ? `; original restart checkpoint retained at ${originalPath}` : ""}`,
							{ cause: error },
						);
					} finally {
						committed = undefined;
						if (!existsSync(originalPath)) rmSync(directory, { recursive: true, force: true });
					}
				},
			};
		},
		async ready() {
			if (closing) return false;
			if (!currentContext) throw new Error("Pi restart control failed to initialize");
			// Cold restore validates the saved tools first; restart then admits startup-approved new tools.
			restoreTools?.();
			restoreTools = undefined;
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
