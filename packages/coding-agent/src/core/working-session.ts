import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { assertPrivateFilePath, atomicWriteFileSync } from "../utils/atomic-file.ts";
import { assertValidSessionId, type SessionEntry, type SessionHeader, SessionManager } from "./session-manager.ts";
import type { Settings } from "./settings-manager.ts";
import type { NormalizedBuildSystemPromptOptions } from "./system-prompt.ts";

export type WorkingSessionBoundary = "turn" | "settled";

/** Complete private state. Executable tools, credentials and callback memory stay with their native owners. */
export interface WorkingSession {
	version: 1;
	createdAt: string;
	boundary: WorkingSessionBoundary;
	cwd: string;
	sessionFile?: string;
	sessionDir: string;
	header: SessionHeader;
	entries: SessionEntry[];
	leafId: string | null;
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	scopedModels: Array<{ provider: string; id: string; thinkingLevel?: ThinkingLevel }>;
	activeTools: string[];
	pendingTools: string[];
	allowedTools?: string[];
	excludedTools?: string[];
	usesDefaultTools: boolean;
	steering: AgentMessage[];
	followUp: AgentMessage[];
	steeringText: string[];
	followUpText: string[];
	nextTurn: AgentMessage[];
	pendingCustom: AgentMessage[];
	pendingBash: AgentMessage[];
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	settings: Settings;
	prompt: NormalizedBuildSystemPromptOptions;
	runPrompt?: NormalizedBuildSystemPromptOptions;
	flags: Array<[string, boolean | string]>;
	launch?: WorkingSessionLaunch;
	mode?: { kind: string; data: unknown };
}

/** Resource selection, never consumed input or auth. CLI paths are normalized before capture. */
export interface WorkingSessionLaunch {
	agentDir: string;
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	trustProject?: boolean;
	offline?: boolean;
}

export interface WorkingSessionSaveEvent {
	type: "working_session_save";
	boundary: WorkingSessionBoundary;
	/** Ends only on release, including preparation failure or connection loss. */
	signal: AbortSignal;
	invalidate(reason: string): void;
	/** Only valid during this handler dispatch. Other mutation APIs remain guarded. */
	appendEntry(customType: string, data?: unknown): void;
}

export interface WorkingSessionReadiness {
	blockers?: string[];
}

/** SDK/mode owners use the same strict hook as extensions. Unsupported memory waits veto sleep. */
export interface WorkingSessionHost {
	kind: string;
	readiness(
		event: WorkingSessionSaveEvent,
	): Promise<WorkingSessionReadiness> | Promise<void> | WorkingSessionReadiness | void;
	capture(): unknown;
	restore(data: unknown): void;
}

export interface WorkingSessionHold {
	readonly state: WorkingSession;
	readonly boundary: WorkingSessionBoundary;
	readonly sleepReady: boolean;
	readonly blockers: readonly string[];
	readonly signal: AbortSignal;
	readonly invalidated: AbortSignal;
	assertHeld(): void;
	release(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function content(value: unknown): boolean {
	return (
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every((part: unknown) => {
				if (!record(part)) return false;
				switch (part.type) {
					case "text":
						return typeof part.text === "string";
					case "image":
						return typeof part.data === "string" && typeof part.mimeType === "string";
					case "thinking":
						return typeof part.thinking === "string";
					case "toolCall":
						return typeof part.id === "string" && typeof part.name === "string" && record(part.arguments);
					default:
						return false;
				}
			}))
	);
}

function message(value: unknown): boolean {
	if (!record(value) || typeof value.timestamp !== "number") return false;
	switch (value.role) {
		case "user":
		case "system":
			return content(value.content);
		case "assistant":
			return (
				Array.isArray(value.content) &&
				content(value.content) &&
				typeof value.api === "string" &&
				typeof value.provider === "string" &&
				typeof value.model === "string" &&
				record(value.usage) &&
				typeof value.stopReason === "string"
			);
		case "toolResult":
			return (
				Array.isArray(value.content) &&
				content(value.content) &&
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string" &&
				typeof value.isError === "boolean"
			);
		case "custom":
			return typeof value.customType === "string" && typeof value.display === "boolean" && content(value.content);
		case "bashExecution":
			return (
				typeof value.command === "string" &&
				typeof value.output === "string" &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean" &&
				(value.exitCode === undefined || typeof value.exitCode === "number")
			);
		case "branchSummary":
			return typeof value.summary === "string" && (value.fromId === null || typeof value.fromId === "string");
		case "compactionSummary":
			return typeof value.summary === "string" && typeof value.tokensBefore === "number";
		default:
			return false;
	}
}

function prompt(value: unknown): boolean {
	return (
		record(value) &&
		typeof value.cwd === "string" &&
		isAbsolute(value.cwd) &&
		(value.customPrompt === undefined || typeof value.customPrompt === "string") &&
		(value.forceSystemPrompt === undefined || typeof value.forceSystemPrompt === "string") &&
		typeof value.appendSystemPrompt === "string" &&
		strings(value.selectedTools) &&
		strings(value.promptGuidelines) &&
		record(value.toolSnippets) &&
		Object.values(value.toolSnippets).every((item) => typeof item === "string") &&
		record(value.sections) &&
		Object.values(value.sections).every((item) => typeof item === "string") &&
		record(value.toolGuidelines) &&
		Object.values(value.toolGuidelines).every(strings) &&
		Array.isArray(value.contextFiles) &&
		value.contextFiles.every(
			(file: unknown) => record(file) && typeof file.path === "string" && typeof file.content === "string",
		) &&
		Array.isArray(value.skills) &&
		value.skills.every(
			(skill: unknown) =>
				record(skill) &&
				["name", "description", "filePath", "baseDir"].every((key) => typeof skill[key] === "string") &&
				record(skill.sourceInfo) &&
				typeof skill.disableModelInvocation === "boolean",
		)
	);
}

/** Validation precedes SessionManager construction: no journal repair or migration on rejection. */
export function parseWorkingSession(text: string): WorkingSession {
	const value: unknown = JSON.parse(text);
	const fail: () => never = () => {
		throw new Error("Invalid native working session");
	};
	if (!record(value) || value.version !== 1 || !["turn", "settled"].includes(String(value.boundary))) fail();
	if (!record(value)) fail();
	for (const name of ["cwd", "sessionDir", "createdAt"]) if (typeof value[name] !== "string") fail();
	if (
		!isAbsolute(String(value.cwd)) ||
		(value.sessionDir !== "" && !isAbsolute(String(value.sessionDir))) ||
		(value.sessionFile !== undefined && (typeof value.sessionFile !== "string" || !isAbsolute(value.sessionFile)))
	)
		fail();
	if (
		!record(value.header) ||
		value.header.type !== "session" ||
		value.header.version !== 3 ||
		typeof value.header.id !== "string" ||
		typeof value.header.cwd !== "string" ||
		typeof value.header.timestamp !== "string"
	)
		fail();
	assertValidSessionId(value.header.id);
	if (!Array.isArray(value.entries)) fail();
	const ids = new Set<string>();
	for (const entry of value.entries as unknown[]) {
		if (
			!record(entry) ||
			typeof entry.id !== "string" ||
			!entry.id ||
			ids.has(entry.id) ||
			typeof entry.timestamp !== "string" ||
			typeof entry.type !== "string"
		)
			fail();
		if (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId))) fail();
		if (
			![
				"message",
				"thinking_level_change",
				"model_change",
				"usage",
				"compaction",
				"branch_summary",
				"custom",
				"label",
				"session_info",
				"custom_message",
				"context_edit",
			].includes(entry.type)
		)
			fail();
		switch (entry.type) {
			case "message":
				if (!message(entry.message)) fail();
				break;
			case "thinking_level_change":
				if (typeof entry.thinkingLevel !== "string") fail();
				break;
			case "model_change":
				if (typeof entry.provider !== "string" || typeof entry.modelId !== "string") fail();
				break;
			case "usage":
				if (!["kind", "provider", "model"].every((key) => typeof entry[key] === "string") || !record(entry.usage))
					fail();
				break;
			case "compaction":
				if (
					typeof entry.summary !== "string" ||
					typeof entry.firstKeptEntryId !== "string" ||
					!ids.has(entry.firstKeptEntryId) ||
					typeof entry.tokensBefore !== "number" ||
					(entry.systemMessage !== undefined &&
						(!record(entry.systemMessage) ||
							entry.systemMessage.role !== "system" ||
							!message(entry.systemMessage)))
				)
					fail();
				break;
			case "branch_summary":
				if (typeof entry.summary !== "string" || typeof entry.fromId !== "string" || !ids.has(entry.fromId)) fail();
				break;
			case "custom":
				if (typeof entry.customType !== "string") fail();
				break;
			case "label":
				if (
					typeof entry.targetId !== "string" ||
					!ids.has(entry.targetId) ||
					(entry.label !== undefined && typeof entry.label !== "string")
				)
					fail();
				break;
			case "session_info":
				if (entry.name !== undefined && typeof entry.name !== "string") fail();
				break;
			case "custom_message":
				if (typeof entry.customType !== "string" || typeof entry.display !== "boolean" || !content(entry.content))
					fail();
				break;
			case "context_edit":
				if (
					typeof entry.targetId !== "string" ||
					!ids.has(entry.targetId) ||
					(entry.replacement !== null && (!record(entry.replacement) || !content(entry.replacement.content)))
				)
					fail();
				break;
		}
		ids.add(entry.id);
	}
	if (value.leafId !== null && (typeof value.leafId !== "string" || !ids.has(value.leafId))) fail();
	for (const name of [
		"activeTools",
		"pendingTools",
		"steeringText",
		"followUpText",
		"allowedTools",
		"excludedTools",
	]) {
		const list = value[name];
		if (list === undefined && (name === "allowedTools" || name === "excludedTools")) continue;
		if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) fail();
	}
	for (const name of ["steering", "followUp", "nextTurn", "pendingCustom", "pendingBash"]) {
		const list = value[name];
		if (!Array.isArray(list) || !list.every(message)) fail();
		const role =
			name === "pendingBash"
				? "bashExecution"
				: name === "nextTurn" || name === "pendingCustom"
					? "custom"
					: undefined;
		if (role && !list.every((item: unknown) => record(item) && item.role === role)) fail();
	}
	for (const name of ["steeringMode", "followUpMode"])
		if (!["all", "one-at-a-time"].includes(String(value[name]))) fail();
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (!levels.includes(String(value.thinkingLevel)) || typeof value.usesDefaultTools !== "boolean") fail();
	const model = (item: unknown): boolean =>
		record(item) &&
		typeof item.provider === "string" &&
		typeof item.id === "string" &&
		(item.thinkingLevel === undefined || levels.includes(String(item.thinkingLevel)));
	if (
		(value.model !== undefined && !model(value.model)) ||
		!Array.isArray(value.scopedModels) ||
		!value.scopedModels.every(model)
	)
		fail();
	if (!record(value.settings) || !prompt(value.prompt) || (value.runPrompt !== undefined && !prompt(value.runPrompt)))
		fail();
	if (
		!Array.isArray(value.flags) ||
		!value.flags.every(
			(item) =>
				Array.isArray(item) &&
				item.length === 2 &&
				typeof item[0] === "string" &&
				["boolean", "string"].includes(typeof item[1]),
		)
	)
		fail();
	if (
		value.mode !== undefined &&
		(!record(value.mode) || typeof value.mode.kind !== "string" || !("data" in value.mode))
	)
		fail();
	if (value.launch !== undefined) {
		if (!record(value.launch) || typeof value.launch.agentDir !== "string" || !isAbsolute(value.launch.agentDir))
			fail();
		for (const name of ["extensions", "skills", "prompts", "themes"]) {
			const list = value.launch[name];
			if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) fail();
		}
		for (const name of [
			"noExtensions",
			"noSkills",
			"noPromptTemplates",
			"noThemes",
			"noContextFiles",
			"trustProject",
			"offline",
		])
			if (value.launch[name] !== undefined && typeof value.launch[name] !== "boolean") fail();
		if (value.launch.systemPrompt !== undefined && typeof value.launch.systemPrompt !== "string") fail();
		if (
			value.launch.appendSystemPrompt !== undefined &&
			(!Array.isArray(value.launch.appendSystemPrompt) ||
				!value.launch.appendSystemPrompt.every((item) => typeof item === "string"))
		)
			fail();
	}
	return value as unknown as WorkingSession;
}

export function readWorkingSession(path: string): WorkingSession {
	return parseWorkingSession(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
}

export function writeWorkingSession(path: string, state: WorkingSession): void {
	assertPrivateFilePath(path);
	atomicWriteFileSync(path, `${JSON.stringify(state)}\n`);
}

export function openWorkingSession(state: WorkingSession): SessionManager {
	const entries = [state.header, ...state.entries];
	if (state.sessionFile && existsSync(state.sessionFile)) {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(state.sessionFile));
		const actual: unknown[] = text
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
		if (JSON.stringify(actual) !== JSON.stringify(entries))
			throw new Error("Native working session journal differs from saved state; refusing to overwrite it");
	}
	return SessionManager.fromWorkingSession(state.cwd, state.sessionDir, state.sessionFile, entries, state.leafId);
}

/** Single native admission gate; no sleep policy or polling. */
export class WorkingSessionGate {
	private readonly context = new AsyncLocalStorage<Array<{ foreground: boolean }>>();
	private readonly activity = new Set<{ foreground: boolean }>();
	private held?: {
		invalidated: AbortController;
		onInvalidate?: (reason: string) => void;
		released: Promise<void>;
		release: () => void;
	};
	private preparationMutation = false;
	onIdle?: () => void;

	get inActivity(): boolean {
		return this.context.getStore()?.some((activity) => this.activity.has(activity)) ?? false;
	}
	get busy(): boolean {
		return [...this.activity].some((activity) => !activity.foreground);
	}
	get reserved(): boolean {
		return this.held !== undefined;
	}

	beforeMutation = (): void => {
		if (!this.held || this.preparationMutation) return;
		this.invalidate("Native input or mutation during save");
		throw new Error("Native working session is reserved for saving; retry after release");
	};

	invalidate(reason: string): void {
		if (!this.held || this.held.invalidated.signal.aborted) return;
		// The filesystem guard must change before an incompatible admission returns.
		this.held.onInvalidate?.(reason);
		this.held.invalidated.abort(new Error(reason));
	}

	reserve(invalidated: AbortController, onInvalidate?: (reason: string) => void): void {
		if (this.held) throw new Error("Native working session already reserved");
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.held = { invalidated, onInvalidate, released, release };
	}

	release(): void {
		this.held?.release();
		this.held = undefined;
		this.onIdle?.();
	}

	async waitForRelease(): Promise<void> {
		await this.held?.released;
	}

	prepareMutation<T>(action: () => T): T {
		this.preparationMutation = true;
		try {
			return action();
		} finally {
			this.preparationMutation = false;
		}
	}

	async run<T>(action: () => Promise<T>): Promise<T> {
		this.beforeMutation();
		const activity = { foreground: false };
		this.activity.add(activity);
		try {
			return await this.context.run([...(this.context.getStore() ?? []), activity], action);
		} finally {
			this.activity.delete(activity);
			this.onIdle?.();
		}
	}

	/** Public notification listeners keep their synchronous dispatch semantics. */
	callback(action: () => unknown): void {
		this.beforeMutation();
		const activity = { foreground: false };
		this.activity.add(activity);
		const finish = () => {
			this.activity.delete(activity);
			queueMicrotask(() => this.onIdle?.());
		};
		try {
			const result = this.context.run([...(this.context.getStore() ?? []), activity], action);
			if (result instanceof Promise) void result.finally(finish);
			else finish();
		} catch (error) {
			finish();
			throw error;
		}
	}

	foreground(): () => void {
		const activities = this.context.getStore() ?? [];
		const previous = activities.map((activity) => activity.foreground);
		for (const activity of activities) activity.foreground = true;
		return () => {
			activities.forEach((activity, index) => {
				activity.foreground = previous[index]!;
			});
		};
	}

	/** Quit joins the run and excludes only its own caller, never independently admitted work. */
	async finalExit<T>(action: () => Promise<T>): Promise<T> {
		const restore = this.foreground();
		try {
			return await this.context.exit(action);
		} finally {
			restore();
		}
	}
}
