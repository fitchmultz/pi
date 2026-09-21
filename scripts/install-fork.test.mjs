import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
	readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";
import { activateRelease, installRelease, isolatedEnvironment, main, releaseIdentity, resolveBuildTools } from "./install-fork.mjs";

const name = "@earendil-works/pi-coding-agent";
const tools = resolveBuildTools();

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-selector-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const env = isolatedEnvironment(home, tools);
	const selector = join(root, "npm-global/lib/node_modules", name);
	const oldPackage = join(root, "old-release");
	mkdirSync(oldPackage);
	writeFileSync(join(oldPackage, "untouched"), "previous runtime");
	mkdirSync(dirname(selector), { recursive: true });
	symlinkSync(oldPackage, selector);
	for (const filename of ["settings.json", "auth.json", "sessions/real.jsonl"]) {
		const path = join(home, ".pi/agent", filename);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `preserve ${filename}`);
	}
	return { root, env, selector, oldPackage, releases: join(root, "releases") };
}

function receipt(commit = "a", catalog = "b") {
	return {
		commit: commit.repeat(40), catalogSha256: catalog.repeat(64), archiveSha256: "c".repeat(64),
		node: process.versions.node, npm: tools.npmVersion, platform: process.platform, arch: process.arch,
	};
}

function packages(f, { brokenCli = false } = {}) {
	const packages = [name, "@earendil-works/chord"].map((name) => ({ name, directory: join(f.root, "packages", name) }));
	for (const pkg of packages) {
		const coding = pkg.name === name;
		const files = {
			"package.json": JSON.stringify({
				name: pkg.name, version: "1.0.0", type: "module", exports: "./dist/index.js",
				...(coding ? { dependencies: { "@earendil-works/chord": "1.0.0" }, bin: { pi: "dist/bundle/cli.js" } } : {}),
			}),
			"dist/index.js": coding ? `
import { identity } from "@earendil-works/chord";
if (identity !== "fixture fork") throw new Error("Resolved public package instead of local fork");
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
` : 'export const identity = "fixture fork";',
			...(coding ? {
				"dist/cli.js": brokenCli ? "process.exit(19);" : 'console.log("1.0.0");',
				"dist/bundle/cli.js": brokenCli ? "process.exit(19);" : 'console.log("1.0.0");',
				"dist/bundle/cli-worker.js": "// Native worker fixture\n",
			} : {}),
		};
		for (const [filename, content] of Object.entries(files)) {
			mkdirSync(dirname(join(pkg.directory, filename)), { recursive: true });
			writeFileSync(join(pkg.directory, filename), content);
		}
	}
	return packages;
}

function installFixture(f, options) {
	const pkgs = packages(f, options);
	return (directory) => {
		const tarballs = packReleasePackages(pkgs, join(directory, "tarballs"), { npm: tools.npm, env: f.env });
		installCodingAgentConsumer(directory, tarballs, tools.npm, { env: f.env });
		smokeTestCodingAgentConsumer(directory, tools.node, { path: tools.path });
	};
}

function assertPreserved(f) {
	assert.equal(readlinkSync(f.selector), f.oldPackage);
	assert.equal(readFileSync(join(f.oldPackage, "untouched"), "utf8"), "previous runtime");
	for (const filename of ["settings.json", "auth.json", "sessions/real.jsonl"]) {
		assert.equal(readFileSync(join(f.env.HOME, ".pi/agent", filename), "utf8"), `preserve ${filename}`);
	}
}

test("stages real npm artifacts, selects atomically, reuses without rebuilding, and rolls back", async (t) => {
	const f = fixture(t);
	const first = await installRelease({ ...f, receipt: receipt(), stage: true }, installFixture(f));
	assertPreserved(f);
	assert.equal(first.changed, false);
	assert.equal(first.reused, false);
	assert.equal(lstatSync(first.packageDir).isSymbolicLink(), false);
	const before = readFileSync(join(first.directory, "fork-release.json"));
	const inode = lstatSync(first.packageDir).ino;
	const active = await installRelease({ ...f, receipt: receipt() }, () => assert.fail("A verified release must not be rebuilt"));
	assert.equal(active.reused, true);
	assert.equal(readlinkSync(f.selector), first.packageDir);
	assert.equal(readlinkSync(`${f.selector}.previous`), f.oldPackage);
	assert.deepEqual(readFileSync(join(first.directory, "fork-release.json")), before);
	assert.equal(lstatSync(first.packageDir).ino, inode);
	const selectorInode = lstatSync(f.selector).ino;
	assert.equal(activateRelease(f.releases, releaseIdentity(receipt()), f.selector).changed, false);
	assert.equal(lstatSync(f.selector).ino, selectorInode);

	const second = await installRelease({ ...f, receipt: receipt("d") }, installFixture(f));
	assert.equal(readlinkSync(f.selector), second.packageDir);
	assert.equal(readlinkSync(`${f.selector}.previous`), first.packageDir);
	await main(["--rollback", releaseIdentity(receipt()), "--releases", f.releases, "--selector", f.selector]);
	assert.equal(readlinkSync(f.selector), first.packageDir);
	assert.deepEqual(readFileSync(join(first.directory, "fork-release.json")), before);
	assert.ok(existsSync(second.packageDir));
});

test("rejects a CI archive for another commit before building or changing the selector", async (t) => {
	const f = fixture(t);
	const archive = join(f.root, "source.tar.gz");
	writeFileSync(archive, "must not be extracted");
	writeFileSync(join(f.root, "source.commit"), `${"0".repeat(40)}\n`);
	await assert.rejects(main(["--ref", "HEAD", "--source-archive", archive,
		"--releases", f.releases, "--selector", f.selector]), /Source archive commit .* does not match selected commit/);
	assertPreserved(f);
	assert.equal(existsSync(f.releases), false);
});

test("rejects changed or extra archive source despite a matching companion commit", async (t) => {
	const f = fixture(t);
	const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	const commit = git(["rev-parse", "HEAD"]);
	const version = JSON.parse(git(["show", `${commit}:packages/coding-agent/package.json`])).version;
	const archive = join(f.root, "source.tar.gz");
	git(["archive", "--format=tar.gz", `--prefix=pi-${version}/`, "--output", archive, commit]);
	execFileSync("tar", ["-xzf", archive, "-C", f.root]);
	writeFileSync(join(f.root, "source.commit"), `${commit}\n`);
	const source = join(f.root, `pi-${version}`);
	const file = join(source, "package.json");
	const original = readFileSync(file);
	const inputs = ["--ref", commit, "--source-archive", archive, "--releases", f.releases, "--selector", f.selector];
	for (const change of ["tracked", "extra"]) {
		if (change === "tracked") writeFileSync(file, `${original}\n`);
		else {
			writeFileSync(file, original);
			writeFileSync(join(source, "extra-source.mjs"), "export const unexpected = true;\n");
		}
		execFileSync("tar", ["-czf", archive, "-C", f.root, `pi-${version}`]);
		await assert.rejects(main(inputs), /Source archive differs from selected commit/);
		assertPreserved(f);
		assert.equal(existsSync(f.releases), false);
	}
});

test("a real child build failure cannot select or leave a reusable success receipt", async (t) => {
	const f = fixture(t);
	await assert.rejects(installRelease({ ...f, receipt: receipt() }, (directory) => {
		execFileSync(tools.node, ["-e", "process.exit(23)"], { cwd: directory, env: f.env });
	}), /Command failed/);
	assertPreserved(f);
	assert.deepEqual(readdirSync(f.releases), []);
});

test("a real npm install failure leaves the selector unchanged", async (t) => {
	const f = fixture(t);
	await assert.rejects(installRelease({ ...f, receipt: receipt() }, (directory) => {
		const tarball = join(directory, "broken.tgz");
		writeFileSync(tarball, "not an npm tarball");
		installCodingAgentConsumer(directory, new Map([[name, tarball]]), tools.npm, { env: f.env });
	}), /Command failed/);
	assertPreserved(f);
	assert.deepEqual(readdirSync(f.releases), []);
});

test("an installed CLI smoke failure leaves selector/config/journals intact", async (t) => {
	const f = fixture(t);
	await assert.rejects(installRelease({ ...f, receipt: receipt() }, installFixture(f, { brokenCli: true })), /Command failed/);
	assertPreserved(f);
	assert.deepEqual(readdirSync(f.releases), []);
});

test("never overwrites an existing incomplete release or an unrelated selector file", async (t) => {
	const f = fixture(t);
	const candidate = join(f.releases, releaseIdentity(receipt()));
	mkdirSync(candidate, { recursive: true });
	writeFileSync(join(candidate, "untouched"), "incomplete from a previous invocation");
	await assert.rejects(installRelease({ ...f, receipt: receipt() }, () => assert.fail("must not rebuild in place")), /ENOENT/);
	assert.equal(readFileSync(join(candidate, "untouched"), "utf8"), "incomplete from a previous invocation");
	assertPreserved(f);
	const valid = await installRelease({ ...f, receipt: receipt("d"), stage: true }, installFixture(f));
	const realSelector = join(f.root, "real-package");
	mkdirSync(realSelector);
	writeFileSync(join(realSelector, "keep"), "keep");
	assert.throws(() => activateRelease(f.releases, basename(valid.directory), realSelector), /non-symlink/);
	assert.equal(readFileSync(join(realSelector, "keep"), "utf8"), "keep");
	assert.throws(() => activateRelease(f.releases, "../outside", f.selector), /identity/);
});

test("native selection replaces the link inode and leaves no temporary selectors", async (t) => {
	const f = fixture(t);
	const a = await installRelease({ ...f, receipt: receipt(), stage: true }, installFixture(f));
	const b = await installRelease({ ...f, receipt: receipt("d"), stage: true }, installFixture(f));
	activateRelease(f.releases, releaseIdentity(receipt()), f.selector);
	for (const candidate of [b, a, b, a]) {
		const previous = readlinkSync(f.selector);
		const previousInode = lstatSync(f.selector).ino;
		activateRelease(f.releases, releaseIdentity(candidate.receipt), f.selector);
		assert.notEqual(lstatSync(f.selector).ino, previousInode);
		assert.equal(readlinkSync(f.selector), candidate.packageDir);
		assert.equal(readlinkSync(`${f.selector}.previous`), previous);
		assert.equal(JSON.parse(readFileSync(join(f.selector, "package.json"), "utf8")).name, name);
	}
	assert.deepEqual(readdirSync(dirname(f.selector)).sort(), ["pi-coding-agent", "pi-coding-agent.previous"]);
});

test("isolates ambient Pi/npm config and resolves native Node/npm before HOME changes", (t) => {
	const f = fixture(t);
	assert.equal(f.env.PI_CACHE_RETENTION, undefined);
	assert.equal(f.env.PI_RESTART_SOCKET, undefined);
	assert.equal(f.env.NODE_OPTIONS, undefined);
	assert.equal(f.env.NPM_CONFIG_USERCONFIG, undefined);
	assert.equal(execFileSync(tools.node, [tools.npm, "--version"], { env: f.env, encoding: "utf8" }).trim(), tools.npmVersion);
	assert.equal(execFileSync("node", ["-p", "process.execPath"], { env: f.env, encoding: "utf8" }).trim(), tools.node);
	assert.notEqual(releaseIdentity(receipt()), releaseIdentity(receipt("a", "e")));
});
