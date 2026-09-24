#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { runBackgroundCommandWorker } from "./core/background-command.ts";
import { main } from "./main.ts";

if (process.argv[2] === "--internal-background-command") {
	runBackgroundCommandWorker(process.argv[3]).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
} else {
	setupCli();
	main(process.argv.slice(2));
}
