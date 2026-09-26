import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
	readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";
import {
	activateRelease, installRelease, isolatedEnvironment, main, pruneReleases, releaseIdentity, resolveBuildTools,
} from "./install-fork.mjs";

const name = "@earendil-works/pi-coding-agent";
const tools = resolveBuildTools();

test("runs the installer CLI through a symlinked path", (t) => {
	const f = fixture(t);
	const entry = join(f.root, "install-fork.mjs");
	symlinkSync(fileURLToPath(new URL("./install-fork.mjs", import.meta.url)), entry);
	const output = execFileSync(tools.node, [entry, "--help"], { env: f.env, encoding: "utf8" });
	assert.match(output, /Usage: node scripts\/install-fork\.mjs/);
});

test("importing the installer from stdin does not run the CLI", () => {
	const entry = new URL("./install-fork.mjs", import.meta.url).href;
	const output = execFileSync(tools.node, ["--input-type=module", "-"], {
		input: `import ${JSON.stringify(entry)};`,
		encoding: "utf8",
	});
	assert.equal(output, "");
});

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

function installFixture(f, options = {}) {
	const pkgs = packages(f, options);
	return (directory) => {
		const lockDirectory = join(f.root, "install-lock");
		const manifest = { private: true, dependencies: { [name]: "1.0.0" } };
		const lock = { lockfileVersion: 3, requires: true, packages: { "": manifest } };
		for (const pkg of pkgs) {
			const { version, dependencies, bin } = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
			lock.packages[`node_modules/${pkg.name}`] = { version, dependencies, bin };
		}
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(join(lockDirectory, "package.json"), JSON.stringify(manifest));
		writeFileSync(join(lockDirectory, "package-lock.json"), JSON.stringify(lock));
		const tarballs = packReleasePackages(pkgs, join(directory, "tarballs"), { npm: tools.npm, env: f.env });
		if (options.brokenTarball) writeFileSync(tarballs.get(name), "not an npm tarball");
		installCodingAgentConsumer(directory, tarballs, tools.npm, { env: f.env, lockDirectory });
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
	await assert.rejects(installRelease({ ...f, receipt: receipt() }, installFixture(f, { brokenTarball: true })), /Command failed/);
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

function validatedRelease(f, commit, validatedAt) {
	const directory = join(f.releases, releaseIdentity(receipt(commit)));
	const pkg = join(directory, "node_modules", name);
	mkdirSync(join(pkg, "dist/bundle"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name }));
	writeFileSync(join(pkg, "dist/bundle/cli-worker.js"), "");
	writeFileSync(join(directory, "fork-release.json"), JSON.stringify({ ...receipt(commit), validated: true }));
	utimesSync(join(directory, "fork-release.json"), validatedAt, validatedAt);
	return { identity: basename(directory), directory };
}

test("prunes old validated releases except selected, previous and visibly running ones", (t) => {
	const f = fixture(t);
	const [previous, selected, running, old, newer, newest] = ["1", "2", "3", "4", "5", "6"]
		.map((commit, index) => validatedRelease(f, commit, 1_000 + index));
	activateRelease(f.releases, previous.identity, f.selector);
	activateRelease(f.releases, selected.identity, f.selector);
	const legacy = join(f.releases, "legacy-release");
	const installing = join(f.releases, releaseIdentity(receipt("7")));
	for (const directory of [legacy, installing]) mkdirSync(directory, { recursive: true });

	const result = pruneReleases({ releases: f.releases, selector: f.selector, keep: 2 },
		() => `p1\nn${running.directory}/node_modules/native.node\n`);

	assert.deepEqual(result, { kept: 5, removed: [old.identity] });
	assert.equal(existsSync(old.directory), false);
	for (const directory of [previous, selected, running, newer, newest].map((release) => release.directory).concat(legacy, installing)) {
		assert.ok(existsSync(directory), directory);
	}
	assert.equal(readlinkSync(f.selector), join(selected.directory, "node_modules", name));
});

test("prune is a separate operation and requires an explicit keep count", async (t) => {
	const f = fixture(t);
	const paths = ["--releases", f.releases, "--selector", f.selector];
	await assert.rejects(main(["--prune", ...paths]), /Use --prune with --keep/);
	await assert.rejects(main(["--keep", "1", ...paths]), /Use --prune with --keep/);
	for (const keep of ["-1", "two", "1.5"]) {
		await assert.rejects(main(["--prune", "--keep", keep, ...paths]), /non-negative integer/);
	}
	await assert.rejects(main(["--prune", "--keep", "1", "--stage", ...paths]), /cannot combine/);
	await assert.rejects(main(["--prune", "--keep", "1", "--rollback", "x", ...paths]), /cannot combine/);
	assertPreserved(f);
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
