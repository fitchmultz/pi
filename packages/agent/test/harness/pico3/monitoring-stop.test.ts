import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolDeclaration } from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, Gate, model, open, tool, untilPhase, untilTerminal } from "./helpers.ts";

// All provider responses and tools are local fakes. Display text deliberately does not identify the policy.
function blockedFake(opts: { gate?: Gate; blockCall?: number; code?: string } = {}) {
	const models = fake({
		respond: (messages, call) =>
			call === (opts.blockCall ?? 0) ? { error: "request blocked" } : echoScript(messages),
		gate: opts.gate,
	});
	const stream = models.stream.bind(models);
	models.stream = async function* (...args: Parameters<typeof stream>) {
		for await (const event of stream(...args)) {
			if (event.type === "error")
				yield {
					...event,
					error: { ...event.error, providerError: { code: opts.code ?? "misalignment_policy_violation" } },
				};
			else yield event;
		}
	};
	return models;
}

for (const backend of ["memory", "jsonl"] as const) {
	test(`${backend}: exact monitoring block settles queued triggers without successor model/tool dispatch`, async () => {
		const gate = new Gate();
		const models = blockedFake({ gate });
		const probe = tool("probe");
		const env = await open({ backend, models, tools: [probe] });
		try {
			const first = await env.root.send({ content: "original request", requestId: "original" }, ctx);
			await gate.arrivals(1);
			const queued = await Promise.all([
				env.root.send({ content: "tool:probe" }, ctx),
				env.root.send({ content: "steering", whenBusy: "steer" }, ctx),
				env.root.send({ content: "another followup" }, ctx),
			]);
			gate.open();
			for (const input of [first, ...queued]) assert.equal((await input.wait(ctx)).status, "unanswered");
			await env.root.waitForIdle(ctx);
			assert.equal(models.calls, 1);
			assert.equal(probe.calls, 0);
			assert.equal((await env.tasks()).filter((task) => task.kind === "pi.generation").length, 1);
			assert.deepEqual((await env.root.sticky(ctx)).inbox, []);
			assert.equal((await env.root.send({ content: "duplicate", requestId: "original" }, ctx)).id, first.id);
			await assert.rejects(env.root.send({ content: "later" }, ctx), /misalignment_policy_violation/);
		} finally {
			await env.close();
		}
	});
}

test("JSONL reopen and reset retain the source stop while history forks and new conversations can dispatch", async () => {
	const models = blockedFake();
	const original = await open({ backend: "jsonl", models, root: { rewindable: { model, keepRecent: 0 } } });
	let env = original;
	try {
		assert.equal((await (await env.root.send({ content: "original request" }, ctx)).wait(ctx)).status, "unanswered");
		await env.root.waitForIdle(ctx);
		const entries = await env.entries();
		const blocked = entries.find((entry) => entry.data?.display !== undefined)!;
		assert.equal(blocked.model, undefined);
		assert.equal(
			(blocked.data?.display as { providerError: { code: string } }).providerError.code,
			"misalignment_policy_violation",
		);
		env = await (await env.crash())();
		const watch = await env.root.watch(ctx);
		await env.root.context(ctx);
		assert.equal((await env.entries()).length, entries.length);
		watch.stop();
		await assert.rejects(env.root.send({ content: "later" }, ctx), /misalignment_policy_violation/);
		const collapse = await env.root.collapse(undefined, ctx);
		assert.equal((await untilTerminal(env, collapse)).outcome?.status, "failed");
		for (const at of [entries[0]!.id, blocked.id]) {
			const fork = await env.root.fork(at, {}, ctx);
			assert.equal((await fork.sticky(ctx)).monitoringBlocked, undefined);
			assert.equal((await (await fork.send({ content: "continue" }, ctx)).wait(ctx)).status, "done");
		}
		const related = await env.h.createConversation(
			{ parent: { conversationId: env.root.id, at: blocked.id }, rewindable: { model } },
			ctx,
		);
		assert.equal((await related.sticky(ctx)).monitoringBlocked, undefined);
		assert.equal((await (await related.send({ content: "related" }, ctx)).wait(ctx)).status, "done");
		assert.ok(
			models.requests
				.slice(1, 4)
				.every((messages) =>
					messages.some((message) => message.role === "user" && message.content === "original request"),
				),
		);
		await env.root.reset(undefined, ctx);
		await assert.rejects(env.root.send({ content: "after reset" }, ctx), /misalignment_policy_violation/);
		assert.equal((await env.root.sticky(ctx)).monitoringBlocked, true);
		assert.equal(models.calls, 4);
		const fresh = await env.h.createConversation({ rewindable: { model } }, ctx);
		assert.equal((await (await fresh.send({ content: "independent" }, ctx)).wait(ctx)).status, "done");
		const emptyFork = await env.root.fork("start", { rewindable: { model } }, ctx);
		assert.equal((await (await emptyFork.send({ content: "empty" }, ctx)).wait(ctx)).status, "done");
		assert.equal(models.calls, 6);
		assert.ok(
			models.requests
				.slice(4)
				.every(
					(messages) =>
						!messages.some((message) => message.role === "user" && message.content === "original request"),
				),
		);
	} finally {
		await env.close();
		await original.close();
	}
});

test("a new monitoring stop in a history fork does not stop its source after JSONL reopen", async () => {
	const models = blockedFake({ blockCall: 1 });
	const original = await open({ backend: "jsonl", models });
	let env = original;
	try {
		const source = await (await env.root.send({ content: "source history" }, ctx)).wait(ctx);
		assert.equal(source.status, "done");
		const fork = await env.root.fork(source.answer!, {}, ctx);
		assert.equal((await (await fork.send({ content: "blocked fork" }, ctx)).wait(ctx)).status, "unanswered");
		await fork.waitForIdle(ctx);
		assert.equal((await fork.sticky(ctx)).monitoringBlocked, true);
		assert.equal((await env.root.sticky(ctx)).monitoringBlocked, undefined);
		env = await (await env.crash())();
		const reopenedFork = (await env.h.conversation(fork.id, ctx))!;
		await assert.rejects(reopenedFork.send({ content: "still blocked" }, ctx), /misalignment_policy_violation/);
		assert.equal((await (await env.root.send({ content: "source continues" }, ctx)).wait(ctx)).status, "done");
		assert.equal(models.calls, 3);
	} finally {
		await env.close();
		await original.close();
	}
});

test("ordinary structured provider errors still admit queued followups and later sends", async () => {
	const gate = new Gate();
	const models = blockedFake({ gate, code: "invalid_request_error" });
	const probe = tool("probe");
	const env = await open({ models, tools: [probe] });
	try {
		const first = await env.root.send({ content: "first" }, ctx);
		await gate.arrivals(1);
		const queued = await env.root.send({ content: "tool:probe" }, ctx);
		gate.open();
		assert.equal((await first.wait(ctx)).status, "unanswered");
		assert.equal((await queued.wait(ctx)).status, "done");
		assert.equal((await (await env.root.send({ content: "later" }, ctx)).wait(ctx)).status, "done");
		assert.equal(models.calls, 4);
		assert.equal(probe.calls, 1);
	} finally {
		await env.close();
	}
});

for (const phase of ["pending", "started"] as const) {
	test(`collapse-originated stop prevents persisted ${phase} tool work and post-tools continuation after reopen`, async () => {
		const gate = new Gate();
		const models = blockedFake({ blockCall: 1 });
		const probe = tool("probe", phase === "started" ? { gate } : {});
		const original = await open({
			backend: "jsonl",
			models,
			tools: [probe],
			root: { rewindable: { model, selectedTools: ["probe"], keepRecent: 0 } },
			hooks:
				phase === "pending"
					? {
							tool: {
								beforeTool: async (_call, _api, context) => {
									await gate.wait(context);
								},
							},
						}
					: undefined,
		});
		let env = original;
		try {
			const input = await env.root.send({ content: "tool:probe" }, ctx);
			await gate.arrivals(1);
			const toolTask = await untilPhase(env, "pi.tool", phase === "started" ? "started" : undefined);
			const collapse = await env.root.collapse(undefined, ctx);
			assert.equal((await untilTerminal(env, collapse)).outcome?.status, "failed");
			assert.equal((await input.wait(ctx)).status, "unanswered");
			assert.equal((await env.root.sticky(ctx)).monitoringBlocked, true);
			const reopen = await env.crash();
			gate.open();
			env = await reopen();
			await env.root.waitForIdle(ctx);
			assert.equal((await untilTerminal(env, toolTask.id)).outcome?.status, "completed");
			assert.equal(probe.calls, phase === "started" ? 1 : 0);
			assert.equal(models.calls, 2);
			assert.equal((await env.input(input.id))?.status, "unanswered");
			await assert.rejects(env.root.send({ content: "continue" }, ctx), /misalignment_policy_violation/);
		} finally {
			await env.close();
			await original.close();
		}
	});
}

test("an in-flight tool preserves its completed result after a monitoring stop without continuing", async () => {
	const gate = new Gate();
	const models = blockedFake({ blockCall: 1 });
	const probe = tool("probe");
	const streaming: ToolDeclaration = {
		...probe,
		async execute(_args, api, context) {
			probe.calls++;
			await gate.wait(context);
			api.stream("finished output");
			await api.progress((slot) => {
				slot.progress = "finished";
			}, context);
			return { details: { completed: true }, control: { handoff: "continue with completed action" } };
		},
	};
	const reports: unknown[] = [];
	const env = await open({
		models,
		tools: [streaming],
		root: { rewindable: { model, selectedTools: ["probe"], keepRecent: 0 } },
		onReport: (error) => reports.push(error),
	});
	try {
		const input = await env.root.send({ content: "tool:probe" }, ctx);
		await gate.arrivals(1);
		const task = await untilPhase(env, "pi.tool", "started");
		const collapse = await env.root.collapse(undefined, ctx);
		assert.equal((await untilTerminal(env, collapse)).outcome?.status, "failed");
		gate.open();
		await env.root.waitForIdle(ctx);
		assert.equal((await untilTerminal(env, task.id)).outcome?.status, "completed");
		const entries = await env.entries();
		const result = entries.find((entry) => entry.kind === "pi.tool_result")!;
		const message = result.model?.[0];
		assert.ok(message?.role === "toolResult");
		assert.deepEqual(message.content, [{ type: "text", text: "finished output" }]);
		assert.equal(message.isError, false);
		assert.deepEqual(result.data?.details, { completed: true });
		assert.deepEqual(result.data?.control, { handoff: "continue with completed action" });
		assert.equal(
			entries.some((entry) => entry.kind === "pi.handoff"),
			false,
		);
		assert.equal((await input.wait(ctx)).status, "unanswered");
		assert.equal(models.calls, 2);
		assert.equal(probe.calls, 1);
		assert.deepEqual(reports, []);
		assert.deepEqual((await env.root.sticky(ctx)).turn, { tools: [] });
	} finally {
		await env.close();
	}
});

test("a prepared generation cannot dispatch after a concurrent stop and reopen", async () => {
	const gate = new Gate();
	const models = blockedFake();
	const original = await open({
		backend: "jsonl",
		models,
		root: { rewindable: { model, keepRecent: 0 } },
		hooks: {
			generation: {
				beforeRequest: async (_request, _info, context) => {
					await gate.wait(context);
				},
			},
		},
	});
	let env = original;
	try {
		const input = await env.root.send({ content: "first" }, ctx);
		await gate.arrivals(1);
		const generation = await untilPhase(env, "pi.generation", "prepared");
		const collapse = await env.root.collapse(undefined, ctx);
		assert.equal((await untilTerminal(env, collapse)).outcome?.status, "failed");
		const reopen = await env.crash();
		gate.open();
		env = await reopen();
		await env.root.waitForIdle(ctx);
		assert.equal((await untilTerminal(env, generation.id)).outcome?.status, "failed");
		assert.equal((await env.input(input.id))?.status, "unanswered");
		assert.equal(models.calls, 1);
	} finally {
		await env.close();
		await original.close();
	}
});

test("collapse-originated stop prevents a persisted deferred handle from polling after reopen", async () => {
	const models = blockedFake({ blockCall: 1 });
	const stream = models.stream.bind(models);
	models.stream = async function* (...args: Parameters<typeof stream>) {
		for await (const event of stream(...args)) {
			if (event.type === "done")
				yield {
					type: "done",
					reason: "deferred",
					message: {
						...event.message,
						stopReason: "deferred",
						deferred: {
							id: "deferred-stop",
							provider: model.provider,
							modelId: model.modelId,
							api: event.message.api,
							pollAfterMs: 60_000,
						},
					},
				};
			else yield event;
		}
	};
	let polls = 0;
	models.fetchDeferred = async () => {
		polls++;
		throw new Error("must not poll a stopped conversation");
	};
	const original = await open({ backend: "jsonl", models, root: { rewindable: { model, keepRecent: 0 } } });
	let env = original;
	try {
		const input = await env.root.send({ content: "first" }, ctx);
		const generation = await untilPhase(env, "pi.generation", "deferred");
		const collapse = await env.root.collapse(undefined, ctx);
		assert.equal((await untilTerminal(env, collapse)).outcome?.status, "failed");
		env = await (await env.crash())();
		await env.root.waitForIdle(ctx);
		assert.equal((await untilTerminal(env, generation.id)).outcome?.status, "failed");
		assert.equal((await env.input(input.id))?.status, "unanswered");
		assert.equal(models.calls, 2);
		assert.equal(polls, 0);
	} finally {
		await env.close();
		await original.close();
	}
});
