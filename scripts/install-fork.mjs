#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
	realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const codingAgentName = "@earendil-works/pi-coding-agent";
const receiptFile = "fork-release.json";
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
	mkdirSync(home, { recursive: true });
	return {
		PATH: tools.path,
		HOME: home,
		USERPROFILE: home,
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
	};
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
	if (manifest.name !== codingAgentName || !existsSync(join(pkg, "dist/bundle/cli-worker.js"))) {
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

export function activateRelease(releases, identity, selector) {
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

// The callback builds/installs/tests only a NEW candidate. The receipt is written
// last, and is the only reusable success marker. Existing releases are never modified.
export async function installRelease({ releases, receipt, selector, stage = false }, installAndValidate) {
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
		: { ...activateRelease(releases, identity, selector), reused: !created };
}

export function smokeTestInstalledRuntime(directory, tools, env) {
	const pkg = packagePath(directory);
	const cli = join(pkg, "dist/bundle/cli.js");
	smokeTestCodingAgentConsumer(directory, tools.node, { path: tools.path });
	run(tools.node, [cli, "--help"], { cwd: env.HOME, env });
	run(tools.node, [cli, "restart", "--help"], { cwd: env.HOME, env });
	const entry = join(directory, "fork-smoke.mjs");
	const extension = join(directory, "fork-smoke-extension.ts");
	try {
		writeFileSync(extension, `import { getPackageDir } from "${codingAgentName}";
export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.sessionManager.getEntries().some(entry => entry.customType === "fork-smoke")) {
      pi.appendEntry("fork-smoke", { packageDir: getPackageDir() });
    }
  });
}
`);
		writeFileSync(entry, `import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, getPackageDir, ModelRuntime, SessionManager, SettingsManager,
  readSessionCheckpoint, writeSessionCheckpoint } from "${codingAgentName}";
import { getRestartRuntimeWorker } from ${JSON.stringify(pathToFileURL(join(pkg, "dist/cli/launcher.js")).href)};
const expected = realpathSync(${JSON.stringify(pkg)});
assert.equal(realpathSync(getPackageDir()), expected);
assert.equal(getRestartRuntimeWorker(expected), realpathSync(join(expected, "dist/bundle/cli-worker.js")));
const cwd = join(process.env.HOME, "sdk-work");
mkdirSync(cwd);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
async function create(checkpoint) {
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    additionalExtensionPaths: [${JSON.stringify(extension)}], noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const result = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, modelRuntime,
    ...(checkpoint ? { checkpoint } : { sessionManager: SessionManager.create(cwd, join(cwd, "sessions")) }) });
  await result.session.bindExtensions({});
  return result.session;
}
const session = await create();
const checkpointPath = join(cwd, "checkpoint.json");
try {
  const hold = await session.acquireCheckpoint({ boundary: "settled", signal: AbortSignal.timeout(10000), quiesce: () => () => {} });
  try {
    assert.equal(hold.sleepReady, true, hold.sleepBlockers.join("; "));
    const marker = hold.checkpoint.entries.find(entry => entry.customType === "fork-smoke");
    assert.equal(realpathSync(marker.data.packageDir), expected);
    writeSessionCheckpoint(checkpointPath, hold.checkpoint);
  } finally { hold.release(); }
} finally { session.dispose(); }
const checkpoint = readSessionCheckpoint(checkpointPath);
const restored = await create(checkpoint);
try {
  assert.equal(restored.sessionId, checkpoint.selection.sessionId);
  assert.equal(restored.sessionManager.getLeafId(), checkpoint.selection.leafId);
  assert.equal(restored.model, undefined);
  assert.deepEqual(restored.getActiveToolNames(), checkpoint.selection.activeTools);
} finally { restored.dispose(); }
console.log("Installed SDK, extension identity and native checkpoint restore passed.");
`);
		run(tools.node, [entry], { cwd: env.HOME, env, timeout: 60_000 });
	} finally {
		rmSync(entry, { force: true });
		rmSync(extension, { force: true });
	}
}

function printUsage() {
	console.log(`Usage: node scripts/install-fork.mjs [--ref <commit>] [--source-archive <file>] [--stage]
       node scripts/install-fork.mjs --activate <identity>
       node scripts/install-fork.mjs --rollback <identity>

Builds an exact local commit (default HEAD) with the checkout's ALREADY hydrated
model-data snapshot using create-source-archive.sh and build:offline. Prefer the
reviewed CI --source-archive with its adjacent source.commit to reuse exactly the
validated input. No fetch or model generation. npm may download frozen dependencies. Requires Node with npm
installed alongside it, Git, tar, and tmux for required real-terminal validation.

--source-archive <file> Use a frozen CI archive and adjacent source.commit
--stage                 Build/install/validate without changing the selector
--activate <identity>   Select an existing validated release, without rebuilding
--rollback <identity>   Select an older validated release (same native operation)
--releases <directory>  Default: ~/.local/share/pi-fork/releases
--selector <symlink>    Default: ~/.local/share/npm-global/lib/node_modules/${codingAgentName}
--help                  Show this help

Selection atomically replaces only the package symlink; its old target is kept
at <selector>.previous. Existing releases and user settings/auth/sessions are
never edited. Run native pi restart --runtime <printed package directory> from
the current session separately, then verify its loaded identity.
`);
}

export async function main(args = process.argv.slice(2)) {
	const options = {
		ref: "HEAD", stage: false,
		releases: join(homedir(), ".local/share/pi-fork/releases"),
		selector: join(homedir(), ".local/share/npm-global/lib/node_modules", codingAgentName),
	};
	let selection;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") { printUsage(); return; }
		if (arg === "--stage") { options.stage = true; continue; }
		if (!["--ref", "--source-archive", "--releases", "--selector", "--activate", "--rollback"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
		if (arg === "--activate" || arg === "--rollback") {
			if (selection) throw new Error("Choose only one activation operation");
			selection = value;
		} else options[arg.slice(2)] = value;
	}
	options.releases = resolve(options.releases);
	options.selector = resolve(options.selector);
	if (selection && (options.stage || args.includes("--ref") || options["source-archive"])) {
		throw new Error("Activation cannot combine with --stage, --ref or --source-archive");
	}
	if (selection) {
		const result = activateRelease(options.releases, selection, options.selector);
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
			run(tools.node, [tools.npm, "run", "build:offline"], { cwd: source, env });
			const packages = getPublicWorkspacePackages(join(source, "packages"));
			const tarballs = packReleasePackages(packages, join(directory, "tarballs"), { npm: tools.npm, env });
			installCodingAgentConsumer(directory, tarballs, tools.npm, { env });
			smokeTestInstalledRuntime(directory, tools, env);
			run(tools.node, [join(source, "node_modules/vitest/vitest.mjs"), "run", "test/restart-tui.test.ts", "--maxWorkers=1"], {
				cwd: join(source, "packages/coding-agent"),
				env: { ...env, PI_TEST_CLI: join(packagePath(directory), "dist/bundle/cli.js") },
			});
		});
		console.log(JSON.stringify(result, null, 2));
		return result;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
