import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import * as childProcess from "../src/utils/child-process.ts";
import { runForkUpdate } from "../src/utils/fork-update.ts";

describe.skipIf(process.platform === "win32")("fork update bootstrap", () => {
	let root: string;
	let selector: string;
	let oldPackage: string;
	let source: string;
	let expectedCommit: string;
	let temporarySource: string | undefined;
	let failInstall: boolean;
	let fetched: number;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		root = mkdtempSync(join(tmpdir(), "pi-fork-bootstrap-test-"));
		const globalRoot = join(root, "custom prefix/lib/node_modules");
		selector = join(globalRoot, PACKAGE_NAME);
		oldPackage = join(root, "old-package");
		mkdirSync(dirname(selector), { recursive: true });
		mkdirSync(oldPackage);
		symlinkSync(oldPackage, selector);
		const bin = join(root, "custom prefix/bin/pi");
		mkdirSync(dirname(bin));
		symlinkSync(join(selector, "dist/bundle/cli.js"), bin);
		vi.stubEnv("PI_PACKAGE_DIR", oldPackage);
		vi.stubEnv("HOME", join(root, "real-home"));
		vi.stubEnv("ANTHROPIC_API_KEY", "must-not-leak");
		vi.stubEnv("PI_RESTART_SOCKET", "must-not-leak");
		vi.stubEnv("NODE_OPTIONS", "");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		temporarySource = undefined;
		failInstall = false;
		fetched = 0;

		source = join(root, "remote");
		mkdirSync(join(source, "scripts"), { recursive: true });
		writeFileSync(join(source, "marker"), "pinned main");
		// This fixture observes only the bootstrap boundary. Real installer validation,
		// atomic activation and rollback are owned by scripts/install-fork.test.mjs.
		writeFileSync(
			join(source, "scripts/install-fork.mjs"),
			`
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(args[args.indexOf('--ref') + 1], commit);
assert.equal(readFileSync('marker', 'utf8'), 'pinned main');
assert.equal(readFileSync('hydrated', 'utf8'), 'ready');
writeFileSync(${JSON.stringify(join(root, "observed.json"))}, JSON.stringify({ args, commit, env: process.env }));
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
			// Prerequisite availability is tested separately, not dependent on CI's tmux install.
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
					return spawn(process.execPath, ["-e", "process.exit(0)"], options);
				}
				expect(args.slice(1)).toEqual(["run", "hydrate:model-data"]);
				// Advance remote main after fetch; installation must still use the fetched commit.
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
			return spawn(command, args, options);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.exitCode = originalExitCode;
		rmSync(root, { recursive: true, force: true });
	});

	it("routes --fork without settings writes, pins fetched main, isolates the build and cleans up", async () => {
		expect(await handlePackageCommand(["update", "--fork"])).toBe(true);
		expect(process.exitCode).toBeUndefined();
		const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
		expect(observed.commit).toBe(expectedCommit);
		expect(observed.args).toEqual([
			"--ref",
			expectedCommit,
			"--selector",
			selector,
			"--releases",
			join(root, "real-home/.local/share/pi-fork/releases"),
		]);
		expect(observed.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(observed.env.PI_RESTART_SOCKET).toBeUndefined();
		expect(observed.env.PI_PACKAGE_DIR).toBeUndefined();
		expect(observed.env.HOME).not.toBe(process.env.HOME);
		expect(fetched).toBe(1);
		expect(existsSync(temporarySource!)).toBe(false);
		expect(existsSync(`${selector}.lock`)).toBe(false);
		expect(existsSync(process.env.HOME!)).toBe(false);
	});

	it("reports installer failure without success, leaves the selector and cleans up", async () => {
		failInstall = true;
		await handlePackageCommand(["update", "--fork"]);
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("exited with code 23"));
		expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Selected fork commit"));
		expect(readlinkSync(selector)).toBe(oldPackage);
		expect(existsSync(temporarySource!)).toBe(false);
		expect(existsSync(`${selector}.lock`)).toBe(false);
	});

	it.each(["--self", "--all", "--extensions", "--models", "--force", "pi", "npm:example"])(
		"rejects --fork combined with %s before running commands",
		async (target) => {
			await handlePackageCommand(["update", "--fork", target]);
			expect(process.exitCode).toBe(1);
			expect(childProcess.spawnProcessSync).not.toHaveBeenCalled();
			expect(childProcess.spawnProcess).not.toHaveBeenCalled();
		},
	);

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
				const bin = join(root, "custom prefix/bin/pi");
				rmSync(bin);
				symlinkSync(join(oldPackage, "dist/bundle/cli.js"), bin);
			} else writeFileSync(`${selector}.previous`, "unrelated");
			await expect(runForkUpdate()).rejects.toThrow(/Cannot safely update.*Initial setup:/);
			expect(childProcess.spawnProcess).not.toHaveBeenCalled();
			expect(existsSync(join(root, "observed.json"))).toBe(false);
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
