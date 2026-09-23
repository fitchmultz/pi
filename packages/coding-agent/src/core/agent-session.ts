/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	Agent,
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	NewContextRequest,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { getPendingToolCalls } from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	retryDelayMs,
	type ToolReference,
	type ToolSelection,
	toolId,
	toolKey,
	toToolDeclaration,
	toToolReference,
	withoutToolSearchState,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { Clone } from "typebox/value";
import { APP_NAME } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import type {
	CheckpointBoundary,
	CheckpointHold,
	CheckpointOptions,
	SessionCheckpoint,
	SessionCheckpointQueues,
	ShutdownCheckpoint,
} from "./checkpoint.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	isContextUsageInvalidatingEntry,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type AutoRetryEndEvent,
	type AutoRetryStartEvent,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type SummarizationRetryAttemptStartEvent,
	type SummarizationRetryFinishedEvent,
	type SummarizationRetryScheduledEvent,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "./session-manager.ts";
import type { CacheWarmingMode, SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	buildSystemPromptState,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

const MAX_CONTEXT_HANDOFF_CHARS = 20_000;

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
			pendingToolCalls?: ReturnType<typeof getPendingToolCalls>;
	  }
	| { type: "agent_settled"; pendingToolCalls?: ReturnType<typeof getPendingToolCalls> }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "context_window_started"; pendingMessages: AgentMessage[] }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			contextWindowStarted?: boolean;
			/** Live inputs to retain when the UI rebuilds before request preparation finishes. */
			pendingMessages?: AgentMessage[];
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: ToolSelection[];
	/** Suppress default built-ins, retaining extension tools and explicit selection. */
	noBuiltinTools?: boolean;
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: ToolSelection[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: ToolSelection[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	/** User inputs held by the mode before they reach prompt(). */
	getQueuedInputCount?: () => number;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface ProviderRequestPrefix {
	provider: string;
	api: string;
	model: string;
	systemPrompt: string;
	/** Structured prompt at dispatch; idle usage stays valid when a request-only force ends. */
	transcriptSystemPrompt: string;
	toolKeys: readonly string[];
	/** Dispatch-time conversation and prefix estimate; opaque content is covered by response usage. */
	conversation: unknown[];
	systemTokens: number;
	response?: AssistantMessage;
	responseSnapshot?: unknown;
}

function isSameResponse(message: AgentMessage, response: AssistantMessage): boolean {
	return (
		message === response ||
		(message.role === "assistant" &&
			!!response.responseId &&
			message.responseId === response.responseId &&
			message.provider === response.provider &&
			message.api === response.api &&
			message.model === response.model)
	);
}

/** Match persisted JSON's optional fields without reserializing large conversation strings. */
function withoutUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => withoutUndefined(item ?? null));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.map(([key, item]) => [key, withoutUndefined(item)]),
	);
}

/** Snapshot provider content; execution checkpoints and request diagnostics are local bookkeeping. */
function snapshotProviderConversation(messages: AgentMessage[]): unknown[] {
	return convertToLlm(messages.filter((message) => message.role !== "system")).map((message) => {
		if (message.role !== "assistant") return withoutUndefined({ ...message, timestamp: 0 });
		const { usage: _usage, diagnostics: _diagnostics, ...response } = message;
		return withoutUndefined({
			...response,
			timestamp: 0,
			content: message.content.map((block) => {
				if (block.type !== "toolCall") return block;
				const {
					executionStarted: _started,
					executionArguments: _arguments,
					executionDetached: _detached,
					...call
				} = block;
				return call;
			}),
		});
	});
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _promptAbortController: AbortController | undefined;
	private readonly _shutdownAbortController = new AbortController();
	private _agentRunAbortRequested = false;
	private readonly _idleWaiters = new Set<() => void>();
	private readonly _deferredSettlement = new AsyncLocalStorage<{ barriers: number }>();

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];
	/** Opted-in streamed customs owned here until message_end, including drained but undelivered messages. */
	private _cancelPersistentCustomMessages = new Set<CustomMessage>();
	/** Provider-bound inputs waiting until request preparation can no longer add a context boundary. */
	private _pendingProviderMessages: AgentMessage[] = [];
	/** Native inputs awaiting handling, admission, queueing, or rejection. */
	private _pendingInputCount = 0;
	/** Idle prompts normalize during admission; queued inputs normalize at native delivery, only once. */
	private _normalizedUserMessages = new WeakSet<UserMessage>();
	private _activeCommands = 0;
	private _settling = 0;
	private _checkpointHeld = false;
	private _checkpointRestored = false;
	private _checkpointActiveTools?: ToolSelection[];
	private _checkpointEntryPersistence?: AbortSignal;
	private readonly _shutdownCheckpointWaiters = new Set<() => void>();
	private _checkpointRequest?: {
		boundary: CheckpointBoundary;
		canQuiesce?: () => boolean;
		run: (boundary: CheckpointBoundary) => Promise<void>;
		cancel: () => void;
	};

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _pendingNewContext: NewContextRequest | undefined;
	private _reportedUsagePrefix: ProviderRequestPrefix | null | undefined;
	private _providerRequestPrefix: ProviderRequestPrefix | undefined;
	private _toolPrefixKeys = new WeakMap<AgentTool, string>();
	private _contextUsageCache?: {
		inputs: unknown;
		prefix: ProviderRequestPrefix | null | undefined;
		usage: ContextUsage;
	};
	private _skipNextProviderRequestPreflight = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantToolResults: AgentMessage[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: ToolSelection[];
	private _noBuiltinTools: boolean;
	private _allowedToolNames?: ToolSelection[];
	private _excludedToolNames?: ToolSelection[];
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionGetQueuedInputCount?: () => number;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolIds = new Map<string, string>();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;
	/** Snapshot of base inputs; navigation replaces only its selected tools, preserving other pending edits. */
	private _baseSystemPromptBaseline!: NormalizedBuildSystemPromptOptions;
	/** Startup discovery completes initial inputs only until a loadout has been prepared. */
	private _hasPreparedPrompt = false;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.agent.requestAdmissionSignal = this._shutdownAbortController.signal;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._noBuiltinTools = config.noBuiltinTools ?? false;
		this._allowedToolNames = config.allowedToolNames?.slice();
		this._excludedToolNames = config.excludedToolNames?.slice();
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		const afterTurn = this.agent.afterTurn;
		this.agent.afterTurn = async (signal) => {
			await afterTurn?.(signal);
			await this._checkpointSafePoint("turn");
		};
		this.agent.prepareSteering = async (message) => {
			if (message.role === "user") await this._normalizeUserMessageImages(message);
		};
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentBoundaryHooks();
		this._installAgentForcedPromptProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		const restoredSystemMessage = getCurrentSystemMessage(this.messages);
		// Resume itself does not schedule a reset of a persisted before_agent_start override.
		// Use the saved selection as the baseline so explicit startup tool changes stay pending.
		this._baseSystemPromptBaseline = normalizeBuildSystemPromptOptions({
			...this._baseSystemPromptOptions,
			selectedTools: restoredSystemMessage
				? (restoredSystemMessage.toolsAdded ?? []).map(toToolReference)
				: this._baseSystemPromptOptions.selectedTools,
		});
		if (this._initialActiveToolNames === undefined) this._restoreToolsFromTranscript();
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		this._shutdownAbortController.signal.throwIfAborted();
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model, signal);
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					namespace: toolCall.namespace,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						namespace: toolCall.namespace,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			const resizeOptions = this.model?.inputLimits?.images?.resize;
			const normalizedContent = await normalizeToolResultImages(content, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				...(resizeOptions ? { resizeOptions } : {}),
			});

			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	private _consumeNewContext(request?: NewContextRequest): AgentContext | undefined {
		const next = request ?? this._pendingNewContext;
		this._pendingNewContext = undefined;
		if (
			!next ||
			this._shutdownAbortController.signal.aborted ||
			this.agent.signal?.aborted ||
			this._autoCompactionAbortController?.signal.aborted
		)
			return undefined;

		if (this.agent.state.pendingToolCalls.size > 0 || this.getPendingToolCalls().length > 0) {
			this._pendingNewContext = next;
			return undefined;
		}
		const handoff = next.handoff?.trim().slice(0, MAX_CONTEXT_HANDOFF_CHARS) || undefined;
		const usage = this.getContextUsage();
		this.sessionManager.appendContextWindow(handoff, usage?.tokens ?? null);
		this._reportedUsagePrefix = null;
		this._refreshFinalizedContext();
		const messages = this.agent.state.messages;

		const marker = messages.find((message) => message.role === "custom" && message.customType === "context-window")!;
		this._emit({ type: "message_start", message: marker });
		this._emit({ type: "message_end", message: marker });
		this._emit({ type: "context_window_started", pendingMessages: this._pendingProviderMessages.slice() });

		return {
			messages: messages.slice(),
			tools: this.agent.state.tools.slice(),
		};
	}

	/** Start a fresh model context while preserving the full session transcript. */
	newContext(options: NewContextRequest = {}): void {
		this._assertNotCheckpointHeld();
		const request = { handoff: options.handoff?.trim() || undefined };
		if (this.isStreaming) {
			this._pendingNewContext = request;
			return;
		}
		this._consumeNewContext(request);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		if (
			!model ||
			model.contextWindow <= 0 ||
			!shouldCompact(this._estimateContextTokens(context).tokens, model.contextWindow, settings)
		) {
			return context;
		}

		await this._runAutoCompaction("threshold", false);
		return this._restorePendingProviderMessages({
			...context,
			messages: this.sessionManager.buildSessionProjection().messages,
		});
	}

	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			this._shutdownAbortController.signal.throwIfAborted();
			const canonicalContext = this._restorePendingProviderMessages({
				...request.context,
				messages: this.sessionManager.buildSessionProjection().messages,
				// Transcript declarations and executable implementations share the same loadout.
				tools: this.agent.state.tools.slice(),
			});
			const previous = await previousPrepareRequest?.(
				{
					...request,
					context: canonicalContext,
					model: this.agent.state.model,
					thinkingLevel: this.agent.state.thinkingLevel,
				},
				signal,
			);
			let prepared = previous?.context ?? canonicalContext;
			if (!this._skipNextProviderRequestPreflight) {
				prepared = await this._compactBeforeNextAssistantResponse(prepared);
			}
			prepared = this._restorePendingProviderMessages(this._consumeNewContext() ?? prepared);
			return {
				...previous,
				context: prepared,
				model: previous?.model ?? this.agent.state.model,
				thinkingLevel: previous?.thinkingLevel ?? this.agent.state.thinkingLevel,
			};
		};

		const previousTransform = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			// Final input/tool declarations can now be persisted exactly once. Refresh the
			// inspection cache without replacing request-only edits from prepareRequest.
			this._flushPendingProviderMessages();
			this._refreshFinalizedContext();
			const model = this.model;
			const systemPrompt = getCurrentSystemPrompt(messages);
			const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
			this._providerRequestPrefix = model
				? {
						provider: model.provider,
						api: model.api,
						model: model.id,
						systemPrompt: getCurrentSystemPrompt(transformed),
						transcriptSystemPrompt: systemPrompt,
						toolKeys: this.agent.state.tools.map((tool) => this._captureToolPrefix(tool)),
						conversation: snapshotProviderConversation(transformed),
						systemTokens: this._projectEstimatedMessages(transformed).reduce(
							(sum, message) => sum + (message.role === "system" ? estimateTokens(message) : 0),
							0,
						),
					}
				: undefined;
			return transformed;
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		this._commitBoundaryDrafts(boundary.entries);
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (this._shutdownAbortController.signal.aborted) return { action: "end" };
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	/**
	 * Keep measured usage for retained conversations, estimating changed prefixes and new input.
	 * Unknown legacy prefixes use the larger of matching usage and the full visible estimate.
	 */
	private _estimateContextTokens(
		context: AgentContext = this.agent.state,
		usageState = this._getContextUsageState(context.messages),
	) {
		const options = { model: this.model, useReportedUsage: usageState.useReportedUsage };
		if (options.useReportedUsage && this._reportedUsageApplies(context)) {
			const messages =
				this._runSystemPromptOptions?.forceSystemPrompt === undefined
					? context.messages
					: context.messages.filter((message) => message.role !== "system");
			return estimateContextTokens(messages, options);
		}
		// Include unsent prompt/tool changes without mutating or persisting the transcript.
		const pendingOptions = this._getPendingSystemPromptOptions();
		const current = getCurrentSystemMessage(context.messages);
		const desired = pendingOptions ? buildSystemPromptState(pendingOptions) : undefined;
		const replace =
			desired &&
			(desired.sections === undefined ||
				(current && (current.sections === undefined || contentText(current.content).length > 0)));
		const sections =
			desired && !replace ? diffSystemPromptSections(current?.sections ?? {}, desired.sections ?? {}) : undefined;
		const changes = getToolStateChanges(getCurrentTools(context.messages), context.tools ?? []);
		const messages: AgentMessage[] = replace
			? [
					...context.messages,
					{
						role: "system",
						...desired,
						replace: true,
						toolsAdded: (context.tools ?? []).map(toToolDeclaration),
						timestamp: Date.now(),
					},
				]
			: sections || changes.toolsAdded.length || changes.toolsRemoved.length
				? [...context.messages, { role: "system", content: "", sections, ...changes, timestamp: Date.now() }]
				: context.messages;
		const forced = pendingOptions?.forceSystemPrompt;
		const estimatedMessages = this._projectEstimatedMessages(messages, forced !== undefined);
		if (options.useReportedUsage && this._reportedConversationApplies(context)) {
			const estimate = estimateContextTokens(
				context.messages.filter((message) => message.role !== "system"),
				options,
			);
			const systemTokens = estimatedMessages.reduce(
				(sum, message) => sum + (message.role === "system" ? estimateTokens(message) : 0),
				0,
			);
			return {
				...estimate,
				tokens: Math.max(0, estimate.tokens + systemTokens - this._reportedUsagePrefix!.systemTokens),
				source: "estimated" as const,
			};
		}
		const fullEstimate = estimateContextTokens(estimatedMessages, { ...options, useReportedUsage: false });
		if (forced !== undefined || this._reportedUsagePrefix !== undefined || !usageState.hasPostCompactionUsage) {
			return fullEstimate;
		}

		const historicalEstimate = estimateContextTokens(context.messages, options);
		return historicalEstimate.tokens > fullEstimate.tokens
			? { ...historicalEstimate, source: "estimated" as const }
			: fullEstimate;
	}

	/** Match native replacement replay for both captured and adjusted prefix estimates. */
	private _projectEstimatedMessages(messages: AgentMessage[], forceCollapse = false): AgentMessage[] {
		return forceCollapse ||
			messages.some((message, index) => index > 0 && message.role === "system" && message.replace)
			? [getCurrentSystemMessage(messages)!, ...messages.filter((message) => message.role !== "system")]
			: messages;
	}

	private _captureToolPrefix(tool: AgentTool): string {
		const key = JSON.stringify(
			toToolDeclaration({ ...tool, constrainedSampling: tool.constrainedSampling || undefined }),
		);
		this._toolPrefixKeys.set(tool, key);
		return key;
	}

	private _reportedConversationApplies(context: AgentContext): boolean {
		const prefix = this._reportedUsagePrefix;
		const model = this.model;
		if (
			!prefix?.response ||
			!model ||
			prefix.provider !== model.provider ||
			prefix.api !== model.api ||
			prefix.model !== model.id
		)
			return false;
		const { lastUsageIndex } = estimateContextTokens(context.messages, { model });
		return (
			lastUsageIndex !== null &&
			isSameResponse(context.messages[lastUsageIndex], prefix.response) &&
			isDeepStrictEqual(
				snapshotProviderConversation([context.messages[lastUsageIndex]])[0],
				prefix.responseSnapshot,
			) &&
			isDeepStrictEqual(snapshotProviderConversation(context.messages.slice(0, lastUsageIndex)), prefix.conversation)
		);
	}

	private _reportedUsageApplies(context: AgentContext): boolean {
		const prefix = this._reportedUsagePrefix;
		if (!prefix || !this._reportedConversationApplies(context)) return false;
		const tools = context.tools ?? [];
		const pendingOptions = this._getPendingSystemPromptOptions();
		const systemPrompt = pendingOptions
			? buildSystemPrompt(pendingOptions)
			: getCurrentSystemPrompt(context.messages);
		return (
			(pendingOptions ? prefix.systemPrompt : prefix.transcriptSystemPrompt) === systemPrompt &&
			prefix.toolKeys.length === tools.length &&
			tools.every(
				(tool, index) =>
					prefix.toolKeys[index] === (this._toolPrefixKeys.get(tool) ?? this._captureToolPrefix(tool)),
			)
		);
	}

	private _getContextUsageState(messages: AgentMessage[]): {
		hasPostCompactionUsage: boolean;
		useReportedUsage: boolean;
	} {
		const model = this.model;
		let invalidated = false;
		let entry = this.sessionManager.getLeafEntry();
		// Walk only to the latest relevant response or boundary. The context meter must
		// not materialize all history on each render, even after many native windows.
		while (entry) {
			if (entry.type === "compaction") return { hasPostCompactionUsage: false, useReportedUsage: false };
			if (entry.type === "context_window") return { hasPostCompactionUsage: true, useReportedUsage: false };
			if (isContextUsageInvalidatingEntry(entry)) invalidated = true;
			if (model && entry.type === "message" && entry.message.role === "assistant") {
				const message = entry.message;
				const entryId = entry.id;
				if (
					message.provider === model.provider &&
					message.api === model.api &&
					message.model === model.id &&
					message.stopReason !== "aborted" &&
					message.stopReason !== "error" &&
					message.usage &&
					calculateContextTokens(message.usage) > 0 &&
					messages.some(
						(projected) =>
							isSameResponse(projected, message) || this._entryIdsByMessage.get(projected) === entryId,
					)
				) {
					return { hasPostCompactionUsage: true, useReportedUsage: !invalidated };
				}
			}
			entry = entry.parentId ? this.sessionManager.getEntry(entry.parentId) : undefined;
		}
		return { hasPostCompactionUsage: true, useReportedUsage: false };
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = this._consumeNewContext(turn.newContext) ?? {
				...turn.context,
				messages: this.sessionManager.buildSessionProjection().messages,
			};
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolReferences(),
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	private _restorePendingProviderMessages(context: AgentContext): AgentContext {
		for (const message of this._pendingProviderMessages) {
			if (!context.messages.includes(message)) context.messages.push(message);
			if (!this.agent.state.messages.includes(message)) this.agent.state.messages.push(message);
		}
		return context;
	}

	private _persistMessage(message: AgentMessage): void {
		let entryId: string | undefined;
		if (message.role === "custom") {
			entryId = this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} else if (
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult"
		) {
			entryId = this.sessionManager.appendMessage(
				message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.async)
					? structuredClone(message)
					: message,
			);
		}
		if (entryId) this._entryIdsByMessage.set(message, entryId);
	}

	private _flushPendingProviderMessages(): void {
		while (this._pendingProviderMessages.length > 0) {
			// SessionManager updates its tree before I/O; an I/O error must not append the input twice.
			this._persistMessage(this._pendingProviderMessages.shift()!);
		}
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private async _emitRetryEvent(
		event:
			| AutoRetryStartEvent
			| AutoRetryEndEvent
			| SummarizationRetryScheduledEvent
			| SummarizationRetryAttemptStartEvent
			| SummarizationRetryFinishedEvent,
	): Promise<void> {
		await this._extensionRunner.emit(event);
		this._emit(event);
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _resolveIdleWaitIfIdle(): void {
		this.notifyCheckpointStateChanged();
		if (!this.isIdle) return;
		for (const notify of this._idleWaiters) notify();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		this._settling++;
		this._isEmittingAgentSettled = true;
		try {
			try {
				const pendingToolCalls = this.getPendingToolCalls();
				const event = { type: "agent_settled" as const, ...(pendingToolCalls.length ? { pendingToolCalls } : {}) };
				await this._extensionRunner.emit(event);
				this._emit(event);
			} finally {
				this._isEmittingAgentSettled = false;
			}
			// Deferred closures are not checkpoint queues. Keep the barrier until the last
			// action starts; its native run then owns ordinary turn and settlement cuts.
			const deferred = this._deferredSettledActions.splice(0);
			const last = deferred.pop();
			for (const action of deferred) {
				// An action may join child work, but cannot wait for its own enclosing drain.
				const scope = { barriers: this._settling };
				try {
					await this._deferredSettlement.run(scope, action);
				} finally {
					scope.barriers = 0;
				}
			}
			if (last) {
				this._settling--;
				try {
					await last();
				} finally {
					this._settling++;
				}
			}
		} finally {
			this._settling--;
			await this._checkpointSafePoint("settled");
			this._resolveIdleWaitIfIdle();
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "message_checkpoint") {
			this._flushPendingProviderMessages();
			const entryId = this.sessionManager.appendMessage(structuredClone(event.message), true);
			this._entryIdsByMessage.set(event.message, entryId);
			this._emit(event);
			return;
		}
		if (event.type === "steering") {
			// Status is independent of input delivery. An accepted send is not application.
			this.sessionManager.appendCustomEntry("response-steering", {
				message: event.message,
				status: event.status,
				steeringId: event.steeringId,
				responseId: event.responseId,
				errorMessage: event.errorMessage,
			});
			await this._extensionRunner.emit(event);
			this._emit(event);
			return;
		}
		if (event.type === "tool_execution_prepared" || event.type === "tool_execution_detached") {
			await this._extensionRunner.emit(event);
			this._emit(event);
			return;
		}
		const requestEnded = event.type === "message_end" && event.message.role === "assistant";
		const requestPrefix = requestEnded ? this._providerRequestPrefix : undefined;
		const responseSnapshot =
			event.type === "message_end" && event.message.role === "assistant"
				? snapshotProviderConversation([event.message])[0]
				: undefined;
		if (requestEnded) this._skipNextProviderRequestPreflight = false;
		if (event.type === "agent_end") this._providerRequestPrefix = undefined;
		if (event.type === "message_start" && event.message.role === "assistant") {
			if (this._providerRequestPrefix && event.continuationInput !== undefined) {
				this._providerRequestPrefix = {
					...this._providerRequestPrefix,
					conversation: [
						...this._providerRequestPrefix.conversation,
						...snapshotProviderConversation([...event.continuationInput]),
					],
				};
			}
			this._flushPendingProviderMessages();
		}

		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			// An "all" drain owns the entire batch before its first message starts. Reflect
			// native ownership before yielding so clearQueue cannot restore already-drained text.
			// Matching the current message by text would also remove undrained duplicates.
			const queues = this.agent.getQueuedMessages();
			const steering = queues.steering
				.filter((message) => message.role === "user")
				.map((message) => contentText(message.content, ""));
			const followUp = queues.followUp
				.filter((message) => message.role === "user")
				.map((message) => contentText(message.content, ""));
			if (
				steering.length !== this._steeringMessages.length ||
				followUp.length !== this._followUpMessages.length ||
				steering.some((text, index) => text !== this._steeringMessages[index]) ||
				followUp.some((text, index) => text !== this._followUpMessages[index])
			) {
				this._steeringMessages = steering;
				this._followUpMessages = followUp;
				this._emitQueueUpdate();
			}
			// The loop owns this await after draining the native queue. Awaiting image work in
			// _queueSteer/_queueFollowUp instead could enqueue after the run has already settled.
			// Finish accepted delivery even on abort; request preflight prevents further dispatch.
			await this._normalizeUserMessageImages(event.message);
		}

		// Emit to extensions first, then notify public listeners.
		await this._emitExtensionEvent(event);

		if (requestPrefix && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			if (
				requestPrefix.provider === message.provider &&
				requestPrefix.api === message.api &&
				requestPrefix.model === message.model &&
				message.stopReason !== "error" &&
				message.stopReason !== "aborted" &&
				calculateContextTokens(message.usage) > 0
			) {
				this._reportedUsagePrefix = {
					...requestPrefix,
					response: message,
					responseSnapshot,
				};
			}
			this._providerRequestPrefix = {
				...requestPrefix,
				conversation: [...requestPrefix.conversation, responseSnapshot],
			};
		}

		try {
			this._emit(
				event.type === "agent_end"
					? {
							...event,
							willRetry: this._willRetryAfterAgentEnd(event),
							...(this.getPendingToolCalls().length ? { pendingToolCalls: this.getPendingToolCalls() } : {}),
						}
					: event,
			);
		} finally {
			// A throwing subscriber must not skip persistence of the completed message.
			if (event.type === "message_end") {
				if (
					this._isAgentRunActive &&
					(event.message.role === "system" || event.message.role === "user" || event.message.role === "custom")
				) {
					this._pendingProviderMessages.push(event.message);
					if (event.message.role === "custom") this._cancelPersistentCustomMessages.delete(event.message);
				} else {
					this._persistMessage(event.message);
				}
				// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere
			}
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			const assistantMsg = event.message as AssistantMessage;
			this._lastAssistantMessage = assistantMsg;
			if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
				this._overflowRecoveryAttempted = false;
			}

			// Reset retry counter immediately on successful assistant response
			// This prevents accumulation across multiple LLM calls within a turn
			if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
				await this._emitRetryEvent({
					type: "auto_retry_end",
					success: true,
					attempt: this._retryAttempt,
				});
				this._retryAttempt = 0;
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._lastAssistantToolResults = event.toolResults;
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	private _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): void {
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		// Native admission precedes preflight; even a blocked call owns its recorded result.
		const committedCallIds = new Set(
			message.content.flatMap((block) =>
				block.type === "toolCall" && (block.executionStarted || (block.async && block.responsesItem))
					? [block.id]
					: [],
			),
		);
		for (const [index, targetId] of targetIds.entries()) {
			if (!targetId) continue;
			const target = targets[index];
			// Late async results can belong to earlier responses; omit only this attempt's removed calls.
			if (
				target.role === "toolResult" &&
				(committedCallIds.has(target.toolCallId) ||
					!message.content.some((block) => block.type === "toolCall" && block.id === target.toolCallId))
			)
				continue;
			const committed =
				target?.role === "assistant" && committedCallIds.size > 0
					? target.content.filter((block) =>
							block.type === "toolCall"
								? committedCallIds.has(block.id)
								: block.type === "text"
									? !!block.textSignature
									: !!block.thinkingSignature,
						)
					: [];
			// Retained reasoning must still have a following completed text or call.
			while (committed.at(-1)?.type === "thinking") committed.pop();
			const editId = this.sessionManager.appendContextEdit(
				targetId,
				committed.length > 0 ? { content: committed } : null,
			);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		this._refreshFinalizedContext();
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				namespace: event.namespace,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				namespace: event.namespace,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				namespace: event.namespace,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/** Close admission before host cleanup yields. Active responses are aborted only at final disposal. */
	beginShutdown(): void {
		this._cacheWarmer?.cancel();
		this._checkpointRequest?.cancel();
		this._shutdownAbortController.abort();
		this._promptAbortController?.abort();
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._checkpointRequest?.cancel();
		this._shutdownAbortController.abort();
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this._promptAbortController?.abort();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			this._cacheWarmer.cancel();
		}
		cleanupSessionResources(this.sessionId);
		this._deferredSettlement.disable();
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._assertNotCheckpointHeld();
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Native call obligations in the active branch/window. Detached work can remain after local idle. */
	getPendingToolCalls(): ReturnType<typeof getPendingToolCalls> {
		return getPendingToolCalls(this.agent.state.messages);
	}

	/** Current cache-warming state and the policy inputs that produced it. */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	/** Persist the cache-warming mode and immediately reconcile active warming. */
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this._assertNotCheckpointHeld();
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.selectedModel;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is preparing an admitted prompt, running the agent, or continuing it. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		const pendingOptions = this._getPendingSystemPromptOptions();
		return pendingOptions ? buildSystemPrompt(pendingOptions) : getCurrentSystemPrompt(this.messages);
	}

	private _getPendingSystemPromptOptions(): NormalizedBuildSystemPromptOptions | undefined {
		if (this._runSystemPromptOptions) return this._runSystemPromptOptions;
		// Structured before_agent_start edits remain in the transcript after a run ends.
		// Forced text is request-only; saved replacement records still replay until the next run.
		// Compare rendered inputs so mutable getSystemPromptOptions() edits are detected too.
		// Empty contexts need the initial prompt, but do not erase the baseline used when navigating back.
		return getCurrentSystemMessage(this.messages) &&
			buildSystemPrompt(this._baseSystemPromptOptions) === buildSystemPrompt(this._baseSystemPromptBaseline)
			? undefined
			: this._baseSystemPromptOptions;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/** Return every active tool's public ID, accepted by setActiveToolsByName. */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(toolId);
	}

	/** Return the complete active loadout with exact namespace/name identities. */
	getActiveToolReferences(): ToolReference[] {
		return this.agent.state.tools.map(toToolReference);
	}

	/** Get all permitted tools with public IDs, declarations, and source metadata. */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			id: toolId(definition),
			...toToolReference(definition),
			...(definition.toolSearch ? { toolSearch: definition.toolSearch } : {}),
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: ToolSelection): ToolDefinition | undefined {
		return this._toolDefinitions.get(this._toolSelectionKey(name))?.definition;
	}

	/** Replace the complete active loadout by public ID; unknown IDs are ignored. */
	setActiveToolsByName(toolNames: string[]): void {
		this._setActiveTools(toolNames);
	}

	private _toolSelectionKey(tool: ToolSelection): string {
		return typeof tool === "string" ? (this._toolIds.get(tool) ?? toolKey(tool)) : toolKey(tool);
	}

	setActiveToolReferences(references: ToolReference[]): void {
		this._setActiveTools(references);
	}

	private _setActiveTools(references: ToolSelection[]): void {
		this._assertNotCheckpointHeld();
		const selected = new Map<string, AgentTool>();
		for (const reference of references) {
			const key = this._toolSelectionKey(reference);
			const tool = this._toolRegistry.get(key);
			if (tool) selected.set(key, tool);
		}
		this.agent.state.tools = [...selected.values()];
		this._rebuildSystemPrompt(this.getActiveToolReferences());
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._assertNotCheckpointHeld();
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: ToolSelection[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(this._toolSelectionKey(name)));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * {@link _installAgentForcedPromptProjection}.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = [...new Map(options.selectedTools.map((tool) => [toolKey(tool), tool])).values()].filter(
			(tool) => this._toolRegistry.has(this._toolSelectionKey(tool)),
		);
		this.agent.state.tools = options.selectedTools.flatMap((name) => {
			const tool = this._toolRegistry.get(this._toolSelectionKey(name));
			return tool ? [tool] : [];
		});
		this._baseSystemPromptBaseline = normalizeBuildSystemPromptOptions(this._baseSystemPromptOptions);
		this._hasPreparedPrompt = true;
		const current = getCurrentSystemMessage(messages);
		const desired = buildSystemPromptSections(options);
		// Saved full-prompt replacements must not become a permanent opaque prefix.
		if (current && (current.sections === undefined || contentText(current.content).length > 0)) {
			return { role: "system", content: "", sections: desired, replace: true, timestamp: Date.now() };
		}
		const sections = diffSystemPromptSections(current?.sections ?? {}, desired);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (this._providerRequestPrefix) {
				this._providerRequestPrefix.systemPrompt = forced ?? getCurrentSystemPrompt(transformed);
			}
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			if (this._providerRequestPrefix) this._providerRequestPrefix.systemTokens = estimateTokens(head);
			return [head, ...withoutToolSearchState(transformed.filter((message) => message.role !== "system"))];
		};
	}

	/** Restore the active tool loadout declared by the session transcript, if it declares one. */
	private _restoreToolsFromTranscript(): void {
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const toolNames = (current.toolsAdded ?? [])
			.map(toToolReference)
			.filter((tool) => this._toolRegistry.has(this._toolSelectionKey(tool)));
		this.agent.state.tools = toolNames.flatMap((name) => {
			const registered = this._toolRegistry.get(toolKey(name));
			return registered ? [registered] : [];
		});
		// Restoration changes the selected tools, not local prompt edits or loaded resources.
		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			...this._baseSystemPromptOptions,
			selectedTools: toolNames,
		});
		// The destination supersedes pending tool selections on both sides of the comparison.
		// All other baseline inputs remain unchanged, so genuine prompt/resource edits still differ.
		this._baseSystemPromptBaseline = { ...this._baseSystemPromptBaseline, selectedTools: toolNames };
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(prepare: (signal: AbortSignal) => Promise<() => AgentMessage[]>): Promise<void> {
		this._assertNotCheckpointHeld();
		this._shutdownAbortController.signal.throwIfAborted();
		if (this._checkpointActiveTools) throw new Error("Checkpoint restore requires extension initialization");
		if (this._isAgentRunActive || this.agent.state.isStreaming) {
			throw new Error("Agent is already processing.");
		}
		this._agentRunAbortRequested = false;
		this._isAgentRunActive = true;
		const controller = new AbortController();
		this._promptAbortController = controller;
		const previousBaseSystemPromptBaseline = this._baseSystemPromptBaseline;
		let started = false;
		try {
			const accept = await prepare(controller.signal);
			controller.signal.throwIfAborted();
			const messages = accept();
			this._skipNextProviderRequestPreflight = this.agent.state.messages.length === 0;
			started = true;
			let run = this.agent.prompt(messages);
			while (true) {
				// Keep extension cancellation alive when the low-level Agent releases its signal.
				const signal = this.agent.signal;
				const abort = () => controller.abort(signal?.reason);
				if (signal?.aborted) abort();
				signal?.addEventListener("abort", abort, { once: true });
				try {
					await run;
				} finally {
					signal?.removeEventListener("abort", abort);
				}
				const continueRun = await this._handlePostAgentRun(signal);
				if (this._agentRunAbortRequested || signal?.aborted || this._shutdownAbortController.signal.aborted) break;
				if (!continueRun && !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested || this._shutdownAbortController.signal.aborted) break;
				run = this.agent.continue();
			}
		} catch (error) {
			if (!started) controller.signal.throwIfAborted();
			throw error;
		} finally {
			try {
				if (controller.signal.aborted) this._pendingNewContext = undefined;
				this._skipNextProviderRequestPreflight = false;
				if (this._agentRunAbortRequested) await this._finishCancelledRetry();
				this._runSystemPromptOptions = undefined;
				if (!started) this._baseSystemPromptBaseline = previousBaseSystemPromptBaseline;
				// No further retry or continuation can deliver these messages. Recover both queued
				// and drained-but-undelivered customs without starting another turn.
				this._preserveUndeliveredCustomMessages(true);
				this._flushPendingProviderMessages();
				this._flushPendingBashMessages();
				this._flushPendingCustomMessages();
			} finally {
				this._promptAbortController = undefined;
				if (started) {
					await this._emitAgentSettled();
				} else {
					this._isAgentRunActive = false;
					this._resolveIdleWaitIfIdle();
				}
			}
		}
	}

	private async _prepareAgentStart(prompt: string, images?: ImageContent[]): Promise<AgentMessage[]> {
		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
		const result = await this._extensionRunner.emitBeforeAgentStart(prompt, images, this._baseSystemPromptOptions);
		// Explicit selectedTools edits win; otherwise honor live setActiveTools() calls.
		const handlerEditedTools =
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			result.systemPromptOptions.selectedTools.some(
				(name, index) => toolKey(name) !== toolKey(selectedToolsBefore[index]),
			);
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolReferences();
		const messages: AgentMessage[] = result.messages.map((message) => ({
			role: "custom",
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		}));
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);
		return messages;
	}

	private async _handlePostAgentRun(signal: AbortSignal | undefined): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (
			this._agentRunAbortRequested ||
			this._shutdownAbortController.signal.aborted ||
			signal?.aborted ||
			message?.stopReason === "aborted"
		) {
			this._pendingNewContext = undefined;
			await this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (this._consumeNewContext()) {
			return message.stopReason !== "stop" || this.agent.hasQueuedMessages();
		}

		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			if (this._agentRunAbortRequested) await this._finishCancelledRetry();
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			await this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			await this._emitRetryEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		const compacted = await this._checkCompaction(message, true, toolResults);
		if (this._agentRunAbortRequested || this._shutdownAbortController.signal.aborted) return false;
		if (this._consumeNewContext()) {
			return message.stopReason !== "stop" || this.agent.hasQueuedMessages();
		}
		if (compacted) return true;

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	private async _normalizeUserMessageImages(message: UserMessage): Promise<void> {
		if (this._normalizedUserMessages.has(message) || typeof message.content === "string") return;
		if (!message.content.some((part) => part.type === "image")) return;

		const content: (TextContent | ImageContent)[] = [];
		const hints: string[] = [];
		for (const part of message.content) {
			if (part.type === "text") {
				content.push(part);
				continue;
			}
			const processed = await processImage(Buffer.from(part.data, "base64"), part.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this.model?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			content.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		// Keep the prompt hint convention without flattening structured Agent inputs:
		// text blocks and surviving images retain their original order and boundaries.
		if (hints.length > 0) {
			const textIndex = content.findIndex((part) => part.type === "text");
			const text = content[textIndex];
			const hintText = `\n\n${hints.join("\n")}`;
			if (text?.type === "text") content[textIndex] = { ...text, text: text.text + hintText };
			else content.unshift({ type: "text", text: hintText });
		}
		message.content = content;
		this._normalizedUserMessages.add(message);
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		this._assertNotCheckpointHeld();
		this._shutdownAbortController.signal.throwIfAborted();
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => await this.prompt(text, options));
			return;
		}
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		let preflightComplete = false;
		let pendingInput = false;
		const preflightResult = (success: boolean) => {
			preflightComplete = true;
			if (pendingInput) {
				pendingInput = false;
				this._pendingInputCount--;
			}
			options?.preflightResult?.(success);
		};

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult(true);
					return;
				}
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			this._pendingInputCount++;
			pendingInput = true;

			// Emit input event for extension interception (before skill/template expansion)
			const processedInput = await this._runInputHandlers(
				text,
				options?.images,
				options?.source ?? "interactive",
				this.isStreaming ? options?.streamingBehavior : undefined,
			);
			if (!processedInput) {
				preflightResult(true);
				return;
			}
			const { text: currentText, images: currentImages } = processedInput;

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult(true);
				return;
			}

			await this._runAgentPrompt(async (signal) => {
				// Reserve before auth, compaction, or startup hooks can yield and mutate shared run state.
				this._flushPendingBashMessages();
				this._flushPendingCustomMessages();

				// Validate model
				if (!this.model) {
					throw new Error(formatNoModelSelectedMessage());
				}

				const hasConfiguredAuth =
					this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
					(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
				signal.throwIfAborted();
				if (!hasConfiguredAuth) {
					const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
					if (isOAuth) {
						throw new Error(
							`Authentication failed for "${this.model.provider}". ` +
								`Credentials may have expired or network is unavailable. ` +
								`Run '/login ${this.model.provider}' to re-authenticate.`,
						);
					}
					throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
				}

				// Consume only these asides after startup succeeds; asides added by the hook stay queued.
				const nextTurnMessages = this._pendingNextTurnMessages.slice();
				const startupMessages = await this._prepareAgentStart(expandedText, currentImages);
				signal.throwIfAborted();
				// Hook-driven model selection determines the resize profile for request and history.
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: expandedText }, ...(currentImages ?? [])],
					timestamp: Date.now(),
				};
				await this._normalizeUserMessageImages(userMessage);
				signal.throwIfAborted();
				const messages: AgentMessage[] = [userMessage, ...nextTurnMessages];
				// Renew request-only guidance before checking the budget, but keep compaction
				// inside admission. Provider preflight also counts the new input and asides.
				const lastAssistant = this._findLastAssistantMessage();
				if (lastAssistant) {
					await this._checkCompaction(lastAssistant, false);
				}
				signal.throwIfAborted();
				messages.unshift(...startupMessages.filter((message) => message.role === "system"));
				messages.push(...startupMessages.filter((message) => message.role !== "system"));
				return () => {
					preflightResult(true);
					signal.throwIfAborted();
					// No await between consuming these asides and handing them to Agent.
					this._pendingNextTurnMessages.splice(0, nextTurnMessages.length);
					return messages;
				};
			});
		} catch (error) {
			if (!preflightComplete) preflightResult(false);
			throw error;
		} finally {
			await this._checkpointSafePoint("settled");
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		this._activeCommands++;
		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		} finally {
			this._activeCommands--;
			await this._checkpointSafePoint("settled");
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<void> {
		this._assertNotCheckpointHeld();
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		this._pendingInputCount++;
		try {
			const processedInput = await this._runInputHandlers(
				text,
				images,
				source,
				this.isStreaming ? behavior : undefined,
			);
			if (!processedInput) return;

			let expandedText = this._expandSkillCommand(processedInput.text);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

			if (behavior === "steer") {
				await this._queueSteer(expandedText, processedInput.images);
			} else {
				await this._queueFollowUp(expandedText, processedInput.images);
			}
		} finally {
			this._pendingInputCount--;
			await this._checkpointSafePoint("settled");
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void> {
		await this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void> {
		await this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		const queuedTexts = this._steeringMessages;
		queuedTexts.push(text);
		try {
			this._emitQueueUpdate();
		} catch (error) {
			queuedTexts.pop();
			throw error;
		}
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		const queuedTexts = this._followUpMessages;
		queuedTexts.push(text);
		try {
			this._emitQueueUpdate();
		} catch (error) {
			queuedTexts.pop();
			throw error;
		}
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({ role: "user", content, timestamp: Date.now() });
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 * @param options.persistOnCancel Preserve undelivered streamed messages without waking on cancellation, final stop, or clearQueue. Ignored for nextTurn.
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			persistOnCancel?: boolean;
		},
	): Promise<void> {
		this._assertNotCheckpointHeld();
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.persistOnCancel) this._cancelPersistentCustomMessages.add(appMessage);
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			if (this._isEmittingAgentSettled) {
				this._deferredSettledActions.push(async () => await this.sendCustomMessage(appMessage, options));
				return;
			}
			await this._runAgentPrompt(async () => {
				const startupMessages = await this._prepareAgentStart("");
				const messages = [
					...startupMessages.filter((message) => message.role === "system"),
					appMessage,
					...startupMessages.filter((message) => message.role !== "system"),
				];
				return () => messages;
			});
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _preserveUndeliveredCustomMessages(includeInFlight = false): void {
		if (this._cancelPersistentCustomMessages.size === 0) return;
		const queued = this.agent.takeQueuedMessages(
			(message) => message.role === "custom" && this._cancelPersistentCustomMessages.has(message),
		);
		// clearQueue may only take actual queue entries; an in-flight message can still
		// reach message_end. Final run cleanup also recovers messages lost after a drain.
		for (const message of includeInFlight ? this._cancelPersistentCustomMessages : queued) {
			if (message.role !== "custom") continue;
			this._cancelPersistentCustomMessages.delete(message);
			this._pendingCustomMessages.push(message);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		// Appending one accepted message does not change the earlier projection. Keep it
		// inspectable even if the journal's subsequent disk write fails.
		this.agent.state.messages.push(appMessage);
		this._persistMessage(appMessage);
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		while (this._pendingCustomMessages.length > 0) {
			// SessionManager owns the attempted entry even if persistence fails.
			this._appendCustomMessage(this._pendingCustomMessages.shift()!);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear queued steering/follow-up messages and return their user text.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		this._assertNotCheckpointHeld();
		this._preserveUndeliveredCustomMessages();
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		if (!this.isStreaming) {
			this._flushPendingProviderMessages();
			this._flushPendingCustomMessages();
		}
		return { steering, followUp };
	}

	/** Whether steering/follow-up messages await delivery, including custom messages but not context-only asides. */
	get hasPendingMessages(): boolean {
		return this.agent.hasQueuedMessages();
	}

	/** Inputs awaiting preflight or queueing, or held by the bound mode; excludes dispatched extension commands. */
	get pendingInputCount(): number {
		return this._pendingInputCount + (this._extensionGetQueuedInputCount?.() ?? 0);
	}

	/** Number of context-only asides awaiting the next user prompt; not yet persisted. */
	get pendingNextTurnCount(): number {
		return this._pendingNextTurnMessages.length;
	}

	/** Number of pending user texts shown in the steering/follow-up UI. */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Pending non-user steering/follow-up messages, retained in the native agent queues. */
	get pendingCustomMessageCount(): number {
		const queues = this.agent.getQueuedMessages();
		return [...queues.steering, ...queues.followUp].filter((message) => message.role !== "user").length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	private async _flushCheckpointSettings(): Promise<void> {
		await this.settingsManager.flush({ requireSuccessfulPersistence: true });
		const errors = this.settingsManager.drainErrors();
		if (errors.length)
			throw new Error(`Settings checkpoint failed: ${errors.map((error) => error.error.message).join("; ")}`);
	}

	private _captureCheckpoint(boundary: CheckpointBoundary): SessionCheckpoint {
		if (this._checkpointActiveTools) throw new Error("Checkpoint restore requires extension initialization");
		const sessionFile = this.sessionFile;
		const header = this.sessionManager.getHeader();
		if (!sessionFile || !header) throw new Error("Checkpoint requires a persistent session");
		// Both live and clean-exit capture must reconcile accepted entries after failed I/O.
		this.sessionManager.flush();
		const checkpoint: SessionCheckpoint = {
			version: 1,
			createdAt: new Date().toISOString(),
			selection: {
				sessionFile,
				sessionId: this.sessionId,
				cwd: this._cwd,
				leafId: this.sessionManager.getLeafId(),
				model: this.model ? { provider: this.model.provider, id: this.model.id } : undefined,
				thinkingLevel: this.thinkingLevel,
				activeTools: this.getActiveToolNames(),
				knownTools: this.getAllTools().map((tool) => tool.id),
			},
			header,
			entries: this.sessionManager.getEntries(),
			queues: this.getCheckpointQueues(),
			toolConfiguration: {
				noBuiltinTools: this._noBuiltinTools || undefined,
				allowedToolNames: this._allowedToolNames ? [...this._allowedToolNames] : undefined,
				excludedToolNames: this._excludedToolNames ? [...this._excludedToolNames] : undefined,
			},
			scopedModels: this._scopedModels.map(({ model, thinkingLevel }) => ({
				provider: model.provider,
				id: model.id,
				thinkingLevel,
			})),
			boundary,
			settled: boundary === "settled" && this.isIdle,
		};
		// Both held and final-exit artifacts use the same native snapshot and JSON validation.
		return JSON.parse(JSON.stringify(checkpoint)) as SessionCheckpoint;
	}

	private _notifyShutdownCheckpointWaiters(): void {
		for (const notify of this._shutdownCheckpointWaiters) notify();
	}

	/** After shutdown hooks, cancel and join actual native work without consuming accepted remaining queues. */
	async finishShutdownForCheckpoint(): Promise<void> {
		if (!this._shutdownAbortController.signal.aborted) throw new Error("Session shutdown has not begun");
		this.abortBash();
		await this.abort();
		while (!this._isShutdownCheckpointSettled()) {
			let notify!: () => void;
			await new Promise<void>((resolve) => {
				notify = resolve;
				this._shutdownCheckpointWaiters.add(notify);
			});
			this._shutdownCheckpointWaiters.delete(notify);
		}
	}

	private _isShutdownCheckpointSettled(): boolean {
		return (
			this.isIdle &&
			!this.agent.state.isStreaming &&
			!this._settling &&
			!this._pendingInputCount &&
			!this._activeCommands &&
			!this.isBashRunning &&
			!this.isRetrying &&
			this.agent.state.pendingToolCalls.size === 0 &&
			!this._extensionRunner.checkpointActivity.busy
		);
	}

	/** Caller owns stopped ingress and completed shutdown handlers. Never use this as a live-process sleep receipt. */
	async captureShutdownCheckpoint(): Promise<ShutdownCheckpoint> {
		if (!this._shutdownAbortController.signal.aborted) throw new Error("Session shutdown has not begun");
		this._flushPendingProviderMessages();
		this._flushPendingBashMessages();
		this._flushPendingCustomMessages();
		await this._modelRuntime.flushForCheckpoint({ requireSuccessfulPersistence: true });
		const controller = new AbortController();
		const invalidate = () => controller.abort(new Error("Late native activity invalidated clean-exit capture"));
		const releases: Array<() => void> = [];
		const release = () => {
			for (const done of releases.splice(0)) done();
			controller.abort();
		};
		try {
			releases.push(this._modelRuntime.holdForCheckpoint(invalidate));
			releases.push(this._extensionRunner.checkpointActivity.hold(invalidate));
			await this._flushCheckpointSettings();
			controller.signal.throwIfAborted();
			if (!this._isShutdownCheckpointSettled() || this.pendingInputCount)
				throw new Error("Unfinished native callbacks or input prevent a clean-exit checkpoint");
			if (this.model && this._modelRuntime.getProviderAuthStatus(this.model.provider).source === "runtime")
				throw new Error("Runtime-only API key cannot be restored from a clean-exit checkpoint");
			return { checkpoint: this._captureCheckpoint("settled"), signal: controller.signal, release };
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Acquire a completed-turn or fully settled native hold. Never call from an awaited run handler. */
	async acquireCheckpoint(options: CheckpointOptions = {}): Promise<CheckpointHold> {
		if (this._checkpointRequest) return Promise.reject(new Error("Checkpoint already requested"));
		this._shutdownAbortController.signal.throwIfAborted();
		options.signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const holdController = new AbortController();
			let released = false;
			let unquiesce: (() => void) | undefined;
			const releaseWriters: Array<() => void> = [];
			let resume: (() => void) | undefined;
			const release = () => {
				if (released) return;
				released = true;
				this._checkpointHeld = false;
				this._checkpointRequest = undefined;
				options.signal?.removeEventListener("abort", cancel);
				holdController.abort();
				for (const releaseWriter of releaseWriters) releaseWriter();
				try {
					unquiesce?.();
				} finally {
					resume?.();
				}
			};
			const cancel = () => {
				reject(new Error("Checkpoint cancelled"));
				release();
			};
			this._checkpointRequest = {
				boundary: options.boundary ?? "settled",
				canQuiesce: options.canQuiesce,
				cancel,
				run: async (boundary) => {
					if (released) return;
					this._checkpointHeld = true;
					this._cacheWarmer?.cancel();
					const held = new Promise<void>((done) => {
						resume = done;
					});
					try {
						unquiesce = options.quiesce?.();
						this._flushPendingProviderMessages();
						this._flushPendingBashMessages();
						this._flushPendingCustomMessages();
						this._checkpointEntryPersistence = holdController.signal;
						let sleepBlockers: string[];
						try {
							sleepBlockers = await this._extensionRunner.prepareCheckpoint({
								type: "session_checkpoint",
								boundary,
								signal: holdController.signal,
								invalidate: cancel,
							});
						} finally {
							if (this._checkpointEntryPersistence === holdController.signal)
								this._checkpointEntryPersistence = undefined;
						}
						if (released) return;
						await this._modelRuntime.flushForCheckpoint();
						if (released) return;
						releaseWriters.push(this._modelRuntime.holdForCheckpoint(cancel));
						releaseWriters.push(this._extensionRunner.checkpointActivity.hold(cancel));
						await this._flushCheckpointSettings();
						if (released) return;
						const checkpoint = this._captureCheckpoint(boundary);
						if (this.model && this._modelRuntime.getProviderAuthStatus(this.model.provider).source === "runtime")
							sleepBlockers.push(
								"Selected provider uses a runtime-only API key; persist native authentication first",
							);
						if (!options.quiesce) sleepBlockers.push("Host input is not quiesced");
						if (!checkpoint.settled) sleepBlockers.push("Native run has not settled");
						resolve({
							checkpoint,
							sleepReady: sleepBlockers.length === 0,
							sleepBlockers,
							signal: holdController.signal,
							release,
						});
						await held;
					} catch (error) {
						reject(error);
					} finally {
						release();
					}
				},
			};
			options.signal?.addEventListener("abort", cancel, { once: true });
			if (this.isIdle && !this._settling) void this._checkpointSafePoint("settled");
		});
	}

	private async _checkpointSafePoint(boundary: CheckpointBoundary): Promise<void> {
		this._notifyShutdownCheckpointWaiters();
		const request = this._checkpointRequest;
		if (!request || this._checkpointHeld || this._settling || (boundary === "turn" && request.boundary === "settled"))
			return;
		if (
			this.pendingInputCount ||
			this._activeCommands ||
			this._extensionRunner.checkpointActivity.busy ||
			this.isBashRunning ||
			this.isCompacting ||
			this.isRetrying ||
			this.agent.state.pendingToolCalls.size > 0 ||
			(boundary === "settled" && (!this.isIdle || this.agent.state.isStreaming)) ||
			(request.canQuiesce && !request.canQuiesce())
		)
			return;
		await request.run(boundary);
	}

	/** Native host callbacks call this after releasing mode-held input or finishing asynchronous UI work. */
	notifyCheckpointStateChanged(): void {
		this._notifyShutdownCheckpointWaiters();
		if (this._checkpointRequest && !this._checkpointHeld)
			setImmediate(() => void this._checkpointSafePoint("settled"));
	}

	get isCheckpointHeld(): boolean {
		return this._checkpointHeld;
	}

	/** Invalidate a pending or acquired hold without interrupting the agent's work. */
	cancelCheckpoint(): void {
		this._checkpointRequest?.cancel();
	}

	private _assertNotCheckpointHeld(): void {
		if (this._checkpointHeld) {
			this.cancelCheckpoint();
			throw new Error("Session is held for checkpoint; hold invalidated, retry after release");
		}
	}

	getCheckpointQueues(): SessionCheckpointQueues {
		const queues = this.agent.getQueuedMessages();
		return structuredClone({
			...queues,
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			nextTurn: this._pendingNextTurnMessages,
			persistOnCancel: [...queues.steering, ...queues.followUp].flatMap((message, index) =>
				message.role === "custom" && this._cancelPersistentCustomMessages.has(message) ? [index] : [],
			),
		});
	}

	/** Startup handlers may reconstruct tools; apply the exact saved selection after they finish. */
	restoreCheckpointTools(names: ToolSelection[], configuration?: SessionCheckpoint["toolConfiguration"]): void {
		this._assertNotCheckpointHeld();
		if (configuration) {
			this._noBuiltinTools = configuration.noBuiltinTools ?? false;
			this._allowedToolNames = configuration.allowedToolNames?.slice();
			this._excludedToolNames = configuration.excludedToolNames?.slice();
			this._refreshToolRegistry();
		}
		this._checkpointActiveTools = [...names];
		this._setActiveTools(names);
		if (!this.hasExtensionHandlers("session_start") && !this.hasExtensionHandlers("resources_discover"))
			this._finishCheckpointToolRestore();
	}

	private _finishCheckpointToolRestore(): void {
		const names = this._checkpointActiveTools;
		if (!names) return;
		if (names.some((name) => !this._toolRegistry.has(this._toolSelectionKey(name))))
			throw new Error("Checkpoint tools unavailable after extension initialization");
		this._setActiveTools(names);
		this._checkpointActiveTools = undefined;
	}

	/** Restore once into an idle, empty queue; no handlers, expansion, or model calls are replayed. */
	restoreCheckpointQueues(saved: SessionCheckpointQueues): void {
		this._assertNotCheckpointHeld();
		if (this._checkpointRestored || !this.isIdle || this.hasPendingMessages || this.pendingNextTurnCount)
			throw new Error("Checkpoint queues require a fresh idle session");
		const queues = structuredClone(saved);
		this._checkpointRestored = true;
		this.agent.steeringMode = queues.steeringMode;
		this.agent.followUpMode = queues.followUpMode;
		for (const message of queues.steering) this.agent.steer(message);
		for (const message of queues.followUp) this.agent.followUp(message);
		this._steeringMessages = queues.steering
			.filter((message) => message.role === "user")
			.map((message) => contentText(message.content, ""));
		this._followUpMessages = queues.followUp
			.filter((message) => message.role === "user")
			.map((message) => contentText(message.content, ""));
		this._pendingNextTurnMessages = queues.nextTurn;
		const messages = [...queues.steering, ...queues.followUp];
		for (const index of queues.persistOnCancel) {
			const message = messages[index];
			if (message?.role === "custom") this._cancelPersistentCustomMessages.add(message);
		}
		this._emitQueueUpdate();
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this._checkpointRequest?.cancel();
		this._promptAbortController?.abort();
		if (this._isAgentRunActive) {
			this._agentRunAbortRequested = true;
		}
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		const scope = this._deferredSettlement.getStore();
		const isIdle = () => this.isIdle && this._settling <= (scope?.barriers ?? 0);
		if (isIdle()) return;
		await new Promise<void>((resolve) => {
			const notify = () => {
				if (!isIdle()) return;
				this._idleWaiters.delete(notify);
				resolve();
			};
			this._idleWaiters.add(notify);
		});
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		this._assertNotCheckpointHeld();
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this._assertNotCheckpointHeld();
		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		this._assertNotCheckpointHeld();
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		this._assertNotCheckpointHeld();
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._assertNotCheckpointHeld();
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._assertNotCheckpointHeld();
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate Pi's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		requestModel: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		env: Record<string, string> | undefined,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		return compact(
			preparation,
			requestModel,
			apiKey,
			headers,
			customInstructions,
			signal,
			this.thinkingLevel,
			this.agent.streamResponse,
			env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId
		);
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._assertNotCheckpointHeld();
		this._shutdownAbortController.signal.throwIfAborted();
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const settings = this.settingsManager.getCompactionSettings(model);
			const {
				model: requestModel,
				apiKey,
				headers,
				env,
			} = await this._getSummarizationRequestAuth(model, this._compactionAbortController.signal);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					env,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			this._reportedUsagePrefix = null;
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateProjectedContextTokens(
				this.sessionManager.buildSessionProjection(),
				this.sessionManager.getBranch(),
				{ model: this.model, useReportedUsage: false },
			).tokens;

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._clearManualCompactionState();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings(this.model);
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model &&
			assistantMessage.provider === this.model.provider &&
			assistantMessage.api === this.model.api &&
			assistantMessage.model === this.model.id;

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		// Raw branch order, not provider timestamps, determines whether this attempt
		// predates a completed compaction/window. Kept usage cannot retrigger recovery.
		if (entriesAfterAssistant.some((entry) => entry.type === "compaction" || entry.type === "context_window")) {
			return false;
		}
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined || latestAssistantEdit?.replacement !== null;
		const assistantUsageMatchesProjection =
			assistantIsProjected && !hasPostAssistantContextEdit && this._reportedUsageApplies(this.agent.state);
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage, toolResults);
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		// At settlement, valid usage describes the completed request. Trailing tool
		// results need a budget check only if another request is actually admitted;
		// request preflight already owns that check (including terminating batches).
		const directContextTokens =
			sameModel &&
			assistantUsageMatchesProjection &&
			assistantMessage.stopReason !== "error" &&
			assistantMessage.stopReason !== "aborted"
				? calculateContextTokens(assistantMessage.usage)
				: 0;
		const contextTokens =
			directContextTokens ||
			this._estimateContextTokens({
				...this.agent.state,
				messages: currentProjection.messages,
			}).tokens;
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		let abortController: AbortController | undefined;
		let started = false;
		let fromExtension = false;
		let signal: AbortSignal | undefined;
		let cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			// A tool completing while an async hook runs is still absent from its snapshot.
			const canStartContextWindow =
				this.agent.state.pendingToolCalls.size === 0 && this.getPendingToolCalls().length === 0;
			const pathEntries = this.sessionManager.getBranch();
			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			signal = AbortSignal.any([
				abortController.signal,
				this._shutdownAbortController.signal,
				...(this.agent.signal ? [this.agent.signal] : []),
				...(this._promptAbortController ? [this._promptAbortController.signal] : []),
			]);
			started = true;
			this._emit({ type: "compaction_start", reason });
			signal.throwIfAborted();

			// An extension may claim the automatic trigger with a fresh context window. This runs before
			// summarization auth and summary preparation, which a summary-free rollover does not need.
			// A claimed trigger never reaches session_before_compact.
			if (this._extensionRunner.hasHandlers("session_before_auto_compact")) {
				const claim = await this._extensionRunner.emit({
					type: "session_before_auto_compact",
					branchEntries: pathEntries,
					pendingMessages: this._pendingProviderMessages.slice(),
					reason,
					willRetry,
					signal,
				});
				signal.throwIfAborted();
				if (claim?.newContext) {
					const contextWindowStarted = canStartContextWindow && !!this._consumeNewContext(claim.newContext);
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: contextWindowStarted && willRetry,
						contextWindowStarted,
						pendingMessages: this._pendingProviderMessages.slice(),
					});
					return contextWindowStarted && (willRetry || this.agent.hasQueuedMessages());
				}
			}

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this._emit({ type: "compaction_end", reason, result: undefined, aborted: false, willRetry: false });
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model, signal);
			signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}
				signal.throwIfAborted();

				if (extensionResult?.newContext) {
					const contextWindowStarted =
						canStartContextWindow && !!this._consumeNewContext(extensionResult.newContext);
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: contextWindowStarted && willRetry,
						contextWindowStarted,
						pendingMessages: this._pendingProviderMessages.slice(),
					});
					return contextWindowStarted && (willRetry || this.agent.hasQueuedMessages());
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			signal.throwIfAborted();

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					signal,
					env,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}
			signal.throwIfAborted();

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			this._reportedUsagePrefix = null;
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateProjectedContextTokens(
				this.sessionManager.buildSessionProjection(),
				this.sessionManager.getBranch(),
				{ model: this.model, useReportedUsage: false },
			).tokens;

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry,
				pendingMessages: this._pendingProviderMessages.slice(),
			});

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = signal?.aborted === true || cancelledByExtension;
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			if (signal?.aborted) this._pendingNewContext = undefined;
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this._assertNotCheckpointHeld();
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	/** Change frontend ownership without re-running extension startup. Retained across reloads. */
	setExtensionMode(mode: ExtensionMode): void {
		this._extensionMode = mode;
		this._extensionRunner.setUIContext(this._extensionUIContext, mode);
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.getQueuedInputCount !== undefined) {
			this._extensionGetQueuedInputCount = bindings.getQueuedInputCount;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		this._finishCheckpointToolRestore();
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		// Discovery adds skills, prompts and themes; only skills affect the system prompt.
		// Do not rebuild unrelated inputs and discard local prompt edits or tool choices.
		if (skillPaths.length === 0) return;
		const skills = this._resourceLoader.getSkills().skills;
		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({ ...this._baseSystemPromptOptions, skills });
		if (reason === "startup" && !this._hasPreparedPrompt) {
			// These are initial resources, not a pending reset of a resumed before_agent_start prompt.
			// Adopt only the discovered input, retaining the saved tool selection and other baseline fields.
			this._baseSystemPromptBaseline = normalizeBuildSystemPromptOptions({
				...this._baseSystemPromptBaseline,
				skills,
			});
		}
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					if (this.isCheckpointHeld) this.cancelCheckpoint();
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					if (this.isCheckpointHeld) this.cancelCheckpoint();
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					if (!this._checkpointEntryPersistence || this._checkpointEntryPersistence.aborted)
						this._assertNotCheckpointHeld();
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				recordUsage: ({ id, kind, provider, model, usage, note }) => {
					if (typeof id !== "string") throw new Error("Usage contribution ID must be a string");
					if (!this._checkpointEntryPersistence || this._checkpointEntryPersistence.aborted)
						this._assertNotCheckpointHeld();
					const revision = this.sessionManager.getEntriesRevision();
					const entry = this.sessionManager.appendUsage(kind, provider, model, usage, note, id);
					if (this.sessionManager.getEntriesRevision() !== revision) this._emit({ type: "entry_appended", entry });
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this._assertNotCheckpointHeld();
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getActiveToolReferences: () => this.getActiveToolReferences(),
				setActiveToolReferences: (tools) => this.setActiveToolReferences(tools),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => !this._shutdownAbortController.signal.aborted && this.isIdle,
				isBashRunning: () => this.isBashRunning,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this._promptAbortController?.signal ?? this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.hasPendingMessages,
				hasPendingSteeringMessages: () => this.agent.hasQueuedSteeringMessages(),
				getPendingNextTurnCount: () => this.pendingNextTurnCount,
				getPendingInputCount: () => this.pendingInputCount,
				getPendingToolCalls: () => this.getPendingToolCalls(),
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				getCompactionSettings: () => this.settingsManager.getCompactionSettings(this.model),
				newContext: (options) => this.newContext(options),
				compact: (options) => {
					void runner.checkpointActivity.run(async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					});
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: {
		activeToolNames?: ToolSelection[];
		includeAllExtensionTools?: boolean;
	}): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolReferences();
		const allowedToolNames = this._allowedToolNames ? new Set(this._allowedToolNames.map(toolKey)) : undefined;
		const excludedToolNames = this._excludedToolNames ? new Set(this._excludedToolNames.map(toolKey)) : undefined;
		const isAllowedTool = (tool: ToolSelection): boolean =>
			(!allowedToolNames || allowedToolNames.has(toolKey(tool))) && !excludedToolNames?.has(toolKey(tool));

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition));
		const baseToolSource = this._baseToolsOverride ? "sdk" : "builtin";
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([, definition]) => isAllowedTool(definition))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<${baseToolSource}:${definition.name}>`, {
							source: baseToolSource,
						}),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(toolKey(tool.definition), {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		const publicIds = new Map<string, string>();
		for (const [key, { definition }] of definitionRegistry) {
			const id = toolId(definition);
			const previous = publicIds.get(id);
			if (previous !== undefined && previous !== key)
				throw new Error(`Ambiguous public tool ID ${JSON.stringify(id)}`);
			publicIds.set(id, key);
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([toolKey(definition), snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([toolKey(definition), guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<${baseToolSource}:${definition.name}>`, {
						source: baseToolSource,
					}),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [toolKey(tool), tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(toolKey(tool), tool);
		}
		this._toolRegistry = toolRegistry;
		this._toolIds = publicIds;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) nextActiveToolNames.push(toToolReference(tool));
		} else if (!options?.activeToolNames) {
			for (const [key, tool] of this._toolRegistry) {
				if (!previousRegistryNames.has(key)) nextActiveToolNames.push(toToolReference(tool));
			}
		}

		this.setActiveToolReferences(nextActiveToolNames.map(toToolReference));
	}

	private _buildRuntime(options: {
		activeToolNames?: ToolSelection[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						spawnHook: (context) => ({ ...context, cwd: this._extensionRunner.resolveBashCwd(context.cwd) }),
					},
				});

		this._baseToolDefinitions = new Map(
			Object.values(baseToolDefinitions).map((tool) => [toolKey(tool), tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		this._extensionRunner.checkpointActivity.onIdle = () => {
			// Let the enclosing native callback finish its continuation before checking settlement.
			this.notifyCheckpointStateChanged();
		};
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._noBuiltinTools
			? []
			: this._baseToolsOverride
				? Object.keys(this._baseToolsOverride)
				: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	/** Refresh resources and reinitialize extensions. Extension code updates require a process restart. */
	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		this._checkpointRequest?.cancel();
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolReferences(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
		this._extensionUIContext?.notify(`Restart ${APP_NAME} to apply extension code changes.`, "warning");
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
				await this._emitRetryEvent({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: async () => {
				await this._emitRetryEvent({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: async () => {
				await this._emitRetryEvent({ type: "summarization_retry_finished" });
			},
		};
	}

	private async _finishCancelledRetry(): Promise<void> {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		await this._emitRetryEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt);

		// Install cancellation before extension handlers can yield or abort the retry.
		this._retryAbortController = new AbortController();
		try {
			await this._emitRetryEvent({
				type: "auto_retry_start",
				attempt: this._retryAttempt,
				maxAttempts: settings.maxRetries,
				delayMs,
				errorMessage: message.errorMessage || "Unknown error",
			});

			// Keep raw history while durably omitting the selected attempt from future requests.
			this._omitRecoveryAttempt(message);

			await sleep(delayMs, this._retryAbortController.signal);
			this._retryAbortController.signal.throwIfAborted();
		} catch (error) {
			if (!this._retryAbortController.signal.aborted) throw error;
			await this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this._assertNotCheckpointHeld();
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a user bash command, including user_bash interception.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		this._assertNotCheckpointHeld();
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		try {
			// Own activity before any interceptor can await or return a replacement result.
			const intercepted = this._extensionRunner.hasHandlers("user_bash")
				? await this._extensionRunner.emitUserBash({
						type: "user_bash",
						command,
						excludeFromContext: options?.excludeFromContext ?? false,
						cwd: this.sessionManager.getCwd(),
					})
				: undefined;
			let result = intercepted?.result;
			if (abortController.signal.aborted) {
				result = { output: "", exitCode: undefined, cancelled: true, truncated: false };
			} else if (result) {
				if (result.output) onChunk?.(result.output);
			} else {
				const prefix = this.settingsManager.getShellCommandPrefix();
				const shellPath = this.settingsManager.getShellPath();
				result = await executeBashWithOperations(
					prefix ? `${prefix}\n${command}` : command,
					this._extensionRunner.resolveBashCwd(this.sessionManager.getCwd()),
					intercepted?.operations ?? options?.operations ?? createLocalBashOperations({ shellPath }),
					{
						onChunk: (delta) => {
							onChunk?.(delta);
							this._emit({ type: "bash_execution_update", id: options?.id, delta });
						},
						signal: abortController.signal,
					},
				);
			}

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
			await this._checkpointSafePoint("settled");
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._assertNotCheckpointHeld();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether any user Bash dispatch or execution is unfinished, including async interceptors. */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		while (this._pendingBashMessages.length > 0) {
			// SessionManager owns the attempted entry even if persistence fails.
			this.sessionManager.appendMessage(this._pendingBashMessages.shift()!);
		}
		this._refreshFinalizedContext();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this._assertNotCheckpointHeld();
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		this._assertNotCheckpointHeld();
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamResponse,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			this._refreshFinalizedContext();
			this._reportedUsagePrefix = undefined;
			this._restoreToolsFromTranscript();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message" || entry.checkpoint) continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const usageState = this._getContextUsageState(this.messages);
		const inputs = {
			model: [model.provider, model.api, model.id, contextWindow],
			messages: this.messages,
			tools: this.agent.state.tools,
			basePrompt: this._baseSystemPromptOptions,
			baseBaseline: this._baseSystemPromptBaseline,
			runPrompt: this._runSystemPromptOptions,
			usageState,
		};
		// SDK state and prompt options are mutable, including nested content and schemas.
		// Compare a retained snapshot instead of rebuilding provider input on every UI render.
		const cached = this._contextUsageCache;
		if (cached && cached.prefix === this._reportedUsagePrefix && isDeepStrictEqual(cached.inputs, inputs)) {
			return { ...cached.usage };
		}

		this._toolPrefixKeys = new WeakMap();
		// Retained pre-compaction usage is unknown until a matching projected response arrives.
		const estimate = usageState.hasPostCompactionUsage
			? this._estimateContextTokens(this.agent.state, usageState)
			: undefined;
		const usage: ContextUsage = estimate
			? {
					tokens: estimate.tokens,
					source: estimate.source,
					contextWindow,
					percent: (estimate.tokens / contextWindow) * 100,
				}
			: { tokens: null, contextWindow, percent: null, source: "unknown" };
		// TypeBox's clone preserves schema metadata and executable tool references.
		this._contextUsageCache = { inputs: Clone(inputs), prefix: this._reportedUsagePrefix, usage };
		return { ...usage };
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
		return generateBugReportSummary({
			messages: this.messages,
			hint: options.hint,
			model: requestModel,
			apiKey,
			headers,
			env,
			signal: options.signal,
			thinkingLevel: this.thinkingLevel,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const isEligibleAssistant = (message: AgentMessage): message is AssistantMessage =>
			message.role === "assistant" && !(message.stopReason === "aborted" && message.content.length === 0);
		// Active state includes message_end output before persistence; older windows live on the selected branch.
		const lastAssistant =
			this.messages.slice().reverse().find(isEligibleAssistant) ??
			this.sessionManager.getBranch().flatMap(sessionEntryToContextMessages).reverse().find(isEligibleAssistant);

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
