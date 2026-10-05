import { createHash } from "node:crypto";
import type { PlatformPath } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError, type FileWatcher, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import { type Json, RemoteError } from "./connection.ts";
import { type RemoteExecutionEnv, remotePath } from "./remote-env.ts";

const DEFAULT_INTERVAL_MS = 2000;
const MAX_DIRECTORIES = 10_000;
/** Recently modified small files are also compared by content: a second write within the file system's timestamp
 * granularity can keep size and modification time. */
const HASH_MAX_BYTES = 256 * 1024;
const HASH_RECENT_MS = 5000;

type RemoteInfo = {
	kind: "file" | "directory" | "symlink" | "other";
	size: number;
	mtimeSec: number;
	mtimeNsec: number;
	dev: number;
	ino: number;
};

class BudgetExceeded extends Error {}

function ancestorsOf(path: string, paths: PlatformPath): string[] {
	const result: string[] = [];
	for (let current = paths.dirname(path); ; current = paths.dirname(current)) {
		result.push(current);
		if (paths.dirname(current) === current) return result;
	}
}

function isWithin(path: string, ancestor: string, paths: PlatformPath): boolean {
	return path === ancestor || path.startsWith(ancestor.endsWith(paths.sep) ? ancestor : ancestor + paths.sep);
}

/**
 * A polling `FileWatcher` over the daemon's `lstat` and `readdir`: it compares snapshots of the watched paths at an
 * interval, with the same rules as `NodeExecutionEnv`'s watcher. A change undone between two snapshots can be missed;
 * a lost connection is reported as `overflow`.
 */
export class PollingWatcher implements FileWatcher {
	readonly mode = "polling" as const;
	readonly #env: RemoteExecutionEnv;
	readonly #targets: readonly WatchTarget[];
	readonly #onChange: (change: WatchChange) => void;
	readonly #intervalMs: number;
	readonly #paths: PlatformPath;
	#snapshot = new Map<string, string>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	#uncertain = false;
	#closed = false;

	private constructor(
		env: RemoteExecutionEnv,
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		intervalMs: number,
		paths: PlatformPath,
	) {
		this.#paths = paths;
		this.#env = env;
		this.#targets = targets;
		this.#onChange = onChange;
		this.#intervalMs = intervalMs;
	}

	/** `targets` hold absolute paths. Coverage is established when this resolves. */
	static async open(
		env: RemoteExecutionEnv,
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		intervalMs = DEFAULT_INTERVAL_MS,
	): Promise<PollingWatcher> {
		const watcher = new PollingWatcher(env, targets, onChange, intervalMs, await remotePath(env.connection));
		try {
			watcher.#snapshot = await watcher.#scan();
		} catch (error) {
			if (error instanceof BudgetExceeded) throw new FileError("invalid", error.message);
			throw error;
		}
		watcher.#schedule();
		return watcher;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#timer);
		await this.#running;
	}

	#deliver(change: WatchChange): void {
		if (this.#closed) return;
		try {
			this.#onChange(change);
		} catch {
			// A throwing callback must not stop watching.
		}
	}

	#schedule(): void {
		if (this.#closed) return;
		this.#timer = setTimeout(() => {
			this.#running = this.#poll().finally(() => {
				this.#running = undefined;
				this.#schedule();
			});
		}, this.#intervalMs);
	}

	async #poll(): Promise<void> {
		let next: Map<string, string>;
		try {
			next = await this.#scan();
		} catch (error) {
			if (error instanceof BudgetExceeded) {
				this.#deliver({ error: new FileError("invalid", error.message) });
				this.#closed = true;
				return;
			}
			// Unreachable for now (a lost connection): changes meanwhile are unknown.
			if (!this.#uncertain) this.#deliver({ overflow: true });
			this.#uncertain = true;
			return;
		}
		if (this.#uncertain) {
			this.#uncertain = false;
			this.#snapshot = next;
			this.#deliver({ overflow: true });
			return;
		}
		const changed = new Set<string>();
		for (const [path, key] of next) if (this.#snapshot.get(path) !== key) changed.add(this.#reported(path));
		for (const path of this.#snapshot.keys()) if (!next.has(path)) changed.add(this.#reported(path));
		this.#snapshot = next;
		if (changed.size > 0) this.#deliver({ paths: [...changed].sort() });
	}

	/** An ancestor that changed identity moved every target below it; report those targets. */
	#reported(path: string): string {
		if (this.#targets.some((target) => isWithin(path, target.path, this.#paths))) return path;
		return this.#targets.find((target) => isWithin(target.path, path, this.#paths))?.path ?? path;
	}

	async #lstat(path: string): Promise<RemoteInfo | undefined> {
		try {
			const { json } = await this.#env.connection.request("lstat", { path });
			return json as unknown as RemoteInfo;
		} catch (error) {
			if (error instanceof RemoteError && ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code))
				return undefined;
			throw error;
		}
	}

	async #key(path: string, info: RemoteInfo, identityOnly: boolean): Promise<string> {
		const identity = `${info.kind}:${info.dev}:${info.ino}`;
		if (identityOnly || info.kind === "directory") return identity;
		let hash = "";
		const mtimeMs = info.mtimeSec * 1000 + info.mtimeNsec / 1e6;
		if (info.kind === "file" && info.size <= HASH_MAX_BYTES && Date.now() - mtimeMs < HASH_RECENT_MS) {
			const bytes = await this.#env.readBinaryFile(path, BACKGROUND_CONTEXT);
			if (bytes.ok) hash = createHash("sha256").update(bytes.value).digest("hex");
		}
		return `${identity}:${info.size}:${info.mtimeSec}.${info.mtimeNsec}:${hash}`;
	}

	async #scan(): Promise<Map<string, string>> {
		const snapshot = new Map<string, string>();
		let directories = 0;
		const countDirectory = () => {
			if (++directories > MAX_DIRECTORIES)
				throw new BudgetExceeded(`Watched paths exceed ${MAX_DIRECTORIES} directories`);
		};
		const scanDirectory = async (target: WatchTarget, directory: string): Promise<void> => {
			let handle: number;
			try {
				handle = (await this.#env.connection.request("opendir", { path: directory })).json.handle as number;
			} catch (error) {
				if (error instanceof RemoteError && ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return;
				throw error;
			}
			const entries: { name: string; info?: RemoteInfo; error?: Json }[] = [];
			try {
				for (let done = false; !done; ) {
					const { json } = await this.#env.connection.request("readdir", { handle, max: 1000 });
					entries.push(...(json.entries as typeof entries));
					done = json.done === true;
				}
			} finally {
				await this.#env.connection.request("close", { handle }).catch(() => undefined);
			}
			for (const entry of entries) {
				if (entry.info === undefined) continue;
				if ((target.exclude?.hidden && entry.name.startsWith(".")) || target.exclude?.names?.includes(entry.name))
					continue;
				const path = this.#paths.join(directory, entry.name);
				if (snapshot.has(path)) continue;
				snapshot.set(path, await this.#key(path, entry.info, false));
				if (target.recursive && entry.info.kind === "directory") {
					countDirectory();
					await scanDirectory(target, path);
				}
			}
		};
		for (const target of this.#targets) {
			for (const ancestor of ancestorsOf(target.path, this.#paths)) {
				if (snapshot.has(ancestor)) continue;
				const info = await this.#lstat(ancestor);
				if (info !== undefined) snapshot.set(ancestor, await this.#key(ancestor, info, true));
			}
			// The target itself may be a symbolic link to what is watched; follow it.
			let resolved = target.path;
			let info = await this.#lstat(target.path);
			if (info?.kind === "symlink") {
				try {
					resolved = (await this.#env.connection.request("realpath", { path: target.path })).json.path as string;
					info = await this.#lstat(resolved);
				} catch {
					info = undefined;
				}
			}
			if (info === undefined) continue;
			snapshot.set(target.path, await this.#key(resolved, info, false));
			if (info.kind === "directory") {
				countDirectory();
				await scanDirectory(target, target.path);
			}
		}
		return snapshot;
	}
}
