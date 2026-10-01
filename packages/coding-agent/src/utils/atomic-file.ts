import { randomUUID } from "crypto";
import {
	accessSync,
	closeSync,
	constants,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	openSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, resolve } from "path";

/** Resolve existing or dangling file symlinks without creating their targets. */
export function resolveFileTarget(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Follow dangling symlinks too, without replacing the link itself.
	let target: string;
	try {
		target = readlinkSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EINVAL") return path;
		throw error;
	}
	return resolveFileTarget(resolve(dirname(path), target));
}

/** Replace a file only after its complete contents have been written and synced. */
export function atomicWriteFileSync(path: string, content: string | ((fd: number) => void)): void {
	const destination = resolveFileTarget(path);
	const existing = statSync(destination, { throwIfNoEntry: false });
	if (existing) accessSync(destination, constants.W_OK);
	const temporary = `${destination}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			if (existing) {
				const created = fstatSync(fd);
				if (created.uid !== existing.uid || created.gid !== existing.gid) {
					try {
						fchownSync(fd, existing.uid, existing.gid);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
					}
				}
			}
			// ponytail: ACLs, xattrs and security labels are not replicated; add platform-specific copying if required.
			if (typeof content === "string") writeFileSync(fd, content, "utf8");
			else content(fd);
			// Writing or changing ownership can clear special mode bits.
			fchmodSync(fd, existing ? existing.mode & 0o7777 : 0o600);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}
