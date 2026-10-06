import type { Message } from "@earendil-works/pi-ai";
import {
	type ContextView,
	createRegistry,
	defineTask,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	MemoryStorage,
	type Storage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { addTask, assistant, describeMessage, openHarness, system, toolResult, user } from "./harness-support.ts";
import { context } from "./session-support.ts";

async function setup() {
	const { harness } = await openHarness(new MemoryStorage());
	const root = await harness.root(context);
	const append = (draft: EntryDraft): Promise<EntryRecord> =>
		root.commit((tx) => tx.appendEntry(root.id, draft), context);
	const message = (model: Message, kind = "message"): Promise<EntryRecord> => append({ kind, model: [model] });
	return { harness, root, append, message };
}

function ids(entries: readonly EntryRecord[]): EntryId[] {
	return entries.map((entry) => entry.id);
}

describe("conversation context", () => {
	it("returns the whole transcript without a head and excludes model-less entries from messages", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("hi"));
		const note = await append({ kind: "note", data: { text: "display only" } });
		const answer = await message(assistant("hello"));
		const view = await root.context(context);
		expect(view.head).toBeUndefined();
		expect(ids(view.entries)).toEqual([first.id, note.id, answer.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:hi", "assistant:hello"]);
	});

	it("excludes aborted, error, and deferred assistant messages but keeps their raw entries", async () => {
		const { root, message } = await setup();
		await message(user("q"));
		const aborted = await message(assistant("partial", { stopReason: "aborted" }));
		await message(assistant("failed", { stopReason: "error" }));
		await message(assistant("later", { stopReason: "deferred" }));
		await message(assistant("done", { stopReason: "length" }));
		const view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.entries[1]!.id).toBe(aborted.id);
		expect(view.messages.map(describeMessage)).toEqual(["user:q", "assistant:done"]);
	});

	it("resolves self heads and uses the newest head marker", async () => {
		const { root, append, message } = await setup();
		await message(user("old"));
		const reset = await append({ kind: "reset", head: "self", model: [user("fresh start")] });
		expect(reset.head).toBe(reset.id);
		const after = await message(assistant("after reset"));
		let view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(ids(view.entries)).toEqual([reset.id, after.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:fresh start", "assistant:after reset"]);

		// A compaction summary heads an earlier kept entry; older head markers in range drop out.
		const summary = await append({ kind: "summary", head: after.id, model: [user("summary")] });
		const tail = await message(user("next"));
		view = await root.context(context);
		expect(view.head?.id).toBe(summary.id);
		expect(ids(view.entries)).toEqual([summary.id, after.id, tail.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:summary", "assistant:after reset", "user:next"]);
	});

	it("applies the newest edit per target within the active range", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("first"));
		const second = await message(user("second"));
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v2")] }] });
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v3")] }] });
		await append({ kind: "edit", edits: [{ target: second.id, action: "omit" }] });
		let view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.messages.map(describeMessage)).toEqual(["user:first v3"]);

		// Edits before the active range no longer apply.
		const reset = await append({ kind: "reset", head: second.id });
		view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(view.messages.map(describeMessage)).toEqual([]);
		await append({ kind: "edit", edits: [{ target: second.id, action: "replace", messages: [user("second v2")] }] });
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["user:second v2"]);
	});

	it("keeps positional system messages and orders tool results by call order", async () => {
		const { root, message, append } = await setup();
		await message(system({ preamble: "You help." }), "pi.system");
		await message(user("run tools"));
		await message(assistant("calling", { calls: ["b", "a"] }));
		await message(toolResult("a"));
		await append({ kind: "pi.system", model: [system({ cwd: "/repo" })] });
		await message(toolResult("b"));
		await message(toolResult("zz"));
		await message(assistant("done"));
		const view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:run tools",
			"assistant:calling",
			"result:b:result b",
			"result:a:result a",
			"system:cwd",
			"assistant:done",
		]);
	});

	it("synthesizes missing tool results after a fork and drops results cut from their call", async () => {
		const { root, message } = await setup();
		await message(user("go"));
		const call = await message(assistant("calling", { calls: ["x", "y"] }));
		await message(toolResult("x"));
		const second = await message(toolResult("y"));
		const child = await root.fork(call.id, { ownership: { kind: "ownerless" } }, context);
		const childView = await child.context(context);
		expect(childView.messages.map(describeMessage)).toEqual([
			"user:go",
			"assistant:calling",
			"result:x:error",
			"result:y:error",
		]);
		const missing = childView.messages[2]!;
		expect(missing).toMatchObject({
			role: "toolResult",
			toolName: "tool-x",
			details: { reason: "missing_result" },
		});

		// A head between a call and its results leaves stray results that are not sent.
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "reset", head: second.id }), context);
		const parentView = await root.context(context);
		expect(parentView.messages.map(describeMessage)).toEqual([]);
		expect(parentView.entries.map((entry) => entry.kind)).toEqual(["reset", "message"]);
	});

	it("extends a task invocation's context read with only newer entries", async () => {
		let scanned = 0;
		const memory = new MemoryStorage();
		const storage = new Proxy<Storage>(memory, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (key === "scanEntries") {
					return async (...args: Parameters<Storage["scanEntries"]>) => {
						const page = await target.scanEntries(...args);
						scanned += page.items.length;
						return page;
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const registry = createRegistry();
		const { harness } = await openHarness(storage, [], { registry });
		const root = await harness.root(context);
		const append = (draft: EntryDraft): Promise<EntryRecord> =>
			root.commit((tx) => tx.appendEntry(root.id, draft), context);
		const first = await append({ kind: "message", model: [user("first")] });
		for (let index = 0; index < 20; index++) await append({ kind: "message", model: [assistant(`old ${index}`)] });
		const Reads = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-reads",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const write = (draft: EntryDraft) =>
						runtime.commit(async (tx) => {
							await tx.appendEntry(root.id, draft);
							return undefined;
						}, taskContext);
					const read = async (at?: EntryId): Promise<{ view: ContextView; rows: number }> => {
						const before = scanned;
						const view = await runtime.context(root.id, taskContext, at);
						return { view, rows: scanned - before };
					};
					const initial = await read();
					expect(initial.view).toEqual(await root.context(taskContext));

					// Three new entries: the bounds probe reads one row, the extension the three new ones.
					await write({ kind: "message", model: [user("new")] });
					await write({ kind: "note", data: { text: "display only" } });
					await write({ kind: "message", model: [assistant("answer")] });
					const extended = await read();
					expect(extended.rows).toBe(4);
					expect(extended.view).toEqual(await root.context(taskContext));

					// A newer edit of an older entry applies to the extended range.
					await write({ kind: "edit", edits: [{ target: first.id, action: "omit" }] });
					const edited = await read();
					expect(edited.rows).toBe(2);
					expect(edited.view).toEqual(await root.context(taskContext));
					expect(edited.view.messages.map(describeMessage)).not.toContain("user:first");

					// An earlier cutoff reuses the range.
					const cutoff = await read(extended.view.entries.at(-1)!.id);
					expect(cutoff.rows).toBe(0);
					expect(cutoff.view).toEqual(extended.view);

					// A new head marker changes the range: read it whole.
					await write({ kind: "reset", head: "self", model: [user("fresh")] });
					const reset = await read();
					expect(reset.view).toEqual(await root.context(taskContext));
					expect(reset.view.messages.map(describeMessage)).toEqual(["user:fresh"]);

					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						taskContext,
					);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
			},
		});
		addTask(registry, Reads);
		const id = await harness.commit(
			(tx) => tx.createTask(Reads, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		harness.resume();
		const settled = await harness.waitForTask(id, context);
		expect(settled.state.outcome).toEqual({ status: "completed", result: null });
		await harness.close(context);
	});
});
