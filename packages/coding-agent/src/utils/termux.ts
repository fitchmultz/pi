import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Termux owns Bash; version-managed Node installations need not contain a shell. */
export function getTermuxBash(): string {
	const prefix = process.env.PREFIX;
	if (!prefix || !isAbsolute(prefix)) {
		throw new Error("Termux requires an absolute PREFIX pointing to its native installation.");
	}
	const bash = join(prefix, "bin/bash");
	try {
		accessSync(bash, constants.X_OK);
	} catch {
		throw new Error(`Termux requires executable Bash at ${bash}; run pkg install bash and check PREFIX.`);
	}
	return bash;
}
