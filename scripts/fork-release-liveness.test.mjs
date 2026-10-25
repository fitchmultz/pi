import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { buildSync } from "esbuild";
import { installRelease, pruneReleases } from "./install-fork.mjs";

test("pruning protects JavaScript-only runtimes and fails closed without process inspection", {
	skip: process.platform === "win32" || spawnSync("lsof", ["-v"]).error?.code === "ENOENT",
	timeout: 60_000,
}, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-live-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const releases = join(root, "releases");
	const selector = join(root, "selector");
	const receipt = {
		commit: "a".repeat(40), catalogSha256: "b".repeat(64), archiveSha256: "c".repeat(64),
		node: process.versions.node, platform: process.platform, arch: process.arch,
	};
	const active = await installRelease({ releases, selector, receipt, stage: true }, (directory) => {
		const pkg = join(directory, "node_modules/@earendil-works/pi-coding-agent");
		mkdirSync(join(pkg, "dist/bundle"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
		writeFileSync(join(pkg, "dist/bundle/cli-worker.js"), "");
		buildSync({
			entryPoints: [fileURLToPath(new URL("../packages/coding-agent/src/config.ts", import.meta.url))],
			outfile: join(pkg, "dist/config.js"), bundle: true, platform: "node", format: "esm",
			banner: { js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);' },
		});
	});
	const assets = join(root, "assets");
	mkdirSync(assets);
	writeFileSync(join(assets, "package.json"), "{}");
	const childFile = join(root, "sdk-host.mjs");
	writeFileSync(childFile, `import ${JSON.stringify(pathToFileURL(join(active.packageDir, "dist/config.js")).href)};
process.title = "pi";
process.send("ready");
setInterval(() => {}, 1000);
`);
	const child = spawn(process.execPath, [childFile], {
		env: { ...process.env, PI_PACKAGE_DIR: assets },
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	});
	await Promise.race([
		once(child, "message"),
		once(child, "exit").then(([code]) => { throw new Error(`SDK host exited before readiness: ${code}`); }),
	]);
	const ps = spawnSync("ps", ["-p", String(child.pid), "-ww", "-o", "args="], { encoding: "utf8" });
	assert.equal(ps.status, 0, ps.stderr);
	assert.equal(ps.stdout.includes(active.directory), false);
	const whileRunning = await pruneReleases({ releases, selector, keep: 0 });
	assert.deepEqual(whileRunning.removed, []);
	assert.ok(existsSync(active.directory), "the running SDK host still needs its release");

	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	const withoutInspection = spawnSync(process.execPath, [
		fileURLToPath(new URL("./install-fork.mjs", import.meta.url)),
		"--prune", "--keep", "0", "--releases", releases, "--selector", selector,
	], { env: { ...process.env, PATH: join(root, "no-tools") }, encoding: "utf8" });
	assert.equal(withoutInspection.status, 1, withoutInspection.stderr);
	assert.match(withoutInspection.stderr, /lsof.*ENOENT/s);
	assert.ok(existsSync(active.directory), "failed inspection must not remove releases");
	const afterExit = await pruneReleases({ releases, selector, keep: 0 });
	assert.deepEqual(afterExit.removed, [basename(active.directory)]);
	assert.equal(existsSync(active.directory), false);
});
