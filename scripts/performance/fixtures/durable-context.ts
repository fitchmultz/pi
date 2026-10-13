// Uses a fixed clock so seeding cannot expire the retained contexts. SQLite keeps history out of the JS heap.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "/pi-performance-source/packages/ai/src/models.ts";
import {
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
} from "/pi-performance-source/packages/durable/src/index.ts";
import { openNodeSqliteStorage } from "/pi-performance-source/packages/durable/src/storage/sqlite/node.ts";
import { witness } from "../proof.mjs";

const Touch = defineTask<{ read: boolean }, { phase: "run" }, null>({
	name: "probe.context",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			if (task.input.read) {
				const view = await runtime.context(runtime.conversationId, ctx);
				assert.equal(view.entries.length, 1);
				assert.equal(view.messages.length, 1);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const populations = (process.argv[2] ?? "3").split(",").map(Number);
const samples = Number(process.argv[3] ?? "3");
assert(populations.every((n) => Number.isSafeInteger(n) && n >= 0));
assert(Number.isSafeInteger(samples) && samples > 0);
for (const cycles of populations) {
	for (const retentionMs of [0, 600_000]) {
		const directory = mkdtempSync(join(tmpdir(), "pi-context-probe-"));
		try {
			const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
			let taskReads = 0;
			const readTask = storage.task.bind(storage);
			storage.task = (...args) => {
				taskReads++;
				return readTask(...args);
			};
			const reports: unknown[] = [];
			const registry = createRegistry();
			registry.install(defineExtension({ name: "probe", tasks: [Touch] }));
			const harness = await Harness.open(
				storage,
				{
					models: createModels(),
					registry,
					now: () => 1,
					settings: { contextRetentionMs: retentionMs },
					onReport: (error) => reports.push(error),
				},
				context,
			);
			try {
				const root = await harness.root(context);
				harness.resume();
				globalThis.gc?.();
				const heapBefore = process.memoryUsage().heapUsed;
				const start = performance.now();
				for (let i = 0; i < cycles; i++) {
					const id = await root.commit(async (tx) => {
						const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
						await tx.appendEntry(child.id, {
							kind: "message",
							model: [{ role: "user", content: "seed", timestamp: 1 }],
						});
						return tx.createTask(
							Touch,
							{ read: true },
							{ ownership: { kind: "conversation" }, conversationId: child.id },
						);
					}, context);
					assert.equal((await harness.waitForTask(id, context)).state.outcome.status, "completed");
				}
				const seedMs = performance.now() - start;
				globalThis.gc?.();
				const seededHeapBytes = process.memoryUsage().heapUsed - heapBefore;
				const latencies: number[] = [];
				const beforeReads = taskReads;
				// Warm one root task before recording; no runtime.context() calls here, isolating retention bookkeeping.
				for (let i = 0; i <= samples; i++) {
					const started = performance.now();
					const id = await root.commit(
						(tx) => tx.createTask(Touch, { read: false }, { ownership: { kind: "conversation" } }),
						context,
					);
					assert.equal((await harness.waitForTask(id, context)).state.outcome.status, "completed");
					if (i > 0) latencies.push(performance.now() - started);
				}
				assert.deepEqual(reports, []);
				witness(
					"context",
					{ cycles, retentionMs, samples },
					{ completedSeedTasks: cycles, completedRootTasks: samples + 1, reports },
				);
				latencies.sort((a, b) => a - b);
				const percentile = (p: number) => latencies[Math.min(samples - 1, Math.ceil(samples * p) - 1)];
				console.log(
					JSON.stringify({
						cycles,
						retentionMs,
						samples,
						seedMs,
						seededHeapBytes,
						p50Ms: percentile(0.5),
						p99Ms: percentile(0.99),
						rootTaskReads: taskReads - beforeReads,
					}),
				);
			} finally {
				await harness.close(context);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}
