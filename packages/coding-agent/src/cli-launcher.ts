#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { runCliLauncher } from "./cli/launcher.ts";

enableCompileCache();
runCliLauncher(process.argv.slice(2), process.argv[1]).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	},
);
