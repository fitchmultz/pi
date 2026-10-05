#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
	console.log(`Usage: node scripts/build.mjs [--offline]

Build all runtime packages in dependency order.
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
for (const name of [
	"chord", "tui", "telemetry", "codemode", "mcp", "ai", "durable",
	"env", "agent", "protocol", "client", "server", "coding-agent",
]) {
	const cwd = join(root, "packages", name);
	const script = name === "ai" && args.includes("--offline") ? "build:offline" : "build";
	// Go's os.Getwd honors inherited PWD, even when its casing differs from native realpath.
	const result = spawnSync("npm", ["run", script], {
		cwd,
		env: { ...process.env, PWD: cwd },
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) console.error(result.error.message);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
