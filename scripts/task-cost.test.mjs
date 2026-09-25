import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyzeTasks, readLedger, summarizeRecords } from "./task-cost.mjs";

const usage = { input: 10, output: 4, cacheRead: 80, cacheWrite: 6, totalTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const assistant = (id, extra = {}) => ({ type: "message", id, timestamp: "2026-09-23T01:00:00Z",
	message: { role: "assistant", provider: "openai", model: "test", usage, stopReason: "stop", ...extra } });

async function journal(t, id, entries) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-cost-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "session.jsonl");
	await writeFile(file, [{ type: "session", id }, ...entries].map((entry) => JSON.stringify(entry)).join("\n"));
	return file;
}

test("includes summaries, warming, worker rollups and failed responses; excludes checkpoints", async (t) => {
	const file = await journal(t, "parent", [assistant("ok"), { ...assistant("snapshot"), checkpoint: true }, assistant("failed", { stopReason: "error" }),
		{ type: "compaction", id: "summary", usage }, { type: "usage", id: "warm", kind: "cache_warm", provider: "openai", model: "test", usage },
		{ type: "usage", id: "child", kind: "subagent", contributionId: "subagent:worker:a", provider: "openai", model: "test", usage }]);
	const ledger = await readLedger(file);
	const result = summarizeRecords(ledger.records);
	assert.equal(result.recordedCostUsd.total, 50);
	assert.deepEqual(result.tokens, { input: 50, cacheWrite: 30, cacheRead: 400, output: 20 });
	assert.equal(result.directResponses, 2);
	assert.equal(result.directErrors, 1);
	assert.equal(result.bySource.subagent.recordedCostUsd.total, 10);
	assert.equal(ledger.counts.checkpoints, 1);
});

test("copied history and imported child contributions are counted once in either file order", async (t) => {
	const root = await journal(t, "root", [assistant("a"), { type: "usage", id: "u", kind: "subagent", contributionId: "subagent:worker:b", provider: "openai", model: "test", usage }]);
	const fork = await journal(t, "fork", [assistant("a"), assistant("c")]);
	const worker = await journal(t, "worker", [assistant("b")]);
	const ledgers = await Promise.all([root, fork, worker].map(readLedger));
	for (const order of [ledgers, ledgers.toReversed()]) {
		const result = summarizeRecords(order.flatMap((ledger) => ledger.records));
		assert.equal(result.recordedCostUsd.total, 30);
		assert.equal(result.records, 3);
		assert.equal(result.duplicates, 2);
		assert.equal(result.directResponses, 2);
		assert.equal(result.bySource.subagent.recordedCostUsd.total, 10);
	}
});

test("conflicting contribution amounts fail instead of silently choosing one", async (t) => {
	const file = await journal(t, "root", [
		{ type: "usage", id: "a", kind: "subagent", contributionId: "subagent:worker:b", usage },
		{ type: "usage", id: "c", kind: "subagent", contributionId: "subagent:worker:b", usage: { ...usage, input: 100 } },
	]);
	const ledger = await readLedger(file);
	assert.throws(() => summarizeRecords(ledger.records), /Conflicting usage/);
});

test("cost per completion includes failed task spending and needs independent completion evidence", async (t) => {
	const success = await journal(t, "success", [assistant("a")]);
	const failed = await journal(t, "failed", [assistant("b", { stopReason: "error" })]);
	const manifest = { tasks: [
		{ id: "success", outcome: "completed", evidence: "regression and review passed", sessions: [success], actualBilledUsd: 11, billingEvidence: "invoice A",
			additionalCharges: [{ kind: "search", usd: 1, evidence: "provider usage export" }] },
		{ id: "failed", outcome: "failed", sessions: [failed], actualBilledUsd: 10, billingEvidence: "invoice B" },
	] };
	const result = await analyzeTasks(manifest);
	assert.equal(result.estimatedUsdPerCompletedTask, 21);
	assert.equal(result.actualUsdPerCompletedTask, 21);
	assert.equal(result.measurementComplete, true);
	delete manifest.tasks[0].actualBilledUsd;
	assert.equal((await analyzeTasks(manifest)).actualUsdPerCompletedTask, null);
	delete manifest.tasks[0].evidence;
	await assert.rejects(analyzeTasks(manifest), /needs evidence/);
});

test("descendant supplements require intervening journals and deduplicate nested rollups", async (t) => {
	const root = await journal(t, "root", [{ type: "usage", id: "r", kind: "subagent", contributionId: "subagent:worker:w", provider: "openai", model: "test", usage }]);
	const worker = await journal(t, "worker", [{ type: "usage", id: "w", kind: "subagent", contributionId: "subagent:grandchild:g", provider: "openai", model: "test", usage }]);
	const grandchild = await journal(t, "grandchild", [assistant("g")]);
	const task = { id: "nested", outcome: "unknown", sessions: [root], supplementalSessions: [grandchild] };
	await assert.rejects(analyzeTasks({ tasks: [task] }), /Unlinked supplemental session grandchild/);
	for (const supplementalSessions of [[worker, grandchild], [grandchild, worker]]) {
		const result = await analyzeTasks({ tasks: [{ ...task, supplementalSessions }] });
		assert.equal(result.estimatedTotalUsd, 10);
		assert.equal(result.tasks[0].duplicates, 2);
	}
});

test("the same copied usage cannot be assigned to separate tasks", async (t) => {
	const root = await journal(t, "root", [assistant("a")]);
	const fork = await journal(t, "fork", [assistant("a")]);
	await assert.rejects(analyzeTasks({ tasks: [
		{ id: "one", outcome: "unknown", sessions: [root] },
		{ id: "two", outcome: "unknown", sessions: [fork] },
	] }), /Usage shared by tasks/);
});

test("usage without a stable journal ID rejects instead of collapsing legacy records", async (t) => {
	const entry = assistant("a");
	delete entry.id;
	const file = await journal(t, "legacy", [entry, entry]);
	await assert.rejects(readLedger(file), /Missing usage entry ID/);
});

test("unknown outcomes and malformed lines remain visible measurement gaps", async (t) => {
	const file = await journal(t, "root", [assistant("a")]);
	await writeFile(file, "\n{partial", { flag: "a" });
	const result = await analyzeTasks({ tasks: [{ id: "unfinished", outcome: "unknown", sessions: [file] }] });
	assert.equal(result.estimatedUsdPerCompletedTask, null);
	assert.equal(result.actualUsdPerCompletedTask, null);
	assert.equal(result.measurementComplete, false);
	assert.equal(result.tasks[0].journal.malformedLines, 1);
});
