import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import test from "node:test";
import { produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

test("artifact packing uses resolved Node/npm, isolated environment and array or keyed-object npm JSON", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-artifact-packing-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repoRoot = join(root, "source");
	const home = join(root, "isolated-home");
	mkdirSync(home);
	const node = realpathSync(process.execPath);
	const npmCli = realpathSync(join(dirname(node),
		process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "../lib/node_modules/npm/bin/npm-cli.js"));
	const globalConfig = join(root, "npm-globalconfig");
	writeFileSync(globalConfig, "");
	const env = {
		PATH: `${dirname(node)}${delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home,
		npm_config_globalconfig: globalConfig,
		...(process.platform === "android" ? { PREFIX: process.env.PREFIX, LD_PRELOAD: process.env.LD_PRELOAD } : {}),
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	const name = "@pi-package-test/target";
	writePackage(join(repoRoot, "packages/target"), { name, version: "1.0.0" }, { "index.js": "export {};" });
	const observed = join(root, "packing-env.json");
	const npm = join(root, "npm-observer.cjs");
	writeFileSync(npm, `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ node: process.execPath, env: process.env }));
const result = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...process.argv.slice(2)], {
  env: process.env, encoding: "utf8"
});
if (result.status !== 0) { console.error(result.stderr); process.exit(result.status ?? 1); }
const parsed = JSON.parse(result.stdout);
const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
console.log(JSON.stringify(process.env.PACK_JSON === "array" ? entries : Object.fromEntries(entries.map(entry => [entry.name, entry]))));
`);
	const inherited = { HOME: process.env.HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, NODE_OPTIONS: process.env.NODE_OPTIONS };
	const preload = join(root, "ambient-preload.cjs");
	const leaked = join(root, "preload-ran");
	writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(leaked)}, "leaked");`);
	try {
		process.env.HOME = join(root, "ambient-home");
		process.env.ANTHROPIC_API_KEY = "synthetic-secret";
		process.env.NODE_OPTIONS = `--require ${preload}`;
		for (const format of ["array", "object"]) {
			const artifactSet = produceArtifactSet({
				repoRoot, outDir: join(root, `artifacts-${format}`), build: false, source: null,
				npmOptions: { node, npm, env: { ...env, PACK_JSON: format } },
			});
			assert.ok(existsSync(artifactSet.getPackage(name).tarballPath));
			const result = JSON.parse(readFileSync(observed, "utf8"));
			assert.equal(result.node, node);
			assert.equal(result.env.HOME, home);
			assert.equal(result.env.ANTHROPIC_API_KEY, undefined);
			assert.equal(result.env.NODE_OPTIONS, undefined);
			assert.equal(result.env.npm_config_globalconfig, globalConfig);
			assert.equal(existsSync(leaked), false);
		}
	} finally {
		for (const [name, value] of Object.entries(inherited)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("produces a verified, content-addressed artifact set", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo with spaces");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{ name: "@pi-package-test/shared", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const marker = "artifact";\n' },
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{ name: "@pi-package-test/target", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const target = true;\n' },
	);
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });

	const artifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "package set"), repoRoot });
	assert.deepEqual(artifactSet.packages.map((pkg) => pkg.name), ["@pi-package-test/shared", "@pi-package-test/target"]);
	for (const pkg of artifactSet.packages) {
		assert.match(pkg.tarball, /-[0-9a-f]{12}\.tgz$/);
		assert.match(pkg.integrity, /^sha512-/);
	}
	assert.equal(artifactSet.source.dirty, false);
	assert.equal(readArtifactSet(artifactSet.manifestPath).packages.length, 2);

	writeFileSync(join(repoRoot, "packages/shared/dist/index.js"), 'export const marker = "changed";\n');
	const changedArtifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "changed package set"), repoRoot });
	assert.notEqual(
		changedArtifactSet.getPackage("@pi-package-test/shared").tarball,
		artifactSet.getPackage("@pi-package-test/shared").tarball,
	);

	appendFileSync(artifactSet.packages[0].tarballPath, "corrupt");
	assert.throws(() => readArtifactSet(artifactSet.manifestPath), /integrity mismatch/);
	const packageJsonPath = join(repoRoot, "packages", "shared", "package.json");
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: join(repoRoot, "packages", "shared"), repoRoot }),
		/Repository-local output directory must be inside.*\.artifacts/,
	);
	assert.equal(existsSync(packageJsonPath), true);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: repoRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: temporaryRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: parse(repoRoot).root, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
});
