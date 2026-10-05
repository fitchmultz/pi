import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";

/** The daemon built by `cargo build` in ../daemon; tests talk to it over a pipe instead of SSH. */
const daemon = resolve(
	import.meta.dirname,
	`../daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`,
);
if (!existsSync(daemon))
	throw new Error(`Build the daemon first: npm run build:daemon in packages/env (missing ${daemon})`);

const connection = new Connection({ command: [daemon] });
afterAll(() => connection.close());

const windows = process.platform === "win32";
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");

registerEnvConformance(
	{ describe, expect, it },
	"RemoteExecutionEnv over a pipe",
	async (use) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-env-conformance-"));
		try {
			await use(new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd, watchIntervalMs: 100 }));
		} finally {
			// On Windows a killed command's processes can hold the directory for a moment.
			rmSync(cwd, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
		}
	},
	// Git Bash's `ln -s` copies instead of linking unless native symlinks are enabled.
	windows ? { shell: [gitBash, "-c"], symlinks: false } : {},
);
