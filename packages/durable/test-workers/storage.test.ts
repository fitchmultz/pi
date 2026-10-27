import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare";
import {
	AssistantEntry,
	InboxDoc,
	LiveDoc,
	StorageCapacityError,
	type SubmissionDraft,
} from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { admitSubmission } from "../src/harness/submissions.ts";
import { openDurableObjectSqliteStorage } from "../src/storage/sqlite/cloudflare.ts";
import { applySqliteMigrationsForSchema, createSqliteMigrations } from "../src/storage/sqlite/migrations.ts";
import { createSqliteSchema } from "../src/storage/sqlite/schema.ts";
import type { TestSession } from "./worker.ts";

const context = BACKGROUND_CONTEXT;
const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

let suite = 0;
registerStorageConformance({ describe, expect, it }, "SqliteStorage on Durable Object SQLite in workerd", (use) =>
	runInDurableObject(fresh(), async (_instance, state) => {
		// Tables of their own, next to the ones the object's Harness opened.
		await use(await openDurableObjectSqliteStorage(state.storage, { prefix: `conformance${suite++}_` }));
	}),
);

describe("Durable Object SQLite admission", () => {
	it.each(["input", "write"] as const)(
		"catches an oversized idle %s inside a commit without staging Native effects",
		async (type) => {
			await runInDurableObject(fresh(), async (instance: TestSession, state) => {
				const root = await instance.root();
				const database = new DurableObjectSqliteDatabase(state.storage);
				// This input-only row fits pinned workerd; its complete Native entry exceeds the real SQLite limit.
				const content = "x".repeat(8 * 1024 * 1024 - (type === "input" ? 64 : 0));
				await database.exec("CREATE TABLE input_only (record TEXT NOT NULL)");
				await database.run("INSERT INTO input_only VALUES (?)", JSON.stringify(content));
				expect(await database.get("SELECT length(record) AS length FROM input_only")).toEqual({
					length: content.length + 2,
				});
				await database.exec("DROP TABLE input_only");

				const draft: SubmissionDraft =
					type === "input"
						? { type, content, requestId: "oversized" }
						: { type, entry: { kind: "test.write", head: "self", data: content }, requestId: "oversized" };
				const diagnostic = await root.commit(async (tx) => {
					try {
						await admitSubmission(tx, root.id, draft, instance.now(), {
							steeringMode: "one-at-a-time",
							followUpMode: "one-at-a-time",
						});
					} catch (error) {
						if (!(error instanceof StorageCapacityError)) throw error;
						return tx.appendEntry(root.id, { kind: "test.correction-required" });
					}
					throw new Error("Expected capacity refusal before Native admission");
				}, context);

				expect((await root.entries({}, 10, undefined, context)).items).toEqual([diagnostic]);
				expect(await root.commit((tx) => tx.submissionByRequest(root.id, "oversized"), context)).toBeUndefined();
				expect((await root.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context)).items).toEqual(
					[],
				);
				expect(await instance.harness.snapshot(LiveDoc, root.id, context)).toEqual({});
				expect(await instance.harness.snapshot(InboxDoc, root.id, context)).toEqual({ items: [] });

				instance.script(["accepted"]);
				const valid = await root.submit({ type: "input", content: "valid", requestId: "valid" }, context);
				const settled = await valid.wait(context);
				if (settled.type !== "input" || settled.status !== "done") throw new Error(`Unexpected ${settled.status}`);
				const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				expect(answer?.model?.[0]?.content).toEqual([{ type: "text", text: "accepted" }]);
			});
		},
	);
});

describe("Durable Object SQLite schema", () => {
	it("migrates a version 1 schema to admit sleeping tasks, keeping tasks and indexes", async () => {
		await runInDurableObject(fresh(), async (_instance, state) => {
			const database = new DurableObjectSqliteDatabase(state.storage);
			const schema = createSqliteSchema("legacy_");
			const tasks = schema.tables.tasks;
			const insert = (id: number, status: string) =>
				database.run(
					`INSERT INTO ${tasks} (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, 1, 'test', ?, 0, 0, '{}')`,
					id,
					status,
				);
			// A database written by a version that knew schema version 1 only.
			await applySqliteMigrationsForSchema(database, schema, createSqliteMigrations(schema).slice(0, 1));
			await insert(5, "waiting");
			await expect(insert(6, "sleeping")).rejects.toThrow();

			await openDurableObjectSqliteStorage(state.storage, { prefix: "legacy_" });
			expect(await database.get(`SELECT version FROM ${schema.tables.durableSchema}`)).toEqual({ version: 2 });
			expect(await database.get(`SELECT status FROM ${tasks} WHERE id = 5`)).toEqual({ status: "waiting" });
			await insert(6, "sleeping");
			const indexes = await database.all<{ name: string }>(
				`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`,
				tasks,
			);
			expect(indexes.map(({ name }) => name)).toEqual([
				schema.indexes.tasksByAbortRequested,
				schema.indexes.tasksByBackground,
				schema.indexes.tasksByConversation,
				schema.indexes.tasksByKind,
				schema.indexes.tasksByStatus,
			]);
		});
	});
});
