import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("workspace root and subpath imports compile through a case-aliased checkout", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-workspace-build-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const root = join(realpathSync.native(temporary), "mixed");
	const alias = join(realpathSync.native(temporary), "MiXeD");
	await mkdir(root);
	if (!existsSync(alias)) {
		t.skip("requires a case-insensitive filesystem");
		return;
	}
	const files = {
		"tsconfig.base.json": await readFile(join(repo, "tsconfig.base.json"), "utf8"),
		// Copied verbatim: tsconfig files may contain comments.
		"packages/durable/tsconfig.build.json": await readFile(join(repo, "packages/durable/tsconfig.build.json"), "utf8"),
		// The fixture exercises workspace resolution, without unrelated ambient Node types or declaration files.
		"packages/durable/tsconfig.fixture.json": JSON.stringify({
			extends: "./tsconfig.build.json",
			files: [],
			compilerOptions: { types: [] },
		}),
		"packages/durable/package.json": JSON.stringify({ type: "module" }),
		"packages/durable/src/index.ts": `
import type { Delta } from "@earendil-works/chord";
import type { Delta as SubpathDelta } from "@earendil-works/chord/delta";
export const identity = (delta: Delta): SubpathDelta => delta;
`,
		"packages/chord/package.json": JSON.stringify({
			name: "@earendil-works/chord",
			version: "1.0.0",
			type: "module",
			exports: { ".": "./dist/index.d.ts", "./delta": "./dist/delta/index.d.ts" },
		}),
		"packages/chord/dist/index.d.ts": 'export type { Delta } from "./delta/index.js";\n',
		"packages/chord/dist/delta/index.d.ts": "export interface Delta { value: string; }\n",
	};
	for (const [path, content] of Object.entries(files)) {
		const fullPath = join(root, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content);
	}
	await mkdir(join(root, "node_modules/@earendil-works"), { recursive: true });
	await symlink("../../packages/chord", join(root, "node_modules/@earendil-works/chord"));
	const result = spawnSync(process.execPath, [
		join(repo, "node_modules/typescript/bin/tsc"),
		"--noEmit",
		"--project",
		join(alias, "packages/durable/tsconfig.fixture.json"),
	], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

async function createBuildFixture(t) {
	const temporary = await mkdtemp(join(tmpdir(), "pi-build-scheduler-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const root = join(realpathSync.native(temporary), "repo with spaces");
	await mkdir(join(root, "scripts"), { recursive: true });
	await writeFile(join(root, "scripts/build.mjs"), await readFile(join(repo, "scripts/build.mjs"), "utf8"));
	const packages = getPublicWorkspacePackages(join(repo, "packages"));
	const directories = {};
	for (const pkg of packages) {
		const name = basename(pkg.directory);
		directories[pkg.name] = name;
		await mkdir(join(root, "packages", name), { recursive: true });
		await writeFile(join(root, "packages", name, "package.json"), await readFile(join(pkg.directory, "package.json"), "utf8"));
	}
	const bin = join(root, "bin");
	await mkdir(bin);
	const npmSource = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
const name = path.basename(cwd);
const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
const directories = JSON.parse(process.env.BUILD_PACKAGE_DIRS);
const record = phase => fs.appendFileSync(process.env.BUILD_EVENTS, JSON.stringify({ phase, name, cwd, pwd: process.env.PWD, args: process.argv.slice(2) }) + "\\n");
for (const dependency of Object.keys(pkg.dependencies || {})) {
  if (directories[dependency] && !fs.existsSync(path.join(cwd, "..", directories[dependency], "finished"))) {
    console.error("Missing built dependency: " + dependency); process.exit(92);
  }
}
record("start");
setTimeout(() => {
  if (process.env.FAIL_PACKAGE === name) { record("failed"); process.exit(17); }
  fs.writeFileSync(path.join(cwd, "finished"), "");
  record("finish");
}, process.env.FAIL_PACKAGE ? (process.env.FAIL_PACKAGE === name ? 10 : 200) : 40);
`;
	await writeFile(join(bin, process.platform === "win32" ? "npm.cjs" : "npm"), npmSource, { mode: 0o755 });
	if (process.platform === "win32") {
		await writeFile(join(bin, "npm.cmd"), `@echo off\r\n"${process.execPath}" "${join(bin, "npm.cjs")}" %*\r\n`);
	}
	const events = join(root, "events.jsonl");
	return { root, events, packages, env: { ...process.env,
		PATH: `${bin}${delimiter}${process.env.PATH}`, PWD: temporary,
		BUILD_EVENTS: events, BUILD_PACKAGE_DIRS: JSON.stringify(directories),
	} };
}

test("builds every runtime package after its dependencies with bounded overlap, native PWD and AI model-data mode", async (t) => {
	for (const offline of [false, true]) {
		const fixture = await createBuildFixture(t);
		const result = spawnSync(process.execPath, [join(fixture.root, "scripts/build.mjs"), ...(offline ? ["--offline"] : [])], {
			cwd: fixture.root, env: fixture.env, encoding: "utf8",
		});
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
		const events = (await readFile(fixture.events, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const starts = events.filter((event) => event.phase === "start");
		assert.deepEqual(starts.map((event) => event.name).sort(), fixture.packages.map((pkg) => basename(pkg.directory)).sort());
		let active = 0;
		let peak = 0;
		for (const event of events) {
			assert.equal(event.pwd, event.cwd);
			assert.deepEqual(event.args, ["run", event.name === "ai" && offline ? "build:offline" : "build"]);
			active += event.phase === "start" ? 1 : -1;
			peak = Math.max(peak, active);
		}
		assert.equal(active, 0, "all owned builds must finish");
		assert.equal(peak, 2, "overlap independent builds without exceeding two active children");
	}
});

test("returns the failed build status after draining owned children without starting dependents", async (t) => {
	const fixture = await createBuildFixture(t);
	const result = spawnSync(process.execPath, [join(fixture.root, "scripts/build.mjs"), "--offline"], {
		cwd: fixture.root, env: { ...fixture.env, FAIL_PACKAGE: "chord" }, encoding: "utf8",
	});
	assert.equal(result.status, 17, `${result.stdout}${result.stderr}`);
	const events = (await readFile(fixture.events, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(events.filter((event) => event.phase === "start").map((event) => event.name).sort(), ["chord", "tui"]);
	assert.ok(events.some((event) => event.name === "chord" && event.phase === "failed"));
	assert.ok(events.some((event) => event.name === "tui" && event.phase === "finish"), "the remaining child must finish before the root returns");
});
