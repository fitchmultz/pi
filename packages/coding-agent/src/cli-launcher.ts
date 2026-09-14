#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runCliLauncher } from "./cli/launcher.ts";

runCliLauncher(process.argv.slice(2), fileURLToPath(import.meta.url)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	},
);
