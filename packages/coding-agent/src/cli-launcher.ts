#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { runCliLauncher } from "./cli/launcher.ts";

enableCompileCache();
runCliLauncher(process.argv.slice(2), process.argv[1]).then(
	(code) => {
		if (process.platform !== "win32") process.on("SIGHUP", () => {});
		process.exitCode = code;
	},
	(error: unknown) => {
		if (process.platform !== "win32") process.on("SIGHUP", () => {});
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	},
);
