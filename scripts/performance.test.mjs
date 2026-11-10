import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Nothing else loads the fixtures, so APIs that upstream syncs deleted or changed under them (the assistant frame
// API, Chord v1, Storage.commit) left this command failing unnoticed.
test("the smoke command in docs/performance.md runs every selected case", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-performance-smoke-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const groups = "tools,images,ai,tui,bridges,sessions,durable,env-client,evals,telemetry,background";
	const result = spawnSync(
		process.execPath,
		["scripts/performance/run.mjs", "--repo", root, "--groups", groups, "--smoke", "--out", join(temporary, "out")],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
