// A persisted run's record (slice 6b §4.1, D5): the document each unsettled run of a persisted job keeps in its
// object's store (namespace `chord.jobs`, kind the job name, key the run id), and the conversion of a run's phase and
// outcome to and from it. Errors are stored in the wire error format, so a `PluginError`'s code, message and details
// survive; a result names the job version whose code returned it when that is not the run's own.

import type { JsonObject } from "../documents/index.ts";
import type { JsonValue } from "../json.ts";
import { errorFromWire, wireError } from "../link/internal.ts";
import type { WireError } from "../link/message.ts";
import type { JobError, JobVersion } from "./definition.ts";
import type { AnyOutcome, BlockedReason, JobRun, Recorded, RunPhase } from "./run.ts";

/** How a run failed, as stored: a thrown error in the wire format, an abort, the restart limit. */
export type StoredJobError =
	| { readonly kind: "threw"; readonly error: WireError }
	| { readonly kind: "aborted"; readonly reason: "abort" | "reload" | "restart" }
	| { readonly kind: "restart_limit"; readonly restarts: number };

/**
 * A run's outcome as stored: its result, or how it failed. A result returned by the code of another job version than
 * the run's own (the run invoked on newer code after a reload, slice 7b §8) names that version and its fingerprint; a
 * result without them reads as the run's own version's. A version 1 record names none, so a result newer code returned
 * before record version 2 reads as the run's own version's, also once its record is written again at version 2:
 * nothing stored tells it apart.
 */
export type StoredOutcome =
	| { readonly kind: "done"; readonly result: JsonValue }
	| ({ readonly kind: "done"; readonly result: JsonValue } & JobVersion)
	| { readonly kind: "failed"; readonly error: StoredJobError };

/** The record document of one unsettled persisted run: its phase with what that holds (`StoredPhase`). */
export type StoredRun = {
	readonly version: number;
	readonly fingerprint: string;
	readonly args: JsonValue;
	readonly key?: string;
	readonly trace?: { readonly [key: string]: string };
	readonly restarts: number;
	readonly finishFailures: number;
	readonly abort?: true;
} & StoredPhase;

/** A record's phase and what it holds: a finishing run's outcome, a blocked run's reason and outcome if recorded. */
type StoredPhase =
	| { readonly phase: "pending" | "running" | "stopped" }
	| { readonly phase: "finishing"; readonly outcome: StoredOutcome }
	| { readonly phase: "blocked"; readonly blocked: BlockedReason; readonly outcome?: StoredOutcome };

/**
 * The record documents' version and fingerprint (Chord's own documents: no definition, no `migrate`; a new record
 * shape raises the version). Version 2 adds the job version of a result (`StoredOutcome`); a version 1 record reads
 * as one of version 2 whose results are all of the run's own version.
 */
export const RUN_RECORD = { version: 2, fingerprint: "chord.job-run.2" } as const;

/** What a change sets on a run's record (and on the run, as its commit adopts it); the rest is the run's own. */
export type StoredFields = {
	readonly phase?: RunPhase;
	readonly restarts?: number;
	readonly finishFailures?: number;
	readonly abortMarked?: true;
};

/** `run`'s record as stored with `fields` changed (its own version and fingerprint). */
export function storedRun(run: JobRun, fields: StoredFields = {}): StoredRun {
	const { version, fingerprint, args, key, trace } = run;
	const { phase = run.phase, restarts = run.restarts, finishFailures = run.finishFailures } = fields;
	const own = {
		version,
		fingerprint,
		args,
		...(key === undefined ? {} : { key }),
		...(trace === undefined ? {} : { trace }),
	};
	const counts = {
		restarts,
		finishFailures,
		...((fields.abortMarked ?? run.abortMarked) ? { abort: true as const } : {}),
	};
	// The stored key order: the run's own, its phase, its counts and abort mark, then what its phase holds.
	switch (phase.kind) {
		case "pending":
		case "running":
		case "stopped":
			return { ...own, phase: phase.kind, ...counts };
		case "finishing":
			return { ...own, phase: phase.kind, ...counts, outcome: storedOutcome(phase.recorded, run) };
		case "blocked": {
			const { reason, recorded } = phase;
			const stored = recorded === undefined ? {} : { outcome: storedOutcome(recorded, run) };
			return { ...own, phase: phase.kind, ...counts, blocked: reason, ...stored };
		}
	}
}

/**
 * `recorded` of `run` as stored: a result as it is (JSON: persisted jobs refuse `bytes()`), with the version that
 * returned it when that is not the run's own; an error in the wire format.
 */
function storedOutcome(recorded: Recorded, run: JobVersion): StoredOutcome {
	const { outcome } = recorded;
	if (outcome.kind === "failed") return { kind: "failed", error: storedError(outcome.error) };
	const result = outcome.result as JsonValue;
	if (sameVersion(recorded, run)) return { kind: "done", result };
	const { version, fingerprint } = recorded;
	return { kind: "done", result, version, fingerprint };
}

function storedError(error: JobError): StoredJobError {
	return error.kind === "threw" ? { kind: "threw", error: wireError(error.error) } : error;
}

/** Whether `a` and `b` are the same job version: its number and its fingerprint. */
function sameVersion(a: JobVersion, b: JobVersion): boolean {
	return a.version === b.version && a.fingerprint === b.fingerprint;
}

/** The phase `record` stands for (`atLoad` false), an outcome rebuilt with the run's `id` and its `state`. */
export function phaseOf(record: StoredRun, id: string, state: JsonValue | undefined): RunPhase {
	switch (record.phase) {
		case "pending":
		case "running":
		case "stopped":
			return { kind: record.phase };
		case "finishing":
			return { kind: "finishing", recorded: recordedOf(record, record.outcome, id, state) };
		case "blocked": {
			const { blocked: reason, outcome } = record;
			const recorded = outcome === undefined ? undefined : recordedOf(record, outcome, id, state);
			return { kind: "blocked", reason, recorded, atLoad: false };
		}
	}
}

/** The recorded outcome `stored` of `record` stands for: rebuilt with the run's `id` and its `state`, of its version. */
function recordedOf(record: StoredRun, stored: StoredOutcome, id: string, state: JsonValue | undefined): Recorded {
	const { version, fingerprint } = versionOf(stored, record);
	return { outcome: outcomeOf(stored, id, record.args, state), version, fingerprint };
}

/** The job version of `stored`, an outcome of `record`: the one its result names, otherwise the run's own. */
function versionOf(stored: StoredOutcome, record: StoredRun): JobVersion {
	return "version" in stored ? stored : record;
}

/** The outcome a stored one stands for, rebuilt as the in-memory one (`id`, `args` and `state` from the run). */
function outcomeOf(stored: StoredOutcome, id: string, args: JsonValue, state: JsonValue | undefined): AnyOutcome {
	if (stored.kind === "done") return { id, args, state, kind: "done", result: stored.result };
	const { error } = stored;
	const rebuilt: JobError = error.kind === "threw" ? { kind: "threw", error: errorFromWire(error.error) } : error;
	return { id, args, state, kind: "failed", error: rebuilt };
}

/**
 * Whether `record` is all of job version `version`: its run, and its result if one is recorded (a load blocks any
 * other, slice 6b §4.2).
 */
export function isOf(record: StoredRun, version: JobVersion): boolean {
	if (!sameVersion(record, version)) return false;
	const outcome = record.phase === "finishing" || record.phase === "blocked" ? record.outcome : undefined;
	return outcome === undefined || sameVersion(versionOf(outcome, record), version);
}

/** A stored record as Chord wrote it (the record definition's value, a JSON object). */
export function recordOf(value: JsonObject): StoredRun {
	// Chord's own document: `storedRun` wrote it.
	return value as unknown as StoredRun;
}
