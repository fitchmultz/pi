import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ForkNpmEnvironment {
	/** Shared across attempts; npm verifies cached packages against lockfile integrity. */
	npm_config_cache: string;
	/** Private to this attempt. Its owner removes it after success; failed attempts keep it. */
	npm_config_logs_dir: string;
	/** Nested npm commands must not rotate away a running parent's log. */
	npm_config_logs_max: "Infinity";
}

export function forkNpmEnvironment(cacheDir: string): ForkNpmEnvironment {
	const cache = join(cacheDir, "npm-cache");
	const logs = join(cacheDir, "npm-logs");
	for (const path of [cache, logs]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		// npm's log redaction is best effort, and cache contents may include private URLs.
		if ((statSync(path).mode & 0o077) !== 0) {
			throw new Error(
				`Expected private npm directory ${path}; set its permissions to 700 or choose another --cache-dir.`,
			);
		}
	}
	return {
		npm_config_cache: cache,
		npm_config_logs_dir: mkdtempSync(join(logs, "attempt-")),
		npm_config_logs_max: "Infinity",
	};
}

export function removeForkNpmLogs(logsDir: string): void {
	try {
		rmSync(logsDir, { recursive: true, force: true });
	} catch (error) {
		console.warn(
			`Could not remove npm logs at ${logsDir}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
