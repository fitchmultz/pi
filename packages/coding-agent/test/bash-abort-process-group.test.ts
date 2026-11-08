import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

function groupHasMembers(group: number): boolean {
	try {
		process.kill(-group, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("aborting a bash command", () => {
	// Each round aborts at the first output, which arrives while the shell starts `sleep`. macOS can miss a process that
	// is being forked when it kills a group; most rounds miss that moment, so several run.
	it("also stops the step the shell is starting", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-bash-abort-"));
		const groups: number[] = [];
		try {
			for (let round = 0; round < 20; round++) {
				const controller = new AbortController();
				await expect(
					createLocalBashOperations().exec(`echo $$ > group-${round}.pid; echo started; sleep 5`, cwd, {
						onData: () => controller.abort(),
						signal: controller.signal,
					}),
				).rejects.toThrow("aborted");
				const group = Number.parseInt(readFileSync(join(cwd, `group-${round}.pid`), "utf8"), 10);
				groups.push(group);
				// The whole group ends at once; a `sleep` that escaped the kill would stay for five seconds.
				const goneBy = Date.now() + 1000;
				while (groupHasMembers(group)) {
					expect(Date.now(), `process group ${group} still has members`).toBeLessThan(goneBy);
					await delay(20);
				}
			}
		} finally {
			for (const group of groups) {
				try {
					process.kill(-group, "SIGKILL");
				} catch {}
			}
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});
