import { randomUUID } from "crypto";
import {
	accessSync,
	closeSync,
	constants,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, isAbsolute, resolve } from "path";

/** Private capability files cannot follow links or expose contents to another user. */
export function assertPrivateFilePath(path: string): void {
	if (!isAbsolute(path) || realpathSync(dirname(path)) !== resolve(dirname(path)))
		throw new Error("Working-session paths must be absolute with a real parent directory");
	const parent = lstatSync(dirname(path));
	if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)
		throw new Error("Working-session directory must be owned by this user and not writable by others");
	const existing = lstatSync(path, { throwIfNoEntry: false });
	if (existing && (!existing.isFile() || existing.uid !== parent.uid || (existing.mode & 0o077) !== 0))
		throw new Error("Working-session destination must be a private regular file owned by this user");
}

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
