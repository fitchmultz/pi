import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDirectory, "..");

function runScript(name, args) {
	return spawnSync(process.execPath, [join(scriptsDirectory, name), ...args], { cwd: repoRoot, encoding: "utf8" });
}

function assertFailsBeforeWork(result, message) {
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, message);
	assert.doesNotMatch(result.stdout, /generate:models|npm run clean/);
}

test("rejects missing option values before doing work", () => {
	assertFailsBeforeWork(runScript("local-release.mjs", ["--out"]), /--out/);
	assertFailsBeforeWork(runScript("pack-packages.mjs", ["--out", "--force"]), /--out/);
	assertFailsBeforeWork(runScript("use-local-packages.mjs", ["--manifest", "--consumer", "target"]), /--manifest/);
});

test("rejects an unsupported package manager before doing work", () => {
	assertFailsBeforeWork(
		runScript("use-local-packages.mjs", ["--manifest", "missing.json", "--consumer", "target", "--package", "example", "--package-manager", "yarn"]),
		/Unsupported package manager: yarn/,
	);
});

test("Nix packing retains selected directory filenames and rejects private or duplicate selections before writing", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-nix-pack-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "source with spaces");
	mkdirSync(join(source, "scripts"), { recursive: true });
	for (const name of ["pack-nix-packages.mjs", "package-artifacts.mjs", "npm-command.mjs", "release-packages.mjs", "package-workspaces.mjs"]) {
		copyFileSync(join(scriptsDirectory, name), join(source, "scripts", name));
	}
	for (const name of ["shared", "target", "private"]) {
		const directory = join(source, "packages", name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({
			name: `@pi-nix-test/${name}`, version: "1.0.0", private: name === "private",
			files: ["index.js"], scripts: { prepack: "node -e \"process.exit(73)\"" },
		}));
		writeFileSync(join(directory, "index.js"), "export {};\n");
	}
	const script = join(source, "scripts", "pack-nix-packages.mjs");
	const out = join(root, "out with spaces");
	const result = spawnSync(process.execPath, [script, out, "target", "shared"], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	assert.deepEqual(readdirSync(out).sort(), ["shared.tgz", "target.tgz"]);
	for (const name of ["shared", "target"]) {
		const manifest = JSON.parse(execFileSync("tar", ["-xOf", join(out, `${name}.tgz`), "package/package.json"], { encoding: "utf8" }));
		assert.equal(manifest.name, `@pi-nix-test/${name}`);
	}
	for (const [names, message] of [[["shared", "private"], /Cannot pack private workspace/], [["shared", "shared"], /Usage:/]]) {
		const rejected = join(root, `rejected-${names.join("-")}`);
		const failure = spawnSync(process.execPath, [script, rejected, ...names], { cwd: root, encoding: "utf8" });
		assert.notEqual(failure.status, 0);
		assert.match(failure.stderr, message);
		assert.equal(existsSync(rejected), false, "invalid selection must not produce partial package files");
	}
});
