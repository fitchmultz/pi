/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import type { InteractiveMode } from "../interactive/interactive-mode.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RpcTuiDetachedEvent,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcTuiDetachedEvent,
} from "./rpc-types.ts";

export interface RpcModeOptions {
	interactiveMode?: InteractiveMode;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime, options: RpcModeOptions = {}): Promise<never> {
	const interactiveMode = options.interactiveMode;
	const interactiveUI = interactiveMode?.host(() => shutdown());
	let frontend: "rpc" | "tui" = "rpc";
	let transitioning = false;
	let returnRequested = false;
	let attachToken: string | undefined;
	let interactiveRunStarted = false;
	let extensionTitle: string | undefined;
	let editorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	let headerFactory: Parameters<ExtensionUIContext["setHeader"]>[0];
	let editorFactoryPending = false;
	let headerFactoryPending = false;
	const stdinWasRaw = process.stdin.isRaw ?? false;
	if (interactiveMode) process.stdin.setRawMode?.(true);
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		if (frontend === "rpc") writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{
			request: RpcExtensionUIRequest;
			resolve?: (value: RpcExtensionUIResponse) => void;
			reject: (error: Error) => void;
			present?: () => void;
		}
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
		present?: (opts: ExtensionUIDialogOptions) => Promise<T>,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		const rpcRequest = { type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest;
		const deadline = opts?.timeout ? Date.now() + opts.timeout : undefined;
		return new Promise((resolve, reject) => {
			let nativeController: AbortController | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
				nativeController?.abort();
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
				request: rpcRequest,
				present: present
					? () => {
							if (nativeController) return;
							nativeController = new AbortController();
							void present({
								signal: nativeController.signal,
								timeout: deadline ? Math.max(1, deadline - Date.now()) : undefined,
							}).then(
								(value) => {
									if (!pendingExtensionRequests.has(id)) return;
									cleanup();
									resolve(value);
								},
								(error: unknown) => {
									cleanup();
									reject(error);
								},
							);
						}
					: undefined,
			});
			output(rpcRequest);
			if (frontend === "tui") pendingExtensionRequests.get(id)?.present?.();
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, values, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "select", title, options: values, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				interactiveUI ? (tuiOpts) => interactiveUI.select(title, values, tuiOpts) : undefined,
			),
		confirm: (title, message, opts) =>
			createDialogPromise(
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
				interactiveUI ? (tuiOpts) => interactiveUI.confirm(title, message, tuiOpts) : undefined,
			),
		input: (title, placeholder, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				interactiveUI ? (tuiOpts) => interactiveUI.input(title, placeholder, tuiOpts) : undefined,
			),
		editor: (title, prefill, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "editor", title, prefill },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				interactiveUI ? (tuiOpts) => interactiveUI.editor(title, prefill, tuiOpts) : undefined,
			),
		notify: (message, notifyType) => {
			if (frontend === "tui") interactiveUI?.notify(message, notifyType);
			else output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType });
		},
		onTerminalInput: (handler) => interactiveUI?.onTerminalInput(handler) ?? (() => {}),
		setStatus: (statusKey, statusText) => {
			interactiveUI?.setStatus(statusKey, statusText);
			output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey, statusText });
		},
		setWorkingMessage: (message) => interactiveUI?.setWorkingMessage(message),
		setWorkingVisible: (visible) => interactiveUI?.setWorkingVisible(visible),
		setWorkingIndicator: (indicator) => interactiveUI?.setWorkingIndicator(indicator),
		setHiddenThinkingLabel: (label) => interactiveUI?.setHiddenThinkingLabel(label),
		setWidget(
			key: string,
			content: string[] | Parameters<ExtensionUIContext["setWidget"]>[1],
			widgetOptions?: ExtensionWidgetOptions,
		): void {
			if (typeof content === "function") {
				interactiveUI?.setWidget(key, content, widgetOptions);
				return;
			}
			interactiveUI?.setWidget(key, content, widgetOptions);
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWidget",
				widgetKey: key,
				widgetLines: content,
				widgetPlacement: widgetOptions?.placement,
			});
		},
		setFooter: (factory) => interactiveUI?.setFooter(factory),
		setHeader: (factory) => {
			headerFactory = factory;
			headerFactoryPending = frontend === "rpc";
			if (frontend === "tui") interactiveUI?.setHeader(factory);
		},
		setTitle: (title) => {
			extensionTitle = title;
			if (frontend === "tui") interactiveUI?.setTitle(title);
			else output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setTitle", title });
		},
		async custom(factory, customOptions) {
			if (!interactiveUI) return undefined as never;
			const id = crypto.randomUUID();
			const request: RpcExtensionUIRequest = { type: "extension_ui_request", id, method: "custom" };
			return new Promise((resolve, reject) => {
				let presented = false;
				const present = () => {
					if (presented) return;
					presented = true;
					void interactiveUI
						.custom(factory, customOptions)
						.then(resolve, reject)
						.finally(() => pendingExtensionRequests.delete(id));
				};
				pendingExtensionRequests.set(id, { request, reject, present });
				output(request);
				if (frontend === "tui") present();
			});
		},
		pasteToEditor: (text) => {
			interactiveUI?.pasteToEditor(text);
			output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "set_editor_text", text });
		},
		setEditorText: (text) => {
			interactiveUI?.setEditorText(text);
			output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "set_editor_text", text });
		},
		getEditorText: () => interactiveUI?.getEditorText() ?? "",
		addAutocompleteProvider: (factory) => interactiveUI?.addAutocompleteProvider(factory),
		setEditorComponent: (factory) => {
			editorFactory = factory;
			editorFactoryPending = frontend === "rpc";
			if (frontend === "tui") interactiveUI?.setEditorComponent(factory);
		},
		getEditorComponent: () =>
			editorFactoryPending && interactiveUI ? editorFactory : interactiveUI?.getEditorComponent(),
		get theme() {
			return interactiveUI?.theme ?? theme;
		},
		getAllThemes: () => interactiveUI?.getAllThemes() ?? [],
		getTheme: (name) => interactiveUI?.getTheme(name),
		setTheme: (value: string | Theme) =>
			interactiveUI?.setTheme(value) ?? { success: false, error: "Theme switching not supported in RPC mode" },
		getToolsExpanded: () => interactiveUI?.getToolsExpanded() ?? false,
		setToolsExpanded: (expanded) => interactiveUI?.setToolsExpanded(expanded),
	});

	const getRpcState = (): RpcSessionState => ({
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		pendingExtensionUIRequests: Array.from(pendingExtensionRequests.values(), (pending) => pending.request),
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: frontend,
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
					await interactiveMode?.rebindHostedSession();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				if (frontend === "tui") {
					interactiveMode?.showError(`Extension "${err.extensionPath}" error: ${err.error}`);
					return;
				}
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			output(toJsonEvent(event));
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			if (frontend === "rpc") await waitForRawStdoutBackpressure();
		});
		await interactiveMode?.rebindHostedSession();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		if (interactiveMode && process.platform !== "win32") {
			const detach = () => {
				if (frontend === "rpc" && !transitioning) return;
				returnRequested = true;
				void activateRpcFrontend().catch(() => shutdown(1));
			};
			process.on("SIGUSR2", detach);
			signalCleanupHandlers.push(() => process.off("SIGUSR2", detach));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (disposition) => {
							preflightSucceeded = true;
							output(success(id, "prompt", { disposition }));
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				const disposition = await session.steer(command.message, command.images, { source: "rpc" });
				return success(id, "steer", { disposition });
			}

			case "follow_up": {
				const disposition = await session.followUp(command.message, command.images, { source: "rpc" });
				return success(id, "follow_up", { disposition });
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "clear_queue": {
				return success(id, "clear_queue", session.clearQueue());
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "attach_tui": {
				if (!interactiveMode || !process.stdin.isTTY || !process.stdout.isTTY || process.platform === "win32") {
					return error(id, "attach_tui", "TUI handoff requires a PTY");
				}
				if (
					command.token !== undefined &&
					(typeof command.token !== "string" ||
						!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.token))
				) {
					return error(id, "attach_tui", "TUI handoff token must be a UUID");
				}
				attachToken = command.token ?? crypto.randomUUID();
				transitioning = true;
				detachInput();
				return success(id, "attach_tui", { token: attachToken });
			}

			case "get_state": {
				return success(id, "get_state", getRpcState());
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.modelRuntime.getAvailableSnapshot();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function activateTuiFrontend(): Promise<void> {
		if (!interactiveMode) return;
		try {
			await flushRawStdout();
			frontend = "tui";
			session.setExtensionMode("tui");
			restoreStdout();
			await interactiveMode.activateHosted();
			if (extensionTitle !== undefined) interactiveUI?.setTitle(extensionTitle);
			if (editorFactoryPending) interactiveUI?.setEditorComponent(editorFactory);
			if (headerFactoryPending) interactiveUI?.setHeader(headerFactory);
			editorFactoryPending = false;
			headerFactoryPending = false;
			if (!interactiveRunStarted) {
				interactiveRunStarted = true;
				void interactiveMode.runHosted().catch(() => shutdown(1));
			}
			for (const pending of pendingExtensionRequests.values()) pending.present?.();
		} catch {
			await shutdown(1);
		} finally {
			transitioning = false;
		}
		if (returnRequested) await activateRpcFrontend();
	}

	async function activateRpcFrontend(): Promise<void> {
		if (transitioning || frontend === "rpc" || !interactiveMode) return;
		transitioning = true;
		try {
			await interactiveMode.deactivateHosted();
			takeOverStdout();
			frontend = "rpc";
			session.setExtensionMode("rpc");
			process.stdin.setRawMode?.(true);
			const event: RpcTuiDetachedEvent = { type: "tui_detached", state: getRpcState() };
			writeRawStdout(`\x1e${attachToken}\x1e${serializeJsonLine(event)}`);
			for (const pending of pendingExtensionRequests.values()) output(pending.request);
			await waitForRawStdoutBackpressure();
			returnRequested = false;
		} finally {
			transitioning = false;
		}
		attachInput();
	}

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await interactiveMode?.deactivateHosted();
		interactiveMode?.stop();
		takeOverStdout();
		frontend = "rpc";
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (interactiveMode) process.stdin.setRawMode?.(stdinWasRaw);
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		if (frontend !== "rpc" || transitioning) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			pending?.resolve?.(response);
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
			if (command.type === "attach_tui" && response?.success) await activateTuiFrontend();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	function attachInput(): void {
		process.stdin.on("end", onInputEnd);
		process.stdin.resume();
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		detachInput = () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	}
	attachInput();

	// Keep process alive forever
	return new Promise(() => {});
}
