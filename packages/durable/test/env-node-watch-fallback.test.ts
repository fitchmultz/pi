import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FileChange, getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

const context = BACKGROUND_CONTEXT;
const limit = vi.hoisted(() => ({ watches: Number.POSITIVE_INFINITY }));

// The system's watch limit: past `limit.watches`, `fs.watch` fails as Linux does when inotify runs out of watches.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	const watch = (...args: unknown[]): Fs.FSWatcher => {
		if (limit.watches <= 0) {
			throw Object.assign(new Error("ENOSPC: System limit for number of file watchers reached, watch"), {
				code: "ENOSPC",
			});
		}
		limit.watches--;
		return Reflect.apply(actual.watch, actual, args) as Fs.FSWatcher;
	};
	return { ...actual, watch: watch as typeof Fs.watch };
});

describe("NodeExecutionEnv watch fallback", () => {
	afterEach(() => {
		limit.watches = Number.POSITIVE_INFINITY;
		vi.useRealTimers();
	});

	it("polls on one timer after the system refuses a watch while opening, and stop releases it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-durable-env-watch-fallback-"));
		try {
			mkdirSync(join(cwd, "tree", "a"), { recursive: true });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			// The first watch succeeds; the next one finds the limit reached.
			limit.watches = 1;
			const changes: FileChange[] = [];
			const env = new NodeExecutionEnv({ cwd, watch: { mode: "native", pollIntervalMs: 100 } });
			const watcher = getOrThrow(
				await env.watch([{ path: "tree", recursive: true }], (change) => changes.push(change), context),
			);
			expect(watcher.mode).toBe("polling");
			expect(changes).toEqual([{ kind: "overflow" }]);
			expect(vi.getTimerCount()).toBe(1);

			await watcher.stop(context);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
