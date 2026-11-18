#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	strict: true,
	options: {
		offline: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});
if (values.help) {
	console.log(`Usage: node scripts/build.mjs [--offline] [package...]

Build runtime packages and their local dependencies in topological order, with up to two builds at once.
--offline  Use already hydrated model data; do not refresh the catalog.
-h, --help Show this help.

Examples: npm run build
          npm run build:offline
          node scripts/build.mjs chord durable
Exit codes: 0 success, 1 invalid options, otherwise the failed build's exit code.`);
	process.exit(0);
}

const root = realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
const packages = new Map([
	"schema", "chord", "tui", "telemetry", "codemode", "mcp", "ai", "durable",
	"env", "agent", "coding-agent",
].map((name) => [name, JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"))]));
const byPackageName = new Map([...packages].map(([dir, pkg]) => [pkg.name, dir]));
const selectedDirs = new Set();
if (positionals.length === 0) {
	for (const dir of packages.keys()) selectedDirs.add(dir);
} else {
	const queue = [...positionals];
	while (queue.length > 0) {
		const target = queue.shift();
		if (!packages.has(target)) {
			console.error(`Unknown package: ${target}`);
			process.exit(1);
		}
		if (selectedDirs.has(target)) continue;
		selectedDirs.add(target);
		for (const dep of Object.keys(packages.get(target).dependencies ?? {})) {
			const depDir = byPackageName.get(dep);
			if (depDir) queue.push(depDir);
		}
	}
}

const localNames = new Set([...selectedDirs].map((dir) => packages.get(dir).name));
const pending = new Map([...selectedDirs].map((dir) => [dir, packages.get(dir)]));
const finished = new Set();
const running = new Map();
while (pending.size > 0 || running.size > 0) {
	for (const [name, pkg] of pending) {
		if (running.size >= 2) break;
		if (Object.keys(pkg.dependencies ?? {}).some((dependency) => localNames.has(dependency) && !finished.has(dependency))) {
			continue;
		}
		pending.delete(name);
		const cwd = join(root, "packages", name);
		const script = name === "ai" && values.offline ? "build:offline" : "build";
		running.set(name, new Promise((resolve) => {
			// Go's os.Getwd honors inherited PWD, even when its casing differs from native realpath.
			const child = spawn("npm", ["run", script], {
				cwd,
				env: { ...process.env, PWD: cwd },
				stdio: "inherit",
			});
			child.once("error", (error) => console.error(error.message));
			child.once("close", (code) => resolve({ name, code: code ?? 1 }));
		}));
	}
	if (running.size === 0) throw new Error("Cannot resolve runtime build dependencies");
	const { name, code } = await Promise.race(running.values());
	running.delete(name);
	if (code !== 0) {
		// Stop admitting work and join every started build before returning failure.
		await Promise.all(running.values());
		process.exitCode = code;
		break;
	}
	finished.add(packages.get(name).name);
}
