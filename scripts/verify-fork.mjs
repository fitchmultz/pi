#!/usr/bin/env node

// Offline validation for a task worktree or candidate release. Callers install
// frozen dependencies and hydrate model data first.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--suite" || !["full", "runtime"].includes(args[1]))) {
	console.error("Usage: node scripts/verify-fork.mjs [--suite full|runtime]");
	process.exit(1);
}
const suite = args[1] ?? "full";
const nodeBin = dirname(process.execPath);
const npm = realpathSync(join(nodeBin, "npm"));
const env = { ...process.env, PATH: `${nodeBin}:${process.env.PATH}` };
function run(command, args, cwd = root, extraEnv = {}) {
	execFileSync(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: "inherit" });
}

try {
	// restart-tui.test.ts normally skips without tmux. Delivery must not.
	run("tmux", ["-V"]);
	run(npm, ["run", "check:model-data"]);
	run(npm, ["run", "build:offline"]);
	if (suite === "full") run(npm, ["run", "check"]);
	const cli = join(root, "packages/coding-agent/dist/bundle/cli.js");
	if (!existsSync(cli)) throw new Error(`Missing bundled CLI: ${cli}`);
	const testEnv = { PI_TEST_CLI: cli };
	if (suite === "full") {
		run("bash", [join(root, "test.sh")], root, testEnv);
	} else {
		run("bash", [join(root, "test.sh"), "--", process.execPath,
			join(root, "node_modules/vitest/dist/cli.js"), "--run",
			"test/restart-launcher.test.ts", "test/restart-tui.test.ts",
			"test/suite/restart-control.test.ts", "test/suite/checkpoint.test.ts",
			"test/suite/checkpoint-cli.test.ts"],
			join(root, "packages/coding-agent"), testEnv);
	}
} catch (error) {
	console.error(`Fork verification failed: ${error.message}`);
	process.exit(1);
}
