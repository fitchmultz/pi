import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MINIMUM_PI_VERSION } from "./model-catalog-minimum-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(repoRoot, "scripts/check-model-catalog-compat.mjs");

// Keep registry and git transport offline; exercise the CLI, real tar extraction,
// release-catalog merging, hydration and the actual TypeScript compiler.
test("catalog compatibility CLI accepts both npm pack formats and rejects unsupported release APIs", { skip: process.platform === "win32" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-catalog-compat-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const source = join(root, "source");
	const release = join(source, "release");
	const builtins = join(root, "package/dist/providers/data");
	mkdirSync(bin);
	mkdirSync(join(release, "packages/ai/scripts"), { recursive: true });
	mkdirSync(builtins, { recursive: true });
	writeFileSync(join(release, "package.json"), '{"type":"module"}');
	writeFileSync(join(release, "packages/ai/package.json"), '{"dependencies":{}}');
	writeFileSync(join(release, "packages/ai/tsconfig.build.json"), JSON.stringify({
		compilerOptions: { types: [], skipLibCheck: true }, files: ["models.ts"],
	}));
	writeFileSync(join(release, "packages/ai/scripts/hydrate-model-catalog.ts"), `import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
copyFileSync(process.argv[2], process.env.OBSERVED_MERGED);
const models = JSON.parse(readFileSync(process.argv[2], "utf8"));
writeFileSync("packages/ai/models.ts", "export const models = " + JSON.stringify(models) + ' satisfies Record<string, { type: "chat"; id: string; api: "supported" }[]>;');
`);
	const builtin = { type: "chat", id: "model-a", api: "supported" };
	const retained = { ...builtin, id: "retained" };
	writeFileSync(join(builtins, "fixture.json"), JSON.stringify({ chat: { "model-a": builtin, retained } }));
	execFileSync("tar", ["cf", join(root, "release.tar"), "-C", source, "release"]);
	execFileSync("tar", ["czf", join(root, "models.tgz"), "-C", root, "package"]);
	const npm = join(bin, "npm");
	writeFileSync(npm, `#!${process.execPath}
const { copyFileSync, mkdirSync, symlinkSync } = require("node:fs");
const { join } = require("node:path");
const [command, ...args] = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
if (command === "view") console.log(${JSON.stringify(MINIMUM_PI_VERSION)});
else if (command === "pack") {
  const filename = "models.tgz";
  copyFileSync(join(root, filename), join(args[args.indexOf("--pack-destination") + 1], filename));
  const packed = { name: "@earendil-works/pi-ai", filename: process.env.UNSAFE_PACK ? "../models.tgz" : filename, files: [] };
  console.log(JSON.stringify(process.env.PACK_FORMAT === "array" ? [packed] : { [packed.name]: packed }));
} else if (command === "ci") {
  mkdirSync("node_modules", { recursive: true });
  symlinkSync(${JSON.stringify(join(repoRoot, "node_modules/typescript"))}, "node_modules/typescript", "dir");
} else throw new Error("Unexpected npm command: " + command);
`);
	const git = join(bin, "git");
	writeFileSync(git, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "archive") throw new Error("Unexpected git command");
require("node:fs").copyFileSync(require("node:path").join(process.env.FIXTURE_ROOT, "release.tar"), args[args.indexOf("--output") + 1]);
`);
	chmodSync(npm, 0o755);
	chmodSync(git, 0o755);
	const catalog = join(root, "catalog.json");
	const observed = join(root, "merged.json");
	const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_ROOT: root, OBSERVED_MERGED: observed };
	for (const format of ["array", "object"]) {
		for (const api of ["supported", "unsupported"]) {
			const replacement = { ...builtin, api };
			writeFileSync(catalog, JSON.stringify({ fixture: [replacement], unshipped: [replacement] }));
			const result = spawnSync(process.execPath, [checker, "--catalog", catalog], {
				cwd: repoRoot, env: { ...env, PACK_FORMAT: format }, encoding: "utf8",
			});
			assert.ifError(result.error);
			assert.equal(result.status, api === "supported" ? 0 : 1, result.stderr);
			assert.deepEqual(JSON.parse(readFileSync(observed, "utf8")), { fixture: [replacement, retained] });
			if (api === "supported") assert.ok(result.stdout.includes(`catalog is compatible with pi ${MINIMUM_PI_VERSION}`));
			else {
				assert.match(result.stderr, /Type '"unsupported"' is not assignable to type '"supported"'/);
				assert.match(result.stderr, /set MINIMUM_PI_VERSION/);
			}
		}
	}
	const unsafe = spawnSync(process.execPath, [checker, "--catalog", catalog], {
		cwd: repoRoot, env: { ...env, UNSAFE_PACK: "1" }, encoding: "utf8",
	});
	assert.equal(unsafe.status, 1);
	assert.match(unsafe.stderr, /npm pack returned an unexpected result/);
	const help = spawnSync(process.execPath, [checker, "--help"], { cwd: repoRoot, env, encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /Usage:.*check-model-catalog-compat/);
	assert.match(help.stdout, /--catalog/);
});
