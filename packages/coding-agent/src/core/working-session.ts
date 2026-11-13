import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { copyJson, isJsonValue } from "@earendil-works/chord/json";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { assertPrivateFilePath, atomicWriteFileSync } from "../utils/atomic-file.ts";
import { resolvePath } from "../utils/paths.ts";
import { jsonChunks, readFileChunksSync, readJsonFileSync } from "../utils/streaming-file.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { assertValidSessionId, type SessionEntry, type SessionHeader, SessionManager } from "./session-manager.ts";
import { getToolListError, isToolModifier, type Settings } from "./settings-manager.ts";
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
	defaultToolModifiers?: string[];
	steering: AgentMessage[];
	followUp: AgentMessage[];
	steeringText: string[];
	followUpText: string[];
	nextTurn: CustomMessage[];
	pendingCustom: CustomMessage[];
	pendingBash: BashExecutionMessage[];
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	settings: Settings;
	settingsLayers: { global: Settings; project: Settings };
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
	disabledBuiltinExtensions?: string[];
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

type Json = Record<string, unknown>;
type Check = (value: Json, path: string) => void;
type FieldType = "string" | "number" | "boolean";

function record(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

/** Every rejection names the field that failed, such as `entries[12].message.content[0].type`. */
function fail(path: string): never {
	throw new Error(`Invalid native working session at ${path}`);
}

/** Fail at the first of `keys` whose value is not of `type`. */
function fields(value: Json, path: string, type: FieldType, ...keys: string[]): void {
	for (const key of keys) if (typeof value[key] !== type) fail(`${path}.${key}`);
}

/** As `fields`, for keys that may be absent. */
function optionalFields(value: Json, path: string, type: FieldType, ...keys: string[]): void {
	for (const key of keys) if (value[key] !== undefined && typeof value[key] !== type) fail(`${path}.${key}`);
}

/** Fail unless `value` is an array whose items all pass `item`. */
function list(value: unknown, path: string, item: (value: unknown, path: string) => void): void {
	if (!Array.isArray(value)) fail(path);
	for (let index = 0; index < value.length; index++) item(value[index], `${path}[${index}]`);
}

/** The check a table holds for a tag read from JSON; inherited keys such as "constructor" are not tags. */
function lookup<Tag extends string>(table: Record<Tag, Check>, tag: unknown): Check | undefined {
	return typeof tag === "string" && Object.hasOwn(table, tag) ? table[tag as Tag] : undefined;
}

// Keyed by pi-ai's content block types: a block type added there fails the build until it has a check here.
const contentBlocks: Record<Exclude<Message["content"], string>[number]["type"], Check> = {
	text: (part, path) => fields(part, path, "string", "text"),
	image: (part, path) => fields(part, path, "string", "data", "mimeType"),
	thinking: (part, path) => fields(part, path, "string", "thinking"),
	toolCall: (part, path) => {
		fields(part, path, "string", "id", "name");
		if (!record(part.arguments)) fail(`${path}.arguments`);
	},
};

function block(value: unknown, path: string): void {
	if (!record(value)) fail(path);
	const check = lookup(contentBlocks, value.type);
	if (!check) fail(`${path}.type`);
	check(value, path);
}

function content(value: unknown, path: string): void {
	if (typeof value !== "string") list(value, path, block);
}

// Keyed by every role this build declares, pi-ai's and Pi's own: a role added to either fails the build until it
// has a check here.
const messageRoles: Record<AgentMessage["role"], Check> = {
	user: (value, path) => content(value.content, `${path}.content`),
	system: (value, path) => content(value.content, `${path}.content`),
	assistant: (value, path) => {
		list(value.content, `${path}.content`, block);
		fields(value, path, "string", "api", "provider", "model", "stopReason");
		if (!record(value.usage)) fail(`${path}.usage`);
	},
	toolResult: (value, path) => {
		list(value.content, `${path}.content`, block);
		fields(value, path, "string", "toolCallId", "toolName");
		fields(value, path, "boolean", "isError");
	},
	custom: (value, path) => {
		fields(value, path, "string", "customType");
		fields(value, path, "boolean", "display");
		content(value.content, `${path}.content`);
	},
	bashExecution: (value, path) => {
		fields(value, path, "string", "command", "output");
		fields(value, path, "boolean", "cancelled", "truncated");
		optionalFields(value, path, "number", "exitCode");
	},
	branchSummary: (value, path) => {
		fields(value, path, "string", "summary");
		if (value.fromId !== null && typeof value.fromId !== "string") fail(`${path}.fromId`);
	},
	compactionSummary: (value, path) => {
		fields(value, path, "string", "summary");
		fields(value, path, "number", "tokensBefore");
	},
};

/** A message; `role`, when given, is the only role admitted. */
function message(value: unknown, path: string, role?: AgentMessage["role"]): void {
	if (!record(value)) fail(path);
	if (typeof value.role !== "string" || !value.role || (role && value.role !== role)) fail(`${path}.role`);
	// AgentMessage is declaration-merged; extension roles own their JSON payload schema.
	const check = lookup(messageRoles, value.role);
	if (!check) return;
	fields(value, path, "number", "timestamp");
	check(value, path);
}

function prompt(value: unknown, path: string): void {
	if (!record(value)) fail(path);
	if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) fail(`${path}.cwd`);
	optionalFields(value, path, "string", "customPrompt", "forceSystemPrompt");
	fields(value, path, "string", "appendSystemPrompt");
	for (const key of ["selectedTools", "promptGuidelines"]) if (!strings(value[key])) fail(`${path}.${key}`);
	if (value.hiddenTools !== undefined && !strings(value.hiddenTools)) fail(`${path}.hiddenTools`);
	const dictionary = (key: string, item: (value: unknown) => boolean) => {
		const entries = value[key];
		if (!record(entries)) fail(`${path}.${key}`);
		for (const [name, entry] of Object.entries(entries))
			if (entry !== undefined && !item(entry)) fail(`${path}.${key}.${name}`);
	};
	dictionary("toolSnippets", (item) => typeof item === "string");
	dictionary("sections", (item) => typeof item === "string");
	dictionary("toolGuidelines", strings);
	list(value.contextFiles, `${path}.contextFiles`, (file, at) => {
		if (!record(file)) fail(at);
		fields(file, at, "string", "path", "content");
	});
	list(value.skills, `${path}.skills`, (skill, at) => {
		if (!record(skill)) fail(at);
		fields(skill, at, "string", "name", "description", "filePath", "baseDir");
		if (!record(skill.sourceInfo)) fail(`${at}.sourceInfo`);
		fields(skill, at, "boolean", "disableModelInvocation");
	});
}

function validateWorkingSession(value: unknown): WorkingSession {
	if (!record(value)) fail("(root)");
	if (value.version !== 1) fail("version");
	if (!["turn", "settled"].includes(String(value.boundary))) fail("boundary");
	if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) fail("cwd");
	if (typeof value.sessionDir !== "string" || (value.sessionDir !== "" && !isAbsolute(value.sessionDir)))
		fail("sessionDir");
	if (typeof value.createdAt !== "string") fail("createdAt");
	if (value.sessionFile !== undefined && (typeof value.sessionFile !== "string" || !isAbsolute(value.sessionFile)))
		fail("sessionFile");
	if (!record(value.header)) fail("header");
	if (value.header.type !== "session") fail("header.type");
	if (value.header.version !== 3) fail("header.version");
	if (typeof value.header.id !== "string") fail("header.id");
	fields(value.header, "header", "string", "cwd", "timestamp");
	assertValidSessionId(value.header.id);
	const ids = new Set<string>();
	list(value.entries, "entries", (entry, at) => {
		if (!record(entry)) fail(at);
		if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) fail(`${at}.id`);
		fields(entry, at, "string", "timestamp", "type");
		if (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
			fail(`${at}.parentId`);
		// Other types, such as pre-1.0 fork `context_window` boundaries, round-trip as opaque journal records
		// because the session loader keeps them; the restored journal must still match the file byte for byte.
		switch (entry.type) {
			case "message":
				message(entry.message, `${at}.message`);
				break;
			case "thinking_level_change":
				fields(entry, at, "string", "thinkingLevel");
				break;
			case "model_change":
				fields(entry, at, "string", "provider", "modelId");
				break;
			case "usage":
				fields(entry, at, "string", "kind", "provider", "model");
				if (!record(entry.usage)) fail(`${at}.usage`);
				break;
			case "compaction":
				fields(entry, at, "string", "summary");
				if (
					typeof entry.firstKeptEntryId !== "string" ||
					(entry.firstKeptEntryId !== entry.id && !ids.has(entry.firstKeptEntryId))
				)
					fail(`${at}.firstKeptEntryId`);
				fields(entry, at, "number", "tokensBefore");
				if (entry.systemMessage !== undefined) message(entry.systemMessage, `${at}.systemMessage`, "system");
				if (entry.toolUpdate !== undefined) message(entry.toolUpdate, `${at}.toolUpdate`, "system");
				break;
			case "branch_summary":
				// Provenance may name "root" or an abandoned path omitted by createBranchedSession().
				fields(entry, at, "string", "summary", "fromId");
				break;
			case "custom":
				fields(entry, at, "string", "customType");
				break;
			case "label":
				if (typeof entry.targetId !== "string" || !ids.has(entry.targetId)) fail(`${at}.targetId`);
				optionalFields(entry, at, "string", "label");
				break;
			case "session_info":
				optionalFields(entry, at, "string", "name");
				break;
			case "custom_message":
				fields(entry, at, "string", "customType");
				fields(entry, at, "boolean", "display");
				content(entry.content, `${at}.content`);
				break;
			case "context_edit":
				if (typeof entry.targetId !== "string" || !ids.has(entry.targetId)) fail(`${at}.targetId`);
				if (entry.replacement !== null) {
					if (!record(entry.replacement)) fail(`${at}.replacement`);
					content(entry.replacement.content, `${at}.replacement.content`);
				}
				break;
		}
		ids.add(entry.id);
	});
	if (value.leafId !== null && (typeof value.leafId !== "string" || !ids.has(value.leafId))) fail("leafId");
	for (const name of ["activeTools", "pendingTools", "steeringText", "followUpText"])
		if (!strings(value[name])) fail(name);
	for (const name of ["allowedTools", "excludedTools"])
		if (value[name] !== undefined && !strings(value[name])) fail(name);
	const queues = {
		steering: undefined,
		followUp: undefined,
		nextTurn: "custom",
		pendingCustom: "custom",
		pendingBash: "bashExecution",
	} as const;
	for (const [name, role] of Object.entries(queues)) list(value[name], name, (item, at) => message(item, at, role));
	if (
		value.defaultToolModifiers !== undefined &&
		(!strings(value.defaultToolModifiers) ||
			!value.defaultToolModifiers.every(isToolModifier) ||
			getToolListError(value.defaultToolModifiers))
	)
		fail("defaultToolModifiers");
	for (const name of ["steeringMode", "followUpMode"])
		if (!["all", "one-at-a-time"].includes(String(value[name]))) fail(name);
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (!levels.includes(String(value.thinkingLevel))) fail("thinkingLevel");
	if (typeof value.usesDefaultTools !== "boolean") fail("usesDefaultTools");
	const model = (item: unknown, path: string): void => {
		if (!record(item)) fail(path);
		fields(item, path, "string", "provider", "id");
		if (item.thinkingLevel !== undefined && !levels.includes(String(item.thinkingLevel)))
			fail(`${path}.thinkingLevel`);
	};
	if (value.model !== undefined) model(value.model, "model");
	list(value.scopedModels, "scopedModels", model);
	if (!record(value.settings)) fail("settings");
	prompt(value.prompt, "prompt");
	if (value.runPrompt !== undefined) prompt(value.runPrompt, "runPrompt");
	if (!record(value.settingsLayers)) fail("settingsLayers");
	for (const name of ["global", "project"]) if (!record(value.settingsLayers[name])) fail(`settingsLayers.${name}`);
	list(value.flags, "flags", (item, at) => {
		if (!Array.isArray(item) || item.length !== 2) fail(at);
		if (typeof item[0] !== "string") fail(`${at}[0]`);
		if (!["boolean", "string"].includes(typeof item[1])) fail(`${at}[1]`);
	});
	if (value.mode !== undefined) {
		if (!record(value.mode)) fail("mode");
		fields(value.mode, "mode", "string", "kind");
		if (value.mode.data === undefined) fail("mode.data");
	}
	const launch = value.launch;
	if (launch !== undefined) {
		if (!record(launch)) fail("launch");
		if (typeof launch.agentDir !== "string" || !isAbsolute(launch.agentDir)) fail("launch.agentDir");
		for (const name of ["extensions", "skills", "prompts", "themes"])
			if (!strings(launch[name])) fail(`launch.${name}`);
		optionalFields(
			launch,
			"launch",
			"boolean",
			"noExtensions",
			"noSkills",
			"noPromptTemplates",
			"noThemes",
			"noContextFiles",
			"trustProject",
			"offline",
		);
		optionalFields(launch, "launch", "string", "systemPrompt");
		for (const name of ["disabledBuiltinExtensions", "appendSystemPrompt"])
			if (launch[name] !== undefined && !strings(launch[name])) fail(`launch.${name}`);
	}
	return value as unknown as WorkingSession;
}

/** An owned JSON snapshot; executable or lossy values cannot become persistence evidence. */
export function copyWorkingSession(value: unknown): WorkingSession {
	return validateWorkingSession(copyJson(value, { omitUndefinedProperties: true }));
}

/** Validate the complete snapshot, then detach only the memory retained by AgentSession. */
export function copyWorkingSessionMemory(value: unknown) {
	// Proxies need the existing descriptor copy before schema reads.
	const plain = isJsonValue(value, {
		omitUndefinedProperties: true,
		validateContainer: (container) => !types.isProxy(container),
	});
	const state = plain ? validateWorkingSession(value) : copyWorkingSession(value);
	const memory = {
		steering: state.steering,
		followUp: state.followUp,
		steeringMode: state.steeringMode,
		followUpMode: state.followUpMode,
		steeringText: state.steeringText,
		followUpText: state.followUpText,
		nextTurn: state.nextTurn,
		pendingCustom: state.pendingCustom,
		pendingBash: state.pendingBash,
		usesDefaultTools: state.usesDefaultTools,
		defaultToolModifiers: state.defaultToolModifiers,
		allowedTools: state.allowedTools,
		excludedTools: state.excludedTools,
		activeTools: state.activeTools,
		pendingTools: state.pendingTools,
		prompt: state.prompt,
		runPrompt: state.runPrompt,
		flags: state.flags,
		launch: state.launch,
		mode: state.mode,
	};
	return plain ? (copyJson(memory, { omitUndefinedProperties: true }) as unknown as typeof memory) : memory;
}

/** Parsed trees are already private; reject non-finite JSON numbers without cloning them again. */
export function parseWorkingSession(text: string): WorkingSession {
	const value: unknown = JSON.parse(text);
	if (!isJsonValue(value)) throw new TypeError("Value contains a non-finite number and is not strict JSON");
	return validateWorkingSession(value);
}

export function readWorkingSession(path: string): WorkingSession {
	// The parser constructs private JSON containers and rejects surviving non-finite numbers.
	return validateWorkingSession(readJsonFileSync(path));
}

/** Read-only admission must precede services, discovery and extension factories. */
export function resolveWorkingSession(input: WorkingSession | string | undefined): WorkingSession | undefined {
	const state =
		input === undefined
			? undefined
			: typeof input === "string"
				? readWorkingSession(input)
				: copyWorkingSession(input);
	if (state) assertWorkingSessionJournal(state);
	return state;
}

/** Trusted preparation hint, not journal admission or a proof of arbitrary host memory. */
export function workingSessionResourcesMatch(
	state: WorkingSession,
	prepared: Pick<WorkingSession, "cwd" | "launch" | "settings" | "settingsLayers" | "flags"> | undefined,
): boolean {
	if (!prepared) return false;
	const policy = ({
		cwd,
		launch,
		settings,
		settingsLayers,
		flags,
	}: Pick<WorkingSession, "cwd" | "launch" | "settings" | "settingsLayers" | "flags">) => ({
		cwd: resolvePath(cwd),
		launch,
		settings,
		settingsLayers,
		flags,
	});
	return isDeepStrictEqual(policy(state), policy(prepared));
}

export function writeWorkingSession(path: string, state: WorkingSession): void {
	assertPrivateFilePath(path);
	const saved = copyWorkingSession(state);
	atomicWriteFileSync(path, (fd) => {
		let pending = "";
		for (const chunk of jsonChunks(saved)) {
			pending += chunk;
			if (pending.length >= 64 * 1024) {
				writeFileSync(fd, pending);
				pending = "";
			}
		}
		writeFileSync(fd, `${pending}\n`);
	});
}

/** Compare parsed journal JSON in serialization order without re-encoding its strings. */
function sameJournalJson(actual: unknown, expected: unknown): boolean {
	const stack: Array<{
		actual: Record<string, unknown>;
		expected: Record<string, unknown>;
		keys: Iterator<string | number>;
	}> = [];
	while (true) {
		// JSON.stringify normalizes overflowing parsed numbers and signed zero.
		if (typeof actual === "number" && !Number.isFinite(actual)) actual = null;
		if (actual !== expected) {
			if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object")
				return false;
			if (Array.isArray(actual) !== Array.isArray(expected)) return false;
			let keys: Iterator<string | number>;
			if (Array.isArray(actual)) {
				if (actual.length !== (expected as unknown[]).length) return false;
				keys = actual.keys();
			} else {
				const actualKeys = Object.keys(actual);
				const expectedKeys = Object.keys(expected);
				if (
					actualKeys.length !== expectedKeys.length ||
					actualKeys.some((key, index) => key !== expectedKeys[index])
				)
					return false;
				keys = actualKeys.values();
			}
			stack.push({
				actual: actual as Record<string, unknown>,
				expected: expected as Record<string, unknown>,
				keys,
			});
		}
		while (true) {
			const frame = stack.at(-1);
			if (!frame) return true;
			const key = frame.keys.next();
			if (key.done) {
				stack.pop();
				continue;
			}
			actual = frame.actual[key.value];
			expected = frame.expected[key.value];
			break;
		}
	}
}

function assertWorkingSessionJournal(state: WorkingSession): void {
	if (state.sessionFile && existsSync(state.sessionFile)) {
		const fail = (): never => {
			throw new Error("Native working session journal differs from saved state; refusing to overwrite it");
		};
		let index = 0;
		const compare = (line: string) => {
			if (!line.trim()) return;
			if (index > state.entries.length) fail();
			if (!sameJournalJson(JSON.parse(line), index === 0 ? state.header : state.entries[index - 1])) fail();
			index++;
		};
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const lineChunks: string[] = [];
		for (const bytes of readFileChunksSync(state.sessionFile)) {
			const chunk = decoder.decode(bytes, { stream: true });
			let start = 0;
			let end = chunk.indexOf("\n", start);
			while (end !== -1) {
				lineChunks.push(chunk.slice(start, end));
				const line = lineChunks.join("");
				lineChunks.length = 0;
				compare(line);
				start = end + 1;
				end = chunk.indexOf("\n", start);
			}
			lineChunks.push(chunk.slice(start));
		}
		lineChunks.push(decoder.decode());
		compare(lineChunks.join(""));
		if (index !== state.entries.length + 1) fail();
	}
}

/** Recheck the live journal immediately before the native manager can materialize it. */
export function openWorkingSession(state: WorkingSession): SessionManager {
	const saved = copyWorkingSession(state);
	assertWorkingSessionJournal(saved);
	return SessionManager.fromWorkingSession(
		saved.cwd,
		saved.sessionDir,
		saved.sessionFile,
		[saved.header, ...saved.entries],
		saved.leafId,
	);
}

/** One granted save. Invalidation makes the snapshot unusable but keeps it reserved until release. */
class WorkingSessionReservation {
	private readonly releaseBarrier = Promise.withResolvers<void>();
	readonly released = this.releaseBarrier.promise;
	private readonly lifetime = new AbortController();
	/** Ends on release, including preparation failure or connection loss. */
	readonly signal: AbortSignal = this.lifetime.signal;
	private readonly invalidation = new AbortController();
	/** Aborted once the cut is unusable; the reservation stays held until release. */
	readonly invalidated: AbortSignal = this.invalidation.signal;
	private phase: "preparing" | "appending" | "prepared" | "released" = "preparing";
	private readonly onInvalidate: ((reason: string) => void) | undefined;
	private readonly onRelease: () => void;

	constructor(onInvalidate: ((reason: string) => void) | undefined, onRelease: () => void) {
		this.onInvalidate = onInvalidate;
		this.onRelease = onRelease;
	}

	get appending(): boolean {
		return this.phase === "appending";
	}

	invalidate(reason: string): void {
		if (this.invalidated.aborted) return;
		// The filesystem guard must change before an incompatible admission returns.
		this.onInvalidate?.(reason);
		this.invalidation.abort(new Error(reason));
	}

	/** Run one save-hook journal append; the writer expires when preparation ends or on release. */
	append<T>(action: () => T): T {
		if (this.phase !== "preparing") throw new Error("Working session save writer expired");
		this.phase = "appending";
		try {
			return action();
		} finally {
			this.phase = "preparing";
		}
	}

	endPreparation(): void {
		if (this.phase === "preparing") this.phase = "prepared";
	}

	assertHeld(): void {
		if (this.phase === "released") throw new Error("Native working session released");
		this.invalidated.throwIfAborted();
	}

	/** Free the gate before abort listeners resume native work. */
	async release(): Promise<void> {
		if (this.phase === "released") return;
		this.phase = "released";
		this.releaseBarrier.resolve();
		this.onRelease();
		this.lifetime.abort();
	}
}

/** Single native admission gate; no sleep policy or polling. */
export class WorkingSessionGate {
	private readonly context = new AsyncLocalStorage<Array<{ foreground: boolean }>>();
	private readonly activity = new Set<{ foreground: boolean }>();
	private held?: WorkingSessionReservation;
	private exiting = false;
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
	get reservation(): WorkingSessionReservation | undefined {
		return this.held;
	}

	beforeMutation = (): void => {
		if (!this.held || this.held.appending) return;
		this.invalidate("Native input or mutation during save");
		throw new Error("Native working session is reserved for saving; retry after release");
	};

	/** Final exit still admits shutdown persistence, but no new turn and no steer into a current one. */
	admitTurn(): void {
		if (this.exiting) throw new Error("Native runtime is exiting; new turns are not admitted");
	}

	invalidate(reason: string): void {
		this.held?.invalidate(reason);
	}

	/** Reserve the session for one save; only the reservation's own release ends it. */
	reserve(onInvalidate?: (reason: string) => void): WorkingSessionReservation {
		if (this.held) throw new Error("Native working session already reserved");
		this.held = new WorkingSessionReservation(onInvalidate, () => {
			this.held = undefined;
			this.onIdle?.();
		});
		return this.held;
	}

	async waitForRelease(): Promise<void> {
		await this.held?.released;
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

	/**
	 * Quit joins the run and excludes only its own caller, never independently admitted work.
	 * It closes turn admission for good, so shutdown handlers cannot start work that capture must refuse.
	 */
	async finalExit<T>(action: () => Promise<T>): Promise<T> {
		this.exiting = true;
		const restore = this.foreground();
		try {
			return await this.context.exit(action);
		} finally {
			restore();
		}
	}
}
