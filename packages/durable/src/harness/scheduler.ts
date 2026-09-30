import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "../env/index.ts";
import type { SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	CommitPublication,
	ConversationId,
	ConversationRecord,
	DocumentWatch,
	EntryId,
	EntryRecord,
	HookRunner,
	JsonObject,
	RunningTask,
	Storage,
	TaskDefinition,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskRuntime,
	TaskState,
} from "../types.ts";
import { readContext } from "./context.ts";
import type {
	AnyTask,
	ConversationHandle,
	HarnessInspection,
	HookScope,
	RegistryReader,
	RegistrySnapshot,
	SettledTask,
	TaskInspection,
} from "./types.ts";
import { closedError, scanAll, Waiters } from "./util.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
type LiveTaskRecord = Extract<AnyTaskRecord, { readonly state: { readonly status: "pending" | "running" } }>;
type Checkpoint = { readonly phase: string };
type ErasedDefinition = TaskDefinition<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRuntime = TaskRuntime<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRunningTask = RunningTask<JsonValue, Checkpoint, JsonValue>;

const SCAN_PAGE_SIZE = 256;
/** Longest delay `setTimeout` supports; longer sleeps wait in several steps. */
const MAX_TIMER_DELAY = 2_147_483_647;

/** Why a pending task cannot be reserved under a registry snapshot. Derived, never persisted. */
type BlockedReason = "missing_task" | "task_too_old" | "migration_failed";

type Resolution =
	| { readonly kind: "ready"; readonly task: AnyTask; readonly record: LiveTaskRecord }
	| { readonly kind: "blocked"; readonly reason: BlockedReason };

/** A definition that can take a record, or why none can; deciding it runs no task code. */
type Fit =
	| { readonly task: AnyTask; readonly migrates: boolean }
	| { readonly reason: BlockedReason; readonly error?: unknown };

/** One in-memory execution of a task in run or abort mode. */
type Invocation = {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly mode: "run" | "abort";
	readonly controller: AbortController;
	/** Context passed to handlers; cancelled by `controller`. */
	readonly context: Context;
	/** Watches acquired through the runtime; stopped at invocation end. */
	readonly watches: Set<DocumentWatch<JsonObject>>;
	ended: boolean;
	readonly done: Promise<void>;
	readonly finish: () => void;
};

type Reservation = {
	readonly invocation: Invocation;
	readonly task: AnyTask;
	readonly snapshot: RegistrySnapshot;
};

/** Replacement definition already reported as unable to take over, per invocation. */
type ReportedTask = { readonly task: AnyTask | undefined } | undefined;

/** Outcome of the phase that just returned, judged by the next step. */
type PhaseResult = { readonly checkpoint: Checkpoint; readonly failure?: { readonly error: unknown } };

/** Step decision: continue with the next phase, end the invocation, or end it by writing terminal `faulted`. */
type Decision = boolean | { readonly fault: unknown };

/** Terminal outcomes the scheduler writes without running task code. */
export type SchedulerOutcome = Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" | "orphaned" }>;

/** An invocation a conversation handle is bound to: its signal, and a check that throws once it ended. */
export type InvocationBinding = { readonly signal: AbortSignal; check(): void };

/** A conversation's owner edge; the owner's `background` flag is loaded with it. Both never change. */
type OwnerEdge = { readonly conversationId: ConversationId; readonly taskId: TaskId; background: boolean | undefined };

/** Where ordinary ownership traversal starts: one conversation, or every ownerless conversation. */
type Scope = { readonly conversation: ConversationId } | { readonly roots: true };

export type TaskSchedulerOptions = {
	readonly session: SessionImpl;
	readonly storage: Storage;
	readonly registry: RegistryReader;
	readonly models: Models;
	readonly env: ExecutionEnv | undefined;
	readonly now: () => number;
	readonly report: (error: unknown) => void;
	/** Harness cleanup staged in the same commit as every terminal outcome the scheduler writes itself. */
	readonly settleOutcome: (tx: Transaction, record: AnyTaskRecord, outcome: SchedulerOutcome) => Promise<void>;
	/** Withdraw a conversation's queued inputs, for conversation abort and abort cascades. */
	readonly withdrawInputs: (tx: Transaction, conversationId: ConversationId) => Promise<void>;
	/** Invocation-bound handle of an existing conversation, for task runtimes and tools. */
	readonly conversation: (
		id: ConversationId,
		binding: InvocationBinding,
		context: Context,
	) => Promise<ConversationHandle | undefined>;
	/** Context for scheduler commits and invocations; carries no caller cancellation. */
	readonly context: Context;
};

/**
 * Durable task scheduler of one Harness.
 *
 * `#live` mirrors every committed pending/running task record. The synchronous commit listener updates it on the
 * Session line, so code running on the line reads exactly the committed state from it.
 *
 * Invariant: every task transition is decided and written by one callback serialized on the Session line. That covers
 * reservation, marks, runtime commits, and the synchronous step before each phase, which applies the precedence rules
 * and writes a fault or handover. Handlers and joins run off the line. An invocation ends inside the step that decides its end,
 * so a runtime commit it queued either lands before that decision or is rejected.
 */
export class TaskScheduler {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #registry: RegistryReader;
	readonly #models: Models;
	readonly #env: ExecutionEnv | undefined;
	readonly #now: () => number;
	readonly #report: (error: unknown) => void;
	readonly #settleOutcome: TaskSchedulerOptions["settleOutcome"];
	readonly #withdrawInputs: TaskSchedulerOptions["withdrawInputs"];
	readonly #conversation: TaskSchedulerOptions["conversation"];
	readonly #context: Context;
	readonly #live = new Map<TaskId, LiveTaskRecord>();
	readonly #invocations = new Map<TaskId, Invocation>();
	readonly #taskWaiters = new Waiters<TaskId, SettledTask<JsonValue>>();
	/** Idle waiters by conversation; `undefined` waits for the whole Harness. */
	readonly #idleWaiters = new Waiters<ConversationId | undefined, void>();
	/** Definition whose migration failed per task; retried only once the registry resolves another definition. */
	readonly #failedMigrations = new Map<TaskId, { readonly task: AnyTask; readonly error: unknown }>();
	/** Owner edge of each loaded conversation, `null` when ownerless. */
	readonly #edges = new Map<ConversationId, OwnerEdge | null>();
	/** Tasks that own a loaded conversation. */
	readonly #owners = new Set<TaskId>();
	/** Whether each terminal owner recorded cancellation intent (see `cancellationIntent()`). */
	readonly #cancelledTerminal = new Map<TaskId, boolean>();
	#reconcileScheduled = false;
	#cascadePending = false;
	#unsubscribeRegistry: () => void = () => {};
	#enabled = false;
	#closing = false;
	#dirty = false;
	#draining = false;

	constructor(options: TaskSchedulerOptions) {
		this.#session = options.session;
		this.#storage = options.storage;
		this.#registry = options.registry;
		this.#models = options.models;
		this.#env = options.env;
		this.#now = options.now;
		this.#report = options.report;
		this.#settleOutcome = options.settleOutcome;
		this.#withdrawInputs = options.withdrawInputs;
		this.#conversation = options.conversation;
		this.#context = options.context;
	}

	/** Load live tasks and change surviving `running` tasks back to `pending`. Dispatches nothing. */
	async open(context: Context): Promise<void> {
		this.#session.subscribeCommits((publication) => this.#observe(publication));
		this.#session.subscribeClose(() => this.#seal());
		this.#unsubscribeRegistry = this.#registry.subscribe(() => this.#kick());
		await this.#session.commitWith(async (tx) => {
			const scan = (status: "pending" | "running") =>
				scanAll((cursor) => tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)) as Promise<LiveTaskRecord[]>;
			const pending = await scan("pending");
			const running = await scan("running");
			for (const record of [...pending, ...running]) this.#live.set(record.id, record);
			for (const record of running) {
				tx.setTask(withState(record, { status: "pending", checkpoint: record.state.checkpoint }));
			}
		}, context);
		// Derive abort marks a crash left unapplied below cancelled owners.
		this.#cascadePending = true;
		this.#scheduleReconcile();
	}

	/** Enable scheduling. Idempotent; the kick does nothing once closing. */
	resume(): void {
		this.#enabled = true;
		this.#kick();
	}

	/** Wait for every invocation signalled by `#seal()`. Writes nothing. */
	async join(): Promise<void> {
		await Promise.allSettled([...this.#invocations.values()].map((invocation) => invocation.done));
	}

	/**
	 * Commit the abort mark, or settle a task that no registered definition can take as `orphaned`, then join the run
	 * invocation seen on the line; the commit listener signalled it. The next drain starts the abort invocation.
	 */
	async abort(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		const marked = await this.#session.commitWith(async (tx) => {
			const current = await tx.task(id);
			if (current === undefined) throw new Error(`Task ${id} does not exist`);
			if (current.state.status === "terminal") return { result: "terminal" as const };
			const live = current as LiveTaskRecord;
			const invocation = this.#invocations.get(id);
			if (invocation === undefined) {
				const resolution = this.#resolve(live, this.#registry.snapshot());
				if (resolution.kind === "blocked") {
					await this.#terminate(tx, live, { status: "orphaned", reason: resolution.reason });
					return { result: "marked" as const };
				}
			}
			if (!live.abortRequested) tx.setTask({ ...live, abortRequested: true });
			return { result: "marked" as const, run: invocation?.mode === "run" ? invocation : undefined };
		}, context);
		// The commit listener signalled the run; join it.
		if (marked.run !== undefined) await awaitWithContext(marked.run.done, context);
		return marked.result;
	}

	async waitForTask(id: TaskId, context: Context): Promise<SettledTask<JsonValue>> {
		// Check and register on the line so no terminal publication falls between them.
		const found = await this.#session.readOnLine(async () => {
			if (this.#closing) throw closedError();
			if (this.#live.has(id)) return { promise: this.#taskWaiters.add(id, context) };
			const record = await this.#storage.task(id, context);
			if (record === undefined) throw new Error(`Task ${id} does not exist`);
			return { promise: Promise.resolve(record as SettledTask<JsonValue>) };
		});
		return found.promise;
	}

	/**
	 * Resolve when ordinary traversal from the conversation, or from every ownerless conversation, reaches no live
	 * non-background task.
	 */
	waitForIdle(conversationId: ConversationId | undefined, context: Context): Promise<void> {
		if (this.#closing) return Promise.reject(closedError());
		if (this.#idle(conversationId)) return Promise.resolve();
		this.#scheduleReconcile();
		return this.#idleWaiters.add(conversationId, context);
	}

	/**
	 * `Conversation.abort()`: in one commit, withdraw the queued inputs and mark every live non-background task that
	 * ordinary traversal from the conversation reaches. The commit listener signals their run invocations; resolves once
	 * the scope is idle.
	 */
	async abortConversation(conversationId: ConversationId, context: Context): Promise<void> {
		await this.#session.commitWith(async (tx) => {
			const queued = await this.#loadScopes(true);
			const scope = { conversation: conversationId };
			for (const record of this.#live.values()) {
				if (record.background || record.abortRequested || this.#inScope(record.conversationId, scope) !== true) {
					continue;
				}
				tx.setTask({ ...record, abortRequested: true });
			}
			for (const id of queued) if (this.#inScope(id, scope) === true) await this.#withdrawInputs(tx, id);
		}, context);
		await this.waitForIdle(conversationId, context);
	}

	// ─── Scheduling ────────────────────────────────────────────────────────

	#observe(publication: CommitPublication): void {
		const updated: LiveTaskRecord[] = [];
		let changed = false;
		for (const change of publication.changes) {
			if (change.type !== "task") continue;
			changed = true;
			const record = change.value;
			if (record.state.status !== "terminal") {
				const live = record as LiveTaskRecord;
				if (live.abortRequested && this.#live.get(record.id)?.abortRequested !== true) {
					this.#cascadePending = true;
					// Signal a run invocation of the newly marked task; its next step ends it.
					const invocation = this.#invocations.get(record.id);
					if (invocation?.mode === "run") invocation.controller.abort();
				}
				this.#live.set(record.id, live);
				updated.push(live);
				continue;
			}
			// Only owners' outcomes matter to traversal; `#loadChain` fills in owners loaded later.
			if (this.#owners.has(record.id)) {
				const cancelled = cancellationIntent(record);
				this.#cancelledTerminal.set(record.id, cancelled);
				if (cancelled) this.#cascadePending = true;
			}
			this.#live.delete(record.id);
			this.#failedMigrations.delete(record.id);
			this.#taskWaiters.resolve(record.id, record as SettledTask<JsonValue>);
		}
		// Edges after the tasks, so an owner created in the same commit is live.
		for (const change of publication.changes) {
			if (change.type !== "conversation" || this.#edges.has(change.value.id)) continue;
			const owner = change.value.owner;
			this.#setEdge(
				change.value.id,
				owner === undefined ? null : { ...owner, background: this.#live.get(owner.taskId)?.background },
			);
		}
		for (const change of publication.changes) {
			// A queued input below a cancelled owner is withdrawn, even after its cascade.
			if (change.type !== "submission" || change.value.status !== "queued" || change.value.type !== "input")
				continue;
			const id = change.value.conversationId;
			if (!this.#chainKnown(id) || this.#belowCancelled(id)) this.#cascadePending = true;
		}
		for (const record of updated) {
			// Work created below a cancelled owner, even after its cascade, is aborted too.
			if (!this.#chainKnown(record.conversationId)) this.#scheduleReconcile();
			else if (!record.background && !record.abortRequested && this.#belowCancelled(record.conversationId)) {
				this.#cascadePending = true;
			}
		}
		// Also retries, with the next commit of any kind, a cascade whose commit failed.
		if (this.#cascadePending) this.#scheduleReconcile();
		if (!changed) return;
		this.#resolveIdleWaiters();
		this.#kick();
	}

	#resolveIdleWaiters(): void {
		for (const conversationId of this.#idleWaiters.keys()) {
			if (this.#idle(conversationId)) this.#idleWaiters.resolve(conversationId);
		}
	}

	// ─── Ownership ───────────────────────────────────────────────────────────

	#scheduleReconcile(): void {
		if (this.#reconcileScheduled || this.#closing) return;
		this.#reconcileScheduled = true;
		queueMicrotask(() => void this.#reconcile());
	}

	/**
	 * Load missing owner edges, then, when cancellation intent is pending, derive abort marks in one commit: every live
	 * non-background task below a cancelled owner, found by walking up without crossing a background owner that is not
	 * itself cancelled, is marked, and the queued inputs of such conversations are withdrawn. The cancelled owner's own
	 * record is the durable intent, so this also repairs marks a crash left unapplied. Resolves idle waiters that the
	 * loaded edges decide.
	 */
	async #reconcile(): Promise<void> {
		this.#reconcileScheduled = false;
		const cascade = this.#cascadePending;
		this.#cascadePending = false;
		try {
			await this.#session.commitWith(async (tx) => {
				if (this.#closing) return;
				const queued = await this.#loadScopes(cascade);
				// Loading edges can reveal a cancelled owner, so marks are derived on every pass.
				for (const record of this.#live.values()) {
					if (record.background || record.abortRequested || !this.#belowCancelled(record.conversationId)) continue;
					tx.setTask({ ...record, abortRequested: true });
				}
				for (const id of queued) if (this.#belowCancelled(id)) await this.#withdrawInputs(tx, id);
			}, this.#context);
		} catch (error) {
			// Any pass may have staged marks, so a failed one is retried with the next commit.
			this.#cascadePending = true;
			if (!this.#closing) this.#report(error);
		}
		this.#resolveIdleWaiters();
	}

	/**
	 * Load the owner chains of every live task's conversation and, with `queued`, of every conversation with queued
	 * submissions, on the Session line; returns the latter. Reads committed Storage directly, so it may run inside a
	 * commit callback.
	 */
	async #loadScopes(queued: boolean): Promise<ConversationId[]> {
		for (const record of [...this.#live.values()]) await this.#loadChain(record.conversationId);
		if (!queued) return [];
		const submissions = await scanAll((cursor) =>
			this.#storage.scanSubmissions({ status: "queued" }, SCAN_PAGE_SIZE, cursor, this.#context),
		);
		const conversations = [...new Set(submissions.map((submission) => submission.conversationId))];
		for (const id of conversations) await this.#loadChain(id);
		return conversations;
	}

	/** Load the owner edges from `conversationId` up to its ownerless root. */
	async #loadChain(conversationId: ConversationId): Promise<void> {
		let id: ConversationId | undefined = conversationId;
		while (id !== undefined) {
			let edge: OwnerEdge | null | undefined = this.#edges.get(id);
			if (edge === undefined) {
				const record: ConversationRecord | undefined = await this.#storage.conversation(id, this.#context);
				edge = record?.owner === undefined ? null : { ...record.owner, background: undefined };
				this.#setEdge(id, edge);
			}
			if (edge === null) return;
			if (edge.background === undefined || this.#ownerCancelled(edge.taskId) === undefined) {
				const owner: AnyTaskRecord | undefined =
					this.#live.get(edge.taskId) ?? (await this.#storage.task(edge.taskId, this.#context));
				edge.background = owner?.background ?? false;
				if (owner?.state.status === "terminal") this.#cancelledTerminal.set(owner.id, cancellationIntent(owner));
			}
			id = edge.conversationId;
		}
	}

	#setEdge(conversationId: ConversationId, edge: OwnerEdge | null): void {
		this.#edges.set(conversationId, edge);
		if (edge !== null) this.#owners.add(edge.taskId);
	}

	/** Whether every owner edge above `conversationId` is loaded. */
	#chainKnown(conversationId: ConversationId): boolean {
		let id: ConversationId | undefined = conversationId;
		while (id !== undefined) {
			const edge = this.#edges.get(id);
			if (edge === undefined || (edge !== null && edge.background === undefined)) return false;
			id = edge?.conversationId;
		}
		return true;
	}

	/** Cancellation intent of an owner task: its abort mark while live, or a terminal outcome other than `completed`. */
	#ownerCancelled(taskId: TaskId): boolean | undefined {
		const live = this.#live.get(taskId);
		return live !== undefined ? live.abortRequested : this.#cancelledTerminal.get(taskId);
	}

	/**
	 * Whether ordinary traversal from `scope` reaches `conversationId`: walking up its owner edges reaches the scope's
	 * conversation, or an ownerless one for `roots`, without crossing a background owner. `undefined` while an edge is
	 * not loaded.
	 */
	#inScope(conversationId: ConversationId, scope: Scope): boolean | undefined {
		let id = conversationId;
		for (;;) {
			if ("conversation" in scope && id === scope.conversation) return true;
			const edge = this.#edges.get(id);
			if (edge === undefined || (edge !== null && edge.background === undefined)) return undefined;
			if (edge === null) return "roots" in scope;
			if (edge.background) return false;
			id = edge.conversationId;
		}
	}

	/**
	 * Whether a cancelled owner's abort reaches `conversationId`: walking up finds a cancelled owner before a background
	 * owner that is not cancelled. A cancelled background owner includes its ordinary subtree; nested background owners
	 * stay boundaries.
	 */
	#belowCancelled(conversationId: ConversationId): boolean {
		let id = conversationId;
		for (;;) {
			const edge = this.#edges.get(id);
			if (edge === undefined || edge === null) return false;
			if (this.#ownerCancelled(edge.taskId) === true) return true;
			if (edge.background !== false) return false;
			id = edge.conversationId;
		}
	}

	/** Close listener: runs synchronously once admission is sealed, before `join()`. */
	#seal(): void {
		this.#closing = true;
		this.#unsubscribeRegistry();
		const error = closedError();
		this.#taskWaiters.rejectAll(error);
		this.#idleWaiters.rejectAll(error);
		for (const invocation of this.#invocations.values()) invocation.controller.abort();
	}

	#kick(): void {
		this.#dirty = true;
		if (this.#draining || !this.#enabled || this.#closing) return;
		this.#draining = true;
		// Never commit synchronously from a commit or registry listener.
		queueMicrotask(() => void this.#drain());
	}

	async #drain(): Promise<void> {
		try {
			while (this.#dirty && this.#enabled && !this.#closing) {
				this.#dirty = false;
				for (const reservation of await this.#reserve()) this.#start(reservation);
			}
		} catch (error) {
			if (!this.#closing) this.#report(error);
		} finally {
			this.#draining = false;
			// A wakeup that arrived during a failed pass still needs its pass.
			if (this.#dirty) this.#kick();
		}
	}

	/** Reserve every eligible task in one commit; orphan abort-marked tasks no definition can take. */
	async #reserve(): Promise<Reservation[]> {
		const reservations: Reservation[] = [];
		try {
			await this.#session.commitWith(async (tx) => {
				if (!this.#enabled || this.#closing) return;
				// Taken once per pass, and only when some task is a candidate.
				let snapshot: RegistrySnapshot | undefined;
				for (const record of [...this.#live.values()]) {
					if (this.#invocations.has(record.id) || this.#waitingOn(record).length > 0) continue;
					const mode = record.abortRequested ? "abort" : "run";
					snapshot ??= this.#registry.snapshot();
					const resolution = this.#resolve(record, snapshot);
					if (resolution.kind === "blocked") {
						if (mode === "abort")
							await this.#terminate(tx, record, { status: "orphaned", reason: resolution.reason });
						continue;
					}
					if (resolution.record !== record || record.state.status !== "running") {
						tx.setTask(
							withState(resolution.record, {
								status: "running",
								checkpoint: resolution.record.state.checkpoint,
							}),
						);
					}
					// Registered on the line, so marks and later reservations see it and close joins it.
					const invocation = this.#createInvocation(record, mode);
					reservations.push({ invocation, task: resolution.task, snapshot });
				}
			}, this.#context);
		} catch (error) {
			for (const { invocation } of reservations) {
				this.#invocations.delete(invocation.taskId);
				invocation.finish();
			}
			throw error;
		}
		return reservations;
	}

	/** Resolve the record's definition by kind, migrating an older stored version. */
	#resolve(record: LiveTaskRecord, snapshot: RegistrySnapshot): Resolution {
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", reason: fit.reason };
		if (!fit.migrates) return { kind: "ready", task: fit.task, record };
		const definition = erased(fit.task);
		try {
			if (definition.migrate === undefined) throw missingMigration(record, definition);
			const migrated = definition.migrate(record.input, record.state.checkpoint, record.version);
			const state = { status: record.state.status, checkpoint: copyJson(migrated.checkpoint) };
			const migratedRecord = { ...record, version: definition.version, input: copyJson(migrated.input), state };
			return { kind: "ready", task: fit.task, record: migratedRecord as LiveTaskRecord };
		} catch (error) {
			this.#failedMigrations.set(record.id, { task: fit.task, error });
			this.#report(error);
			return { kind: "blocked", reason: "migration_failed" };
		}
	}

	#fit(record: LiveTaskRecord, task: AnyTask | undefined): Fit {
		if (task === undefined) return { reason: "missing_task" };
		const version = task.definition.version;
		if (version === record.version) return { task, migrates: false };
		if (version < record.version) return { reason: "task_too_old" };
		const failed = this.#failedMigrations.get(record.id);
		if (failed?.task === task) return { reason: "migration_failed", error: failed.error };
		return { task, migrates: true };
	}

	/** Live dependencies a run waits for; an abort mark bypasses them and a running task has passed them. */
	#waitingOn(record: LiveTaskRecord): TaskId[] {
		if (record.abortRequested || record.state.status !== "pending") return [];
		return record.after.filter((id) => this.#live.has(id));
	}

	/**
	 * Scheduling state and every live task with its derived state, read on the Session line. Runs no task code: a
	 * pending migration shows as `ready` with `migrates`, and only a migration the scheduler already tried, or one that
	 * cannot exist, shows as failed.
	 */
	inspect(snapshot: RegistrySnapshot): { scheduling: HarnessInspection["scheduling"]; tasks: TaskInspection[] } {
		const tasks: TaskInspection[] = [];
		for (const record of this.#live.values()) tasks.push({ record, state: this.#inspectTask(record, snapshot) });
		const scheduling = this.#closing ? "closing" : this.#enabled ? "running" : "paused";
		return { scheduling, tasks };
	}

	#inspectTask(record: LiveTaskRecord, snapshot: RegistrySnapshot): TaskInspection["state"] {
		if (this.#invocations.has(record.id)) return { kind: "running" };
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", ...fit };
		if (fit.migrates && fit.task.definition.migrate === undefined) {
			return { kind: "blocked", reason: "migration_failed", error: missingMigration(record, erased(fit.task)) };
		}
		const on = this.#waitingOn(record);
		return on.length > 0 ? { kind: "waiting", on } : { kind: "ready", migrates: fit.migrates };
	}

	#createInvocation(record: LiveTaskRecord, mode: "run" | "abort"): Invocation {
		const controller = new AbortController();
		const { promise: done, resolve: finish } = Promise.withResolvers<void>();
		const invocation: Invocation = {
			taskId: record.id,
			conversationId: record.conversationId,
			mode,
			controller,
			context: withAbortSignal(controller.signal, this.#context),
			watches: new Set(),
			ended: false,
			done,
			finish: () => finish(),
		};
		this.#invocations.set(record.id, invocation);
		return invocation;
	}

	#start(reservation: Reservation): void {
		const invocation = reservation.invocation;
		void (async () => {
			try {
				if (invocation.mode === "run") await this.#run(reservation);
				else await this.#runAbort(reservation);
			} catch (error) {
				this.#report(error);
			} finally {
				this.#end(invocation);
				invocation.finish();
				this.#kick();
			}
		})();
	}

	/** Run phase handlers, each preceded by a step that decides on the line whether the invocation continues. */
	async #run(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const state = { task: reservation.task, snapshot: reservation.snapshot, reported: undefined as ReportedTask };
		const runtime = this.#runtime(
			invocation,
			() => state.snapshot,
			() => state.task,
		);
		let previous: PhaseResult | undefined;
		for (;;) {
			const current = await this.#step(invocation, (tx, current) => this.#decide(tx, current, previous, state));
			// Close may seal between the decision and dispatch.
			if (current === undefined || this.#closing) return;
			const checkpoint = current.state.checkpoint;
			try {
				await erased(state.task).phases[checkpoint.phase]!(current, runtime, invocation.context);
				previous = { checkpoint };
			} catch (error) {
				previous = { checkpoint, failure: { error } };
			}
		}
	}

	/**
	 * Precedence rules for a run invocation, on the line. Rules 1 (terminal) and 2 (closing) are applied by `#step`.
	 * Returns whether the invocation continues with the next phase.
	 */
	#decide(
		tx: Transaction,
		current: ErasedRunningTask,
		previous: PhaseResult | undefined,
		state: { task: AnyTask; snapshot: RegistrySnapshot; reported: ReportedTask },
	): Decision {
		// 3. abort mark: end; the next drain starts a fresh abort invocation.
		if (current.abortRequested) return false;
		if (previous === undefined) return true;
		// 4. uncaught error.
		if (previous.failure !== undefined) return { fault: previous.failure.error };
		// 6. no durable progress.
		if (jsonEqual(current.state.checkpoint, previous.checkpoint)) {
			const message = `Task ${current.kind} phase ${previous.checkpoint.phase} returned without durable progress`;
			return { fault: new Error(message) };
		}
		// 5. progress: refresh the snapshot; hand over to a replacement definition that can take the task.
		state.snapshot = this.#registry.snapshot();
		const next = state.snapshot.task(current.kind);
		if (next !== state.task) {
			if (next !== undefined && canReserve(next, current)) {
				tx.setTask(withState(current, { status: "pending", checkpoint: current.state.checkpoint }));
				return false;
			}
			if (state.reported === undefined || state.reported.task !== next) {
				state.reported = { task: next };
				const cause = next === undefined ? "missing_task" : "incompatible_task";
				this.#report(
					new Error(`Task ${current.id} keeps running under its old ${current.kind} definition`, { cause }),
				);
			}
		}
		return true;
	}

	/** Run the abort handler once; rules 1, 2, and 4 apply, and returning without an outcome faults. */
	async #runAbort(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const current = this.#live.get(invocation.taskId) as ErasedRunningTask | undefined;
		if (current === undefined || this.#closing) return;
		let failure: { readonly error: unknown } | undefined;
		try {
			const runtime = this.#runtime(
				invocation,
				() => reservation.snapshot,
				() => reservation.task,
			);
			await erased(reservation.task).abort(current, runtime, invocation.context);
		} catch (error) {
			failure = { error };
		}
		const message = `Abort handler of task ${invocation.taskId} returned without a terminal outcome`;
		await this.#step(invocation, () => ({ fault: failure?.error ?? new Error(message) }));
	}

	/**
	 * One synchronous decision on the Session line. A terminal task (rule 1) or a closing Harness (rule 2) ends the
	 * invocation without a write; otherwise `decide` may stage a write and returns whether the invocation continues.
	 * Ending happens inside the callback, before a fault's Harness cleanup. A rejected step, such as admission after
	 * close, also ends the invocation.
	 */
	async #step(
		invocation: Invocation,
		decide: (tx: Transaction, current: ErasedRunningTask) => Decision,
	): Promise<ErasedRunningTask | undefined> {
		try {
			return await this.#session.commitWith(async (tx) => {
				const current = this.#live.get(invocation.taskId) as ErasedRunningTask | undefined;
				const decision = current !== undefined && !this.#closing ? decide(tx, current) : false;
				if (decision === true) return current;
				this.#end(invocation);
				if (decision !== false) {
					const message = decision.fault instanceof Error ? decision.fault.message : String(decision.fault);
					await this.#terminate(tx, current!, { status: "faulted", error: { message } });
				}
				return undefined;
			}, this.#context);
		} catch (error) {
			this.#end(invocation);
			if (!this.#closing) this.#report(error);
			return undefined;
		}
	}

	/** Write a scheduler-decided terminal outcome together with its Harness cleanup. */
	#terminate(tx: Transaction, record: LiveTaskRecord, outcome: SchedulerOutcome): Promise<void> {
		tx.setTask(withState(record, { status: "terminal", outcome }));
		return this.#settleOutcome(tx, record, outcome);
	}

	/** End an invocation: its runtime operations reject from now on, its signal aborts, its watches stop, and its task is free. */
	#end(invocation: Invocation): void {
		if (invocation.ended) return;
		invocation.ended = true;
		if (this.#invocations.get(invocation.taskId) === invocation) this.#invocations.delete(invocation.taskId);
		for (const watch of invocation.watches) void watch.stop();
		// Pending waits bound to the invocation, such as a tool's waitForTask(), reject with it.
		invocation.controller.abort(endedError(invocation));
	}

	/** No live non-background task in the scope; a task whose owner edges are not loaded yet counts as inside. */
	#idle(conversationId: ConversationId | undefined): boolean {
		const scope: Scope = conversationId === undefined ? { roots: true } : { conversation: conversationId };
		for (const record of this.#live.values()) {
			if (!record.background && this.#inScope(record.conversationId, scope) !== false) return false;
		}
		return true;
	}

	// ─── Invocation runtime ──────────────────────────────────────────────────

	#runtime(invocation: Invocation, snapshot: () => RegistrySnapshot, task: () => AnyTask): ErasedRuntime {
		const hooks: HookRunner<Record<string, unknown>> = {
			each: async (name, invoke) => {
				if (invocation.ended) throw endedError(invocation);
				for (const { handlers, scope } of snapshot().hooks(task())) {
					const handler = (handlers as Record<string, unknown>)[name];
					if (typeof handler !== "function") continue;
					if (scope !== undefined && !(await this.#hookMatches(invocation, scope))) continue;
					try {
						await invoke(handler.bind(handlers));
					} catch (error) {
						if (invocation.controller.signal.aborted) throw error;
						this.#report(error);
					}
				}
			},
		};
		return {
			taskId: invocation.taskId as TaskId<JsonValue>,
			conversationId: invocation.conversationId,
			signal: invocation.controller.signal,
			models: this.#models,
			env: this.#env,
			hooks: hooks as ErasedRuntime["hooks"],
			get registry() {
				return snapshot();
			},
			commit: (change, context) =>
				this.#gated(
					invocation,
					async (tx, current) => {
						const next = await change(tx, current);
						if (next !== undefined) tx.setTask(withState(current, next));
					},
					context,
				),
			memo: ((name: string, ...rest: readonly unknown[]) => {
				if (rest.length === 1) {
					return this.#read(invocation, async () => memoOf(this.#live.get(invocation.taskId), name));
				}
				const candidate = rest[0] as JsonValue;
				return this.#gated(
					invocation,
					(tx, current) => {
						const winner = memoOf(current, name);
						if (winner !== undefined) return winner;
						tx.setTask({ ...current, memos: { ...current.memos, [name]: candidate } } as AnyTaskRecord);
						return candidate;
					},
					rest[1] as Context,
				);
			}) as ErasedRuntime["memo"],
			sleep: (until, context) => this.#sleep(invocation, until, context),
			watchDoc: ((...args: readonly unknown[]) => this.#watchDoc(invocation, args)) as ErasedRuntime["watchDoc"],
			snapshot: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshot")(...args),
				)) as ErasedRuntime["snapshot"],
			snapshotAsOf: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshotAsOf")(...args),
				)) as ErasedRuntime["snapshotAsOf"],
			getTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(() => this.#storage.task(id, context)),
				)) as ErasedRuntime["getTask"],
			waitForTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.waitForTask(id, withAbortSignal(invocation.controller.signal, context)),
				)) as ErasedRuntime["waitForTask"],
			conversation: (id, context) =>
				this.#read(invocation, () =>
					this.#conversation(
						id,
						{
							signal: invocation.controller.signal,
							check: () => {
								if (invocation.ended) throw endedError(invocation);
							},
						},
						context,
					),
				),
			entry: ((...args: readonly unknown[]) => {
				const [token, id, context] =
					args.length === 2
						? [undefined, args[0] as EntryId, args[1] as Context]
						: [args[0] as { readonly kind: string }, args[1] as EntryId, args[2] as Context];
				return this.#read(invocation, async () => {
					const found = await this.#session.readOnLine(() =>
						this.#storage.entry(invocation.conversationId, id, context),
					);
					const entry: EntryRecord | undefined = found?.entry;
					return token === undefined || entry?.kind === token.kind ? entry : undefined;
				});
			}) as ErasedRuntime["entry"],
			context: (conversationId, context, at) =>
				this.#read(invocation, () => readContext(this.#session, this.#storage, conversationId, context, at)),
			now: () => this.#now(),
			report: (error) => this.#report(error),
		};
	}

	/** Whether a scoped hook registration matches the invocation's conversation: itself, or an owner for `subtree`. */
	async #hookMatches(invocation: Invocation, scope: HookScope): Promise<boolean> {
		if (scope.conversationId === invocation.conversationId) return true;
		if (scope.subtree !== true) return false;
		if (!this.#chainKnown(invocation.conversationId)) {
			await this.#session.readOnLine(() => this.#loadChain(invocation.conversationId));
		}
		let edge = this.#edges.get(invocation.conversationId);
		while (edge) {
			if (edge.conversationId === scope.conversationId) return true;
			edge = this.#edges.get(edge.conversationId);
		}
		return false;
	}

	/** Run a committed-state read unless the invocation has ended. */
	async #read<T>(invocation: Invocation, read: () => Promise<T>): Promise<T> {
		if (invocation.ended) throw endedError(invocation);
		return read();
	}

	/** Commit after rereading the task on the line and gating the invocation. */
	#gated<T>(
		invocation: Invocation,
		change: (tx: Transaction, current: ErasedRunningTask) => T | Promise<T>,
		context: Context,
	): Promise<T> {
		if (invocation.ended) return Promise.reject(endedError(invocation));
		return this.#session.commitWith(
			async (tx) => {
				if (invocation.ended) throw endedError(invocation);
				if (this.#closing) throw closedError();
				const current = this.#live.get(invocation.taskId) as ErasedRunningTask | undefined;
				if (current === undefined) throw new Error(`Task ${invocation.taskId} is terminal`);
				if (invocation.mode === "run" && current.abortRequested) {
					throw new Error(`Task ${invocation.taskId} has a durable abort mark`);
				}
				return change(tx, current);
			},
			context,
			{ conversationId: invocation.conversationId, taskId: invocation.taskId },
		);
	}

	/** Wait until the Harness clock reaches `until`, rechecking it after every timer. */
	async #sleep(invocation: Invocation, until: number, context: Context): Promise<void> {
		if (invocation.ended) throw endedError(invocation);
		const signals = [invocation.controller.signal];
		if (context.abortSignal !== undefined) signals.push(context.abortSignal);
		const signal = AbortSignal.any(signals);
		for (;;) {
			signal.throwIfAborted();
			const remaining = until - this.#now();
			if (remaining <= 0) return;
			await delay(Math.min(remaining, MAX_TIMER_DELAY), signal);
		}
	}

	async #watchDoc(invocation: Invocation, args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		if (invocation.ended) throw endedError(invocation);
		const watch = (await sessionMethod(this.#session, "watchDoc")(...args)) as DocumentWatch<JsonObject> | undefined;
		if (watch === undefined) return undefined;
		if (invocation.ended) {
			void watch.stop();
			throw endedError(invocation);
		}
		invocation.watches.add(watch);
		void watch.closed.then(() => invocation.watches.delete(watch));
		return watch;
	}
}

/** A terminal task's durable cancellation intent: its abort mark, or any outcome but `completed`. */
function cancellationIntent(record: AnyTaskRecord): boolean {
	return record.abortRequested || (record.state.status === "terminal" && record.state.outcome.status !== "completed");
}

/** Own memo entry only; memo names such as `toString` must not resolve to inherited properties. */
function memoOf(record: LiveTaskRecord | undefined, name: string): JsonValue | undefined {
	const memos = record?.memos;
	return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined;
}

/** Overloaded Session method bound for forwarding an argument list unchanged. */
function sessionMethod(
	session: SessionImpl,
	name: "snapshot" | "snapshotAsOf" | "watchDoc",
): (...args: readonly unknown[]) => Promise<unknown> {
	return (session[name] as (...args: readonly unknown[]) => Promise<unknown>).bind(session);
}

function missingMigration(record: LiveTaskRecord, definition: ErasedDefinition): Error {
	return new Error(`Task ${record.kind} version ${definition.version} has no migration from ${record.version}`);
}

function erased(task: AnyTask): ErasedDefinition {
	return task.definition as unknown as ErasedDefinition;
}

function endedError(invocation: Invocation): Error {
	return new Error(`Task ${invocation.taskId} invocation has ended`);
}

/** Replace a live record's state; memos disappear in the terminal replacement. */
function withState(record: LiveTaskRecord, state: TaskState<JsonValue, JsonValue>): AnyTaskRecord {
	if (state.status !== "terminal") return { ...record, state } as AnyTaskRecord;
	const { memos: _memos, ...rest } = record;
	return { ...rest, state };
}

/** Whether a definition can take the task at reservation: same version, or newer with a migration. */
function canReserve(task: AnyTask, record: LiveTaskRecord): boolean {
	const definition = task.definition;
	return (
		definition.version === record.version || (definition.version > record.version && definition.migrate !== undefined)
	);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Structural equality of two JSON values; object key order is ignored. */
function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => jsonEqual(value, right[index]));
	}
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}
