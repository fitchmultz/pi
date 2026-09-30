import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { publishLocalFileExclusiveSync } from "@earendil-works/pi-agent-core/node";
import type { RestartCheckpoint } from "../cli/restart-protocol.ts";
import type { AgentSession } from "./agent-session.ts";
import { THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { writeJsonValue } from "./json-record-writer.ts";
import type { CustomMessage } from "./messages.ts";
import { assertSessionConversionNotRequired } from "./session-conversion.ts";
import { closeJournalSource, JsonTokenProjection, readJournalRecord, scanJournal } from "./session-journal.ts";
import { type SessionEntry, type SessionHeader, SessionManager } from "./session-manager.ts";

export type CheckpointBoundary = "turn" | "settled";
export const CHECKPOINT_EXIT_PATH_ENV = "PI_CHECKPOINT_EXIT_PATH";

/** Native callback ownership, not a registry of arbitrary extension promises or external processes. */
export class CheckpointActivity {
	private readonly pending = new Set<Promise<unknown>>();
	private readonly invalidators = new Set<() => void>();
	onIdle?: () => void;

	get busy(): boolean {
		return this.pending.size > 0;
	}

	invalidate(): void {
		for (const invalidate of [...this.invalidators]) invalidate();
	}

	run<T>(callback: () => T | Promise<T>): Promise<T> {
		// Reserve before invalidation listeners or callbacks can re-enter checkpoint acquisition.
		let finish!: () => void;
		const reservation = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.pending.add(reservation);
		const release = () => {
			this.pending.delete(reservation);
			finish();
			if (!this.busy) this.onIdle?.();
		};
		try {
			this.invalidate();
			return Promise.resolve(callback()).finally(release);
		} catch (error) {
			release();
			return Promise.reject(error);
		}
	}

	async flush(): Promise<void> {
		while (this.busy) await Promise.all([...this.pending]);
	}

	hold(invalidate: () => void): () => void {
		if (this.busy) throw new Error("Checkpoint unavailable: native callbacks still running");
		this.invalidators.add(invalidate);
		return () => {
			this.invalidators.delete(invalidate);
		};
	}
}

export interface SessionCheckpointQueues {
	steering: AgentMessage[];
	followUp: AgentMessage[];
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	nextTurn: CustomMessage[];
	/** Indices in steering followed by followUp, retaining cancellation-safe custom ownership. */
	persistOnCancel: number[];
}

export interface SessionCheckpoint {
	version: 1;
	createdAt: string;
	selection: RestartCheckpoint;
	header: SessionHeader;
	entries: SessionEntry[];
	queues: SessionCheckpointQueues;
	/** Native registry restrictions, not inferred from the active/known tool names. Absent on older v1 artifacts. */
	toolConfiguration?: {
		allowedToolNames?: string[];
		excludedToolNames?: string[];
		noBuiltinTools?: boolean;
	};
	/** Exact native cycling scope, including session-only picker changes. Absent on older artifacts. */
	scopedModels?: Array<{ provider: string; id: string; thinkingLevel?: RestartCheckpoint["thinkingLevel"] }>;
	boundary: CheckpointBoundary;
	/** Native settlement only. The host must still coordinate UI and external writers. */
	settled: boolean;
	/** Only deliberate CLI clean exit publishes this marker. Also require observed launcher exit status 0. */
	completedExit?: { pid: number };
}

export interface CheckpointHold {
	checkpoint: SessionCheckpoint;
	/** Native resumability only; the archive owner must separately freeze filesystem writers. */
	sleepReady: boolean;
	sleepBlockers: string[];
	/** Aborted when released or invalidated by cancellation/reload/shutdown. */
	signal: AbortSignal;
	/** Idempotent; release on every failure path. No queue is consumed by capture. */
	release(): void;
}

/** Final disposed-session candidate; validity must still be checked immediately before exit publication. */
export type ShutdownCheckpoint = Pick<CheckpointHold, "checkpoint" | "signal" | "release">;

export type SessionCheckpointState = Omit<SessionCheckpoint, "entries">;

export interface CheckpointFile extends SessionCheckpointState {
	path: string;
}

export interface CheckpointFileHold extends Omit<CheckpointHold, "checkpoint"> {
	checkpoint: CheckpointFile;
}

export type ShutdownCheckpointFile = Pick<CheckpointFileHold, "checkpoint" | "signal" | "release">;

export interface CheckpointExitWriter {
	(checkpoint: SessionCheckpoint | CheckpointFile): void;
	readonly path: string;
}

/** Native JSON normalization at a single value boundary, including omission/toJSON/errors. */
export function normalizeCheckpointValue<T>(value: T, key: string): T {
	const normalized = JSON.parse(JSON.stringify({ [key]: value }));
	return (Object.hasOwn(normalized, key) ? normalized[key] : null) as T;
}

export interface CheckpointOptions {
	boundary?: CheckpointBoundary;
	signal?: AbortSignal;
	/** Synchronously close host input; reject unsupported UI/callback state. */
	quiesce?: () => () => void;
	/** Defer until the native host can quiesce; notifyCheckpointStateChanged retries idle acquisition. */
	canQuiesce?: () => boolean;
}

/** Refuse a journal (including hardlink/symlink aliases) and unsafe/unrelated existing artifacts. */
export function assertCheckpointTarget(path: string, journal: string): void {
	if (!isAbsolute(path)) throw new Error("Checkpoint path must be absolute");
	if (!statSync(dirname(path)).isDirectory()) throw new Error("Checkpoint parent must be a directory");
	const target = lstatSync(path, { throwIfNoEntry: false });
	const source = statSync(journal, { throwIfNoEntry: false });
	const resolvedTarget = join(realpathSync(dirname(path)), basename(path));
	const resolvedJournal = existsSync(dirname(journal))
		? join(realpathSync(dirname(journal)), basename(journal))
		: resolve(journal);
	const alias = statSync(path, { throwIfNoEntry: false });
	if (resolvedTarget === resolvedJournal || (alias && source && alias.dev === source.dev && alias.ino === source.ino))
		throw new Error("Checkpoint path must not replace the native journal or its aliases");
	if (target && (!target.isFile() || target.isSymbolicLink()))
		throw new Error("Checkpoint target must be a regular file");
	if (target) readSessionCheckpointState(path);
}

const checkpointLayout = {
	fields: {
		entries: { items: {} },
		queues: {
			fields: {
				steering: { items: {} },
				followUp: { items: {} },
				nextTurn: { items: {} },
				persistOnCancel: { items: {} },
			},
		},
		scopedModels: { items: {} },
	},
};

/** Private atomic v1 replacement. Explicit object callers retain their requested full-object heap ceiling. */
export function writeSessionCheckpoint(path: string, checkpoint: SessionCheckpoint): void {
	assertCheckpointTarget(path, checkpoint.selection.sessionFile);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	let closed = false;
	try {
		writeJsonValue(checkpoint, (text) => writeFileSync(fd, text), checkpointLayout);
		writeFileSync(fd, "\n");
		closeSync(fd);
		closed = true;
		readSessionCheckpointState(temporary);
		assertCheckpointTarget(path, checkpoint.selection.sessionFile);
		renameSync(temporary, path);
	} finally {
		if (!closed) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

/** Write complete self-contained bytes while native activity is held; yield between records for invalidation. */
export async function writeCheckpointFile(
	path: string,
	state: SessionCheckpointState,
	entries: Iterable<SessionEntry>,
	signal: AbortSignal,
): Promise<CheckpointFile> {
	assertCheckpointTarget(path, state.selection.sessionFile);
	signal.throwIfAborted();
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	let closed = false;
	try {
		writeFileSync(fd, "{");
		let first = true;
		for (const [key, value] of Object.entries({ ...state, entries })) {
			if (value === undefined) continue;
			if (!first) writeFileSync(fd, ",");
			first = false;
			writeFileSync(fd, `${JSON.stringify(key)}:`);
			if (key === "entries") {
				writeFileSync(fd, "[");
				let index = 0;
				for (const entry of entries) {
					signal.throwIfAborted();
					if (index) writeFileSync(fd, ",");
					// Native wrapper preserves the entry's array-index toJSON key without an aggregate clone.
					let written = false;
					writeJsonValue(
						entry,
						(text) => {
							written = true;
							writeFileSync(fd, text);
						},
						undefined,
						String(index++),
					);
					if (!written) writeFileSync(fd, "null");
					await setImmediate();
				}
				writeFileSync(fd, "]");
			} else {
				writeJsonValue(
					value,
					(text) => writeFileSync(fd, text),
					checkpointLayout.fields[key as keyof typeof checkpointLayout.fields],
				);
			}
		}
		writeFileSync(fd, "}\n");
		closeSync(fd);
		closed = true;
		readSessionCheckpointState(temporary);
		signal.throwIfAborted();
		assertCheckpointTarget(path, state.selection.sessionFile);
		renameSync(temporary, path);
		return { ...state, path };
	} finally {
		if (!closed) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

function validateState(value: SessionCheckpointState): void {
	if (
		!value ||
		value.version !== 1 ||
		typeof value.createdAt !== "string" ||
		!value.selection ||
		!value.header ||
		value.header.type !== "session" ||
		value.header.id !== value.selection.sessionId ||
		typeof value.selection.sessionFile !== "string" ||
		!isAbsolute(value.selection.sessionFile) ||
		typeof value.selection.cwd !== "string" ||
		!isAbsolute(value.selection.cwd) ||
		(value.selection.leafId !== null && typeof value.selection.leafId !== "string") ||
		!THINKING_LEVEL_OPTIONS.includes(value.selection.thinkingLevel) ||
		!value.queues ||
		!Array.isArray(value.queues.steering) ||
		!Array.isArray(value.queues.followUp) ||
		!Array.isArray(value.queues.nextTurn) ||
		!Array.isArray(value.queues.persistOnCancel) ||
		!["turn", "settled"].includes(value.boundary) ||
		typeof value.settled !== "boolean" ||
		!["all", "one-at-a-time"].includes(value.queues.steeringMode) ||
		!["all", "one-at-a-time"].includes(value.queues.followUpMode)
	)
		throw new Error("Invalid session checkpoint");
	const model = value.selection.model;
	if (
		model !== undefined &&
		(!model || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id)
	)
		throw new Error("Invalid checkpoint model selection");
	const configuration = value.toolConfiguration;
	if (
		configuration !== undefined &&
		(!configuration ||
			typeof configuration !== "object" ||
			Array.isArray(configuration) ||
			(configuration.noBuiltinTools !== undefined && typeof configuration.noBuiltinTools !== "boolean"))
	)
		throw new Error("Invalid checkpoint tool configuration");
	if (
		value.scopedModels !== undefined &&
		(!Array.isArray(value.scopedModels) ||
			value.scopedModels.some(
				(scoped) =>
					!scoped ||
					typeof scoped.provider !== "string" ||
					!scoped.provider ||
					typeof scoped.id !== "string" ||
					!scoped.id ||
					(scoped.thinkingLevel !== undefined && !THINKING_LEVEL_OPTIONS.includes(scoped.thinkingLevel)),
			))
	)
		throw new Error("Invalid checkpoint model scope");
	if (
		value.completedExit !== undefined &&
		(!value.completedExit || !Number.isSafeInteger(value.completedExit.pid) || value.completedExit.pid <= 0)
	)
		throw new Error("Invalid checkpoint completed exit");
	for (const names of [
		value.selection.activeTools,
		value.selection.knownTools,
		configuration?.allowedToolNames === undefined ? [] : configuration.allowedToolNames,
		configuration?.excludedToolNames === undefined ? [] : configuration.excludedToolNames,
	]) {
		if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name))
			throw new Error("Checkpoint uses unsupported tool references; resume and settle it in its original runtime");
	}
	const queued = [...value.queues.steering, ...value.queues.followUp];
	if (
		value.queues.persistOnCancel.some(
			(index) => !Number.isInteger(index) || index < 0 || index >= queued.length || queued[index].role !== "custom",
		)
	)
		throw new Error("Invalid checkpoint cancellation ownership");
	assertSessionConversionNotRequired([
		value.header,
		...[...queued, ...value.queues.nextTurn].map((message) => ({ type: "message", message })),
	]);
}

function validateEntry(entry: SessionEntry, ids: Set<string>): void {
	assertSessionConversionNotRequired([entry]);
	if (
		!entry ||
		typeof entry.id !== "string" ||
		!entry.id ||
		ids.has(entry.id) ||
		(entry.parentId !== null && !ids.has(entry.parentId))
	)
		throw new Error("Invalid checkpoint entry tree");
	ids.add(entry.id);
}

/** Stream complete validation. Only explicit entry consumers assemble bodies, one value at a time. */
function readCheckpointValues(
	path: string,
	onEntry?: (entry: SessionEntry, index: number) => void,
	resetEntries?: () => void,
): SessionCheckpointState {
	const fd = openSync(path, "r");
	try {
		const initial = fstatSync(fd);
		const ids = new Set<string>();
		let entriesSeen = false;
		let previousEntriesComplete = true;
		let entryError: unknown;
		const projection = new JsonTokenProjection({
			select: (path) => (path.length === 0 || (path[0] === "entries" && path.length === 1) ? "descend" : "keep"),
			onValue: (path, value) => {
				if (path[0] !== "entries") return false;
				if (path.length === 2) {
					const index = Number(path[1]);
					if (previousEntriesComplete) {
						ids.clear();
						entryError = undefined;
						previousEntriesComplete = false;
						resetEntries?.();
					}
					try {
						validateEntry(value as SessionEntry, ids);
					} catch (error) {
						entryError = error;
					}
					onEntry?.(value as SessionEntry, index);
					return true;
				}
				if (path.length === 1) {
					if (previousEntriesComplete) {
						ids.clear();
						entryError = undefined;
						resetEntries?.();
					}
					entriesSeen = Array.isArray(value);
					previousEntriesComplete = true;
				}
				return false;
			},
		});
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		while (position < initial.size) {
			const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - position), position);
			if (!bytes) throw new Error("Checkpoint truncated during inspection");
			projection.write(decoder.decode(buffer.subarray(0, bytes), { stream: true }));
			position += bytes;
		}
		projection.write(decoder.decode());
		const value = projection.finish() as SessionCheckpoint;
		validateState(value);
		if (!entriesSeen || !Array.isArray(value.entries)) throw new Error("Invalid session checkpoint entries");
		if (entryError) throw entryError;
		if (value.selection.leafId !== null && !ids.has(value.selection.leafId))
			throw new Error("Checkpoint leaf is missing");
		const final = fstatSync(fd);
		const current = statSync(path);
		if (
			final.size !== initial.size ||
			final.mtimeMs !== initial.mtimeMs ||
			final.ctimeMs !== initial.ctimeMs ||
			current.dev !== initial.dev ||
			current.ino !== initial.ino
		)
			throw new Error("Checkpoint changed during inspection");
		const { entries: _entries, ...state } = value;
		return state;
	} finally {
		closeSync(fd);
	}
}

export function readSessionCheckpointState(path: string): SessionCheckpointState {
	return readCheckpointValues(path);
}

/** ponytail: explicit full-object API needs heap for all requested values, but never a whole artifact string. */
export function readSessionCheckpoint(path: string): SessionCheckpoint {
	const entries: SessionEntry[] = [];
	const state = readCheckpointValues(
		path,
		(entry) => entries.push(entry),
		() => {
			entries.length = 0;
		},
	);
	return { ...state, entries };
}

function openStagedCheckpoint(state: SessionCheckpointState, stage: string): SessionManager {
	const journal = state.selection.sessionFile;
	if (existsSync(journal)) {
		const select = (path: readonly (string | number)[]) =>
			path.length === 0 ? ("descend" as const) : ("skip" as const);
		const existing = scanJournal(journal, { policy: "strict", select });
		try {
			const archived = scanJournal(stage, { policy: "strict", select });
			try {
				if (
					existing.records.length !== archived.records.length ||
					existing.records.some(
						(record, index) =>
							JSON.stringify(readJournalRecord(existing.source, record)) !==
							JSON.stringify(readJournalRecord(archived.source, archived.records[index])),
					)
				)
					throw new Error("Checkpoint journal differs from saved state; restore its filesystem archive first");
				const current = statSync(journal);
				if (
					current.dev !== existing.source.dev ||
					current.ino !== existing.source.ino ||
					current.size !== existing.source.size ||
					current.mtimeMs !== existing.source.mtimeMs ||
					current.ctimeMs !== existing.source.ctimeMs
				)
					throw new Error("Checkpoint journal changed during comparison; restore its filesystem archive first");
			} finally {
				closeJournalSource(archived.source);
			}
		} finally {
			closeJournalSource(existing.source);
		}
	} else {
		mkdirSync(dirname(journal), { recursive: true });
		// Stage beside the journal for atomic exclusive publication on the same filesystem.
		const adjacent = `${journal}.${randomUUID()}.tmp`;
		try {
			copyFileSync(stage, adjacent, constants.COPYFILE_EXCL);
			const output = openSync(adjacent, "r+");
			try {
				fsyncSync(output);
			} finally {
				closeSync(output);
			}
			publishLocalFileExclusiveSync(adjacent, journal);
		} finally {
			rmSync(adjacent, { force: true });
		}
	}
	const manager = SessionManager.open(journal, undefined, state.selection.cwd);
	if (state.selection.leafId === null) manager.resetLeaf();
	else manager.branch(state.selection.leafId);
	return manager;
}

/** Complete validation and native JSONL staging precede any journal mutation. */
export function openSessionCheckpointFile(path: string): {
	checkpoint: SessionCheckpointState;
	sessionManager: SessionManager;
} {
	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
	const stage = join(directory, "entries.jsonl");
	let entries = openSync(stage, "wx", 0o600);
	let entriesClosed = false;
	try {
		const checkpoint = readCheckpointValues(
			path,
			(entry) => {
				writeFileSync(entries, `${JSON.stringify(entry)}\n`);
			},
			() => {
				closeSync(entries);
				entriesClosed = true;
				entries = openSync(stage, "w", 0o600);
				entriesClosed = false;
			},
		);
		closeSync(entries);
		entriesClosed = true;
		const journalStage = join(directory, "journal.jsonl");
		const fd = openSync(journalStage, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(checkpoint.header)}\n`);
			const input = openSync(stage, "r");
			try {
				const buffer = Buffer.allocUnsafe(64 * 1024);
				for (;;) {
					const count = readSync(input, buffer);
					if (!count) break;
					writeFileSync(fd, buffer.subarray(0, count));
				}
			} finally {
				closeSync(input);
			}
		} finally {
			closeSync(fd);
		}
		return { checkpoint, sessionManager: openStagedCheckpoint(checkpoint, journalStage) };
	} finally {
		if (!entriesClosed) closeSync(entries);
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Restore selection BEFORE context construction. Object callers explicitly retain the full-object ceiling. */
export function openSessionCheckpoint(checkpoint: SessionCheckpoint): SessionManager {
	validateState(checkpoint);
	if (!Array.isArray(checkpoint.entries)) throw new Error("Invalid session checkpoint entries");
	const ids = new Set<string>();
	for (const entry of checkpoint.entries) validateEntry(entry, ids);
	if (checkpoint.selection.leafId !== null && !ids.has(checkpoint.selection.leafId))
		throw new Error("Checkpoint leaf is missing");
	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
	const stage = join(directory, "journal.jsonl");
	const fd = openSync(stage, "wx", 0o600);
	let closed = false;
	try {
		writeFileSync(fd, `${JSON.stringify(checkpoint.header)}\n`);
		for (const entry of checkpoint.entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		closeSync(fd);
		closed = true;
		return openStagedCheckpoint(checkpoint, stage);
	} finally {
		if (!closed) closeSync(fd);
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Stream a marker update without materializing entries or altering unrelated files. */
function rewriteCheckpointMarker(path: string, completedExit?: { pid: number }, outputPath = path): void {
	const temporary = `${outputPath}.${randomUUID()}.tmp`;
	let fd = openSync(temporary, "wx", 0o600);
	let closed = false;
	try {
		writeFileSync(fd, '{"entries":[');
		let first = true;
		const write = (text: string) => writeFileSync(fd, text);
		const state = readCheckpointValues(
			path,
			(entry) => {
				if (!first) write(",");
				first = false;
				write(JSON.stringify(entry));
			},
			() => {
				closeSync(fd);
				closed = true;
				fd = openSync(temporary, "w", 0o600);
				closed = false;
				write('{"entries":[');
				first = true;
			},
		);
		if (completedExit && (!state.settled || state.boundary !== "settled"))
			throw new Error("Clean exit requires settled native state");
		assertCheckpointTarget(outputPath, state.selection.sessionFile);
		write("]");
		for (const [key, value] of Object.entries({ ...state, completedExit })) {
			if (value === undefined) continue;
			write(`,${JSON.stringify(key)}:`);
			writeJsonValue(value, write, checkpointLayout.fields[key as keyof typeof checkpointLayout.fields]);
		}
		write("}\n");
		closeSync(fd);
		closed = true;
		readSessionCheckpointState(temporary);
		assertCheckpointTarget(outputPath, state.selection.sessionFile);
		renameSync(temporary, outputPath);
	} finally {
		if (!closed) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

/** Opt in at CLI startup AFTER preflighting --checkpoint (possibly this same path). */
export function prepareCheckpointExit(path: string): CheckpointExitWriter {
	if (!isAbsolute(path)) throw new Error(`${CHECKPOINT_EXIT_PATH_ENV} must be absolute`);
	if (!statSync(dirname(path)).isDirectory()) throw new Error("Checkpoint exit parent must be a directory");
	if (existsSync(path)) {
		const state = readSessionCheckpointState(path);
		assertCheckpointTarget(path, state.selection.sessionFile);
		if (state.completedExit) rewriteCheckpointMarker(path);
	}
	const write = (checkpoint: SessionCheckpoint | CheckpointFile) => {
		if (!checkpoint.settled || checkpoint.boundary !== "settled")
			throw new Error("Clean exit requires settled native state");
		if ("path" in checkpoint) {
			rewriteCheckpointMarker(checkpoint.path, { pid: process.pid }, path);
		} else writeSessionCheckpoint(path, { ...checkpoint, completedExit: { pid: process.pid } });
	};
	return Object.assign(write, { path });
}

/** Apply non-journal working state once, before binding startup extensions or accepting input. */
export function restoreSessionCheckpoint(session: AgentSession, checkpoint: SessionCheckpointState): void {
	if (session.sessionId !== checkpoint.selection.sessionId) throw new Error("Checkpoint session identity mismatch");
	const model = checkpoint.selection.model;
	const resolved = model ? session.modelRuntime.getModel(model.provider, model.id) : undefined;
	if (model && !resolved) throw new Error(`Checkpoint model unavailable: ${model.provider}/${model.id}`);
	session.agent.selectedModel = resolved;
	if (checkpoint.scopedModels) {
		session.setScopedModels(
			checkpoint.scopedModels.map((scoped) => {
				const model = session.modelRuntime.getModel(scoped.provider, scoped.id);
				if (!model) throw new Error(`Checkpoint scoped model unavailable: ${scoped.provider}/${scoped.id}`);
				return { model, thinkingLevel: scoped.thinkingLevel };
			}),
		);
	}
	session.agent.state.thinkingLevel = checkpoint.selection.thinkingLevel;
	session.restoreCheckpointTools(checkpoint.selection.activeTools, checkpoint.toolConfiguration);
	session.restoreCheckpointQueues(checkpoint.queues);
}
