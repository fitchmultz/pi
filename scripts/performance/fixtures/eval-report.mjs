import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
	PI_SESSION_SNAPSHOT_ARTIFACT,
	readTaskObservation,
	summarizeEvalObservations,
} from "/pi-performance-source/packages/evals/src/report.ts";
import { witness } from "../proof.mjs";

const { values } = parseArgs({
	options: {
		runs: { type: "string", default: "3" },
		sizes: { type: "string", default: "100,1000,10000" },
		"report-mib": { type: "string", default: "0,1,10" },
	},
});
const runs = Number(values.runs);
const sizes = values.sizes.split(",").map(Number);
const reportSizes = values["report-mib"].split(",").map(Number);
if (
	!Number.isSafeInteger(runs) ||
	runs < 1 ||
	[...sizes, ...reportSizes].some((value) => !Number.isSafeInteger(value) || value < 0)
)
	throw new Error("Invalid workload");
for (const pairs of sizes) {
	const expected = [];
	const observations = [];
	for (let i = 0; i < pairs; i++) {
		for (const variant of ["without_docs", "with_docs"]) {
			const identity = { evalSet: "scaling", caseId: `case-${i}`, variant, model: "fixture/model", runNumber: 1 };
			expected.push(identity);
			observations.push({
				...identity,
				outcome: "scored",
				score: 1,
				totalTokens: 100,
				toolCalls: 2,
				totalMs: 3,
				estimatedCostUsd: 0.01,
			});
		}
	}
	for (let run = 0; run < runs; run++) {
		const startedAt = performance.now();
		const report = summarizeEvalObservations("benchmark", expected, observations);
		const elapsedMs = performance.now() - startedAt;
		assert.equal(report.blockedPairs.length, 0);
		if (pairs) {
			assert.equal(report.comparisons[0].eligiblePairs, pairs);
			assert.equal(report.comparisons[0].lift, 0);
			assert.equal(report.operationalTotals[0].totalTokens.total, pairs * 100);
		}
		witness("summary", { pairs, expected, observations }, report);
		console.log(JSON.stringify({ mode: "summary", pairs, run, elapsedMs }));
	}
}
const root = mkdtempSync(join(tmpdir(), "pi-eval-report-"));
try {
	const task = {
		evalSet: "fixture",
		caseId: "large-session",
		variant: "without_docs",
		model: "fixture/model",
		runNumber: 1,
		file: "fixture.docs.eval.ts",
		fullName: "fixture > large-session",
	};
	for (const mib of reportSizes) {
		const session = `${JSON.stringify({ type: "session", payload: "x".repeat(mib * 1024 * 1024) })}\n`;
		const path = join(root, "vitest.json");
		writeFileSync(
			path,
			JSON.stringify({
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				numTodoTests: 0,
				numTotalTests: 1,
				startTime: 0,
				success: true,
				testResults: [
					{
						message: "",
						name: task.file,
						status: "passed",
						assertionResults: [
							{
								ancestorTitles: [task.evalSet],
								fullName: "fixture large-session",
								status: "passed",
								title: task.caseId,
								failureMessages: [],
								meta: {
									eval: { avgScore: 1, scores: [{ name: "fixture", score: 1 }], thresholdFailed: false },
									harness: {
										name: "without_docs",
										run: {
											output: "ok",
											session: { events: [] },
											usage: { provider: "fixture", model: "model", totalTokens: 100 },
											timings: { totalMs: 3 },
											artifacts: { [PI_SESSION_SNAPSHOT_ARTIFACT]: session },
											errors: [],
										},
									},
								},
							},
						],
					},
				],
			}),
		);
		for (let run = 0; run < runs; run++) {
			const startedAt = performance.now();
			const observation = await readTaskObservation(task, path, root);
			const elapsedMs = performance.now() - startedAt;
			assert.equal(observation.outcome, "scored");
			assert.equal(observation.totalTokens, 100);
			witness("read", { mib, task }, observation);
			console.log(JSON.stringify({ mode: "read", sessionMiB: mib, run, elapsedMs }));
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
