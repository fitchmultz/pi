// Counts SQL calls and UTF8 string-binding bytes, plus file WAL growth. Counting overhead is not a latency baseline.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc } from "/pi-performance-source/packages/durable/src/documents.ts";
import { createSession } from "/pi-performance-source/packages/durable/src/session/session.ts";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteValue,
} from "/pi-performance-source/packages/durable/src/storage/sqlite/database.ts";
import { openNodeSqliteDatabase } from "/pi-performance-source/packages/durable/src/storage/sqlite/node.ts";
import { SqliteStorage } from "/pi-performance-source/packages/durable/src/storage/sqlite/storage.ts";
import {
	ROOT_CONVERSATION_ID,
	type TaskId,
	type TaskRecord,
} from "/pi-performance-source/packages/durable/src/types.ts";
import { witness } from "../proof.mjs";

const payloadKiB = Number(process.argv[2] ?? "1");
const writes = Number(process.argv[3] ?? "3");
assert(Number.isSafeInteger(payloadKiB) && payloadKiB >= 0);
assert(Number.isSafeInteger(writes) && writes > 0);
const blob = "x".repeat(payloadKiB * 1024);
const Doc = defineDoc<{ blob: string; count: number }>({
	kind: "probe.large",
	version: 1,
	scope: "session",
	// The delta phases measure ordinary commits, so never checkpoint.
	checkpointWhen: () => false,
	initial: () => ({ blob, count: 0 }),
});
const queries = new Map<string, { calls: number; stringBindingBytes: number }>();
function count(sql: string, params: SqliteValue[]): void {
	const key = sql.replace(/\s+/g, " ").trim();
	const record = queries.get(key) ?? { calls: 0, stringBindingBytes: 0 };
	record.calls++;
	for (const param of params) if (typeof param === "string") record.stringBindingBytes += Buffer.byteLength(param);
	queries.set(key, record);
}
function wrap(executor: SqliteExecutor): SqliteExecutor {
	return {
		exec: (sql) => {
			count(sql, []);
			return executor.exec(sql);
		},
		run: (sql, ...params) => {
			count(sql, params);
			return executor.run(sql, ...params);
		},
		get: <T extends object>(sql: string, ...params: SqliteValue[]) => {
			count(sql, params);
			return executor.get<T>(sql, ...params);
		},
		all: <T extends object>(sql: string, ...params: SqliteValue[]) => {
			count(sql, params);
			return executor.all<T>(sql, ...params);
		},
	};
}
const directory = mkdtempSync(join(tmpdir(), "pi-storage-probe-"));
try {
	const path = join(directory, "session.sqlite");
	const raw = await openNodeSqliteDatabase(path, { walAutoCheckpointPages: 0 });
	const counted: SqliteDatabase = {
		...wrap(raw),
		transaction: (callback) => raw.transaction((tx) => callback(wrap(tx))),
		close: () => raw.close(),
	};
	const storage = await SqliteStorage.open(counted);
	const session = createSession(storage);
	const walBytes = () => {
		try {
			return statSync(`${path}-wal`).size;
		} catch {
			return 0;
		}
	};
	async function phase(label: string, run: () => Promise<void>): Promise<{ calls: number; walGrowthBytes: number }> {
		queries.clear();
		const before = walBytes();
		await run();
		const commands = [...queries].map(([sql, counts]) => ({ sql, ...counts }));
		const calls = commands.reduce((n, row) => n + row.calls, 0);
		const stringBindingBytes = commands.reduce((n, row) => n + row.stringBindingBytes, 0);
		const walGrowthBytes = walBytes() - before;
		console.log(JSON.stringify({ label, payloadKiB, writes, calls, stringBindingBytes, walGrowthBytes, commands }));
		return { calls, walGrowthBytes };
	}
	try {
		await session.commit((tx) => tx.doc(Doc), context);
		await phase("document-delta", async () => {
			for (let i = 0; i < writes; i++)
				await session.commit(async (tx) => {
					(await tx.doc(Doc)).count++;
				}, context);
		});
		const noops = await phase("document-noop", async () => {
			for (let i = 0; i < writes; i++)
				await session.commit(async (tx) => {
					const doc = await tx.doc(Doc);
					const currentCount = doc.count;
					doc.count = currentCount;
				}, context);
		});
		assert.equal(noops.calls, 0);
		assert.equal(noops.walGrowthBytes, 0);
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const id = await storage.mintId<TaskId<null>>();
		const task: TaskRecord<{ blob: string }, { phase: string; count: number }, null> = {
			id,
			conversationId: ROOT_CONVERSATION_ID,
			kind: "probe.large-task",
			version: 1,
			input: { blob },
			state: { status: "pending", checkpoint: { phase: "run", count: 0 } },
			background: false,
			abortRequested: false,
		};
		await storage.commit([{ type: "task", value: task }], context);
		await phase("task-checkpoint-replacement", async () => {
			for (let i = 1; i <= writes; i++)
				await storage.commit(
					[
						{
							type: "task",
							value: {
								...task,
								state: { status: "pending", checkpoint: { phase: "run", count: i } },
							},
						},
					],
					context,
				);
		});
		const finalTask = (await storage.task(id, context))?.state;
		assert.deepEqual(finalTask, { status: "pending", checkpoint: { phase: "run", count: writes } });
		witness("sqlite", { payloadKiB, writes }, finalTask);
	} finally {
		await session.close(context);
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
