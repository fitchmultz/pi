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
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	retryDelayMs,
	toToolDeclaration,
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
import { ENV_SESSION_DIR, getAgentDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	BACKGROUND_COMMAND_NOTICE,
	BACKGROUND_COMMAND_RUN_STATE,
	backgroundCommandDirectory,
	backgroundCommandFinished,
	backgroundCommandOutputTail,
	listBackgroundCommands,
	summarizeBackgroundCommand,
} from "./background-command.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	assertCheckpointTarget,
	type CheckpointBoundary,
	type CheckpointFileHold,
	type CheckpointHold,
	type CheckpointOptions,
	normalizeCheckpointValue,
	type SessionCheckpoint,
	type SessionCheckpointQueues,
	type SessionCheckpointState,
	type ShutdownCheckpoint,
	type ShutdownCheckpointFile,
	writeCheckpointFile,
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
	prepareCompaction,
	prepareCompactionForExtension,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExecuteToolOptions,
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
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm, isMessagePreserved } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import type { CacheWarmingMode, SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	buildSystemPromptState,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import type { BackgroundCommandToolDetails } from "./tools/background-command.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";

const TOOL_LOADOUT_SELECTION = "pi-tool-loadout";

interface ReportedUsagePrefix {
	provider: string;
	api: string;
	model: string;
	systemPrompt: string;
	transcriptSystemPrompt: string;
	toolKeys: string[];
	canonicalConversation: unknown[];
	conversationPreserved: boolean;
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

function snapshotProviderConversation(messages: AgentMessage[]): unknown[] {
	return convertToLlm(messages.filter((message) => message.role !== "system")).map((message) => {
		if (message.role !== "assistant") return JSON.parse(JSON.stringify({ ...message, timestamp: 0 }));
		const { usage: _usage, ...response } = message;
		return JSON.parse(JSON.stringify({ ...response, timestamp: 0 }));
	});
}

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

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
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
			errorMessage?: string;
			pendingMessages?: boolean;
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
	agentDir?: string;
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
	/** Initial active built-in tool names. Defaults to DEFAULT_TOOL_NAMES. */
	initialActiveToolNames?: string[];
	deferBackgroundCommandNotifications?: boolean;
	/** Suppress default built-ins while retaining extension tools and explicit selections. */
	noBuiltinTools?: boolean;
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
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
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
	/** Host-owned accepted input not yet handed to this session. */
	getQueuedInputCount?: () => number;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

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
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched. Not called if the prompt is rejected. */
	preflightResult?: (disposition: PromptDisposition) => void;
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

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private readonly _shutdownAbortController = new AbortController();
	private _promptAbortController?: AbortController;
	private _pendingInputCount = 0;
	private _activeCommands = 0;
	private _extensionGetQueuedInputCount?: () => number;
	private readonly _normalizedUserMessages = new WeakSet<UserMessage>();
	private readonly _cancelPersistentCustomMessages = new Set<CustomMessage>();
	private _checkpointHeld = false;
	private _checkpointRestored = false;
	private _checkpointActiveTools?: string[];
	private _checkpointEntryPersistence?: AbortSignal;
	private readonly _shutdownCheckpointWaiters = new Set<() => void>();
	private _checkpointRequest?: {
		boundary: CheckpointBoundary;
		canQuiesce?: () => boolean;
		run: (boundary: CheckpointBoundary) => Promise<void>;
		cancel: () => void;
	};
	private _backgroundTimer?: NodeJS.Timeout;
	private _backgroundWakeSuppressed = false;
	private _backgroundNotificationsReady: boolean;
	private readonly _backgroundCommandSessionDir: string;
	private _backgroundCheckpointPaused = false;
	private readonly _backgroundPending = new Set<string>();

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _agentRunAbortRequested = false;
	private readonly _idleWaiters = new Set<() => void>();
	private readonly _deferredSettlement = new AsyncLocalStorage<{ barriers: number }>();

	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	private _failedResponse: AssistantMessage | undefined;

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
	private _settling = 0;
	// Checkpoints may cut the last admitted child run, but must not skip queued actions.
	private _pendingSettledActions = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _noBuiltinTools: boolean;
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode?: ExtensionMode;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	private _baseSystemPromptBaseline!: NormalizedBuildSystemPromptOptions;
	private _hasPreparedPrompt = false;
	private _reportedUsagePrefix?: ReportedUsagePrefix;
	private _providerRequestPrefix?: ReportedUsagePrefix;
	private _pendingProviderMessages: AgentMessage[] = [];
	private _skipNextProviderRequestPreflight = false;
	private _contextUsageCache?: { inputs: unknown; prefix?: ReportedUsagePrefix; usage: ContextUsage };
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.agent.requestAdmissionSignal = this._shutdownAbortController.signal;
		this._backgroundNotificationsReady = !config.deferBackgroundCommandNotifications;
		this._backgroundCommandSessionDir = resolvePath(
			process.env[ENV_SESSION_DIR] ||
				config.settingsManager.getSessionDir() ||
				join(config.agentDir ?? getAgentDir(), "sessions"),
		);
		let backgroundStateId: string | undefined;
		for (const entry of config.sessionManager.iterateEntryMetadata())
			if (entry.type === "custom" && entry.customType === BACKGROUND_COMMAND_RUN_STATE) backgroundStateId = entry.id;
		if (backgroundStateId) {
			const state = config.sessionManager.getEntry(backgroundStateId);
			this._backgroundWakeSuppressed = state?.type === "custom" && state.data === true;
		}
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
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentBoundaryHooks();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		const restoredSystem = getCurrentSystemMessage(this.messages);
		this._baseSystemPromptBaseline = normalizeBuildSystemPromptOptions({
			...this._baseSystemPromptOptions,
			selectedTools: restoredSystem
				? (restoredSystem.toolsAdded ?? []).map((tool) => tool.name)
				: this._baseSystemPromptOptions.selectedTools,
		});
		if (this._initialActiveToolNames === undefined) this._restoreToolsFromTranscript();
		this._startBackgroundCommandMonitor();
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
		selectedModel: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		// Route a virtual model first: summaries size their input and output from the model they get.
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					reason: "direct",
					thinkingLevel: this.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: this.thinkingLevel };
		if (this.agent.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model, thinkingLevel };
		}
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(
			this.sessionManager.iterateEntryMetadata({ branchFrom: this.sessionManager.getLeafId() }),
			getModel,
		);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/** The model whose limits apply to the conversation. */
	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
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
		this.agent.beforeToolCall = (context) => this._beforeToolCall(context);
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				...(parentToolCallId ? { parentToolCallId } : {}),
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					getTools: () => this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: (context) => this._beforeToolCall(context, parentId),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Whether `projection`, the current session projection, exceeds the compaction threshold of `model`. */
	private _exceedsCompactionThreshold(
		model: Model<any>,
		projection: SessionProjection,
		context: AgentContext = { messages: projection.messages, tools: this.agent.state.tools },
	): boolean {
		if (model.contextWindow <= 0) return false;
		return shouldCompact(
			this._estimateContextTokens(context, model).tokens,
			model.contextWindow,
			this.settingsManager.getCompactionSettings(this.model),
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const projection = this.sessionManager.buildSessionProjection();
		// A virtual selection is checked in prepareRequest, against the model the request is routed to.
		const model = this.model;
		if (!model || isVirtualModel(model) || !this._exceedsCompactionThreshold(model, projection)) {
			return { ...context, messages: projection.messages };
		}
		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		let requestModel: Model<any> | undefined;
		this.agent.prepareRequest = async (request, signal) => {
			this._shutdownAbortController.signal.throwIfAborted();
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const prepare = async () => {
				const projection = this.sessionManager.buildSessionProjection();
				const canonicalContext = {
					...request.context,
					messages: [...projection.messages, ...this._pendingProviderMessages],
					// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
					tools: this.agent.state.tools.slice(),
				};
				const previous = await previousPrepareRequest?.(
					{
						...request,
						context: canonicalContext,
						model: this.agent.state.model,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					signal,
				);
				this._shutdownAbortController.signal.throwIfAborted();
				signal?.throwIfAborted();
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			let { previous, context, projection } = await prepare();
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			if (!isVirtualModel(model)) {
				if (
					!this._skipNextProviderRequestPreflight &&
					shouldCompact(
						this._estimateContextTokens(context, model).tokens,
						model.contextWindow,
						this.settingsManager.getCompactionSettings(this.model),
					)
				) {
					await this._runAutoCompaction("threshold", false);
					({ previous, context } = await prepare());
				}
				requestModel = model;
				return { ...previous, context, model, thinkingLevel };
			}

			// The selection stays in agent state; only this request uses the routed model. A routing
			// failure rejects, which ends the run with an error response. Only messages the user wrote
			// start a turn; extension messages can follow them, e.g. from before_agent_start.
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				thinkingLevel,
				signal,
				failed,
				state,
			});
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				const entry = this.sessionManager.getEntry(
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			// The route stands: the router already decided this request. The state entry does not change
			// the projection.
			if (
				!this._skipNextProviderRequestPreflight &&
				this._exceedsCompactionThreshold(route.model, projection, context)
			) {
				await this._runAutoCompaction("threshold", false);
				({ previous, context } = await prepare());
			}
			this._shutdownAbortController.signal.throwIfAborted();
			signal?.throwIfAborted();
			requestModel = route.model;
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
		const previousTransform = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			this._flushPendingProviderMessages();
			this._refreshFinalizedContext();
			const model = requestModel;
			const canonicalConversation = snapshotProviderConversation(messages);
			const transcriptSystemPrompt = getCurrentSystemPrompt(messages);
			// Project forced text before extension context handlers inspect the provider input.
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (forced !== undefined) {
				const current = getCurrentSystemMessage(messages);
				messages = [
					{
						role: "system",
						content: forced,
						...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
						timestamp: current?.timestamp ?? Date.now(),
					},
					...messages.filter((message) => message.role !== "system"),
				];
			}
			const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
			const sent = snapshotProviderConversation(transformed);
			let index = 0;
			for (const message of sent) {
				if (index === canonicalConversation.length) break;
				if (isMessagePreserved(canonicalConversation[index], message)) index++;
			}
			this._providerRequestPrefix = model
				? {
						provider: model.provider,
						api: model.api,
						model: model.id,
						systemPrompt: getCurrentSystemPrompt(transformed),
						transcriptSystemPrompt,
						toolKeys: this.agent.state.tools
							.filter((tool) => !this._hiddenDeclarations.has(tool.name))
							.map((tool) =>
								JSON.stringify(
									toToolDeclaration({ ...tool, constrainedSampling: tool.constrainedSampling || undefined }),
								),
							),
						canonicalConversation,
						conversationPreserved: index === canonicalConversation.length,
						systemTokens: this._projectEstimatedMessages(transformed).reduce(
							(sum, message) => sum + (message.role === "system" ? estimateTokens(message) : 0),
							0,
						),
					}
				: undefined;
			return transformed;
		};
	}

	/** Keep measured conversation usage while accounting for pending prompt and tool changes. */
	private _estimateContextTokens(context: AgentContext = this.agent.state, model = this._limitsModel()) {
		const usageState = this._getContextUsageState(context.messages, model);
		const options = { model, useReportedUsage: usageState.useReportedUsage };
		const prefix = this._reportedUsagePrefix;
		const lastUsageIndex = estimateContextTokens(context.messages, { model }).lastUsageIndex;
		const conversationApplies =
			options.useReportedUsage &&
			prefix?.response &&
			model &&
			prefix.provider === model.provider &&
			prefix.api === model.api &&
			prefix.model === model.id &&
			prefix.conversationPreserved &&
			lastUsageIndex !== null &&
			isSameResponse(context.messages[lastUsageIndex], prefix.response) &&
			isDeepStrictEqual(
				snapshotProviderConversation([context.messages[lastUsageIndex]])[0],
				prefix.responseSnapshot,
			) &&
			isDeepStrictEqual(
				snapshotProviderConversation(context.messages.slice(0, lastUsageIndex)),
				prefix.canonicalConversation,
			);
		const pending = this._getPendingSystemPromptOptions();
		const systemPrompt = pending ? buildSystemPrompt(pending) : getCurrentSystemPrompt(context.messages);
		const tools = (context.tools ?? []).filter((tool) => !this._hiddenDeclarations.has(tool.name));
		if (
			conversationApplies &&
			(pending ? prefix.systemPrompt : prefix.transcriptSystemPrompt) === systemPrompt &&
			isDeepStrictEqual(
				prefix.toolKeys,
				tools.map((tool) =>
					JSON.stringify(
						toToolDeclaration({ ...tool, constrainedSampling: tool.constrainedSampling || undefined }),
					),
				),
			)
		) {
			return estimateContextTokens(
				this._runSystemPromptOptions?.forceSystemPrompt === undefined
					? context.messages
					: context.messages.filter((message) => message.role !== "system"),
				options,
			);
		}
		const current = getCurrentSystemMessage(context.messages);
		const desired = pending ? buildSystemPromptState(pending) : undefined;
		const replace =
			desired &&
			(desired.sections === undefined ||
				(current && (current.sections === undefined || contentText(current.content).length > 0)));
		const sections =
			desired && !replace ? diffSystemPromptSections(current?.sections ?? {}, desired.sections ?? {}) : undefined;
		const changes = getToolStateChanges(getCurrentTools(context.messages), tools);
		const messages: AgentMessage[] = replace
			? [
					{ role: "system", ...desired, toolsAdded: tools.map(toToolDeclaration), timestamp: Date.now() },
					...context.messages.filter((message) => message.role !== "system"),
				]
			: sections || changes.toolsAdded.length || changes.toolsRemoved.length
				? [...context.messages, { role: "system", content: "", sections, ...changes, timestamp: Date.now() }]
				: context.messages;
		const forced = pending?.forceSystemPrompt;
		const estimatedMessages = this._projectEstimatedMessages(messages, forced !== undefined);
		if (conversationApplies) {
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
				tokens: Math.max(0, estimate.tokens + systemTokens - prefix.systemTokens),
				source: "estimated" as const,
			};
		}
		const fullEstimate = estimateContextTokens(estimatedMessages, { ...options, useReportedUsage: false });
		if (forced !== undefined || prefix !== undefined || !options.useReportedUsage) return fullEstimate;
		const historicalEstimate = estimateContextTokens(context.messages, options);
		return historicalEstimate.tokens > fullEstimate.tokens
			? { ...historicalEstimate, source: "estimated" as const }
			: fullEstimate;
	}

	private _flushPendingProviderMessages(): void {
		while (this._pendingProviderMessages.length > 0) {
			const message = this._pendingProviderMessages.shift()!;
			let id: string | undefined;
			if (message.role === "custom")
				id = this.sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
				);
			else if (message.role === "system" || message.role === "user") id = this.sessionManager.appendMessage(message);
			if (id) this._entryIdsByMessage.set(message, id);
		}
	}

	private _getContextUsageState(
		messages: AgentMessage[],
		model = this._limitsModel(),
	): {
		hasPostCompactionUsage: boolean;
		useReportedUsage: boolean;
	} {
		let invalidated = false;
		let entry = this.sessionManager.getLeafId()
			? this.sessionManager.getEntryMetadata(this.sessionManager.getLeafId()!)
			: undefined;
		while (entry) {
			if (entry.type === "compaction") return { hasPostCompactionUsage: false, useReportedUsage: false };
			if (entry.type === "context_edit") invalidated = true;
			if (model && entry.type === "message" && entry.message.role === "assistant") {
				const message = entry.message;
				const entryId = entry.id;
				if (
					message.provider === model.provider &&
					message.api === model.api &&
					message.model === model.id &&
					message.stopReason !== "aborted" &&
					message.stopReason !== "error" &&
					calculateContextTokens(message.usage!) > 0 &&
					messages.some((projected) => this._findPersistedMessageEntryId(projected) === entryId)
				) {
					return { hasPostCompactionUsage: true, useReportedUsage: !invalidated };
				}
			}
			entry = entry.parentId ? this.sessionManager.getEntryMetadata(entry.parentId) : undefined;
		}
		return { hasPostCompactionUsage: true, useReportedUsage: false };
	}

	private _projectEstimatedMessages(messages: AgentMessage[], forceCollapse = false): AgentMessage[] {
		return forceCollapse
			? [getCurrentSystemMessage(messages)!, ...messages.filter((message) => message.role !== "system")]
			: messages;
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
		const previousAfterTurn = this.agent.afterTurn;
		this.agent.afterTurn = async (signal) => {
			await previousAfterTurn?.(signal);
			await this._checkpointSafePoint("turn");
		};
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			await this._inspectBackgroundCommands(true);
			if (this._shutdownAbortController.signal.aborted || signal?.aborted) return { action: "end" };
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
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
		if (event.type === "compaction_end")
			event.pendingMessages = this.hasPendingMessages || this.pendingInputCount > 0;
		for (const l of [...this._eventListeners]) {
			l(event);
		}
	}

	private async _emitRetryEvent(
		event: Extract<
			AgentSessionEvent,
			{
				type:
					| "auto_retry_start"
					| "auto_retry_end"
					| "summarization_retry_scheduled"
					| "summarization_retry_attempt_start"
					| "summarization_retry_finished";
			}
		>,
	): Promise<void> {
		await this._extensionRunner.emit(event);
		this._emit(event);
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: this.getSteeringMessages(),
			followUp: this.getFollowUpMessages(),
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
		if (!this._shutdownAbortController.signal.aborted) this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		this._settling++;
		this._isEmittingAgentSettled = true;
		try {
			try {
				await this._extensionRunner.emit({ type: "agent_settled" });
				this._emit({ type: "agent_settled" });
			} finally {
				this._isEmittingAgentSettled = false;
			}
			const deferred = this._deferredSettledActions.splice(0);
			let remaining = deferred.length;
			this._pendingSettledActions += remaining;
			try {
				for (const action of deferred) {
					remaining--;
					this._pendingSettledActions--;
					// A deferred command may join its child run, not its enclosing settlement.
					const scope = { barriers: this._settling };
					try {
						await this._deferredSettlement.run(scope, action);
					} finally {
						scope.barriers = 0;
					}
				}
			} finally {
				this._pendingSettledActions -= remaining;
			}
		} finally {
			this._settling--;
			await this._checkpointSafePoint("settled");
			this._resolveIdleWaitIfIdle();
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			this._emitQueueUpdate();
			await this._normalizeUserMessageImages(event.message);
		}
		if (event.type === "message_start" && event.message.role === "system") {
			this._projectNewToolDeclarations(event.message);
		}

		if (event.type === "message_end" && event.message.role === "assistant")
			this._skipNextProviderRequestPreflight = false;
		const responseSnapshot =
			event.type === "message_end" && event.message.role === "assistant"
				? snapshotProviderConversation([event.message])[0]
				: undefined;
		// Emit to extensions first, then notify public listeners.
		await this._emitExtensionEvent(event);
		try {
			this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		} finally {
			// A throwing subscriber must not discard a completed message or tool receipt.
			if (event.type === "message_end") {
				if (event.message.role === "custom") this._cancelPersistentCustomMessages.delete(event.message);
				let entryId: string | undefined;
				// Inputs persist only after request preflight, so compaction cannot discard newly admitted input.
				if (
					this._isAgentRunActive &&
					(event.message.role === "system" || event.message.role === "user" || event.message.role === "custom")
				) {
					this._pendingProviderMessages.push(event.message);
				} else if (event.message.role === "custom") {
					// Persist as CustomMessageEntry
					entryId = this.sessionManager.appendCustomMessageEntry(
						event.message.customType,
						event.message.content,
						event.message.display,
						event.message.details,
					);
				} else if (
					event.message.role === "system" ||
					event.message.role === "user" ||
					event.message.role === "assistant" ||
					event.message.role === "toolResult"
				) {
					// Regular LLM message - persist as SessionMessageEntry
					entryId = this.sessionManager.appendMessage(event.message);
				}
				if (entryId) this._entryIdsByMessage.set(event.message, entryId);
				// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

				if (event.message.role === "assistant") {
					const assistantMsg = event.message as AssistantMessage;
					const prefix = this._providerRequestPrefix;
					this._providerRequestPrefix = undefined;
					if (
						prefix &&
						prefix.provider === assistantMsg.provider &&
						prefix.api === assistantMsg.api &&
						prefix.model === assistantMsg.model &&
						assistantMsg.stopReason !== "error" &&
						assistantMsg.stopReason !== "aborted" &&
						calculateContextTokens(assistantMsg.usage) > 0
					) {
						this._reportedUsagePrefix = {
							...prefix,
							response: assistantMsg,
							responseSnapshot,
						};
					}
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
		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				const current = this.agent.state.messages[projectedIndex++];
				if (current) this._entryIdsByMessage.set(current, entry.sourceEntry.id);
			}
		}
		return this._entryIdsByMessage.get(message);
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
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = this.sessionManager.appendContextEdit(targetId, null);
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
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
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

	/** Close ingress synchronously before shutdown handlers or host teardown yield. */
	beginShutdown(): void {
		this._cacheWarmer?.cancel();
		clearInterval(this._backgroundTimer);
		this._backgroundTimer = undefined;
		this._extensionUIContext?.setStatus("background-command", undefined);
		this.cancelCheckpoint();
		this._shutdownAbortController.abort();
		this._promptAbortController?.abort();
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this.beginShutdown();
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
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
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
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

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		const pending = this._getPendingSystemPromptOptions();
		return pending ? buildSystemPrompt(pending) : getCurrentSystemPrompt(this.messages);
	}

	private _getPendingSystemPromptOptions(): NormalizedBuildSystemPromptOptions | undefined {
		if (this._runSystemPromptOptions) return this._runSystemPromptOptions;
		return getCurrentSystemMessage(this.messages) &&
			buildSystemPrompt(this._baseSystemPromptOptions) === buildSystemPrompt(this._baseSystemPromptBaseline)
			? undefined
			: this._baseSystemPromptOptions;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Tools with `codemode` or `deferred` exposure are callable from other tools without being active.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		this._assertNotCheckpointHeld();
		const tools = this._applyToolLoadout(toolNames);
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `codemode` or `deferred` tool.
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see {@link _installHiddenDeclarationsProjection}).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const tools = [...new Set(toolNames)].flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				if (description === undefined) return tool;
				const presented: AgentTool = Object.create(
					Object.getPrototypeOf(tool),
					Object.getOwnPropertyDescriptors(tool),
				);
				presented.description = description;
				return presented;
			});
		}
		this._hiddenDeclarations = hidden;
		this.agent.state.tools = declared;
		return declared;
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

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
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
	 * the request projection.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		this._baseSystemPromptBaseline = normalizeBuildSystemPromptOptions(this._baseSystemPromptOptions);
		this._hasPreparedPrompt = true;
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		this._recordToolSelection();
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		const declared = new Set((getCurrentSystemMessage(messages)?.toolsAdded ?? []).map((tool) => tool.name));
		const visible = options.selectedTools.filter((name) => !this._hiddenDeclarations.has(name));
		const visibilityChanged = visible.length !== declared.size || visible.some((name) => !declared.has(name));
		return sections || visibilityChanged
			? { role: "system", content: "", ...(sections ? { sections } : {}), timestamp: Date.now() }
			: undefined;
	}

	/** Project visibility only at the new declaration boundary; never rewrite historical loadouts. */
	private _projectNewToolDeclarations(message: SystemMessage): void {
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionProjection().messages);
		const hidden = this._hiddenDeclarations;
		const removed = new Map((message.toolsRemoved ?? []).map((tool) => [tool.name, tool]));
		for (const tool of current?.toolsAdded ?? []) {
			if (hidden.has(tool.name)) removed.set(tool.name, { name: tool.name });
		}
		message.toolsAdded = message.toolsAdded?.filter((tool) => !hidden.has(tool.name));
		message.toolsRemoved = [...removed.values()];
		if (!message.toolsAdded?.length) delete message.toolsAdded;
		if (!message.toolsRemoved.length) delete message.toolsRemoved;
	}

	private _recordToolSelection(): void {
		const names = this.getActiveToolNames();
		const previous = this.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === TOOL_LOADOUT_SELECTION);
		if (previous?.type === "custom" && JSON.stringify(previous.data) === JSON.stringify(names)) return;
		this.sessionManager.appendCustomEntry(TOOL_LOADOUT_SELECTION, names);
	}

	/** Restore the callable selection without discarding pending prompt edits. */
	private _restoreToolsFromTranscript(): void {
		const selection = this.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === TOOL_LOADOUT_SELECTION);
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		const selected =
			selection?.type === "custom" &&
			Array.isArray(selection.data) &&
			selection.data.every((name) => typeof name === "string")
				? (selection.data as string[])
				: current?.toolsAdded?.map((tool) => tool.name);
		if (!selected) return;
		const names = this._applyToolLoadout(selected).map((tool) => tool.name);
		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			...this._baseSystemPromptOptions,
			selectedTools: names,
		});
		this._baseSystemPromptBaseline = normalizeBuildSystemPromptOptions({
			...this._baseSystemPromptBaseline,
			selectedTools: names,
		});
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(
		input: AgentMessage | AgentMessage[] | ((signal: AbortSignal) => Promise<AgentMessage[] | undefined>),
	): Promise<void> {
		this._assertNotCheckpointHeld();
		this._shutdownAbortController.signal.throwIfAborted();
		if (this._checkpointActiveTools) throw new Error("Checkpoint restore requires extension initialization");
		if (!this.isIdle) throw new Error("Agent is already processing");
		this._promptAbortController = new AbortController();
		this._agentRunAbortRequested = false;
		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		this._failedResponse = undefined;
		this._recordSelection();
		this._isAgentRunActive = true;
		this._skipNextProviderRequestPreflight = this.agent.state.messages.length === 0;
		const previousPromptBaseline = this._baseSystemPromptBaseline;
		let started = false;
		try {
			this._backgroundCheckpointPaused = false;
			this._setBackgroundWakeSuppressed(false);
			const messages = typeof input === "function" ? await input(this._promptAbortController.signal) : input;
			this._promptAbortController.signal.throwIfAborted();
			this._shutdownAbortController.signal.throwIfAborted();
			if (!messages) return;
			const accepted = new Set(Array.isArray(messages) ? messages : [messages]);
			this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter((message) => !accepted.has(message));
			started = true;
			// Tool declarations must diff against the same persisted transcript used for requests.
			this._refreshFinalizedContext();
			let run = this.agent.prompt(messages);
			while (true) {
				const signal = this.agent.signal;
				const controller = this._promptAbortController;
				const abort = () => controller.abort(signal?.reason);
				if (signal?.aborted) abort();
				signal?.addEventListener("abort", abort, { once: true });
				try {
					await run;
				} finally {
					signal?.removeEventListener("abort", abort);
				}
				if (this._agentRunAbortRequested || signal?.aborted || this._shutdownAbortController.signal.aborted) break;
				const postRunContinue = await this._handlePostAgentRun();
				const boundaryContinue = postRunContinue ? undefined : await this._runBeforeSettleBoundary();
				if (!postRunContinue && !boundaryContinue) break;
				if (this._agentRunAbortRequested || this._shutdownAbortController.signal.aborted) break;
				run = this.agent.continue({ drainQueuedInput: boundaryContinue !== "explicit" });
			}
		} catch (error) {
			if (!started) this._promptAbortController.signal.throwIfAborted();
			throw error;
		} finally {
			if (!started) this._baseSystemPromptBaseline = previousPromptBaseline;
			if (this._agentRunAbortRequested) await this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._runSystemPromptOptions = undefined;
			this._promptAbortController = undefined;
			try {
				this._flushPendingProviderMessages();
				this._preserveUndeliveredCustomMessages(true);
				this._flushPendingBashMessages();
				this._flushPendingCustomMessages();
			} finally {
				if (started) await this._emitAgentSettled();
				else {
					this._isAgentRunActive = false;
					this._resolveIdleWaitIfIdle();
					this.notifyCheckpointStateChanged();
				}
			}
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		if (this._shutdownAbortController.signal.aborted) return false;
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._agentRunAbortRequested) {
			await this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			if (this._agentRunAbortRequested) await this._finishCancelledRetry();
			this._failedResponse = message;
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

		// A stopped tool-use run has no next assistant request to prepare, e.g. a terminating batch.
		if (message.stopReason === "toolUse") return this.agent.hasQueuedMessages();
		if (await this._checkCompaction(message, true, toolResults)) {
			return !this._agentRunAbortRequested;
		}

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean | "explicit"> {
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
			return result.continue ? "explicit" : shouldContinue;
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
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
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

	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		if (!images) return { images: [], hints: [] };

		const normalizedImages: ImageContent[] = [];
		const hints: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		return { images: normalizedImages, hints };
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
			this._deferredSettledActions.push(() => this.prompt(text, options));
			return;
		}
		this._pendingInputCount++;
		let released = false;
		const releaseInput = () => {
			if (released) return;
			released = true;
			this._pendingInputCount--;
			this.notifyCheckpointStateChanged();
		};
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		try {
			if (
				expandPromptTemplates &&
				text.startsWith("/") &&
				this._extensionRunner.getCommand(text.slice(1).split(" ", 1)[0])
			) {
				releaseInput();
				await this._tryExecuteExtensionCommand(text);
				preflightResult?.("handled");
				return;
			}
			if (this._compactionAbortController || this._branchSummaryAbortController)
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			const processedInput = await this._runInputHandlers(
				text,
				options?.images,
				options?.source ?? "interactive",
				this.isStreaming ? options?.streamingBehavior : undefined,
			);
			this._shutdownAbortController.signal.throwIfAborted();
			if (!processedInput) {
				preflightResult?.("handled");
				return;
			}
			if (this._compactionAbortController || this._branchSummaryAbortController)
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			if (this.isStreaming) {
				if (!options?.streamingBehavior)
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				const expanded = expandPromptTemplates
					? expandPromptTemplate(this._expandSkillCommand(processedInput.text), [...this.promptTemplates])
					: processedInput.text;
				if (options.streamingBehavior === "steer") await this._queueSteer(expanded, processedInput.images);
				else await this._queueFollowUp(expanded, processedInput.images);
				preflightResult?.("queued");
				return;
			}
			await this._runAgentPrompt(async (signal) => {
				const { text: currentText, images: currentImages } = processedInput;

				// Expand skill commands (/skill:name args) and prompt templates (/template args)
				let expandedText = currentText;
				if (expandPromptTemplates) {
					expandedText = this._expandSkillCommand(expandedText);
					expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
				}

				// Flush any pending bash and custom messages before the new prompt
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

				// Check if we need to compact before sending (catches aborted responses).
				// The user's new prompt is sent below, so do not call agent.continue() here.
				const lastAssistant = this._findLastAssistantMessage();
				if (lastAssistant) {
					await this._checkCompaction(lastAssistant, false);
				}

				signal.throwIfAborted();
				// Emit before_agent_start before normalizing images so extension-driven model
				// selection determines the resize profile used for the request and history.
				const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
				const result = await this._extensionRunner.emitBeforeAgentStart(
					expandedText,
					currentImages,
					this._baseSystemPromptOptions,
				);
				signal.throwIfAborted();
				// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
				// which updates the live loadout instead. An explicit edit wins; otherwise the live
				// loadout is authoritative, so a setActiveTools() call is not undone here.
				const handlerEditedTools =
					result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
					result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
				if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

				const normalized = await this._normalizePromptImages(currentImages);
				signal.throwIfAborted();
				const userText =
					normalized.hints.length > 0 ? `${expandedText}\n\n${normalized.hints.join("\n")}` : expandedText;

				// Build messages only after hooks and image normalization have completed.
				const messages: AgentMessage[] = [];
				const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
				userContent.push(...normalized.images);
				const userMessage: UserMessage = {
					role: "user",
					content: userContent,
					timestamp: Date.now(),
				};
				this._normalizedUserMessages.add(userMessage);
				messages.push(userMessage);

				// Inject any pending "nextTurn" messages as context alongside the user message
				for (const msg of this._pendingNextTurnMessages) {
					messages.push(msg);
				}

				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
				const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
				this._runSystemPromptOptions = result.systemPromptOptions;
				if (updateMessage) messages.unshift(updateMessage);

				this._promptAbortController?.signal.throwIfAborted();
				this._shutdownAbortController.signal.throwIfAborted();
				releaseInput();
				preflightResult?.("started");
				return messages;
			});
		} finally {
			releaseInput();
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
			this.notifyCheckpointStateChanged();
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
	): Promise<QueuedInputDisposition> {
		this._assertNotCheckpointHeld();
		this._shutdownAbortController.signal.throwIfAborted();
		this._pendingInputCount++;
		try {
			if (text.startsWith("/")) {
				this._throwIfExtensionCommand(text);
			}

			const processedInput = await this._runInputHandlers(
				text,
				images,
				source,
				this.isStreaming ? behavior : undefined,
			);
			this._shutdownAbortController.signal.throwIfAborted();
			if (!processedInput) return "handled";

			let expandedText = this._expandSkillCommand(processedInput.text);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

			if (behavior === "steer") {
				await this._queueSteer(expandedText, processedInput.images);
			} else {
				await this._queueFollowUp(expandedText, processedInput.images);
			}
			return "queued";
		} finally {
			this._pendingInputCount--;
			this.notifyCheckpointStateChanged();
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
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const message: UserMessage = { role: "user", content, timestamp: Date.now() };
		this.agent.steer(message);
		try {
			this._emitQueueUpdate();
		} catch (error) {
			this.agent.takeQueuedMessages((queued) => queued === message);
			throw error;
		}
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const message: UserMessage = { role: "user", content, timestamp: Date.now() };
		this.agent.followUp(message);
		try {
			this._emitQueueUpdate();
		} catch (error) {
			this.agent.takeQueuedMessages((queued) => queued === message);
			throw error;
		}
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
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; persistOnCancel?: boolean },
	): Promise<void> {
		this._assertNotCheckpointHeld();
		if (options?.triggerTurn !== false) this._shutdownAbortController.signal.throwIfAborted();
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
				this._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));
				return;
			}
			await this._runAgentPrompt(async (signal) => {
				const selected = this._baseSystemPromptOptions.selectedTools;
				const start = await this._extensionRunner.emitBeforeAgentStart(
					"",
					undefined,
					this._baseSystemPromptOptions,
				);
				signal.throwIfAborted();
				if (JSON.stringify(start.systemPromptOptions.selectedTools) === JSON.stringify(selected))
					start.systemPromptOptions.selectedTools = this.getActiveToolNames();
				const update = this._preparePromptAndToolLoadout(start.systemPromptOptions);
				this._runSystemPromptOptions = start.systemPromptOptions;
				return [
					...(update ? [update] : []),
					appMessage,
					...start.messages.map(
						(message): CustomMessage => ({
							...message,
							content: message.content ?? [],
							role: "custom",
							timestamp: Date.now(),
						}),
					),
				];
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
		try {
			this.sessionManager.appendCustomMessageEntry(
				appMessage.customType,
				appMessage.content,
				appMessage.display,
				appMessage.details,
			);
		} finally {
			this._refreshFinalizedContext();
		}
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		while (this._pendingCustomMessages.length) this._appendCustomMessage(this._pendingCustomMessages.shift()!);
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
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		this._assertNotCheckpointHeld();
		this._preserveUndeliveredCustomMessages();
		const steering = [...this.getSteeringMessages()];
		const followUp = [...this.getFollowUpMessages()];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		if (!this.isStreaming) {
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
		return this.getSteeringMessages().length + this.getFollowUpMessages().length;
	}

	/** Pending non-user steering/follow-up messages, retained in the native agent queues. */
	get pendingCustomMessageCount(): number {
		const queues = this.agent.getQueuedMessages();
		return [...queues.steering, ...queues.followUp].filter((message) => message.role !== "user").length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this.agent
			.getQueuedMessages()
			.steering.filter((message) => message.role === "user")
			.map((message) => contentText(message.content, ""));
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this.agent
			.getQueuedMessages()
			.followUp.filter((message) => message.role === "user")
			.map((message) => contentText(message.content, ""));
	}

	private async _flushCheckpointSettings(): Promise<void> {
		await this.settingsManager.flush({ requireSuccessfulPersistence: true });
		const errors = this.settingsManager.drainErrors();
		if (errors.length)
			throw new Error(`Settings checkpoint failed: ${errors.map((error) => error.error.message).join("; ")}`);
	}

	private _captureCheckpointState(boundary: CheckpointBoundary): SessionCheckpointState {
		if (this._checkpointActiveTools) throw new Error("Checkpoint restore requires extension initialization");
		const sessionFile = this.sessionFile;
		const header = this.sessionManager.getHeader();
		if (!sessionFile || !header) throw new Error("Checkpoint requires a persistent session");
		// Both live and clean-exit capture must reconcile accepted entries after failed I/O.
		this.sessionManager.flush();
		const checkpoint: SessionCheckpointState = {
			version: 1,
			createdAt: new Date().toISOString(),
			selection: normalizeCheckpointValue(
				{
					sessionFile,
					sessionId: this.sessionId,
					cwd: this._cwd,
					leafId: this.sessionManager.getLeafId(),
					model: this.model ? { provider: this.model.provider, id: this.model.id } : undefined,
					thinkingLevel: this.thinkingLevel,
					activeTools: this.getActiveToolNames(),
					knownTools: this.getAllTools().map((tool) => tool.name),
				},
				"selection",
			),
			header: normalizeCheckpointValue(header, "header"),
			queues: this.getCheckpointQueues(),
			toolConfiguration: normalizeCheckpointValue(
				{
					noBuiltinTools: this._noBuiltinTools || undefined,
					allowedToolNames: this._allowedToolNames ? [...this._allowedToolNames] : undefined,
					excludedToolNames: this._excludedToolNames ? [...this._excludedToolNames] : undefined,
				},
				"toolConfiguration",
			),
			scopedModels: this._scopedModels.map(({ model, thinkingLevel }, index) =>
				normalizeCheckpointValue({ provider: model.provider, id: model.id, thinkingLevel }, String(index)),
			),
			boundary,
			settled: boundary === "settled" && this.isIdle,
		};
		return checkpoint;
	}

	private *_checkpointEntries(): Iterable<SessionEntry> {
		for (const entry of this.sessionManager.getEntries()) yield entry;
	}

	private _captureCheckpoint(boundary: CheckpointBoundary): SessionCheckpoint {
		const state = this._captureCheckpointState(boundary);
		// ponytail: explicit object capture needs heap for every requested body; file capture never uses this array.
		const entries = Array.from(this._checkpointEntries(), (entry, index) =>
			normalizeCheckpointValue(entry, String(index)),
		);
		return { ...state, entries };
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
			!this._isEmittingAgentSettled &&
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
		return this._captureShutdownCheckpoint(() => this._captureCheckpoint("settled"));
	}

	async captureShutdownCheckpointFile(path: string, signal?: AbortSignal): Promise<ShutdownCheckpointFile> {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const candidate = await this._captureShutdownCheckpoint((held) => {
				const state = this._captureCheckpointState("settled");
				assertCheckpointTarget(path, state.selection.sessionFile);
				return writeCheckpointFile(temporary, state, this._checkpointEntries(), held);
			}, signal);
			return {
				...candidate,
				release: () => {
					candidate.release();
					rmSync(temporary, { force: true });
				},
			};
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	private async _captureShutdownCheckpoint<T extends SessionCheckpointState>(
		capture: (signal: AbortSignal) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<{ checkpoint: T; signal: AbortSignal; release(): void }> {
		if (!this._shutdownAbortController.signal.aborted) throw new Error("Session shutdown has not begun");
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
			const held = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
			const checkpoint = await capture(held);
			held.throwIfAborted();
			return { checkpoint, signal: held, release };
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Acquire a completed-turn or fully settled native hold. Never call from an awaited run handler. */
	async acquireCheckpoint(options: CheckpointOptions = {}): Promise<CheckpointHold> {
		return this._acquireCheckpoint(options, (boundary) => this._captureCheckpoint(boundary));
	}

	/** Capture detached immutable v1 bytes using the same acquisition/refusal barrier as object capture. */
	async acquireCheckpointFile(path: string, options: CheckpointOptions = {}): Promise<CheckpointFileHold> {
		return this._acquireCheckpoint(options, (boundary, signal) =>
			writeCheckpointFile(path, this._captureCheckpointState(boundary), this._checkpointEntries(), signal),
		);
	}

	private async _acquireCheckpoint<T extends SessionCheckpointState>(
		options: CheckpointOptions,
		capture: (boundary: CheckpointBoundary, signal: AbortSignal) => T | Promise<T>,
	): Promise<Omit<CheckpointHold, "checkpoint"> & { checkpoint: T }> {
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
						const checkpoint = await capture(boundary, holdController.signal);
						if (released) return;
						if (this.model && this._modelRuntime.getProviderAuthStatus(this.model.provider).source === "runtime")
							sleepBlockers.push(
								"Selected provider uses a runtime-only API key; persist native authentication first",
							);
						if (!options.quiesce) sleepBlockers.push("Host input is not quiesced");
						if (this._baseToolsOverride) sleepBlockers.push("Runtime-only base tools cannot be restored");
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
			if (this.isIdle && !this._isEmittingAgentSettled) void this._checkpointSafePoint("settled");
		});
	}

	private async _checkpointSafePoint(boundary: CheckpointBoundary): Promise<void> {
		this._notifyShutdownCheckpointWaiters();
		const request = this._checkpointRequest;
		if (
			!request ||
			this._checkpointHeld ||
			this._isEmittingAgentSettled ||
			this._pendingSettledActions > 0 ||
			(boundary === "turn" && request.boundary === "settled")
		)
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
		return {
			steering: queues.steering.map((message, index) => normalizeCheckpointValue(message, String(index))),
			followUp: queues.followUp.map((message, index) => normalizeCheckpointValue(message, String(index))),
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			nextTurn: this._pendingNextTurnMessages.map((message, index) =>
				normalizeCheckpointValue(message, String(index)),
			),
			persistOnCancel: [...queues.steering, ...queues.followUp].flatMap((message, index) =>
				message.role === "custom" && this._cancelPersistentCustomMessages.has(message) ? [index] : [],
			),
		};
	}

	/** Startup handlers may reconstruct tools; apply the exact saved selection after they finish. */
	restoreCheckpointTools(names: string[], configuration?: SessionCheckpoint["toolConfiguration"]): void {
		this._assertNotCheckpointHeld();
		if (configuration) {
			this._noBuiltinTools = configuration.noBuiltinTools ?? false;
			this._allowedToolNames = configuration.allowedToolNames ? new Set(configuration.allowedToolNames) : undefined;
			this._excludedToolNames = configuration.excludedToolNames
				? new Set(configuration.excludedToolNames)
				: undefined;
			this._refreshToolRegistry();
		}
		this._checkpointActiveTools = [...names];
		this.setActiveToolsByName(names);
		if (!this.hasExtensionHandlers("session_start") && !this.hasExtensionHandlers("resources_discover"))
			this._finishCheckpointToolRestore();
	}

	private _finishCheckpointToolRestore(): void {
		const names = this._checkpointActiveTools;
		if (!names) return;
		if (names.some((name) => !this._toolRegistry.has(name)))
			throw new Error("Checkpoint tools unavailable after extension initialization");
		this.setActiveToolsByName(names);
		this._checkpointActiveTools = undefined;
	}

	/** Restore once into an idle, empty queue; no handlers, expansion, or model calls are replayed. */
	restoreCheckpointQueues(saved: SessionCheckpointQueues): void {
		this._assertNotCheckpointHeld();
		if (this._checkpointRestored || !this.isIdle || this.hasPendingMessages || this.pendingNextTurnCount)
			throw new Error("Checkpoint queues require a fresh idle session");
		const queues = {
			...saved,
			steering: saved.steering.map((message, index) => normalizeCheckpointValue(message, String(index))),
			followUp: saved.followUp.map((message, index) => normalizeCheckpointValue(message, String(index))),
			nextTurn: saved.nextTurn.map((message, index) => normalizeCheckpointValue(message, String(index))),
		};
		this._checkpointRestored = true;
		this._backgroundCheckpointPaused = true;
		this.agent.steeringMode = queues.steeringMode;
		this.agent.followUpMode = queues.followUpMode;
		for (const message of queues.steering) this.agent.steer(message);
		for (const message of queues.followUp) this.agent.followUp(message);
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
		this.cancelCheckpoint();
		this._promptAbortController?.abort();
		if (this.isStreaming) this._setBackgroundWakeSuppressed(true);
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
		model: Model<any>,
		customInstructions: string | undefined,
		signal: AbortSignal,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		// Resolve the request only when Pi summarizes itself: routing may call models or fail.
		const request = await this._getSummarizationRequestAuth(model, signal);
		return compact(
			preparation,
			request.model,
			request.apiKey,
			request.headers,
			customInstructions,
			signal,
			request.thinkingLevel,
			this.agent.streamFunction,
			request.env,
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
		this._shutdownAbortController.signal.throwIfAborted();
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
				this._compactionAbortController.signal.throwIfAborted();
				this._shutdownAbortController.signal.throwIfAborted();

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
					model,
					customInstructions,
					this._compactionAbortController.signal,
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

			const compactionId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			// Retain admitted input after the new boundary before compaction observers rebuild the transcript.
			this._flushPendingProviderMessages();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = this.sessionManager.getEntry(compactionId) as CompactionEntry | undefined;

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

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		const messageModel = this._modelForMessage(assistantMessage);
		const sameModel = messageModel !== undefined;
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const branch = this.sessionManager.getBranch();
		const compactionEntry = getLatestCompactionEntry(branch);
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		// Explicit errors use journal order: provider timestamps can precede a just-completed reset.
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null &&
			(assistantIndex >= 0 && assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage)
				? assistantIndex < branch.findIndex((entry) => entry.id === compactionEntry.id)
				: assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime());
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined ||
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				latestAssistantEdit?.replacement !== null);
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
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
			const retry = await this._runAutoCompaction("overflow", willRetry);
			if (retry) this._failedResponse = assistantMessage;
			return retry;
		}

		// Use the same model- and prefix-aware accounting as request preflight and the context meter.
		const contextTokens = this._estimateContextTokens().tokens;
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
		let cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const defaultPreparation = prepareCompaction(pathEntries, settings);
			const preparation =
				defaultPreparation ??
				(this._extensionRunner.hasHandlers("session_before_compact")
					? prepareCompactionForExtension(pathEntries, settings)
					: undefined);
			if (!preparation) return false;

			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			started = true;
			this._emit({ type: "compaction_start", reason });
			abortController.signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: abortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			abortController.signal.throwIfAborted();

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
				if (!defaultPreparation) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
						pendingMessages: this.hasPendingMessages,
					});
					return false;
				}
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._runDefaultCompaction(
					preparation,
					model,
					undefined,
					abortController.signal,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}
			abortController.signal.throwIfAborted();

			const compactionId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			// Retain admitted input after the new boundary before compaction observers rebuild the transcript.
			this._flushPendingProviderMessages();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = this.sessionManager.getEntry(compactionId) as CompactionEntry | undefined;

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
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
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
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.getQueuedInputCount) this._extensionGetQueuedInputCount = bindings.getQueuedInputCount;
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
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
		this._extensionRunner.reportUnhandledMcpServers();
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		this._finishCheckpointToolRestore();
		this._backgroundNotificationsReady = true;
	}

	setExtensionMode(mode: ExtensionMode): void {
		this._extensionMode = mode;
		this._applyExtensionBindings(this._extensionRunner);
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
		if (skillPaths.length === 0) return;
		const skills = this._resourceLoader.getSkills().skills;
		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({ ...this._baseSystemPromptOptions, skills });
		if (reason === "startup" && !this._hasPreparedPrompt) {
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
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
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
		if (isSyntheticPath(extensionPath)) {
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
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
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
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
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
				isBashRunning: () => this.isBashRunning,
				hasPendingSteeringMessages: () => this.agent.hasQueuedSteeringMessages(),
				getPendingNextTurnCount: () => this.pendingNextTurnCount,
				getPendingInputCount: () => this.pendingInputCount,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				getCompactionSettings: () => this.settingsManager.getCompactionSettings(this.model),
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
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
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
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: this._baseToolsOverride
							? createSyntheticSourceInfo(`<sdk:${name}>`, { source: "sdk" })
							: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming a tool activates it even when it is not active by default.
				if (allowedToolNames.has(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
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
					background_command: {
						spawnHook: (context) => ({ ...context, cwd: this._extensionRunner.resolveBashCwd(context.cwd) }),
						sessionManager: this.sessionManager,
						sessionDir: this._backgroundCommandSessionDir,
						isOneShot: () => this._extensionMode === "print" || this._extensionMode === "json",
						commandPrefix: shellCommandPrefix,
						shellPath,
						onStart: () => this._startBackgroundCommandMonitor(),
					},
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
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
		this._extensionRunner.checkpointActivity.onIdle = () => this.notifyCheckpointStateChanged();
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._noBuiltinTools
			? []
			: this._baseToolsOverride
				? Object.keys(this._baseToolsOverride)
				: ["read", "bash", "background_command", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		this.cancelCheckpoint();
		this._backgroundNotificationsReady = false;
		await this.abort();
		this.sessionManager.flush();
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		this.sessionManager.flush();
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
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
			this._extensionRunner.reportUnhandledMcpServers();
			await this.extendResourcesFromExtensions("reload");
		}
		this._backgroundNotificationsReady = true;
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
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
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
				this._shutdownAbortController.signal.throwIfAborted();
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
			// Retain raw history while omitting the failed attempt from model projection.
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
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	private _setBackgroundWakeSuppressed(value: boolean): void {
		if (value === this._backgroundWakeSuppressed) return;
		this._backgroundWakeSuppressed = value;
		this.sessionManager.appendCustomEntry(BACKGROUND_COMMAND_RUN_STATE, value);
	}

	private _startBackgroundCommandMonitor(): void {
		if (this._backgroundTimer || this._shutdownAbortController.signal.aborted) return;
		this._backgroundTimer = setInterval(() => void this._inspectBackgroundCommands(), 1000).unref();
	}

	private async _inspectBackgroundCommands(atTurnEnd = false): Promise<void> {
		if (
			!this._backgroundNotificationsReady ||
			this._backgroundCheckpointPaused ||
			this.isCheckpointHeld ||
			this._shutdownAbortController.signal.aborted
		)
			return;
		let completedIds: string[] = [];
		try {
			const jobs = listBackgroundCommands(
				backgroundCommandDirectory(this.sessionManager, this._backgroundCommandSessionDir),
			);
			const running = jobs.filter((job) => !backgroundCommandFinished(job)).length;
			this._extensionUIContext?.setStatus(
				"background-command",
				running ? `background: ${running} running` : undefined,
			);
			if (
				(!atTurnEnd && (!this.isIdle || this._isEmittingAgentSettled)) ||
				this.isBashRunning ||
				this.isCompacting ||
				this.isRetrying ||
				this._activeCommands > 0 ||
				this.pendingInputCount > 0 ||
				this.hasPendingMessages ||
				(atTurnEnd && (this._agentRunAbortRequested || this._promptAbortController?.signal.aborted))
			)
				return;
			const seen = new Set<string>();
			for (const metadata of this.sessionManager.iterateEntryMetadata()) {
				if (metadata.type === "custom_message" && metadata.customType === BACKGROUND_COMMAND_NOTICE) {
					const entry = this.sessionManager.getEntry(metadata.id);
					const details = (entry?.type === "custom_message" ? entry.details : undefined) as
						| { jobIds?: string[] }
						| undefined;
					for (const id of details?.jobIds ?? []) seen.add(id);
				} else if (
					metadata.type === "message" &&
					metadata.message.role === "toolResult" &&
					metadata.message.toolName === "background_command" &&
					!metadata.message.isError
				) {
					const entry = this.sessionManager.getEntry(metadata.id);
					const details = (entry?.type === "message" ? (entry.message as ToolResultMessage).details : undefined) as
						| BackgroundCommandToolDetails
						| undefined;
					if (details)
						for (const job of "jobs" in details ? details.jobs : [details]) {
							if (job.id && backgroundCommandFinished(job)) seen.add(job.id);
						}
				}
			}
			for (const id of seen) this._backgroundPending.delete(id);
			if (jobs.every((job) => backgroundCommandFinished(job) && seen.has(job.id))) {
				clearInterval(this._backgroundTimer);
				this._backgroundTimer = undefined;
				return;
			}
			const completed = jobs
				.filter(
					(job) => backgroundCommandFinished(job) && !seen.has(job.id) && !this._backgroundPending.has(job.id),
				)
				.slice(0, 20);
			completedIds = completed.map((job) => job.id);
			if (completed.length) {
				for (const id of completedIds) this._backgroundPending.add(id);
				await this.sendCustomMessage(
					{
						customType: BACKGROUND_COMMAND_NOTICE,
						content: `Background commands finished:\n${completed
							.map((job) => {
								const { id, status, exitCode, commandPreview, logFile, error } =
									summarizeBackgroundCommand(job);
								const summary = JSON.stringify({ id, status, exitCode, commandPreview, logFile, error });
								return status === "succeeded"
									? summary
									: `${summary}\nOutput tail:\n${backgroundCommandOutputTail(job, { maxLines: 20, maxBytes: 2048 })}`;
							})
							.join("\n\n")}`,
						display: true,
						details: { jobIds: completedIds },
					},
					{
						triggerTurn: !this._backgroundWakeSuppressed && !!this.model,
						deliverAs: "steer",
						persistOnCancel: true,
					},
				);
			}
		} catch (error) {
			for (const id of completedIds) this._backgroundPending.delete(id);
			clearInterval(this._backgroundTimer);
			this._backgroundTimer = undefined;
			this._extensionRunner.emitError({
				extensionPath: "<background-command>",
				event: "completion",
				error: `Background command monitoring failed: ${String(error)}. Results remain in ${backgroundCommandDirectory(this.sessionManager, this._backgroundCommandSessionDir)}.`,
			});
		}
	}

	/**
	 * Execute a bash command.
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
		this._shutdownAbortController.signal.throwIfAborted();
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		try {
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
				result = await executeBashWithOperations(
					prefix ? `${prefix}\n${command}` : command,
					this._extensionRunner.resolveBashCwd(this.sessionManager.getCwd()),
					intercepted?.operations ??
						options?.operations ??
						createLocalBashOperations({ shellPath: this.settingsManager.getShellPath() }),
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
			this.notifyCheckpointStateChanged();
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
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

	/** Whether a bash command is currently running */
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

		while (this._pendingBashMessages.length) this.sessionManager.appendMessage(this._pendingBashMessages.shift()!);
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
				this._shutdownAbortController.signal.throwIfAborted();
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await this._getSummarizationRequestAuth(this.model!, signal)),
					signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
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

			// A restored branch has no live request-prefix receipt.
			this._reportedUsagePrefix = undefined;
			this._refreshFinalizedContext();
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
		const result: Array<{ entryId: string; text: string }> = [];

		for (const metadata of this.sessionManager.iterateEntryMetadata()) {
			if (metadata.type !== "message" || metadata.message.role !== "user") continue;
			const entry = this.sessionManager.getEntry(metadata.id)!;
			if (entry.type !== "message" || entry.message.role !== "user") continue;
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

		for (const entry of this.sessionManager.iterateEntryMetadata()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
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
				toolCalls += message.toolCallCount;
				addUsageToTotals(usageTotals, message.usage!);
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
		const model = this._limitsModel();
		if (!model || model.contextWindow <= 0) return undefined;
		const usageState = this._getContextUsageState(this.messages);
		const inputs = {
			model: [model.provider, model.api, model.id, model.contextWindow],
			messages: this.messages,
			tools: this.agent.state.tools,
			basePrompt: this._baseSystemPromptOptions,
			baseline: this._baseSystemPromptBaseline,
			runPrompt: this._runSystemPromptOptions,
			usageState,
		};
		const cached = this._contextUsageCache;
		if (cached && cached.prefix === this._reportedUsagePrefix && isDeepStrictEqual(cached.inputs, inputs))
			return { ...cached.usage };
		const estimate = usageState.hasPostCompactionUsage ? this._estimateContextTokens() : undefined;
		const usage: ContextUsage = estimate
			? {
					tokens: estimate.tokens,
					source: estimate.source,
					contextWindow: model.contextWindow,
					percent: (estimate.tokens / model.contextWindow) * 100,
				}
			: { tokens: null, contextWindow: model.contextWindow, percent: null, source: "unknown" };
		this._contextUsageCache = { inputs: Clone(inputs), prefix: this._reportedUsagePrefix, usage };
		return { ...usage };
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional presentation settings and cancellation signal
	 * @returns Path to exported file
	 */
	async exportToHtml(
		outputPath?: string,
		options: { themeName?: string; signal?: AbortSignal } = {},
	): Promise<string> {
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
			signal: options.signal,
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
		return generateBugReportSummary({
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			messages: this.messages,
			hint: options.hint,
			signal: options.signal,
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
		// The active projection can omit completed answers after compaction; /copy still owns the raw branch.
		let lastAssistant = this.messages.findLast(isEligibleAssistant);
		if (!lastAssistant) {
			const branch = Array.from(
				this.sessionManager.iterateEntryMetadata({ branchFrom: this.sessionManager.getLeafId() }),
			);
			for (let i = branch.length - 1; i >= 0; i--) {
				const metadata = branch[i]!;
				if (metadata.type !== "message" || metadata.message.role !== "assistant") continue;
				const entry = this.sessionManager.getEntry(metadata.id)!;
				if (entry.type === "message" && isEligibleAssistant(entry.message)) {
					lastAssistant = entry.message;
					break;
				}
			}
		}

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
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
