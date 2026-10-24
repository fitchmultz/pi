import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getFileRevision, resolvePath } from "../utils/paths.ts";
import type { SessionInfo } from "./session-manager.ts";

const CACHE_DIRECTORY = ".session-list-cache-v1";

export function getSessionListCacheContext(): string | undefined {
	try {
		// Date parsing accepts local timestamps, so a cache cannot cross timezone or runtime changes.
		return JSON.stringify([
			process.versions.node,
			process.versions.icu,
			process.versions.tz,
			process.env.TZ,
			Intl.DateTimeFormat().resolvedOptions().timeZone,
		]);
	} catch {
		return undefined;
	}
}

export function createSessionListCacheContext(): () => string | undefined {
	let timezone: string | undefined;
	let formatter: typeof Intl.DateTimeFormat | undefined;
	let context: string | undefined;
	return () => {
		try {
			if (timezone !== process.env.TZ || formatter !== Intl.DateTimeFormat) {
				timezone = process.env.TZ;
				formatter = Intl.DateTimeFormat;
				context = getSessionListCacheContext();
			}
			return context;
		} catch {
			return undefined;
		}
	};
}

function cachePath(filePath: string): string {
	return join(dirname(resolvePath(filePath)), CACHE_DIRECTORY, `${basename(filePath).slice(0, -6)}.json`);
}

async function isPrivateDirectory(directory: string): Promise<boolean> {
	const stats = await lstat(directory);
	return (
		stats.isDirectory() &&
		(process.platform === "win32" || (stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readSessionListCache(
	filePath: string,
	revision: string | undefined,
	getContext: () => string | undefined,
	signal?: AbortSignal,
): Promise<SessionInfo | undefined> {
	if (!revision) return undefined;
	try {
		const path = cachePath(filePath);
		if (!(await isPrivateDirectory(dirname(path)))) return undefined;
		const record: unknown = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
		if (isRecord(record) && record.revision !== revision) {
			await unlink(path).catch(() => {});
			return undefined;
		}
		if (
			!isRecord(record) ||
			record.version !== 1 ||
			typeof record.context !== "string" ||
			record.context !== getContext() ||
			!isRecord(record.info)
		)
			return undefined;
		const info = record.info;
		if (
			typeof info.id !== "string" ||
			typeof info.cwd !== "string" ||
			(info.name !== undefined && typeof info.name !== "string") ||
			(info.parentSessionPath !== undefined && typeof info.parentSessionPath !== "string") ||
			typeof info.created !== "string" ||
			typeof info.modified !== "string" ||
			typeof info.messageCount !== "number" ||
			!Number.isSafeInteger(info.messageCount) ||
			info.messageCount < 0 ||
			typeof info.firstMessage !== "string" ||
			typeof info.allMessagesText !== "string"
		)
			return undefined;
		const created = new Date(info.created);
		const modified = new Date(info.modified);
		if (!Number.isFinite(created.getTime()) || !Number.isFinite(modified.getTime())) return undefined;
		return {
			path: filePath,
			id: info.id,
			cwd: info.cwd,
			name: info.name,
			parentSessionPath: info.parentSessionPath,
			created,
			modified,
			messageCount: info.messageCount,
			firstMessage: info.firstMessage,
			allMessagesText: info.allMessagesText,
		};
	} catch {
		// This derived index is disposable; source journals remain authoritative.
		return undefined;
	}
}

function cacheRecordName(name: string): string | undefined {
	if (name.endsWith(".json")) return name;
	return /^(.*\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.exec(name)?.[1];
}

export async function removeSessionListCache(filePath: string): Promise<void> {
	try {
		const path = cachePath(filePath);
		const directory = dirname(path);
		if (!(await isPrivateDirectory(directory))) return;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if ((entry.isFile() || entry.isSymbolicLink()) && cacheRecordName(entry.name) === basename(path)) {
				await unlink(join(directory, entry.name)).catch(() => {});
			}
		}
	} catch {
		// Cache cleanup cannot change listing or journal-deletion outcomes.
	}
}

export async function pruneSessionListCache(
	directory: string,
	sessionFiles: string[],
	signal?: AbortSignal,
): Promise<void> {
	try {
		const cache = join(resolvePath(directory), CACHE_DIRECTORY);
		if (!(await isPrivateDirectory(cache))) return;
		const sources = new Set(sessionFiles);
		for (const entry of await readdir(cache, { withFileTypes: true })) {
			signal?.throwIfAborted();
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const record = cacheRecordName(entry.name);
			if (!record) continue;
			const source = `${record.slice(0, -5)}.jsonl`;
			if (!sources.has(source)) {
				await unlink(join(cache, entry.name)).catch(() => {});
			}
		}
	} catch {
		// Missing or unwritable caches do not prevent source discovery.
	}
}

export async function writeSessionListCache(
	info: SessionInfo,
	revision: string,
	context: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!context || !Number.isFinite(info.created.getTime()) || !Number.isFinite(info.modified.getTime())) return;
	const destination = cachePath(info.path);
	const directory = dirname(destination);
	const temporary = `${destination}.${randomUUID()}.tmp`;
	let createdTemporary = false;
	try {
		signal?.throwIfAborted();
		await mkdir(directory, { recursive: true, mode: 0o700 });
		if (!(await isPrivateDirectory(directory))) return;
		const file = await open(temporary, "wx", 0o600);
		createdTemporary = true;
		try {
			await file.writeFile(JSON.stringify({ version: 1, revision, context, info }), { signal });
		} finally {
			await file.close();
		}
		// Unlike journal rewrites, cache publication must replace, not follow, a destination symlink.
		signal?.throwIfAborted();
		if (getFileRevision(info.path) !== revision || getSessionListCacheContext() !== context) return;
		await rename(temporary, destination);
		if (getFileRevision(info.path) !== revision) await removeSessionListCache(info.path);
	} catch {
		// Read-only/full/unavailable cache storage must not hide a successfully scanned session.
	} finally {
		if (createdTemporary) await unlink(temporary).catch(() => {});
	}
}
