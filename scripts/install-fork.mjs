#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync,
	renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { claimForkReleaseStore } from "../packages/coding-agent/src/utils/fork-release-store.ts";
import { packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

const codingAgentName = "@earendil-works/pi-coding-agent";
const receiptFile = "fork-release.json";
const restartWorker = "dist/bundle/cli-worker.js";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr ?? ""}${result.error?.message ?? ""}`);
	}
	return result.stdout?.trim() ?? "";
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function resolveBuildTools() {
	// Resolve before HOME isolation. In particular, never invoke a mise/asdf shim there.
	const node = realpathSync(process.execPath);
	// Some managers replace even bin/npm with a shell wrapper. Use npm's JS entry.
	const npm = realpathSync(join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"));
	const path = `${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}`;
	const npmVersion = run(node, [npm, "--version"], { stdio: "pipe" });
	return { node, npm, path, npmVersion };
}

export function isolatedEnvironment(home, tools) {
	mkdirSync(join(home, "tmp"), { recursive: true });
	const npmGlobalConfig = join(home, "npm-globalconfig");
	writeFileSync(npmGlobalConfig, "");
	return {
		PATH: tools.path,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"),
		PI_CODING_AGENT_DIR: join(home, "agent"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		HUSKY: "0",
		JITI_FS_CACHE: "0",
		npm_config_cache: join(home, "npm-cache"),
		npm_config_userconfig: join(home, ".npmrc"),
		npm_config_globalconfig: npmGlobalConfig,
		...(process.platform === "android" ? {
			PREFIX: process.env.PREFIX,
			LD_PRELOAD: process.env.LD_PRELOAD,
			npm_config_script_shell: join(dirname(tools.node), "bash"),
		} : {}),
	};
}

export function prepareTermuxCompiler(source, tools, env) {
	// TypeScript 7 has no Android package. Use the lockfile-pinned Linux compiler.
	const name = `@typescript/typescript-linux-${process.arch}`;
	const key = `node_modules/${name}`;
	const locked = JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8")).packages[key];
	if (!locked?.version || !locked.integrity) throw new Error(`Missing locked compiler: ${name}`);
	const directory = join(source, "node_modules/.termux-compiler");
	mkdirSync(directory, { recursive: true });
	const optionalDependencies = { [name]: locked.version };
	writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, optionalDependencies }));
	writeFileSync(join(directory, "package-lock.json"), JSON.stringify({
		lockfileVersion: 3, requires: true,
		packages: { "": { optionalDependencies }, [key]: locked },
	}));
	run(tools.node, [tools.npm, "ci", "--ignore-scripts", "--os=linux", "--include=optional", "--no-audit", "--no-fund"], {
		cwd: directory, env,
	});
	const binary = join(directory, key, "lib/tsc");
	const probe = spawnSync(binary, ["--version"], { env, encoding: "utf8" });
	if (probe.stderr?.startsWith("SIGSYS:") && probe.stderr.includes("fanotifyAvailable")) {
		console.log("Android blocked the compiler's fanotify probe; rebuilding the pinned source (requires Go >=1.26).");
		const { gitHead } = JSON.parse(readFileSync(join(directory, key, "package.json"), "utf8"));
		if (!/^[a-f0-9]{40}$/.test(gitHead ?? "")) throw new Error("Missing pinned TypeScript source commit");
		const goEnv = { ...env, GOOS: process.platform === "android" ? "android" : "linux",
			GOARCH: process.arch === "x64" ? "amd64" : process.arch,
			CGO_ENABLED: process.platform === "android" && process.arch === "x64" ? "1" : "0",
			GOTOOLCHAIN: "local", GOWORK: "off", GOFLAGS: "-modcacherw",
			GOPATH: join(directory, "go"), GOCACHE: join(directory, "go-cache") };
		const downloaded = JSON.parse(run("go", ["mod", "download", "-json", `github.com/microsoft/typescript-go@${gitHead}`], {
			cwd: directory, env: goEnv, stdio: "pipe",
		}));
		if (downloaded.Origin?.Hash !== gitHead || !downloaded.Sum || !downloaded.Dir) {
			throw new Error("Downloaded TypeScript source does not match the pinned commit");
		}
		const buildSource = join(directory, "source");
		rmSync(buildSource, { recursive: true, force: true });
		cpSync(downloaded.Dir, buildSource, { recursive: true });
		const watcher = join(buildSource, "internal/fswatch/fanotify_linux.go");
		const contents = readFileSync(watcher, "utf8");
		const patched = contents.replace(/func fanotifyAvailable\(\) bool \{[\s\S]*?\n\}/, "func fanotifyAvailable() bool {\n\treturn false\n}");
		if (patched === contents) throw new Error("Cannot disable the compiler's fanotify probe");
		// ponytail: build-only compiler uses inotify; use an official Android artifact when published.
		chmodSync(watcher, 0o644);
		writeFileSync(watcher, patched);
		const compiled = join(directory, "tsc");
		run("go", ["build", "-mod=readonly", "-buildvcs=false", "-trimpath", "-tags=noembed", "-o", compiled, "./cmd/tsgo"], {
			cwd: buildSource, env: goEnv,
		});
		renameSync(compiled, binary);
	}
	const version = run(binary, ["--version"], { env, stdio: "pipe" });
	if (version !== `Version ${locked.version}`) throw new Error(`Unexpected compiler version: ${version}`);
	replaceSymlink(binary, join(source, "node_modules/.bin/tsc"));
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return undefined;
	const parts = lockPath.slice(index + marker.length).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

// npm does not reliably honor a local-file package's nested shrinkwrap. Install the
// generated install lock instead, replacing only the locally built packages.
export function installFrozenConsumer(directory, tarballs, lockDirectory, tools, env) {
	mkdirSync(directory, { recursive: true });
	const local = Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:./${relative(directory, path)}`]));
	if (!local[codingAgentName]) throw new Error("Missing coding-agent tarball");
	const manifest = JSON.parse(readFileSync(join(lockDirectory, "package.json"), "utf8"));
	manifest.dependencies = { [codingAgentName]: local[codingAgentName] };
	manifest.overrides = { ...manifest.overrides, ...local };
	const lock = JSON.parse(readFileSync(join(lockDirectory, "package-lock.json"), "utf8"));
	lock.packages[""].dependencies = manifest.dependencies;
	for (const [path, entry] of Object.entries(lock.packages)) {
		const name = packageNameFromLockPath(path);
		if (!tarballs.has(name)) continue;
		entry.resolved = local[name];
		entry.integrity = `sha512-${createHash("sha512").update(readFileSync(tarballs.get(name))).digest("base64")}`;
	}
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	writeFileSync(join(directory, "package-lock.json"), `${JSON.stringify(lock, null, "\t")}\n`);
	run(tools.node, [tools.npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: directory, env });
}

export function releaseIdentity(receipt) {
	return `${receipt.commit}-${receipt.catalogSha256.slice(0, 16)}-node${receipt.node}-${receipt.platform}-${receipt.arch}`;
}

function releasePath(releases, identity) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(identity)) throw new Error("Expected a release identity, not a path");
	return join(resolve(releases), identity);
}

function packagePath(directory) {
	return join(directory, "node_modules", codingAgentName);
}

export function readVerifiedRelease(directory) {
	const receipt = JSON.parse(readFileSync(join(directory, receiptFile), "utf8"));
	if (receipt.validated !== true || releaseIdentity(receipt) !== basename(directory)) {
		throw new Error(`Not a validated fork release: ${directory}`);
	}
	const pkg = packagePath(directory);
	const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
	if (manifest.name !== codingAgentName || !existsSync(join(pkg, restartWorker))) {
		throw new Error(`Missing installed coding-agent/restart worker: ${pkg}`);
	}
	return { receipt, directory, packageDir: pkg };
}

function selectorTarget(selector) {
	try {
		if (!lstatSync(selector).isSymbolicLink()) throw new Error(`Refusing to replace a non-symlink: ${selector}`);
		return resolve(dirname(selector), readlinkSync(selector));
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

function replaceSymlink(target, selector) {
	const temporary = `${selector}.${randomUUID()}.tmp`;
	try {
		symlinkSync(target, temporary);
		renameSync(temporary, selector);
	} finally {
		rmSync(temporary, { force: true });
	}
}

async function withMutationLock(releases, selector, action) {
	mkdirSync(dirname(selector), { recursive: true });
	// Synchronous builds can block heartbeats. Never steal a lock based on age.
	const release = await lockfile.lock(selector, { realpath: false, stale: Infinity, update: 1000 });
	try {
		selectorTarget(selector);
		selectorTarget(`${selector}.previous`);
		claimForkReleaseStore(releases, selector);
		return await action();
	} finally {
		await release();
	}
}

export function activateRelease(releases, identity, selector) {
	return withMutationLock(releases, selector, () => activateLockedRelease(releases, identity, selector));
}

function activateLockedRelease(releases, identity, selector) {
	const release = readVerifiedRelease(releasePath(releases, identity));
	const previous = selectorTarget(selector);
	if (previous === release.packageDir) return { ...release, previous, changed: false };
	mkdirSync(dirname(selector), { recursive: true });
	if (previous) {
		selectorTarget(`${selector}.previous`); // Never overwrite an unrelated real file.
		replaceSymlink(previous, `${selector}.previous`);
	}
	replaceSymlink(release.packageDir, selector);
	return { ...release, previous, changed: true };
}

// lsof sees open files, mapped native modules and working directories; ps sees concrete command paths.
// ponytail: a worker that loaded only JavaScript through the selector holds nothing open in its
// release, so neither sees it and --keep is the guard. Exact protection needs a live-worker registry.
function liveProcessPaths() {
	const capture = (command, args) => run(command, args, { stdio: "pipe", maxBuffer: Infinity });
	// Without -ww, procps truncates command lines to COLUMNS even when piped.
	return `${capture("lsof", ["-Fn"])}\n${capture("ps", ["-axww", "-o", "args="])}`;
}

function resolvedLink(link) {
	try {
		return realpathSync(link);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function pruneReleases({ releases, selector, keep }, livePaths = liveProcessPaths) {
	return withMutationLock(releases, selector, () => {
		const selected = [selector, `${selector}.previous`].map(resolvedLink);
		const live = livePaths();
		const mentioned = (path) => new RegExp(`${path.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?:[/\\s]|$)`, "m").test(live);
		const validated = [];
		for (const identity of readdirSync(releases)) {
			const directory = join(releases, identity);
			try {
				readVerifiedRelease(directory);
			} catch {
				continue; // Legacy releases and installations still in progress have no valid receipt.
			}
			validated.push({ directory, validatedAt: statSync(join(directory, receiptFile)).mtimeMs });
		}
		validated.sort((a, b) => b.validatedAt - a.validatedAt);
		const removed = [];
		for (const { directory } of validated.slice(keep)) {
			const real = realpathSync(directory);
			if (selected.some((path) => path === real || path?.startsWith(`${real}/`)) || mentioned(directory) || mentioned(real)) {
				continue;
			}
			rmSync(directory, { recursive: true, force: true });
			removed.push(basename(directory));
		}
		return { kept: validated.length - removed.length, removed };
	});
}

// The callback builds/installs/tests only a NEW candidate. The receipt is written
// last, and is the only reusable success marker. Existing releases are never modified.
export async function installRelease({ releases, receipt, selector, stage = false }, installAndValidate) {
	return withMutationLock(releases, selector, async () => {
		const identity = releaseIdentity(receipt);
		const directory = releasePath(releases, identity);
		mkdirSync(resolve(releases), { recursive: true });
		let created = false;
		try {
			mkdirSync(directory);
			created = true;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const existing = readVerifiedRelease(directory).receipt;
			for (const key of ["commit", "catalogSha256", "archiveSha256", "node", "platform", "arch"]) {
				if (existing[key] !== receipt[key]) throw new Error(`Existing release has a different ${key}: ${directory}`);
			}
		}
		if (created) {
			try {
				await installAndValidate(directory);
				writeFileSync(join(directory, receiptFile), `${JSON.stringify({ ...receipt, validated: true }, null, 2)}\n`, { flag: "wx" });
				readVerifiedRelease(directory);
			} catch (error) {
				// This invocation owns this unselected, incomplete directory, not an active release.
				rmSync(directory, { recursive: true, force: true });
				throw error;
			}
		}
		return stage ? { ...readVerifiedRelease(directory), reused: !created, changed: false }
			: { ...activateLockedRelease(releases, identity, selector), reused: !created };
	});
}

function printUsage() {
	console.log(`Usage: node scripts/install-fork.mjs [--ref <commit>] [--source-archive <file>] [--stage]
       node scripts/install-fork.mjs --activate <identity>
       node scripts/install-fork.mjs --rollback <identity>
       node scripts/install-fork.mjs --prune --keep <count>

Builds an exact local commit (default HEAD) with the checkout's ALREADY hydrated
model-data snapshot using create-source-archive.sh and build:offline. An optional
--source-archive with its adjacent source.commit reuses an already frozen input.
No fetch or model generation. npm may download frozen dependencies. Requires macOS,
Linux or Termux, Node >=22.19 with npm installed alongside it, Git, bash, tar, gzip,
and tmux. Termux also needs Go >=1.26 when Android blocks the compiler's fanotify probe.

--source-archive <file> Use a frozen source archive and adjacent source.commit
--stage                 Build/install/validate without changing the selector
--activate <identity>   Select an existing validated release, without rebuilding
--rollback <identity>   Select an older validated release (same native operation)
--prune --keep <count>  Delete validated releases older than the newest <count>,
                        except selected, .previous and visibly running ones
--releases <directory>  Default: ~/.local/share/pi-fork/releases
--selector <symlink>    Default: ~/.local/share/npm-global/lib/node_modules/${codingAgentName}
-h, --help              Show this help

Example: node scripts/install-fork.mjs --ref HEAD --stage
Exit codes: 0 success, 1 failure.

Selection atomically replaces only the package symlink; its old target is kept
at <selector>.previous. Existing releases and user settings/auth/sessions are
never edited. Running sessions keep their runtime until restarted.
All release mutations share <selector>.lock. Concurrent operations fail; an
abandoned lock must be removed only after confirming its updater/installer stopped.
Each store records one canonical owning selector in .owner-selector, adopting
unowned existing stores without removing releases. Other selectors must use their
own --releases directory; all mutations, including staging and pruning, refuse them.
`);
}

export async function main(args = process.argv.slice(2)) {
	const options = {
		ref: "HEAD", stage: false, prune: false,
		releases: join(homedir(), ".local/share/pi-fork/releases"),
		selector: join(homedir(), ".local/share/npm-global/lib/node_modules", codingAgentName),
	};
	let selection;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") { printUsage(); return; }
		if (arg === "--stage") { options.stage = true; continue; }
		if (arg === "--prune") { options.prune = true; continue; }
		if (!["--ref", "--source-archive", "--releases", "--selector", "--activate", "--rollback", "--keep"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
		if (arg === "--activate" || arg === "--rollback") {
			if (selection) throw new Error("Choose only one activation operation");
			selection = value;
		} else options[arg.slice(2)] = value;
	}
	options.releases = resolve(options.releases);
	options.selector = resolve(options.selector);
	if (options.prune !== (options.keep !== undefined)) throw new Error("Use --prune with --keep <count>");
	if (options.prune) {
		if (selection || options.stage || args.includes("--ref") || options["source-archive"]) {
			throw new Error("--prune cannot combine with installation or activation");
		}
		if (!/^\d+$/.test(options.keep)) throw new Error("--keep requires a non-negative integer");
		const result = await pruneReleases({ ...options, keep: Number(options.keep) });
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	if (selection && (options.stage || args.includes("--ref") || options["source-archive"])) {
		throw new Error("Activation cannot combine with --stage, --ref or --source-archive");
	}
	if (selection) {
		const result = await activateRelease(options.releases, selection, options.selector);
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	const tools = resolveBuildTools();
	const root = mkdtempSync(join(tmpdir(), "pi-fork-install-"));
	try {
		const env = isolatedEnvironment(join(root, "home"), tools);
		const git = (args) => run("git", args, { cwd: repoRoot, env, stdio: "pipe" });
		const commit = git(["rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`]);
		const version = JSON.parse(git(["show", `${commit}:packages/coding-agent/package.json`])).version;
		const archive = join(root, "source.tar.gz");
		if (options["source-archive"]) {
			const input = resolve(options["source-archive"]);
			const archiveCommit = readFileSync(join(dirname(input), "source.commit"), "utf8").trim();
			if (archiveCommit !== commit) throw new Error(`Source archive commit ${archiveCommit} does not match selected commit ${commit}`);
			copyFileSync(input, archive);
		} else {
			run("bash", [join(repoRoot, "scripts/create-source-archive.sh"), "--version", version, "--ref", commit, "--out", archive], { cwd: repoRoot, env });
		}
		run("tar", ["-xzf", archive, "-C", root], { env });
		const source = join(root, `pi-${version}`);
		if (options["source-archive"]) {
			// Use Git's tree comparison without touching the checkout or its real index.
			const sourceEnv = { ...env, GIT_INDEX_FILE: join(root, "source.index"), GIT_WORK_TREE: source };
			const sourceGit = (args) => run("git", args, { cwd: repoRoot, env: sourceEnv, stdio: "pipe" });
			sourceGit(["read-tree", commit]);
			try {
				sourceGit(["diff", "--quiet", "--no-ext-diff", commit, "--"]);
				if (sourceGit(["ls-files", "--others", "--", ":(exclude)packages/ai/src/providers/data"])) {
					throw new Error("Unexpected source files");
				}
			} catch {
				throw new Error(`Source archive differs from selected commit ${commit}`);
			}
		}
		run(tools.node, [join(source, "packages/ai/scripts/check-model-data.ts")], { cwd: source, env });
		const receipt = {
			commit,
			catalogSha256: sha256(join(source, "packages/ai/src/providers/data/.manifest.json")),
			archiveSha256: sha256(archive),
			node: process.versions.node, npm: tools.npmVersion, platform: process.platform, arch: process.arch,
		};
		const result = await installRelease({ ...options, receipt }, async (directory) => {
			copyFileSync(archive, join(directory, "source.tar.gz"));
			writeFileSync(join(directory, "source.commit"), `${commit}\n`);
			run("tmux", ["-V"], { env }); // Missing tmux must fail, not silently skip the acceptance tests.
			run(tools.node, [tools.npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source, env });
			if (process.platform === "android") prepareTermuxCompiler(source, tools, env);
			run(tools.node, [tools.npm, "run", "build:offline"], { cwd: source, env });
			const packages = findPackageDirectories(join(source, "packages"))
				.map((directory) => ({ directory, ...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) }))
				.filter((pkg) => pkg.private !== true);
			const tarballs = packReleasePackages(packages, join(directory, "tarballs"), { ...tools, env });
			installFrozenConsumer(directory, tarballs, join(source, "packages/coding-agent/install-lock"), tools, env);
			smokeTestCodingAgentConsumer(directory, tools.node);
			const cli = join(packagePath(directory), "dist/bundle/cli.js");
			run(tools.node, [cli, "--help"], { cwd: env.HOME, env });
			run(tools.node, [join(source, "node_modules/vitest/vitest.mjs"), "run", "test/restart-tui.test.ts", "--maxWorkers=1"], {
				cwd: join(source, "packages/coding-agent"),
				env: { ...env, PI_TEST_CLI: cli },
			});
		});
		console.log(JSON.stringify(result, null, 2));
		return result;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
