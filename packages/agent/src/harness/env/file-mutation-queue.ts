import { basename, dirname, join } from "node:path";
import { resolveLocalOperationPath } from "./local-path.ts";
import { resolveLocalFileTarget } from "./publish-local-file.ts";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

async function prospectiveTarget(path: string): Promise<string> {
	try {
		return await resolveLocalFileTarget(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		// Resolve each prospective parent before appending the next component. Retry
		// native lookup so missing/../symlink still follows the symlink.
		const candidate = join(await prospectiveTarget(parent), basename(path));
		try {
			return await resolveLocalFileTarget(candidate);
		} catch (retryError) {
			if ((retryError as NodeJS.ErrnoException).code !== "ENOENT") throw retryError;
			return candidate;
		}
	}
}

/** Content-target identity for local queues and ordered multi-file reservations. Never creates parents. */
export async function getFileMutationQueueKey(filePath: string): Promise<string> {
	const addressed = resolveLocalOperationPath(process.cwd(), filePath);
	try {
		return await prospectiveTarget(addressed);
	} catch (error) {
		// A custom backend may use a namespace that is invalid on this host.
		// Strict native validation belongs to the actual publisher, not registration.
		if ((error as NodeJS.ErrnoException).code !== "ENOTDIR" && (error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		return addressed;
	}
}

/** Serialize same-target local mutations in call order; distinct targets can run concurrently. */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getFileMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);
	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
	}
}
