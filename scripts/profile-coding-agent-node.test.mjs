import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseStartupTimings, runRpcBenchmarkRun, runTuiBenchmarkRun } from "./profile-coding-agent-node.mjs";

const groups = `--- Startup Timings: main ---
  interactiveMode.init: 120.5ms
  TOTAL: 180.7ms
-----------------------------
  outside: 999ms
--- Startup Timings: extensions ---
  load:fixture: 50.2ms
  TOTAL: 50.2ms
-----------------------------------
`;

test("keeps both timing namespaces, decimal spans and separate totals", () => {
	assert.deepEqual([...parseStartupTimings(groups)], [
		["main.interactiveMode.init", 120.5], ["main.TOTAL", 180.7],
		["extensions.load:fixture", 50.2], ["extensions.TOTAL", 50.2],
	]);
});

function fixture(t, mode) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-profiler-test-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const entry = join(root, "launcher.mjs");
	const worker = join(root, "worker.mjs");
	writeFileSync(entry, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [...process.execArgv, ${JSON.stringify(worker)}, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code; });
`);
	const params = { runtime: "node", runIndex: 0, measuredIndex: 1, profileDir: root,
		options: { mode, entry, cwd: root, isolatedAgentDir: true, offline: true, cpuProfile: true, label: "test" } };
	return { root, worker, params };
}

test("TUI measures the ready marker before shutdown and preserves launcher/worker profiles", async (t) => {
	const { worker, params } = fixture(t, "tui");
	writeFileSync(worker, `
process.stderr.write('PI_STARTUP_');
setTimeout(() => {
	process.stderr.write('READY\\n');
	setTimeout(() => process.stderr.write(${JSON.stringify(groups)}), 180);
}, 30);
`);
	const result = await runTuiBenchmarkRun(params);
	assert.ok(result.elapsedMs > 0);
	assert.ok(result.exitElapsedMs - result.elapsedMs >= 150, JSON.stringify(result));
	assert.equal(result.profilePaths.length, 2);
	for (const path of result.profilePaths) assert.ok(JSON.parse(readFileSync(path, "utf8")).nodes.length > 0);
	assert.deepEqual(result.timings, parseStartupTimings(groups));
	const again = await runTuiBenchmarkRun(params);
	assert.ok(again.profilePaths.every(path => !result.profilePaths.includes(path)), "repeat invocations must not overwrite profiles");
});

test("TUI rejects an older target without a readiness marker instead of calling exit time startup", async (t) => {
	const { worker, params } = fixture(t, "tui");
	params.options.cpuProfile = false;
	writeFileSync(worker, `process.stderr.write(${JSON.stringify(groups)});`);
	await assert.rejects(runTuiBenchmarkRun(params), /did not report PI_STARTUP_READY/);
});

test("RPC reports get_state readiness, exit, target, cwd and effective offline settings", async (t) => {
	const { root, worker, params } = fixture(t, "rpc");
	writeFileSync(worker, `import assert from 'node:assert/strict';
assert.equal(process.cwd(), ${JSON.stringify(root)});
assert.equal(process.env.PI_OFFLINE, '1');
assert.equal(process.env.PI_STARTUP_BENCHMARK, undefined);
process.stdin.once('data', chunk => {
	const { id } = JSON.parse(chunk);
	process.stdout.write(JSON.stringify({ type: 'response', id, command: 'get_state', success: true }) + '\\n');
});
process.stdin.on('end', () => setTimeout(() => process.stderr.write(${JSON.stringify(groups)}), 180));
`);
	const result = await runRpcBenchmarkRun(params);
	assert.ok(result.exitElapsedMs - result.elapsedMs >= 150);
	assert.equal(result.profilePaths.length, 2);
	assert.deepEqual(result.timings, parseStartupTimings(groups));
	const output = execFileSync(process.execPath, [fileURLToPath(new URL("./profile-coding-agent-node.mjs", import.meta.url)),
		"--mode", "rpc", "--entry", params.options.entry, "--cwd", root, "--isolated-agent-dir", "--profile-dir", root],
		{ encoding: "utf8", env: { ...process.env, PI_STARTUP_BENCHMARK: "1" } });
	assert.ok(output.includes(`Target: ${params.options.entry}`));
	assert.ok(output.includes(`Cwd: ${root}`));
	assert.ok(output.includes("PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1"));
	assert.ok(output.includes("Readiness: successful get_state response"));
	assert.ok(output.includes("process-to-ready:"));
	assert.ok(output.includes("process-to-exit:"));
	assert.ok(output.includes("METRIC main_TOTAL_ms=180.7"));
	assert.ok(output.includes("METRIC extensions_TOTAL_ms=50.2"));
});
