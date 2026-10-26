import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import * as childProcess from "../src/utils/child-process.ts";
import { runForkUpdate } from "../src/utils/fork-update.ts";

const platforms = ["darwin", "linux", "android"];

interface InstallerInvocation {
	script: string;
	args: string[];
	commit: string;
	env: NodeJS.ProcessEnv;
}

describe.skipIf(process.platform === "win32").each(platforms)("fork update bootstrap on %s", (platform) => {
	const originalPlatform = process.platform;
	let root: string;
	let selector: string;
	let bin: string;
	let oldPackage: string;
	let source: string;
	let expectedCommit: string;
	let temporarySource: string | undefined;
	let failInstall: boolean;
	let failPrune: boolean;
	let realNpm: boolean;
	let npmOutput: string;
	let fetched: number;
	let originalExitCode: typeof process.exitCode;
	let invocationsFile: string;
	const readInvocations = (): InstallerInvocation[] =>
		readFileSync(invocationsFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as InstallerInvocation);

	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		root = mkdtempSync(join(tmpdir(), "pi-fork-bootstrap-test-"));
		const globalRoot = join(
			root,
			platform === "android"
				? "real-home/.local/share/npm-global/lib/node_modules"
				: "custom prefix/lib/node_modules",
		);
		selector = join(globalRoot, PACKAGE_NAME);
		oldPackage = join(root, "old-package");
		mkdirSync(dirname(selector), { recursive: true });
		mkdirSync(oldPackage);
		symlinkSync(oldPackage, selector);
		bin = join(root, platform === "android" ? "real-home/.local/bin/pi" : "custom prefix/bin/pi");
		mkdirSync(dirname(bin), { recursive: true });
		symlinkSync(join(selector, "dist/bundle/cli.js"), bin);
		vi.stubEnv("PI_PACKAGE_DIR", oldPackage);
		vi.stubEnv("HOME", join(root, "real-home"));
		vi.stubEnv("ANTHROPIC_API_KEY", "must-not-leak");
		vi.stubEnv("PI_RESTART_SOCKET", "must-not-leak");
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", join(root, "ambient-npmrc"));
		vi.stubEnv("PREFIX", join(root, "termux-prefix"));
		// An empty preload avoids loading a real Android library on the host.
		vi.stubEnv("LD_PRELOAD", "");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		temporarySource = undefined;
		failInstall = false;
		failPrune = false;
		realNpm = false;
		npmOutput = "";
		fetched = 0;
		invocationsFile = join(root, "installer-invocations.jsonl");

		source = join(root, "remote");
		mkdirSync(join(source, "scripts"), { recursive: true });
		writeFileSync(join(source, "marker"), "pinned main");
		// Observe the bootstrap boundary. Installer validation, atomic activation and
		// retention safeguards are exercised by scripts/install-fork.test.mjs.
		writeFileSync(
			join(source, "scripts/install-fork.mjs"),
			`
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(readFileSync('marker', 'utf8'), 'pinned main');
assert.equal(readFileSync('hydrated', 'utf8'), 'ready');
assert.equal(readFileSync(process.env.npm_config_globalconfig, 'utf8'), '');
assert.equal(process.env.NPM_CONFIG_GLOBALCONFIG, undefined);
assert.equal(process.env.npm_config_globalconfig, process.env.HOME + '/npm-globalconfig');
assert.equal(existsSync(${JSON.stringify(`${selector}.lock`)}), false, 'installer must acquire its own mutation lock');
if (!args.includes('--prune')) assert.equal(args[args.indexOf('--ref') + 1], commit);
appendFileSync(${JSON.stringify(invocationsFile)}, JSON.stringify({ script: process.argv[1], args, commit, env: process.env }) + '\\n');
`,
		);
		const git = (args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
		git(["init", "--quiet", "--initial-branch=main"]);
		git(["add", "."]);
		git([
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		]);
		expectedCommit = git(["rev-parse", "HEAD"]);
		vi.spyOn(childProcess, "spawnProcessSync").mockImplementation((command, args, options) => {
			if (args.includes("root") && args.includes("-g")) {
				return spawnSync(process.execPath, ["-e", `console.log(${JSON.stringify(globalRoot)})`], options);
			}
			// Missing prerequisites have their own case; CI need not have tmux installed.
			if (command === "tmux") return spawnSync(process.execPath, ["--version"], options);
			return spawnSync(command, args, options);
		});
		vi.spyOn(childProcess, "spawnProcess").mockImplementation((command, args, options) => {
			temporarySource = String(options.cwd);
			if (command === "git" && args[0] === "fetch") {
				fetched++;
				expect(args).toEqual(["fetch", "--depth=1", "https://github.com/fitchmultz/pi.git", "refs/heads/main"]);
				return spawn(command, ["fetch", "--depth=1", source, "refs/heads/main"], options);
			}
			if (args[0]?.endsWith("npm-cli.js")) {
				if (args[1] === "ci") {
					expect(args).toContain("--ignore-scripts");
					if (realNpm) {
						const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
						for (const stream of [child.stdout, child.stderr]) {
							stream.on("data", (chunk) => {
								npmOutput += chunk;
							});
						}
						return child;
					}
					return spawn(process.execPath, ["-e", "process.exit(0)"], options);
				}
				expect(args.slice(1)).toEqual(["run", "hydrate:model-data"]);
				// Advance remote main after fetch; use the fetched commit, not moving main.
				writeFileSync(join(source, "marker"), "newer main");
				git([
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.com",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"-am",
					"advance",
					"--quiet",
				]);
				return spawn(process.execPath, ["-e", "require('node:fs').writeFileSync('hydrated', 'ready')"], options);
			}
			if (failInstall && args[0]?.endsWith("install-fork.mjs")) {
				return spawn(process.execPath, ["-e", "process.exit(23)"], options);
			}
			if (failPrune && args.includes("--prune")) {
				return spawn(process.execPath, ["-e", "process.exit(42)"], options);
			}
			return spawn(command, args, options);
		});
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.exitCode = originalExitCode;
		rmSync(root, { recursive: true, force: true });
	});

	it("routes --fork without settings writes, pins fetched main, isolates the build, prunes and cleans up", async () => {
		expect(await handlePackageCommand(["update", "--fork"])).toBe(true);
		expect(process.exitCode).toBeUndefined();
		const [observed, prune, ...extra] = readInvocations();
		const location = ["--selector", selector, "--releases", join(root, "real-home/.local/share/pi-fork/releases")];
		const cacheDir = join(root, "real-home/.cache/pi-fork");
		expect(observed.commit).toBe(expectedCommit);
		expect(observed.args).toEqual([
			"--ref",
			expectedCommit,
			...location,
			"--cache-dir",
			cacheDir,
			"--accept-model-removals",
		]);
		expect(prune).toEqual({ ...observed, args: ["--prune", "--keep", "5", ...location] });
		expect(extra).toEqual([]);
		expect(readdirSync(join(cacheDir, "npm-logs"))).toEqual([]);
		expect(observed.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(observed.env.PI_RESTART_SOCKET).toBeUndefined();
		expect(observed.env.PI_PACKAGE_DIR).toBeUndefined();
		expect(observed.env.HOME).not.toBe(process.env.HOME);
		expect(observed.env.TMPDIR).toBe(join(observed.env.HOME!, "tmp"));
		expect(observed.env.PREFIX).toBe(platform === "android" ? process.env.PREFIX : undefined);
		expect(observed.env.LD_PRELOAD ?? "").toBe(platform === "android" ? process.env.LD_PRELOAD : "");
		expect(observed.env.npm_config_script_shell).toBe(
			platform === "android" ? join(dirname(process.execPath), "bash") : undefined,
		);
		expect(fetched).toBe(1);
		expect(readFileSync(join(root, "real-home/.local/share/pi-fork/releases/.owner-selector"), "utf8")).toBe(
			`${join(realpathSync(dirname(selector)), basename(selector))}\n`,
		);
		expect(existsSync(temporarySource!)).toBe(false);
		expect(existsSync(`${selector}.lock`)).toBe(false);
		expect(existsSync(join(process.env.HOME!, ".pi"))).toBe(false);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("reports installer failure without success or pruning, leaves the selector and cleans up", async () => {
		failInstall = true;
		await handlePackageCommand(["update", "--fork"]);
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("exited with code 23"));
		expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Fork commit"));
		expect(existsSync(invocationsFile)).toBe(false);
		expect(readlinkSync(selector)).toBe(oldPackage);
		expect(existsSync(temporarySource!)).toBe(false);
		expect(existsSync(`${selector}.lock`)).toBe(false);
	});

	// #285: a failed npm ci must leave npm's printed debug log readable, even while another
	// process using the shared cache runs more than npm's default ten logged commands, and a
	// retry must reuse the locked package it already downloaded.
	it.runIf(platform === process.platform)(
		"keeps npm's failure log private and reuses cached locked packages across failed updates",
		async () => {
			const cacheDir = join(root, "real-home/.cache/pi-fork");
			const packageRoot = join(root, "registry");
			mkdirSync(join(packageRoot, "package"), { recursive: true });
			writeFileSync(
				join(packageRoot, "package/package.json"),
				JSON.stringify({ name: "available", version: "1.0.0" }),
			);
			execFileSync("tar", ["-czf", join(packageRoot, "available.tgz"), "-C", packageRoot, "package"]);
			const archive = readFileSync(join(packageRoot, "available.tgz"));
			const requests: string[] = [];
			const missingReleased = Promise.withResolvers<void>();
			const firstMissingRequest = Promise.withResolvers<void>();
			const server = createServer(async (request, response) => {
				requests.push(request.url ?? "");
				if (request.url === "/available.tgz") {
					response.end(archive);
					return;
				}
				if (requests.filter((url) => url === "/missing.tgz").length === 1) {
					firstMissingRequest.resolve();
					await missingReleased.promise;
				}
				response.statusCode = 404;
				response.end();
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			let update: Promise<boolean> | undefined;
			try {
				const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
				const integrity = (data: string | Buffer) => `sha512-${createHash("sha512").update(data).digest("base64")}`;
				const dependencies = { available: "1.0.0", missing: "1.0.0" };
				writeFileSync(
					join(source, "package.json"),
					JSON.stringify({ name: "fixture", version: "1.0.0", dependencies }),
				);
				writeFileSync(
					join(source, "package-lock.json"),
					JSON.stringify({
						name: "fixture",
						version: "1.0.0",
						lockfileVersion: 3,
						requires: true,
						packages: {
							"": { name: "fixture", version: "1.0.0", dependencies },
							"node_modules/available": {
								version: "1.0.0",
								resolved: `${registry}/available.tgz`,
								integrity: integrity(archive),
							},
							"node_modules/missing": {
								version: "1.0.0",
								resolved: `${registry}/missing.tgz`,
								integrity: integrity("unavailable"),
							},
						},
					}),
				);
				const git = (args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" });
				git(["add", "package.json", "package-lock.json"]);
				git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "locked"]);
				const ambientCaches = [join(root, "ambient-npm-cache"), join(root, "ambient-userconfig-cache")];
				writeFileSync(join(root, "ambient-userconfig"), `cache=${ambientCaches[1]}\n`);
				vi.stubEnv("NPM_CONFIG_CACHE", ambientCaches[0]);
				vi.stubEnv("NPM_CONFIG_USERCONFIG", join(root, "ambient-userconfig"));
				realNpm = true;

				const npm = join(dirname(realpathSync(process.execPath)), "../lib/node_modules/npm/bin/npm-cli.js");
				for (const file of ["other-userconfig", "other-globalconfig"]) writeFileSync(join(root, file), "");
				const otherNpmUser = {
					PATH: process.env.PATH,
					HOME: root,
					npm_config_cache: join(cacheDir, "npm-cache"),
					npm_config_userconfig: join(root, "other-userconfig"),
					npm_config_globalconfig: join(root, "other-globalconfig"),
					npm_config_update_notifier: "false",
				};
				const failedLogs: string[] = [];
				for (const attempt of [1, 2]) {
					npmOutput = "";
					process.exitCode = undefined;
					update = handlePackageCommand(["update", "--fork"]);
					if (attempt === 1) {
						await firstMissingRequest.promise;
						for (let i = 0; i < 12; i++) {
							await promisify(execFile)(process.execPath, [npm, "config", "get", "cache"], {
								env: otherNpmUser,
							});
						}
						missingReleased.resolve();
					}
					await update;
					expect(process.exitCode).toBe(1);
					failedLogs.push(
						/A complete log of this run can be found in: (\S+)/.exec(npmOutput)?.[1] ?? "not printed",
					);
				}
				const mode = (path: string) => (existsSync(path) ? statSync(path).mode & 0o777 : "missing");
				expect({
					logs: failedLogs.map((log) => ({ kept: existsSync(log), directoryMode: mode(dirname(log)) })),
					cacheDirMode: mode(cacheDir),
					downloads: requests.filter((url) => url === "/available.tgz").length,
					missingRequests: requests.filter((url) => url === "/missing.tgz").length,
					ambientCaches: ambientCaches.filter((path) => existsSync(path)),
					selector: readlinkSync(selector),
					temporaryRemoved: !existsSync(temporarySource!),
				}).toEqual({
					logs: [
						{ kept: true, directoryMode: 0o700 },
						{ kept: true, directoryMode: 0o700 },
					],
					cacheDirMode: 0o700,
					downloads: 1,
					missingRequests: 2,
					ambientCaches: [],
					selector: oldPackage,
					temporaryRemoved: true,
				});
				expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/npm-cli\.js ci .*exited with code 1/));
			} finally {
				missingReleased.resolve();
				await update;
				server.closeAllConnections();
				await new Promise((resolve) => server.close(resolve));
			}
		},
		60_000,
	);

	it("keeps a successful update when pruning fails, warns and cleans up", async () => {
		failPrune = true;
		await handlePackageCommand(["update", "--fork"]);
		expect(process.exitCode).toBeUndefined();
		expect(console.error).not.toHaveBeenCalled();
		expect(readInvocations().map(({ args }) => args[0])).toEqual(["--ref"]);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Fork commit ${expectedCommit} is active`));
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringMatching(/update succeeded.*cleanup.*exited with code 42/),
		);
		expect(existsSync(temporarySource!)).toBe(false);
		expect(existsSync(`${selector}.lock`)).toBe(false);
	});

	it("revalidates selection after acquiring the shared mutation lock", async () => {
		const acquire = lockfile.lock.bind(lockfile);
		vi.spyOn(lockfile, "lock").mockImplementation(async (path, options) => {
			const release = await acquire(path, options);
			rmSync(selector);
			symlinkSync(root, selector);
			return release;
		});
		await expect(runForkUpdate()).rejects.toThrow("does not select this running Pi installation");
		expect(childProcess.spawnProcess).not.toHaveBeenCalled();
		expect(existsSync(`${selector}.lock`)).toBe(false);
	});

	it("refuses a store owned by another selector before fetching or changing the installation", async () => {
		const releases = join(root, "real-home/.local/share/pi-fork/releases");
		mkdirSync(releases, { recursive: true });
		const owner = join(root, "other-selector");
		writeFileSync(join(releases, ".owner-selector"), `${owner}\n`);
		await expect(runForkUpdate()).rejects.toThrow(/owned by selector .*Use a separate release store/);
		expect(childProcess.spawnProcess).not.toHaveBeenCalled();
		expect(readlinkSync(selector)).toBe(oldPackage);
		expect(readFileSync(join(releases, ".owner-selector"), "utf8")).toBe(`${owner}\n`);
		expect(existsSync(`${selector}.lock`)).toBe(false);
	});

	it.each([
		["--self"],
		["--all"],
		["--extensions"],
		["--models"],
		["--force"],
		["pi"],
		["self"],
		["npm:example"],
		["--extension", "npm:example"],
	])("rejects --fork combined with %s before running commands", async (...target) => {
		await handlePackageCommand(["update", "--fork", ...target]);
		expect(process.exitCode).toBe(1);
		expect(childProcess.spawnProcessSync).not.toHaveBeenCalled();
		expect(childProcess.spawnProcess).not.toHaveBeenCalled();
	});

	it("documents the limited support in help without downloads", async () => {
		await handlePackageCommand(["update", "--fork", "--help"]);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ordinary npm directories"));
		expect(childProcess.spawnProcess).not.toHaveBeenCalled();
	});

	it.each(["directory", "other-runtime", "bin-bypass", "backup-file"])(
		"refuses unsafe %s layout before fetch",
		async (layout) => {
			if (layout === "directory") {
				rmSync(selector);
				mkdirSync(selector);
			} else if (layout === "other-runtime") {
				vi.stubEnv("PI_PACKAGE_DIR", root);
			} else if (layout === "bin-bypass") {
				rmSync(bin);
				symlinkSync(join(oldPackage, "dist/bundle/cli.js"), bin);
			} else writeFileSync(`${selector}.previous`, "unrelated");
			await expect(runForkUpdate()).rejects.toThrow(/Cannot safely update.*Initial setup:/);
			expect(childProcess.spawnProcess).not.toHaveBeenCalled();
			expect(existsSync(invocationsFile)).toBe(false);
		},
	);

	it("fails missing prerequisites before downloads", async () => {
		vi.mocked(childProcess.spawnProcessSync).mockImplementation((command, _args, options) => {
			if (command === "git") return spawnSync("/no-such-pi-test-git", [], options);
			return spawnSync(
				process.execPath,
				["-e", `console.log(${JSON.stringify(dirname(dirname(selector)))})`],
				options,
			);
		});
		await expect(runForkUpdate()).rejects.toThrow(/git --version failed:.*ENOENT/);
		expect(childProcess.spawnProcess).not.toHaveBeenCalled();
	});
});

it("rejects Windows before invoking any subprocess", async () => {
	const platform = process.platform;
	const spy = vi.spyOn(childProcess, "spawnProcessSync");
	try {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		await expect(runForkUpdate()).rejects.toThrow("Windows is not supported");
		expect(spy).not.toHaveBeenCalled();
	} finally {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		spy.mockRestore();
	}
});
