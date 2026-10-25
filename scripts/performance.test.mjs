import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./performance/run.mjs", import.meta.url));

function list(group, ...args) {
	const result = spawnSync(process.execPath, [runner, "--list", "--groups", group, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

// fitchmultz/pi#250: keep import latency and route diagnostics under the existing performance owner.
test("extension-imports explicitly owns each workload/runtime case", () => {
	const cases = list("extension-imports");
	assert.equal(cases.length, 12);
	for (const workload of ["esm", "async", "cpu"])
		for (const mode of ["loader", "unbundled", "bundled", "embedded"]) {
			const selected = cases.find((entry) => entry.name === `extension-imports-${workload}-${mode}`);
			assert.equal(selected?.fixture, "extension-imports.mjs");
			assert.deepEqual(selected.args, [workload, mode]);
			assert.deepEqual(selected.env, {});
		}
});

test("diagnostics are separately selected and never silently mixed into import comparisons", () => {
	const cases = list("extension-import-diagnostics");
	assert.equal(cases.length, 6);
	assert.ok(cases.every((entry) => entry.group === "extension-import-diagnostics" && entry.args[2] === "diagnostic"));
	assert.ok(list("extension-imports").every((entry) => !entry.args.includes("diagnostic")));
});

test("smoke checks preserve import workload inputs rather than becoming smaller performance claims", () => {
	assert.deepEqual(list("extension-imports", "--smoke"), list("extension-imports"));
	assert.equal(list("extension-imports-esm-bundled").length, 1);
});
