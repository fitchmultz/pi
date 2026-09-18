import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RestartCheckpoint } from "../cli/restart-protocol.ts";
import type { AgentSession } from "./agent-session.ts";
import type { CustomMessage } from "./messages.ts";
import { type SessionEntry, type SessionHeader, SessionManager } from "./session-manager.ts";

export type CheckpointBoundary = "turn" | "settled";

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
	boundary: CheckpointBoundary;
	/** Native settlement only. The host must still coordinate UI and external writers. */
	settled: boolean;
}

export interface CheckpointHold {
	checkpoint: SessionCheckpoint;
	/** Aborted when released or invalidated by cancellation/reload/shutdown. */
	signal: AbortSignal;
	/** Idempotent; release on every failure path. No queue is consumed by capture. */
	release(): void;
}

export interface CheckpointOptions {
	boundary?: CheckpointBoundary;
	signal?: AbortSignal;
	/** Synchronously close host input; reject unsupported UI/callback state. */
	quiesce?: () => () => void;
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
	session.agent.state.thinkingLevel = checkpoint.selection.thinkingLevel;
	session.setActiveToolsByName(checkpoint.selection.activeTools);
	session.restoreCheckpointQueues(checkpoint.queues);
}
