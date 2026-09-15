import { parentPort, workerData } from "node:worker_threads";
import lockfile from "proper-lockfile";
import { FileSettingsStorage, SettingsManager } from "../../src/core/settings-manager.ts";

const {
	cwd,
	agentDir,
	first,
	barrier: buffer,
} = workerData as {
	cwd: string;
	agentDir: string;
	first: boolean;
	barrier: SharedArrayBuffer;
};
const barrier = new Int32Array(buffer);
function releaseFirstWriter(): void {
	Atomics.store(barrier, 0, 1);
	Atomics.notify(barrier, 0);
}

if (!first) {
	// Observe real contention, without replacing locking or its retry behavior.
	// Release A when B blocks; on the broken path, release A only after B saves.
	const acquire = lockfile.lockSync;
	lockfile.lockSync = (...args) => {
		try {
			return acquire(...args);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOCKED") releaseFirstWriter();
			throw error;
		}
	};
}

const disk = new FileSettingsStorage(cwd, agentDir);
let writes = 0;
const manager = SettingsManager.fromStorage({
	withLock(scope, fn, options) {
		disk.withLock(
			scope,
			(current) => {
				const next = fn(current);
				if (next !== undefined) {
					writes++;
					if (first) {
						parentPort!.postMessage("computed");
						if (Atomics.wait(barrier, 0, 0, 5000) === "timed-out") throw new Error("Writer B did not run");
					}
				}
				return next;
			},
			options,
		);
	},
});
parentPort!.once("message", async () => {
	if (first) manager.setDefaultThinkingLevel("high");
	else manager.setTheme("dark");
	await manager.flush();
	if (!first) releaseFirstWriter();
	parentPort!.postMessage({ writes, errors: manager.drainErrors().map(({ error }) => error.message) });
	parentPort!.close();
});
parentPort!.postMessage("ready");
