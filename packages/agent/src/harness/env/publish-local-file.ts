import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readlink, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** Resolve a local file target, including a dangling final symlink. Its parent must exist. */
export async function resolveLocalFileTarget(absolutePath: string): Promise<string> {
	if (!isAbsolute(absolutePath)) throw new Error("Expected an absolute file path");
	let target = absolutePath;
	const links = new Set<string>();
	for (;;) {
		// A trailing separator requires an existing directory, never a new regular file.
		if (target.endsWith(sep) || target.endsWith("/")) {
			await stat(target);
			return realpath(target);
		}
		const parentInput = dirname(target);
		// realpath alone can accept regular-file/.. on macOS; stat checks traversal.
		const parentInfo = await stat(parentInput);
		if (!parentInfo.isDirectory()) {
			throw Object.assign(new Error(`Not a directory: ${parentInput}`), { code: "ENOTDIR" });
		}
		const parent = await realpath(parentInput);
		target = join(parent, basename(target));
		const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (!info) return target;
		if (!info.isSymbolicLink()) return realpath(target);
		if (links.has(target)) {
			throw Object.assign(new Error(`Symlink cycle: ${absolutePath}`), { code: "ELOOP" });
		}
		links.add(target);
		const link = await readlink(target);
		// Preserve ".." until realpath has followed any preceding directory symlinks.
		target = isAbsolute(link) ? link : `${parent}${sep}${link}`;
	}
}

/**
 * Publish complete bytes by replacing a local file in its existing directory.
 * Follows symlinks and preserves ordinary mode/uid/gid, or fails before publication.
 * Hardlink aliases/open handles keep the old file; ACLs/xattrs and crash durability are not guaranteed.
 * Callers own parent creation and read/plan/publish serialization. After rename submission,
 * its actual result wins over cancellation; a successful publication is never rolled back.
 */
export async function publishLocalFile(
	absolutePath: string,
	content: string | Uint8Array,
	signal?: AbortSignal,
): Promise<void> {
	const throwIfAborted = () => {
		if (signal?.aborted) {
			throw Object.assign(new Error("Operation aborted", { cause: signal.reason }), { code: "ABORT_ERR" });
		}
	};
	throwIfAborted();
	const target = await resolveLocalFileTarget(absolutePath);
	const previous = await lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (previous && !previous.isFile()) {
		throw Object.assign(new Error(`Cannot publish to a non-regular file: ${target}`), {
			code: previous.isDirectory() ? "EISDIR" : "EINVAL",
			path: target,
		});
	}
	if (previous) await access(target, constants.W_OK);
	throwIfAborted();
	const stage = join(dirname(target), `.pi-write-${randomUUID()}`);
	// A failed exclusive open must never clean up a file we did not create.
	const file = await open(stage, "wx", previous ? 0o600 : 0o666);
	try {
		await file.writeFile(content, { signal });
		if (previous) {
			const staged = await file.stat();
			if (staged.uid !== previous.uid || staged.gid !== previous.gid) {
				await file.chown(previous.uid, previous.gid);
			}
			await file.chmod(previous.mode & 0o777);
		}
		await file.close();
		throwIfAborted();
		await rename(stage, target);
	} catch (error) {
		await file.close().catch(() => {});
		await unlink(stage).catch(() => {});
		throw error;
	}
}
