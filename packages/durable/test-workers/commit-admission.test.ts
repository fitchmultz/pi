import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type CommitOptions,
	createRegistry,
	defineDocFamily,
	defineExtension,
	Harness,
	type Session,
	type Storage,
	StorageCapacityError,
	type Tx,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { expect, it, vi } from "vitest";
import { Reminder } from "./worker.ts";

const context = BACKGROUND_CONTEXT;
const OperationDoc = defineDocFamily<{ input: { type: string; content: string } }, null>({
	kind: "test.operation",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ input: { type: "none", content: "kept" } }),
	checkpointWhen: () => false,
});

for (const scenario of ["Session/Harness", "Conversation", "default", "no capability"] as const) {
	const name =
		scenario === "default" || scenario === "no capability"
			? `keeps actual commit failure fatal with ${scenario}`
			: `refuses an oversized assembled ${scenario} commit without effects`;
	it(name, async () => {
		await runInDurableObject(env.SESSIONS.get(env.SESSIONS.newUniqueId()), async (_instance, state) => {
			// A near-band fixture for pinned workerd, not a Native capacity constant or a copied revision envelope.
			// The complete application document fits; its actual delta revision does not.
			const input = { type: "input", content: "x".repeat(8 * 1024 * 1024 - 24) };
			const raw = JSON.stringify({ input });
			state.storage.sql.exec("CREATE TABLE commit_probe (value TEXT NOT NULL)");
			state.storage.sql.exec("INSERT INTO commit_probe VALUES (?)", raw);
			expect(state.storage.sql.exec("SELECT length(value) AS length FROM commit_probe").toArray()).toEqual([
				{ length: raw.length },
			]);
			state.storage.sql.exec("DROP TABLE commit_probe");

			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("answer")]);
			const models = createModels();
			models.setProvider(faux.provider);
			const registry = createRegistry();
			registry.install(defineExtension({ name: "test", tasks: [Reminder] }));
			const storage: Storage = await openDurableObjectSqliteStorage(state.storage, { prefix: "commit_" });
			if (scenario === "no capability") storage.checkAdmission = undefined;
			const harness = await Harness.open(storage, { models, registry, now: () => 1_000 }, context);
			const session: Session = harness;
			try {
				const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
				await harness.commit((tx) => tx.doc(OperationDoc, "retained", null), context);
				const retained = (await harness.documentState(OperationDoc, "retained", context))!;
				const view = await root.viewState(context);
				try {
					const before = view.value;
					const inspection = await harness.inspect(context);
					const commits = vi.spyOn(storage, "commit");
					const published = vi.fn();
					const closed = vi.fn();
					const unsubscribeCommit = harness.subscribeCommits(published);
					const unsubscribeClose = harness.subscribeClose(closed);
					let calls = 0;
					const options: CommitOptions | undefined = scenario === "default" ? undefined : { admission: true };
					const compose = async (tx: Tx) => {
						calls++;
						const task = await tx.createTask(
							Reminder,
							{ at: 2_000 },
							{
								ownership: { kind: "conversation" },
								...(scenario === "Conversation" ? {} : { conversationId: root.id }),
							},
						);
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
						const entry = await tx.appendEntry(root.id, { kind: "test.marker" });
						const receipt = await tx.createSubmission({
							type: "write",
							conversationId: root.id,
							requestId: "operation",
							status: "done",
							entry: entry.id,
						});
						(await tx.doc(OperationDoc, "retained", null)).input = input;
						await tx.doc(OperationDoc, "created", null);
						return { child, task, entry, receipt };
					};
					const commit = () =>
						scenario === "Conversation"
							? root.commit(compose, context, options)
							: session.commit(compose, context, options);
					const attempt = commit();
					if (scenario === "default" || scenario === "no capability") {
						await expect(attempt).rejects.toThrow("string or blob too big: SQLITE_TOOBIG");
						expect(calls).toBe(1);
						expect(commits).toHaveBeenCalledTimes(1);
						expect(published).not.toHaveBeenCalled();
						expect(await harness.closed).toMatchObject({ reason: "failed" });
						await expect(root.submit({ type: "input", content: "valid" }, context)).rejects.toMatchObject({
							name: "SessionFailed",
						});
						return;
					}
					await expect(attempt).rejects.toBeInstanceOf(StorageCapacityError);
					expect(calls).toBe(1);
					expect(commits).not.toHaveBeenCalled();
					expect(published).not.toHaveBeenCalled();
					expect(closed).not.toHaveBeenCalled();
					expect(retained.value).toEqual({ input: { type: "none", content: "kept" } });
					expect(view.value).toEqual(before);
					expect(await harness.inspect(context)).toEqual(inspection);
					expect(await harness.snapshot(OperationDoc, "created", context)).toBeUndefined();
					const stored = await storage.scanDocuments(
						{ scope: { kind: "session" }, at: "current" },
						10,
						undefined,
						context,
					);
					expect(stored.items).toHaveLength(1);
					expect((await storage.document(stored.items[0]!.id, "current", context))?.value).toEqual({
						input: { type: "none", content: "kept" },
					});
					const records = await harness.commit(
						async (tx) => ({
							conversations: (await tx.scanConversations({}, 10)).items,
							entries: (await tx.scanEntries({ conversationId: root.id }, 10)).items,
							tasks: (await tx.scanTasks({}, 10)).items,
							receipt: await tx.submissionByRequest(root.id, "operation"),
						}),
						context,
					);
					expect(records).toEqual({
						conversations: [{ id: root.id }],
						entries: [],
						tasks: [],
						receipt: undefined,
					});
					unsubscribeCommit();
					unsubscribeClose();
					input.content = "corrected";
					const accepted = await commit();
					expect(calls).toBe(2);
					expect((await harness.getTask(accepted.task, context))?.conversationId).toBe(root.id);
					expect(retained.value).toEqual({ input });
					const valid = await root.submit({ type: "input", content: "valid" }, context);
					expect((await valid.wait(context)).status).toBe("done");
					expect(faux.state.callCount).toBe(1);
				} finally {
					retained.dispose();
					view.dispose();
				}
			} finally {
				await harness.close(context);
			}
			const reopened = await Harness.open(
				await openDurableObjectSqliteStorage(state.storage, { prefix: "commit_" }),
				{ models, registry },
				context,
			);
			try {
				expect(await reopened.snapshot(OperationDoc, "retained", context)).toEqual({ input });
			} finally {
				await reopened.close(context);
			}
		});
	});
}
