import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RestartCheckpoint } from "../cli/restart-protocol.ts";
import type { AgentSession } from "./agent-session.ts";
import type { CustomMessage } from "./messages.ts";
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

export interface CheckpointOptions {
	boundary?: CheckpointBoundary;
	signal?: AbortSignal;
	/** Synchronously close host input; reject unsupported UI/callback state. */
	quiesce?: () => () => void;
	/** Defer until the native host can quiesce; notifyCheckpointStateChanged retries idle acquisition. */
	canQuiesce?: () => boolean;
}

/** Private, atomic replacement. The parent archive/upload supplies durable storage. */
export function writeSessionCheckpoint(path: string, checkpoint: SessionCheckpoint): void {
	if (!isAbsolute(path)) throw new Error("Checkpoint path must be absolute");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Opt in at CLI startup, AFTER loading any --checkpoint input (which may use this same path). */
export function prepareCheckpointExit(path: string): (checkpoint: SessionCheckpoint) => void {
	if (!isAbsolute(path)) throw new Error(`${CHECKPOINT_EXIT_PATH_ENV} must be absolute`);
	if (!statSync(dirname(path)).isDirectory()) throw new Error("Checkpoint exit parent must be a directory");
	// Never clear an unrelated file or native journal merely because an environment variable names it.
	if (existsSync(path)) readSessionCheckpoint(path);
	rmSync(path, { force: true });
	return (checkpoint) => {
		if (resolve(checkpoint.selection.sessionFile) === resolve(path))
			throw new Error("Exit checkpoint path must not replace the native journal");
		if (!checkpoint.settled || checkpoint.boundary !== "settled")
			throw new Error("Clean exit requires settled native state");
		writeSessionCheckpoint(path, { ...checkpoint, completedExit: { pid: process.pid } });
	};
}

/** Read trusted, owner-private native data; reject malformed selection before touching the journal. */
export function readSessionCheckpoint(path: string): SessionCheckpoint {
	const value = JSON.parse(readFileSync(path, "utf8")) as SessionCheckpoint;
	if (
		value.version !== 1 ||
		!value.selection ||
		!value.header ||
		!Array.isArray(value.entries) ||
		value.header.type !== "session" ||
		value.header.id !== value.selection.sessionId ||
		!isAbsolute(value.selection.sessionFile) ||
		!isAbsolute(value.selection.cwd) ||
		!value.queues ||
		!Array.isArray(value.queues.steering) ||
		!Array.isArray(value.queues.followUp) ||
		!Array.isArray(value.queues.nextTurn) ||
		!Array.isArray(value.queues.persistOnCancel)
	)
		throw new Error("Invalid session checkpoint");
	const ids = new Set<string>();
	for (const entry of value.entries) {
		if (!entry.id || ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) {
			throw new Error("Invalid checkpoint entry tree");
		}
		ids.add(entry.id);
	}
	if (value.selection.leafId !== null && !ids.has(value.selection.leafId)) {
		throw new Error("Checkpoint leaf is missing");
	}
	return value;
}

/** Restore selection BEFORE constructing AgentSession. Never overwrite a newer/different journal. */
export function openSessionCheckpoint(checkpoint: SessionCheckpoint): SessionManager {
	const { selection, header, entries } = checkpoint;
	if (existsSync(selection.sessionFile)) {
		// SessionManager.open initializes empty files and migrates old journals. Validate bytes
		// first, so a rejected restore cannot modify an unrelated or damaged journal.
		const text = readFileSync(selection.sessionFile, "utf8").trim();
		const existing: unknown[] = text ? text.split("\n").map((line) => JSON.parse(line)) : [];
		if (JSON.stringify(existing) !== JSON.stringify([header, ...entries])) {
			throw new Error("Checkpoint journal differs from saved state; restore its filesystem archive first");
		}
	} else {
		mkdirSync(dirname(selection.sessionFile), { recursive: true });
		writeFileSync(
			selection.sessionFile,
			`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			{ mode: 0o600, flag: "wx" },
		);
	}
	const manager = SessionManager.open(selection.sessionFile, undefined, selection.cwd);
	if (selection.leafId === null) manager.resetLeaf();
	else manager.branch(selection.leafId);
	return manager;
}

/** Apply non-journal working state once, before binding startup extensions or accepting input. */
export function restoreSessionCheckpoint(session: AgentSession, checkpoint: SessionCheckpoint): void {
	if (session.sessionId !== checkpoint.selection.sessionId) throw new Error("Checkpoint session identity mismatch");
	const model = checkpoint.selection.model;
	if (model) {
		const resolved = session.modelRuntime.getModel(model.provider, model.id);
		if (!resolved) throw new Error(`Checkpoint model unavailable: ${model.provider}/${model.id}`);
		session.agent.state.model = resolved;
	}
	const available = new Set(session.getAllTools().map((tool) => tool.name));
	if (checkpoint.selection.activeTools.some((name) => !available.has(name)))
		throw new Error("Checkpoint tools unavailable");
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
	session.setActiveToolsByName(checkpoint.selection.activeTools);
	session.restoreCheckpointQueues(checkpoint.queues);
}
