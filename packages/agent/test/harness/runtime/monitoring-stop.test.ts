import {
	type Api,
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness, type AgentLane } from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { MemorySessionRepo } from "../../../src/harness/session/memory.ts";
import {
	type OperationState,
	operationScopeOf,
	type SettledAssistantMessage,
} from "../../../src/harness/session/types.ts";
import { laneState, operationState } from "../../../src/harness/session/values.ts";
import type { AgentHarnessTool } from "../../../src/harness/types.ts";
import { deferred as barrier } from "./test-utils.ts";

const repositories: MemorySessionRepo[] = [];
const blocked: SettledAssistantMessage = {
	...fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "Monitoring stopped this conversation" }),
	stopReason: "error",
	providerError: {
		code: "misalignment_policy_violation",
		type: "invalid_request_error",
		status: 400,
		requestId: "req_block",
		responseId: "resp_block",
	},
};

async function fixture(deferred = false) {
	const repo = new MemorySessionRepo();
	repositories.push(repo);
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const options = { session, models, model: faux.getModel(), streamOptions: { deferred } };
	const { harness } = await AgentHarness.create(options, BACKGROUND_CONTEXT);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	if (!(lane instanceof Lane)) throw new Error("Expected runtime lane");
	return { session, repo, faux, models, options, harness, lane };
}

afterEach(async () => {
	for (const repo of repositories.splice(0)) await repo.close(BACKGROUND_CONTEXT);
});

describe("durable monitoring stop", () => {
	it.each(["assistant", "compaction", "navigation", "deferred"] as const)(
		"checks the last %s dispatch boundary after an asynchronous preparation hook",
		async (kind) => {
			const { lane, harness, faux, models } = await fixture();
			const root = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
			const related = await harness.lane("related", { createAt: root }, BACKGROUND_CONTEXT);
			if (kind === "navigation") {
				await related.appendMessage({ role: "user", content: "branch", timestamp: 2 }, BACKGROUND_CONTEXT);
			}
			if (kind === "deferred") {
				await harness.setStreamOptions({ deferred: true }, BACKGROUND_CONTEXT);
				faux.setResponses([fauxAssistantMessage("deferred answer")]);
				await related.prompt("deferred request", undefined, BACKGROUND_CONTEXT);
				await harness.setStreamOptions({ deferred: false }, BACKGROUND_CONTEXT);
			}
			const entered = barrier();
			const release = barrier();
			harness.hooks.on("before_request", async (event) => {
				if (event.lane !== "related") return;
				entered.resolve();
				await release.promise;
				return undefined;
			});
			const running =
				kind === "assistant"
					? related.prompt("held request", undefined, BACKGROUND_CONTEXT)
					: kind === "compaction"
						? related.compact(undefined, BACKGROUND_CONTEXT)
						: kind === "navigation"
							? related.navigateTree(root, { summarize: true }, BACKGROUND_CONTEXT)
							: related.resume(BACKGROUND_CONTEXT);
			await entered.promise;
			faux.setResponses([blocked]);
			await lane.prompt("stop this conversation", undefined, BACKGROUND_CONTEXT);
			const request = vi.spyOn(models, "streamSimple");
			const summary = vi.spyOn(models, "completeSimple");
			const poll = vi.spyOn(models, "streamDeferred");
			faux.setResponses([fauxAssistantMessage("must not dispatch")]);
			release.resolve();
			const outcome = await running;
			expect(outcome).toMatchObject({
				ok: true,
				value:
					kind === "compaction" || kind === "navigation" ? { [kind]: { status: "failed" } } : { status: "failed" },
			});
			expect(request).not.toHaveBeenCalled();
			expect(summary).not.toHaveBeenCalled();
			expect(poll).not.toHaveBeenCalled();
		},
	);

	it.each(["assistant", "compaction", "navigation", "deferred"] as const)(
		"checks the last %s payload hook without losing the stored monitoring error",
		async (kind) => {
			const { lane, harness, faux, models, session } = await fixture();
			const root = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
			const related = await harness.lane("related", { createAt: root }, BACKGROUND_CONTEXT);
			if (kind === "navigation") {
				await related.appendMessage({ role: "user", content: "branch", timestamp: 2 }, BACKGROUND_CONTEXT);
			}
			if (kind === "deferred") {
				await harness.setStreamOptions({ deferred: true }, BACKGROUND_CONTEXT);
				faux.setResponses([fauxAssistantMessage("deferred answer")]);
				await related.prompt("deferred request", undefined, BACKGROUND_CONTEXT);
				await harness.setStreamOptions({ deferred: false }, BACKGROUND_CONTEXT);
			}
			const entered = barrier();
			const release = barrier();
			harness.hooks.on("before_payload", async (event) => {
				if (event.lane !== "related") return;
				entered.resolve();
				await release.promise;
				return undefined;
			});
			const dispatch = vi.fn();
			const nativeRequest = (model: Model<Api>, options?: Pick<SimpleStreamOptions, "onPayload" | "signal">) => {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					try {
						await options?.onPayload?.({}, model);
						dispatch();
						const message = fauxAssistantMessage("unexpected dispatch");
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					} catch (error) {
						const reason = options?.signal?.aborted ? "aborted" : "error";
						const message = fauxAssistantMessage([], { stopReason: reason, errorMessage: String(error) });
						stream.push({ type: "error", reason, error: message });
					}
					stream.end();
				})();
				return stream;
			};
			if (kind === "deferred") {
				vi.spyOn(models, "streamDeferred").mockImplementationOnce((model, _handle, options) =>
					nativeRequest(model, options),
				);
			} else {
				vi.spyOn(models, "streamSimple").mockImplementationOnce((model, _context, options) =>
					nativeRequest(model, options),
				);
			}
			const running =
				kind === "assistant"
					? related.prompt("held payload", undefined, BACKGROUND_CONTEXT)
					: kind === "compaction"
						? related.compact(undefined, BACKGROUND_CONTEXT)
						: kind === "navigation"
							? related.navigateTree(root, { summarize: true }, BACKGROUND_CONTEXT)
							: related.resume(BACKGROUND_CONTEXT);
			await entered.promise;
			faux.setResponses([blocked]);
			await lane.prompt("stop this conversation", undefined, BACKGROUND_CONTEXT);
			release.resolve();
			const failure = {
				status: "failed",
				error: { code: "misalignment_policy_violation", details: blocked.providerError },
			};
			expect(await running).toMatchObject({
				ok: true,
				value: kind === "compaction" || kind === "navigation" ? { [kind]: failure } : failure,
			});
			expect(dispatch).not.toHaveBeenCalled();
			expect(
				(await session.getValue(laneState("related"), BACKGROUND_CONTEXT))?.value.monitoringStop?.message
					.providerError,
			).toEqual(blocked.providerError);
		},
	);

	it("stops prepared tools and signals active tools while retaining actual completed effects", async () => {
		const { lane, harness, faux } = await fixture();
		const root = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const related = await harness.lane("related", { createAt: root }, BACKGROUND_CONTEXT);
		const active = barrier();
		const entered = barrier();
		const release = barrier();
		const finishActive = barrier();
		let activeSignal: AbortSignal | undefined;
		const effects: string[] = [];
		const execute = vi.fn<AgentHarnessTool<object | undefined>["execute"]>(
			async (id, _args, _update, _toolContext, _invocation, context) => {
				effects.push(id);
				if (id === "active") {
					activeSignal = context.abortSignal;
					active.resolve();
					await finishActive.promise;
				}
				return { content: [{ type: "text", text: `${id} actually completed` }], details: undefined };
			},
		);
		await harness.setTools(
			[{ name: "work", label: "work", description: "work", parameters: Type.Object({}), execute }],
			BACKGROUND_CONTEXT,
		);
		await related.setActiveTools(["work"], BACKGROUND_CONTEXT);
		harness.hooks.on("before_tool", async (event) => {
			if (event.lane !== "related" || event.toolCallId !== "queued") return;
			entered.resolve();
			await release.promise;
			return undefined;
		});
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("work", {}, { id: "active" }), fauxToolCall("work", {}, { id: "queued" })],
				{ stopReason: "toolUse" },
			),
		]);
		const running = related.prompt("parallel work", undefined, BACKGROUND_CONTEXT);
		await Promise.all([active.promise, entered.promise]);
		faux.setResponses([blocked]);
		await lane.prompt("stop this conversation", undefined, BACKGROUND_CONTEXT);
		release.resolve();
		await vi.waitFor(() => expect(activeSignal?.aborted || execute.mock.calls.length === 2).toBe(true));
		finishActive.resolve();
		expect(await running).toMatchObject({ ok: true, value: { status: "failed" } });
		expect(activeSignal?.aborted).toBe(true);
		expect(effects).toEqual(["active"]);
		expect(
			(await related.findEntries(undefined, BACKGROUND_CONTEXT)).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "active" &&
					!entry.message.isError &&
					entry.message.content.some(
						(block) => block.type === "text" && block.text === "active actually completed",
					),
			),
		).toBe(true);
	});

	it.each(["already-related", "navigate-existing"] as const)(
		"blocks execution in an existing %s lane while retaining inspection and unrelated work",
		async (kind) => {
			const { lane, harness, session, repo, options, faux, models } = await fixture();
			const root = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
			const related = await harness.lane(
				"related",
				{ createAt: kind === "already-related" ? root : null },
				BACKGROUND_CONTEXT,
			);
			const unrelated = await harness.lane("unrelated", { createAt: null }, BACKGROUND_CONTEXT);
			await related.nextRun("queued continuation", undefined, BACKGROUND_CONTEXT);
			faux.setResponses([blocked]);
			await lane.prompt("question", undefined, BACKGROUND_CONTEXT);
			const request = vi.spyOn(models, "streamSimple");
			if (kind === "navigate-existing") {
				expect(await related.navigateTree(root, undefined, BACKGROUND_CONTEXT)).toMatchObject({
					ok: true,
					value: { navigation: { status: "completed" } },
				});
			}
			expect(await related.accept({ kind: "prompt", prompt: "continue" }, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(await related.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			const stopped = (await session.getValue(laneState("related"), BACKGROUND_CONTEXT))?.value;
			expect(stopped?.monitoringStop?.message.providerError).toEqual(blocked.providerError);
			expect(stopped?.inbox).toHaveLength(1);
			expect(await related.findEntries(undefined, BACKGROUND_CONTEXT)).toHaveLength(1);
			await related.navigateTree(null, undefined, BACKGROUND_CONTEXT);
			expect(request).not.toHaveBeenCalled();

			faux.setResponses([fauxAssistantMessage("ordinary answer")]);
			expect(await unrelated.prompt("independent work", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { status: "completed" },
			});
			await harness.close(BACKGROUND_CONTEXT);
			const reopened = await AgentHarness.create(
				{ ...options, session: await repo.open(session.metadata, BACKGROUND_CONTEXT) },
				BACKGROUND_CONTEXT,
			);
			const restored = await reopened.harness.lane("related", BACKGROUND_CONTEXT);
			expect(await restored.prompt("continue after reopening", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it("stops previously admitted related work before its first drive hook or request", async () => {
		const { lane, harness, faux, models } = await fixture();
		const root = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const related = await harness.lane("related", { createAt: root }, BACKGROUND_CONTEXT);
		const admitted = await related.accept({ kind: "prompt", prompt: "queued work" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		faux.setResponses([blocked]);
		await lane.prompt("question", undefined, BACKGROUND_CONTEXT);
		const hook = vi.fn();
		harness.hooks.on("before_drive", hook);
		const request = vi.spyOn(models, "streamSimple");
		expect(await related.drive({ operationId: admitted.value.operationId }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { status: "failed", error: { code: "misalignment_policy_violation" } } },
		});
		expect(hook).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"persists a stop from a deferred=%s response across navigation and reopen",
		async (deferred) => {
			const { lane, harness, faux, options, models, repo, session } = await fixture(deferred);
			const root = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
			faux.setResponses([blocked]);
			if (deferred) {
				expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
					ok: true,
					value: { status: "suspended" },
				});
				expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({ ok: true, value: { status: "failed" } });
			} else {
				expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
					ok: true,
					value: { status: "failed" },
				});
			}
			const request = vi.spyOn(models, "streamSimple");
			const summary = vi.spyOn(models, "completeSimple");
			const poll = vi.spyOn(models, "fetchDeferred");
			expect(
				(await session.getValue(laneState("main"), BACKGROUND_CONTEXT))?.value.monitoringStop?.message
					.providerError,
			).toEqual(blocked.providerError);
			await lane.nextRun("queued continuation", undefined, BACKGROUND_CONTEXT);
			expect(await lane.prompt("continue", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { _tag: "InvalidMessage", reason: "monitoring_blocked" },
			});
			expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(await lane.navigateTree(root, { summarize: true }, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(await lane.navigateTree(root, undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { navigation: { status: "completed" } },
			});
			expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBe(root);
			expect(await lane.findEntries(undefined, BACKGROUND_CONTEXT)).toHaveLength(1);
			const watch = await lane.watch(BACKGROUND_CONTEXT);
			expect(watch.snapshot.faulted).toBe(false);
			watch.unsubscribe();
			await harness.close(BACKGROUND_CONTEXT);
			const reopened = await AgentHarness.create(
				{ ...options, session: await repo.open(session.metadata, BACKGROUND_CONTEXT) },
				BACKGROUND_CONTEXT,
			);
			const restored = await reopened.harness.lane("main", BACKGROUND_CONTEXT);
			expect(await restored.prompt("continue from ancestor", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(request).not.toHaveBeenCalled();
			expect(summary).not.toHaveBeenCalled();
			expect(poll).not.toHaveBeenCalled();
			const unrelated = await reopened.harness.lane("other", { createAt: null }, BACKGROUND_CONTEXT);
			faux.setResponses([fauxAssistantMessage("ordinary answer")]);
			expect(await unrelated.prompt("new conversation", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { status: deferred ? "suspended" : "completed" },
			});
		},
	);

	it.each(["compaction", "navigation"] as const)(
		"persists a stop from %s and does not consume queued continuation",
		async (kind) => {
			const { lane, faux, models, harness, options, repo, session } = await fixture();
			const root = await lane.appendMessage({ role: "user", content: "root", timestamp: 1 }, BACKGROUND_CONTEXT);
			await lane.appendMessage({ role: "user", content: "source", timestamp: 2 }, BACKGROUND_CONTEXT);
			await lane.nextRun("continue", undefined, BACKGROUND_CONTEXT);
			faux.setResponses([blocked, fauxAssistantMessage("must not run")]);
			const request = vi.spyOn(models, "streamSimple");
			const result =
				kind === "compaction"
					? await lane.compact(undefined, BACKGROUND_CONTEXT)
					: await lane.navigateTree(root, { summarize: true }, BACKGROUND_CONTEXT);
			expect(result).toMatchObject({ ok: true, value: { [kind]: { status: "failed" } } });
			expect(faux.state.callCount).toBe(1);
			expect(request).toHaveBeenCalledTimes(1);
			expect(
				(await session.getValue(laneState("main"), BACKGROUND_CONTEXT))?.value.monitoringStop?.message
					.providerError,
			).toEqual(blocked.providerError);
			await harness.close(BACKGROUND_CONTEXT);
			const reopened = await AgentHarness.create(
				{ ...options, session: await repo.open(session.metadata, BACKGROUND_CONTEXT) },
				BACKGROUND_CONTEXT,
			);
			const restored = await reopened.harness.lane("main", BACKGROUND_CONTEXT);
			expect(await restored.prompt("continue", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(faux.state.callCount).toBe(1);
		},
	);

	it("does not let response hooks replace a provider monitoring stop", async () => {
		const { lane, harness, faux } = await fixture();
		const hook = vi.fn(() => ({ message: { ...fauxAssistantMessage("replacement"), stopReason: "stop" as const } }));
		harness.hooks.on("after_response", hook);
		faux.setResponses([blocked]);
		expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "failed" },
		});
		expect(hook).not.toHaveBeenCalled();
	});

	it.each(["branch-tip", "branch-ancestor", "tree", "lane-tip", "lane-ancestor", "data-branch"] as const)(
		"inherits a stopped conversation through %s",
		async (kind) => {
			const { lane, harness, session, repo, options, faux, models } = await fixture();
			const root = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
			faux.setResponses([blocked]);
			await lane.prompt("question", undefined, BACKGROUND_CONTEXT);
			const blockedTip = await lane.getTipId(BACKGROUND_CONTEXT);
			const request = vi.spyOn(models, "streamSimple");
			const target = kind.endsWith("ancestor") ? root : blockedTip;
			let destination = harness;
			let derived: AgentLane;
			if (kind === "tree" || kind.startsWith("branch-")) {
				const forked = await repo.fork(
					session.metadata,
					kind === "tree" ? { scope: "tree" } : { scope: "branch", branch: "main", entryId: target! },
					BACKGROUND_CONTEXT,
				);
				destination = (await AgentHarness.create({ ...options, session: forked }, BACKGROUND_CONTEXT)).harness;
				derived = await destination.lane("main", BACKGROUND_CONTEXT);
			} else {
				await lane.navigateTree(null, undefined, BACKGROUND_CONTEXT);
				if (kind === "data-branch") await session.createBranch("derived", target, BACKGROUND_CONTEXT);
				derived = await destination.lane("derived", { createAt: target }, BACKGROUND_CONTEXT);
			}
			expect(await derived.prompt("continue", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(await derived.findEntries(undefined, BACKGROUND_CONTEXT)).not.toHaveLength(0);
			await derived.navigateTree(root, undefined, BACKGROUND_CONTEXT);
			const descendant = await destination.lane("descendant", { createAt: root }, BACKGROUND_CONTEXT);
			expect(await descendant.prompt("continue again", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: false,
				error: { reason: "monitoring_blocked" },
			});
			expect(request).not.toHaveBeenCalled();

			const empty = await destination.lane("unrelated", { createAt: null }, BACKGROUND_CONTEXT);
			faux.setResponses([fauxAssistantMessage("ordinary answer")]);
			expect(await empty.prompt("new conversation", undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { status: "completed" },
			});
		},
	);

	it("inherits a summary stop after navigation and reopen without blocking unrelated history", async () => {
		const { lane, harness, session, repo, options, faux, models } = await fixture();
		const history = await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const unrelated = await harness.lane("unrelated", { createAt: null }, BACKGROUND_CONTEXT);
		const otherHistory = await unrelated.appendMessage(
			{ role: "user", content: "other", timestamp: 2 },
			BACKGROUND_CONTEXT,
		);
		faux.setResponses([blocked]);
		expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { compaction: { status: "failed" } },
		});
		await lane.navigateTree(null, undefined, BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		const reopened = await AgentHarness.create(
			{ ...options, session: await repo.open(session.metadata, BACKGROUND_CONTEXT) },
			BACKGROUND_CONTEXT,
		);
		const request = vi.spyOn(models, "streamSimple");
		const derived = await reopened.harness.lane("derived", { createAt: history }, BACKGROUND_CONTEXT);
		expect(await derived.prompt("continue", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { reason: "monitoring_blocked" },
		});
		expect(request).not.toHaveBeenCalled();
		const separate = await reopened.harness.lane("separate", { createAt: otherHistory }, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("ordinary answer")]);
		expect(await separate.prompt("continue separate work", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
	});

	it.each([
		"starting",
		"checkpoint",
		"assistant.ready",
		"assistant.retry_wait",
		"assistant.effect_pending",
		"tools",
		"deferred.suspended",
		"deferred.effect_pending",
		"summary.deciding",
		"summary.ready",
		"summary.retry_wait",
		"summary.effect_pending",
	] as const)("fails a restored %s before hooks, requests, tool replay, or polling", async (at) => {
		const { lane, session, repo, harness, options, models, faux } = await fixture();
		const admitted = await lane.accept({ kind: "prompt", prompt: "question" }, BACKGROUND_CONTEXT);
		if (!admitted.ok || lane.state.operation === null) throw new Error("Expected accepted operation");
		const id = admitted.value.operationId;
		const scope = operationScopeOf(lane.state.operation.state);
		const configuration = lane.state.configuration;
		const retryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxAgentDelayMs: 100 };
		const generationContext = {
			stepId: "step",
			triggerEntryId: lane.state.tipId!,
			configuration,
			streamOptions: {},
			retryPolicy,
			overflowRecoveryUsed: false,
		};
		const summaryContext = { resultEntryId: "summary", configuration, streamOptions: {}, retryPolicy };
		const task = {
			taskId: "task",
			reason: "threshold" as const,
			boundary: {
				kind: "resume_checkpoint" as const,
				resumeAfter: {
					continuation: { kind: "need_assistant" as const, overflowRecoveryUsed: false },
					triggerEntryId: lane.state.tipId!,
				},
			},
		};
		const deferred = { stepId: "step", sourceEntryId: "deferred", poll: 0, configuration, streamOptions: {} };
		const states: Record<typeof at, OperationState> = {
			starting: { ...scope, at: "starting" },
			checkpoint: { ...scope, at: "checkpoint", ...task.boundary.resumeAfter },
			"assistant.ready": { ...scope, at: "assistant.ready", generationContext, nextAttempt: 1 },
			"assistant.retry_wait": {
				...scope,
				at: "assistant.retry_wait",
				generationContext,
				nextAttempt: 2,
				notBefore: 0,
				errorMessage: "retry",
			},
			"assistant.effect_pending": {
				...scope,
				at: "assistant.effect_pending",
				generationContext,
				attempt: 1,
				responseEntryId: "response",
				usageId: "usage",
				contextWindow: 1000,
				intendedOutputLimit: 100,
			},
			tools: {
				...scope,
				at: "tools",
				batch: {
					assistantEntryId: "assistant",
					configuration,
					turnId: "turn",
					calls: [{ status: "effect_pending", replay: "safe", sourceIndex: 0, resultEntryId: "tool-result" }],
				},
			},
			"deferred.suspended": { ...scope, ...deferred, at: "deferred.suspended" },
			"deferred.effect_pending": {
				...scope,
				...deferred,
				at: "deferred.effect_pending",
				responseEntryId: "response",
				usageId: "usage",
			},
			"summary.deciding": { ...scope, at: "summary.deciding", task },
			"summary.ready": { ...scope, at: "summary.ready", task, summaryContext, nextAttempt: 1 },
			"summary.retry_wait": {
				...scope,
				at: "summary.retry_wait",
				task,
				summaryContext,
				nextAttempt: 2,
				notBefore: 0,
				errorMessage: "retry",
			},
			"summary.effect_pending": {
				...scope,
				at: "summary.effect_pending",
				task,
				summaryContext,
				attempt: 1,
				usageIds: [],
			},
		};
		await session.setValue(operationState(id), states[at], BACKGROUND_CONTEXT);
		await session.setValue(
			laneState("main"),
			{
				currentOperationId: id,
				lastOperationId: null,
				inbox: [],
				monitoringStop: { message: blocked, tipId: lane.state.tipId },
			},
			BACKGROUND_CONTEXT,
		);
		await harness.close(BACKGROUND_CONTEXT);
		const reopened = await AgentHarness.create(
			{ ...options, session: await repo.open(session.metadata, BACKGROUND_CONTEXT) },
			BACKGROUND_CONTEXT,
		);
		const restored = await reopened.harness.lane("main", BACKGROUND_CONTEXT);
		const hook = vi.fn();
		reopened.harness.hooks.on("before_drive", hook);
		const request = vi.spyOn(models, "streamSimple");
		const poll = vi.spyOn(models, "fetchDeferred");
		expect(await restored.resume(BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "failed", error: { code: "misalignment_policy_violation", details: blocked.providerError } },
		});
		expect(hook).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
		expect(poll).not.toHaveBeenCalled();
		expect(faux.state.callCount).toBe(0);
	});
});
