import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
	readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import lockfile from "proper-lockfile";
import { packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";
import {
	activateRelease, installFrozenConsumer, installRelease, isolatedEnvironment, main, prepareTermuxCompiler, pruneReleases, releaseIdentity, resolveBuildTools,
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
		const tarballs = packReleasePackages(pkgs, join(directory, "tarballs"), { ...tools, env: f.env });
		if (options.brokenTarball) writeFileSync(tarballs.get(name), "not an npm tarball");
		installFrozenConsumer(directory, tarballs, lockDirectory, tools, f.env);
		smokeTestCodingAgentConsumer(directory, tools.node);
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
	assert.equal((await activateRelease(f.releases, releaseIdentity(receipt()), f.selector)).changed, false);
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
	assert.deepEqual(readdirSync(f.releases), [".owner-selector"]);
});

test("a real npm install failure leaves the selector unchanged", async (t) => {
	const f = fixture(t);
	await assert.rejects(installRelease({ ...f, receipt: receipt() }, installFixture(f, { brokenTarball: true })), /Command failed/);
	assertPreserved(f);
	assert.deepEqual(readdirSync(f.releases), [".owner-selector"]);
});

test("an installed CLI smoke failure leaves selector/config/journals intact", async (t) => {
	const f = fixture(t);
	await assert.rejects(installRelease({ ...f, receipt: receipt() }, installFixture(f, { brokenCli: true })), /Command failed/);
	assertPreserved(f);
	assert.deepEqual(readdirSync(f.releases), [".owner-selector"]);
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
	await assert.rejects(activateRelease(f.releases, basename(valid.directory), realSelector), /non-symlink/);
	assert.equal(readFileSync(join(realSelector, "keep"), "utf8"), "keep");
	await assert.rejects(activateRelease(f.releases, "../outside", f.selector), /identity/);
});

test("native selection replaces the link inode and leaves no temporary selectors", async (t) => {
	const f = fixture(t);
	const a = await installRelease({ ...f, receipt: receipt(), stage: true }, installFixture(f));
	const b = await installRelease({ ...f, receipt: receipt("d"), stage: true }, installFixture(f));
	await activateRelease(f.releases, releaseIdentity(receipt()), f.selector);
	for (const candidate of [b, a, b, a]) {
		const previous = readlinkSync(f.selector);
		const previousInode = lstatSync(f.selector).ino;
		await activateRelease(f.releases, releaseIdentity(candidate.receipt), f.selector);
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

test("a release store adopts one canonical selector and refuses another without deleting anything", async (t) => {
	const f = fixture(t);
	const a = validatedRelease(f, "1", 1_000);
	const b = validatedRelease(f, "2", 1_001);
	const alias = join(f.root, "npm-alias");
	symlinkSync(join(f.root, "npm-global"), alias);
	const aliasSelector = join(alias, "lib/node_modules", name);
	await activateRelease(f.releases, a.identity, aliasSelector);
	await activateRelease(f.releases, b.identity, f.selector);
	const secondSelector = join(f.root, "second-selector");
	symlinkSync(join(a.directory, "node_modules", name), secondSelector);
	const before = readdirSync(f.releases).sort();
	const refused = /owned by selector .*Use a separate release store/;
	await assert.rejects(pruneReleases({ ...f, selector: secondSelector, keep: 0 }, () => ""), refused);
	for (const stage of [false, true]) {
		await assert.rejects(installRelease({ ...f, selector: secondSelector, receipt: receipt("3"), stage },
			() => assert.fail("must not build")), refused);
	}
	for (const operation of ["--activate", "--rollback"]) {
		await assert.rejects(main([operation, a.identity, "--releases", f.releases, "--selector", secondSelector]), refused);
	}
	assert.deepEqual(readdirSync(f.releases).sort(), before);
	assert.equal(readFileSync(join(f.releases, ".owner-selector"), "utf8"),
		`${join(realpathSync(dirname(f.selector)), basename(f.selector))}\n`);
	assert.equal(readlinkSync(secondSelector), join(a.directory, "node_modules", name));
	assert.equal(readlinkSync(f.selector), join(b.directory, "node_modules", name));
	assert.ok(existsSync(a.directory));
	assert.ok(existsSync(b.directory));
});

test("simultaneous first adopters with different selector locks cannot share a release store", async (t) => {
	const f = fixture(t);
	const candidate = validatedRelease(f, "1", 1_000);
	const secondSelector = join(f.root, "second-selector");
	symlinkSync(f.oldPackage, secondSelector);
	const results = await Promise.all([f.selector, secondSelector].map((selector) => new Promise((resolve, reject) => {
		const child = spawn(tools.node, [fileURLToPath(new URL("./install-fork.mjs", import.meta.url)),
			"--activate", candidate.identity, "--releases", f.releases, "--selector", selector], { env: f.env });
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stderr }));
	})));
	assert.deepEqual(results.map((result) => result.status).sort(), [0, 1]);
	assert.match(results.find((result) => result.status === 1).stderr, /owned by selector .*Use a separate release store/);
	assert.ok(existsSync(candidate.directory));
});

test("prunes old validated releases except selected, previous and visibly running ones", async (t) => {
	const f = fixture(t);
	const [previous, selected, running, old, newer, newest] = ["1", "2", "3", "4", "5", "6"]
		.map((commit, index) => validatedRelease(f, commit, 1_000 + index));
	await activateRelease(f.releases, previous.identity, f.selector);
	await activateRelease(f.releases, selected.identity, f.selector);
	const legacy = join(f.releases, "legacy-release");
	const installing = join(f.releases, releaseIdentity(receipt("7")));
	for (const directory of [legacy, installing]) mkdirSync(directory, { recursive: true });

	const result = await pruneReleases({ releases: f.releases, selector: f.selector, keep: 2 },
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

test("prune cannot delete a runtime selected after its protection snapshot", async (t) => {
	const f = fixture(t);
	const a = validatedRelease(f, "1", 1_000);
	const b = validatedRelease(f, "2", 1_001);
	await activateRelease(f.releases, a.identity, f.selector);
	let activation;
	await pruneReleases({ releases: f.releases, selector: f.selector, keep: 0 }, () => {
		// A different process tries to select B after prune has read its protected links.
		activation = spawnSync(tools.node, [fileURLToPath(new URL("./install-fork.mjs", import.meta.url)),
			"--activate", b.identity, "--releases", f.releases, "--selector", f.selector], {
			env: f.env, encoding: "utf8",
		});
		return "";
	});
	assert.equal(activation.status, 1);
	assert.match(activation.stderr, /Lock file is already being held/);
	assert.ok(existsSync(f.selector), "Pruning must never leave the selected runtime dangling");
	assert.equal(readlinkSync(f.selector), join(a.directory, "node_modules", name));
	assert.equal(existsSync(b.directory), false);
	assert.equal(existsSync(`${f.selector}.lock`), false);
});

test("installation, activation, rollback and pruning honor the updater's selector lock", async (t) => {
	const f = fixture(t);
	const candidate = validatedRelease(f, "1", 1_000);
	const release = await lockfile.lock(f.selector, { realpath: false, stale: Infinity, update: 1000 });
	try {
		await assert.rejects(installRelease({ ...f, receipt: receipt() }, () => assert.fail("must not build")), { code: "ELOCKED" });
		for (const args of [
			["--activate", candidate.identity], ["--rollback", candidate.identity], ["--prune", "--keep", "0"],
		]) {
			await assert.rejects(main([...args, "--selector", f.selector, "--releases", f.releases]), { code: "ELOCKED" });
		}
		assertPreserved(f);
		assert.ok(existsSync(candidate.directory));
	} finally {
		await release();
	}
	// A paused long build or SIGKILL must not permit another operation to steal the lock.
	mkdirSync(`${f.selector}.lock`);
	utimesSync(`${f.selector}.lock`, new Date(0), new Date(0));
	await assert.rejects(activateRelease(f.releases, candidate.identity, f.selector), { code: "ELOCKED" });
	rmSync(`${f.selector}.lock`, { recursive: true });
});

test("isolates ambient Pi/npm config and resolves native Node/npm before HOME changes", (t) => {
	const f = fixture(t);
	assert.equal(f.env.PI_CACHE_RETENTION, undefined);
	assert.equal(f.env.PI_RESTART_SOCKET, undefined);
	assert.equal(f.env.NODE_OPTIONS, undefined);
	assert.equal(f.env.NPM_CONFIG_USERCONFIG, undefined);
	assert.equal(f.env.TMPDIR, join(f.env.HOME, "tmp"));
	assert.ok(existsSync(f.env.TMPDIR));
	if (process.platform !== "android") {
		assert.equal(f.env.LD_PRELOAD, undefined);
		assert.equal(f.env.PREFIX, undefined);
		assert.equal(f.env.npm_config_script_shell, undefined);
	}
	assert.equal(execFileSync(tools.node, [tools.npm, "--version"], { env: f.env, encoding: "utf8" }).trim(), tools.npmVersion);
	assert.equal(execFileSync("node", ["-p", "process.execPath"], { env: f.env, encoding: "utf8" }).trim(), tools.node);
	assert.notEqual(releaseIdentity(receipt()), releaseIdentity(receipt("a", "e")));
});

test("isolated npm cannot read registry credentials or settings from the native prefix", (t) => {
	const f = fixture(t);
	const prefix = join(f.root, "native-prefix");
	mkdirSync(join(prefix, "etc"), { recursive: true });
	writeFileSync(join(prefix, "etc/npmrc"), "registry=https://credential-fixture.invalid/\n//credential-fixture.invalid/:_authToken=synthetic-secret\n");
	const inherited = { ...f.env, npm_config_prefix: prefix };
	const registry = () => execFileSync(tools.node, [tools.npm, "config", "get", "registry"], {
		cwd: f.root, env: inherited, encoding: "utf8",
	}).trim();
	assert.equal(readFileSync(f.env.npm_config_globalconfig, "utf8"), "");
	assert.equal(f.env.NPM_CONFIG_GLOBALCONFIG, undefined);
	assert.equal(registry(), "https://registry.npmjs.org/");
	// Confirm that this fixture actually reaches prefix/etc/npmrc without isolation.
	delete inherited.npm_config_globalconfig;
	assert.equal(registry(), "https://credential-fixture.invalid/");
});

test("packing uses the resolved native Node/npm and isolated environment", (t) => {
	const f = fixture(t);
	const observed = join(f.root, "packing-env.json");
	const npm = join(f.root, "npm-observer.cjs");
	writeFileSync(npm, `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ node: process.execPath, env: process.env }));
require(${JSON.stringify(tools.npm)});
`);
	const inherited = { HOME: process.env.HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, NODE_OPTIONS: process.env.NODE_OPTIONS };
	const preload = join(f.root, "ambient-preload.cjs");
	const leaked = join(f.root, "preload-ran");
	writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(leaked)}, "leaked");`);
	try {
		process.env.HOME = join(f.root, "ambient-home");
		process.env.ANTHROPIC_API_KEY = "synthetic-secret";
		process.env.NODE_OPTIONS = `--require ${preload}`;
		const tarballs = packReleasePackages(packages(f), join(f.root, "tarballs"), { node: tools.node, npm, env: f.env });
		assert.ok(existsSync(tarballs.get(name)));
		const result = JSON.parse(readFileSync(observed, "utf8"));
		assert.equal(result.node, tools.node);
		assert.equal(result.env.HOME, f.env.HOME);
		assert.equal(result.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(result.env.NODE_OPTIONS, undefined);
		assert.equal(result.env.npm_config_globalconfig, f.env.npm_config_globalconfig);
		assert.equal(existsSync(leaked), false);
	} finally {
		for (const [name, value] of Object.entries(inherited)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("keeps only Termux's exec wrapper, prefix and native shell in the isolated environment", (t) => {
	const f = fixture(t);
	const platform = process.platform;
	const inherited = { PREFIX: process.env.PREFIX, LD_PRELOAD: process.env.LD_PRELOAD };
	try {
		process.env.PREFIX = join(f.root, "termux-prefix");
		process.env.LD_PRELOAD = join(f.root, "libtermux-exec.so");
		Object.defineProperty(process, "platform", { value: "android", configurable: true });
		const env = isolatedEnvironment(f.env.HOME, tools);
		assert.equal(env.PREFIX, process.env.PREFIX);
		assert.equal(env.LD_PRELOAD, process.env.LD_PRELOAD);
		assert.equal(env.npm_config_script_shell, join(dirname(tools.node), "bash"));
		assert.equal(env.PI_RESTART_SOCKET, undefined);
		assert.equal(env.NODE_OPTIONS, undefined);
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
	} finally {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		for (const [name, value] of Object.entries(inherited)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("isolated npm scripts can invoke npm and package executables on Termux", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const bin = join(f.root, "node_modules/.bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "fixture-executable"), '#!/usr/bin/env node\nconsole.log("package executable");\n', { mode: 0o755 });
	writeFileSync(join(f.root, "package.json"), JSON.stringify({
		private: true,
		scripts: { probe: "npm --version && fixture-executable" },
	}));
	const output = execFileSync(tools.node, [tools.npm, "run", "--silent", "probe"], {
		cwd: f.root, env: f.env, encoding: "utf8",
	});
	assert.deepEqual(output.trim().split(/\r?\n/), [tools.npmVersion, "package executable"]);
});

for (const blocked of [false, true]) {
	test(`Termux compiler preserves frozen inputs without scripts and allows cleanup (${blocked ? "fanotify rebuild" : "published artifact"})`, {
		skip: process.platform === "win32" || (blocked && process.platform === "darwin"),
	}, (t) => {
		const f = fixture(t);
		const name = `@typescript/typescript-linux-${process.arch}`;
		const directory = join(f.root, "compiler");
		let gitHead = "a".repeat(40);
		let originalWatcher;
		let watcher;
		if (blocked) {
			const module = join(f.root, "go-source");
			mkdirSync(join(module, "cmd/tsgo"), { recursive: true });
			mkdirSync(join(module, "internal/fswatch"), { recursive: true });
			writeFileSync(join(module, "go.mod"), "module github.com/microsoft/typescript-go\n\ngo 1.21\n");
			watcher = join(module, "internal/fswatch/fanotify_linux.go");
			originalWatcher = "package fswatch\n\nfunc init() { fanotifyAvailable() }\n\nfunc fanotifyAvailable() bool {\n\tpanic(\"forbidden fanotify probe\")\n}\n";
			writeFileSync(watcher, originalWatcher);
			writeFileSync(join(module, "cmd/tsgo/main.go"), `package main
import ("fmt"; _ "github.com/microsoft/typescript-go/internal/fswatch")
func main() { fmt.Println("Version 1.2.3") }
`);
			const git = (args) => execFileSync("git", args, { cwd: module, env: f.env, encoding: "utf8" }).trim();
			git(["init", "--quiet"]);
			git(["add", "go.mod", "cmd", "internal"]);
			git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "compiler fixture"]);
			gitHead = git(["rev-parse", "HEAD"]);
			// A file proxy lets real Go own cache permissions and checksum verification offline.
			const version = `v0.0.0-20260101000000-${gitHead.slice(0, 12)}`;
			const proxy = join(f.root, "proxy");
			const versions = join(proxy, "github.com/microsoft/typescript-go/@v");
			mkdirSync(versions, { recursive: true });
			const info = JSON.stringify({ Version: version, Time: "2026-01-01T00:00:00Z", Origin: { Hash: gitHead } });
			for (const query of [gitHead, version]) writeFileSync(join(versions, `${query}.info`), info);
			writeFileSync(join(versions, `${version}.mod`), readFileSync(join(module, "go.mod")));
			git(["archive", "--format=zip", `--prefix=github.com/microsoft/typescript-go@${version}/`, "--output", join(versions, `${version}.zip`), "HEAD"]);
			f.env.GOPROXY = pathToFileURL(proxy).href;
			f.env.GOSUMDB = "off";
		}
		mkdirSync(join(directory, "lib"), { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({
			name, version: "1.2.3", gitHead, os: ["linux"], cpu: [process.arch],
			scripts: { postinstall: "node -e 'process.exit(27)'" },
		}));
		writeFileSync(join(directory, "lib/tsc"), blocked
			? '#!/usr/bin/env node\nconsole.error("SIGSYS: bad system call\\ninternal/fswatch.fanotifyAvailable()"); process.exit(2);\n'
			: '#!/usr/bin/env node\nconsole.log("Version 1.2.3");\n', { mode: 0o755 });
		const tarball = packReleasePackages([{ name, directory }], join(f.root, "tarballs")).get(name);
		const lock = JSON.stringify({
			lockfileVersion: 3,
			packages: {
				[`node_modules/${name}`]: {
					version: "1.2.3", resolved: `file:${tarball}`, optional: true, os: ["linux"], cpu: [process.arch],
					integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
				},
			},
		});
		writeFileSync(join(f.root, "package-lock.json"), lock);
		mkdirSync(join(f.root, "node_modules/.bin"), { recursive: true });
		symlinkSync(join(f.root, "unusable-android-wrapper"), join(f.root, "node_modules/.bin/tsc"));
		prepareTermuxCompiler(f.root, tools, { ...f.env, npm_config_offline: "true" });
		assert.equal(readFileSync(join(f.root, "package-lock.json"), "utf8"), lock);
		assert.equal(execFileSync(join(f.root, "node_modules/.bin/tsc"), ["--version"], { env: f.env, encoding: "utf8" }).trim(), "Version 1.2.3");
		if (blocked) assert.equal(readFileSync(watcher, "utf8"), originalWatcher);
		const compiler = join(f.root, "node_modules/.termux-compiler");
		rmSync(compiler, { recursive: true, force: true });
		assert.equal(existsSync(compiler), false);
	});
}
