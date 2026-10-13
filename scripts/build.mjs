#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
	console.log(`Usage: node scripts/build.mjs [--offline]

Build all runtime packages in dependency order, with up to two builds at once.
--offline  Use already hydrated model data; do not refresh the catalog.
-h, --help Show this help.

Examples: npm run build
          npm run build:offline
Exit codes: 0 success, 1 invalid options, otherwise the failed build's exit code.`);
	process.exit(0);
}
if (args.some((arg) => arg !== "--offline")) {
	console.error(`Unknown option: ${args.find((arg) => arg !== "--offline")}`);
	process.exit(1);
}

const root = realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
const packages = new Map([
	"chord", "tui", "telemetry", "codemode", "mcp", "ai", "durable",
	"env", "agent", "coding-agent",
].map((name) => [name, JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"))]));
const localNames = new Set([...packages.values()].map((pkg) => pkg.name));
const pending = new Map(packages);
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
		const script = name === "ai" && args.includes("--offline") ? "build:offline" : "build";
		running.set(name, new Promise((resolve) => {
			// Go's os.Getwd honors inherited PWD, even when its casing differs from native realpath.
			const child = spawn("npm", ["run", script], {
				cwd,
				env: { ...process.env, PWD: cwd },
				stdio: "inherit",
				shell: process.platform === "win32",
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
