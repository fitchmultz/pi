import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getPackageDir, isBunRuntime, PACKAGE_NAME } from "../config.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./child-process.ts";

/** Bootstrap a pinned fork checkout; the fork installer owns validation and atomic selection. */
export async function runForkUpdate(): Promise<void> {
	if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
		throw new Error("pi update --fork supports macOS and Linux on arm64/x64 only; Windows is not supported.");
	}
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (isBunRuntime || major < 22 || (major === 22 && minor < 19)) {
		throw new Error("pi update --fork requires Node.js >=22.19 with npm installed alongside Node (not Bun).");
	}
	const node = realpathSync(process.execPath);
	const npm = join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js");
	try {
		accessSync(npm, constants.R_OK);
	} catch {
		throw new Error(`pi update --fork requires npm installed alongside Node: ${npm}`);
	}
	const capture = (command: string, args: string[], cwd?: string, env = process.env): string => {
		const result = spawnProcessSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
		if (result.error || result.status !== 0) {
			throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
		}
		return result.stdout.trim();
	};
	const globalRoot = capture(node, [npm, "root", "-g"]);
	if (!isAbsolute(globalRoot) || !globalRoot.endsWith("/lib/node_modules")) {
		throw new Error(`Unsupported npm global layout: ${globalRoot}`);
	}
	const selector = join(globalRoot, PACKAGE_NAME);
	const bin = resolve(globalRoot, "../../bin/pi");
	try {
		if (!lstatSync(selector).isSymbolicLink()) {
			throw new Error(
				"the package must already be an immutable fork selector symlink; ordinary npm directories are not migrated",
			);
		}
		if (realpathSync(selector) !== realpathSync(getPackageDir())) {
			throw new Error("npm root -g does not select this running Pi installation");
		}
		if (resolve(dirname(bin), readlinkSync(bin)) !== join(selector, "dist/bundle/cli.js")) {
			throw new Error("the npm bin/pi symlink must point through the package selector to dist/bundle/cli.js");
		}
		accessSync(dirname(selector), constants.W_OK);
		try {
			if (!lstatSync(`${selector}.previous`).isSymbolicLink())
				throw new Error("the .previous backup is not a symlink");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	} catch (error) {
		throw new Error(
			`Cannot safely update ${selector}: ${error instanceof Error ? error.message : String(error)}. Initial setup: https://github.com/fitchmultz/pi/blob/main/FORK.md#immutable-installation-and-activation (the installation was not changed).`,
		);
	}
	for (const [command, args] of [
		["git", ["--version"]],
		["bash", ["--version"]],
		["tar", ["--version"]],
		["gzip", ["--version"]],
		["tmux", ["-V"]],
	] as const) {
		capture(command, [...args]);
	}

	const releaseLock = await lockfile.lock(selector, { realpath: false });
	let temporary: string | undefined;
	try {
		temporary = mkdtempSync(join(tmpdir(), "pi-fork-update-"));
		const home = join(temporary, "home");
		const source = join(temporary, "source");
		mkdirSync(home);
		mkdirSync(source);
		// Do not expose real settings, credentials, Git hooks/config, or npm lifecycle hooks to the build.
		const env: NodeJS.ProcessEnv = {
			PATH: `${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_CACHE_HOME: join(home, "cache"),
			XDG_DATA_HOME: join(home, "data"),
			PI_CODING_AGENT_DIR: join(home, "agent"),
			PI_TELEMETRY: "0",
			HUSKY: "0",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			npm_config_cache: join(home, "npm-cache"),
			npm_config_userconfig: join(home, ".npmrc"),
		};
		const run = async (command: string, args: string[]): Promise<void> => {
			console.log(`$ ${[command, ...args].join(" ")}`);
			const code = await waitForChildProcess(spawnProcess(command, args, { cwd: source, env, stdio: "inherit" }));
			if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`);
		};
		await run("git", ["init", "--quiet"]);
		await run("git", ["fetch", "--depth=1", "https://github.com/fitchmultz/pi.git", "refs/heads/main"]);
		const commit = capture("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], source, env);
		if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid fork main commit: ${commit}`);
		console.log(`Installing fitchmultz/pi main at ${commit}`);
		await run("git", ["checkout", "--detach", commit]);
		await run(node, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
		await run(node, [npm, "run", "hydrate:model-data"]);
		await run(node, [
			join(source, "scripts/install-fork.mjs"),
			"--ref",
			commit,
			"--selector",
			selector,
			"--releases",
			join(homedir(), ".local/share/pi-fork/releases"),
		]);
		console.log(`Fork commit ${commit} is active. Rollback selector (when available): ${selector}.previous`);
		console.log(
			"Running sessions are unchanged. Fully relaunch pi, or use pi restart from a selector-following session and verify the loaded runtime.",
		);
	} finally {
		try {
			if (temporary) rmSync(temporary, { recursive: true, force: true });
		} finally {
			await releaseLock();
		}
	}
}
