import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

/** npm settings for one fork update or install attempt. */
export interface ForkNpmEnvironment {
	/** Shared across attempts; npm verifies cached packages against lockfile integrity. */
	npm_config_cache: string;
	/** Private to this attempt. Its owner removes it after success; failed attempts keep it. */
	npm_config_logs_dir: string;
	/** Nested npm commands must not rotate away a running parent's log. */
	npm_config_logs_max: "Infinity";
}

export function forkNpmEnvironment(cacheDir: string): ForkNpmEnvironment {
	mkdirSync(join(cacheDir, "npm-logs"), { recursive: true, mode: 0o700 });
	// npm writes world-readable cache and log files, and its log redaction is best effort.
	chmodSync(cacheDir, 0o700);
	return {
		npm_config_cache: join(cacheDir, "npm-cache"),
		npm_config_logs_dir: mkdtempSync(join(cacheDir, "npm-logs", "attempt-")),
		npm_config_logs_max: "Infinity",
	};
}
