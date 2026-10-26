import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

test("Node profiles retain and identify managed workers across repeated runs", (t) => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-profile-tooling-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const scripts = join(root, "scripts");
	const packageDir = join(root, "packages", "coding-agent");
	const bundle = join(packageDir, "dist", "bundle");
	const profiles = join(root, "profiles");
	mkdirSync(scripts, { recursive: true });
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), '{"type":"module"}\n');
	copyFileSync(new URL("./profile-coding-agent-node.mjs", import.meta.url), join(scripts, "profile.mjs"));
	writeFileSync(join(bundle, "cli.js"), `
import { runCliLauncher } from ${JSON.stringify(new URL("../packages/coding-agent/src/cli/launcher.ts", import.meta.url).href)};
process.exitCode = await runCliLauncher(process.argv.slice(2), process.argv[1]);
`);
	const worker = `
import { createInterface } from "node:readline";
function workerStartupProbe() {
	// Spend 30ms on-CPU, not 30ms wall clock: V8 samples only while this thread runs, so a preempted wall-clock loop can go unsampled.
	const start = process.threadCpuUsage();
	let used = { user: 0, system: 0 };
	while (used.user + used.system < 30_000) used = process.threadCpuUsage(start);
}
workerStartupProbe();
console.error("--- Startup Timings ---\\n  fixture: 30ms\\n------------------------");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	console.log(JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true }));
});
input.on("close", () => process.disconnect?.());
`;
	writeFileSync(join(bundle, "cli-worker.js"), worker);
	writeFileSync(join(packageDir, "dist", "cli.js"), worker);
	const resolver = new URL("../packages/coding-agent/src/experimental/source-resolver.ts", import.meta.url).href;
	const run = (args) => {
		const result = spawnSync(process.execPath, [
			join(scripts, "profile.mjs"), "--runtime", "node", "--mode", "rpc", "--skip-build",
			"--cpu-profile", "--profile-dir", profiles, "--label", "fixture", ...args,
		], {
			cwd: root,
			env: { ...process.env, NODE_OPTIONS: `--import=${resolver}` },
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /METRIC startup_time_ms=\d+\.\d/);
		assert.match(result.stdout, /METRIC fixture_ms=30\.0/);
		return result.stdout;
	};
	const outputs = [run(["--bundle", "--warmup", "1"]), run(["--bundle"]), run([])];
	const retained = readdirSync(profiles, { recursive: true })
		.filter((file) => file.endsWith(".cpuprofile"))
		.map((file) => {
			const path = join(profiles, file);
			const profile = JSON.parse(readFileSync(path, "utf8"));
			const hasWorkerFrames = profile.nodes.some((node) => node.callFrame.functionName === "workerStartupProbe");
			return { path: relative(root, path).replaceAll("\\", "/"), hasWorkerFrames };
		});
	assert.equal(retained.filter((profile) => profile.hasWorkerFrames).length, 4, "every startup retains its actual worker frames");
	assert.equal(retained.length, 7, "three managed runs retain launcher and worker; unbundled retains its CLI");
	const reported = outputs.flatMap((output) => [...output.matchAll(/^  (launcher|worker|CLI) profile: (.+)$/gm)]);
	assert.equal(new Set(reported.map((match) => match[2])).size, 7, "all retained profiles are reported without stale-path reuse");
	assert.equal(reported.filter(([, role]) => role === "worker").length, 3, "managed workers are identified as workers");
	for (const [, role, path] of reported) {
		const profile = retained.find((profile) => profile.path === path);
		assert.ok(profile, `reported ${role} profile exists: ${path}`);
		assert.equal(profile.hasWorkerFrames, role !== "launcher", `${role} label matches the process actually profiled`);
	}
});
