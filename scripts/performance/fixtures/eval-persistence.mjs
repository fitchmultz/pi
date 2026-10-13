import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { witness } from "../proof.mjs";

const { values } = parseArgs({
	options: {
		repo: { type: "string", default: process.env.PI_PERF_REPO ?? process.cwd() },
		runs: { type: "string", default: "3" },
		warmup: { type: "string", default: "1" },
		pairs: { type: "string", default: "100,1000" },
	},
});
const repo = resolve(values.repo);
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const sizes = values.pairs.split(",").map(Number);
assert.ok(Number.isSafeInteger(runs) && runs > 0 && Number.isSafeInteger(warmup) && warmup >= 0);
assert.ok(sizes.length > 0 && sizes.every((value) => Number.isSafeInteger(value) && value > 0));
const scratch = mkdtempSync(join(tmpdir(), "pi-eval-persistence-"));
const hook = fileURLToPath(new URL("./eval-hook.mjs", import.meta.url));
try {
	for (const pairs of sizes) {
		for (let run = -warmup; run < runs; run++) {
			const statePath = join(scratch, "artifact-directory");
			let artifactDirectory;
			try {
				const startedAt = performance.now();
				const result = spawnSync(
					process.execPath,
					[
						"--import",
						join(repo, "packages/coding-agent/src/experimental/source-resolver.ts"),
						"--import",
						fileURLToPath(new URL("../source-hook.mjs", import.meta.url)),
						"--import",
						hook,
						join(repo, "packages/evals/src/cli.ts"),
						"evals/persistence.docs.eval.ts",
						"--provider",
						"fixture",
						"--model",
						"model",
						"--runs-per-variant",
						String(pairs),
					],
					{
						cwd: repo,
						env: { ...process.env, PI_PERF_REPO: repo, PI_PERFORMANCE_STATE: statePath },
						encoding: "utf8",
						stdio: ["ignore", "ignore", "pipe"],
					},
				);
				const elapsedMs = performance.now() - startedAt;
				const artifactPath = readFileSync(statePath, "utf8");
				assert.ok(artifactPath.startsWith(join(repo, "packages/evals/.eval") + sep));
				artifactDirectory = artifactPath;
				assert.equal(result.error, undefined);
				assert.equal(result.status, 1, result.stderr);
				const observations = readFileSync(join(artifactDirectory, "observations.jsonl"), "utf8");
				const records = observations
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line));
				assert.equal(records.length, pairs * 2);
				assert.ok(records.every((record) => record.outcome === "errored"));
				const report = JSON.parse(readFileSync(join(artifactDirectory, "report.json"), "utf8"));
				assert.equal(report.blockedPairs.length, pairs);
				if (run >= 0) witness("persistence", { pairs }, observations);
				if (run >= 0)
					console.log(
						JSON.stringify({
							mode: "cli-persistence",
							pairs,
							arms: pairs * 2,
							run,
							elapsedMs,
							observationBytes: Buffer.byteLength(observations),
							observationSha256: createHash("sha256").update(observations).digest("hex"),
						}),
					);
			} finally {
				if (artifactDirectory) rmSync(artifactDirectory, { recursive: true, force: true });
			}
		}
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
