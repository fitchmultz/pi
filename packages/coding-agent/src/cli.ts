#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { runBackgroundCommandWorker } from "./extensions/background-command/jobs.ts";
import { main } from "./main.ts";

if (process.argv[2] === "--internal-background-command") {
	await runBackgroundCommandWorker(process.argv[3]);
} else {
	setupCli();
	main(process.argv.slice(2));
}
