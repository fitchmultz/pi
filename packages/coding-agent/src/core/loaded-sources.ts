/**
 * What the extension code this process imported looked like on disk right before its import. A process
 * imports an extension once and keeps that code when its package or file changes afterwards, so this is
 * the baseline for the runtime record and for telling which loaded sources are stale.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Extension } from "./extensions/types.ts";
import { isSyntheticPath, type SourceInfo, type SourceScope } from "./source-info.ts";

/** Where an extension's code comes from: a package directory, or the entry file of an extension no package supplied. */
export interface CodeSource {
	kind: "package" | "extension";
	path: string;
}

/**
 * What identifies a source's code on disk. A package has the `version` of its `package.json` and, when its
 * directory is the root of a git checkout, the checked-out `commit`. An extension has the `sha256` of its entry file.
 */
export interface SourceIdentity {
	version?: string;
	commit?: string;
	sha256?: string;
}

/** A loaded package or extension whose code on disk is no longer the code this process imported. */
export interface StaleSource extends CodeSource {
	/** Source as configured for a package, or where the extension was found, as in the runtime record. */
	source: string;
	scope: SourceScope;
	/** Identity right before the import. */
	loaded: SourceIdentity;
	/** Identity on disk now. */
	current: SourceIdentity;
}

/** Identity of each source right before its code was first imported, for as long as the extension cache keeps that code. */
const loadedSources = new Map<string, SourceIdentity>();

/** The code source of an extension entry file with `sourceInfo`; without source info no package supplied it. */
export function getCodeSource(sourceInfo: SourceInfo | undefined, entryPath: string): CodeSource {
	return sourceInfo?.origin === "package" && sourceInfo.baseDir !== undefined
		? { kind: "package", path: sourceInfo.baseDir }
		: { kind: "extension", path: entryPath };
}

/**
 * Run `importCode`, which imports code of `source`, and remember what the source looked like on disk right
 * before. Reading first means that a change which lands in between is reported as stale instead of being
 * missed. An import that fails or yields no code remembers nothing, so the repaired source is not compared
 * with the broken one later. The first import per source wins: a package's later entry files load next to
 * the code already imported.
 */
export async function importRemembered<T>(
	source: CodeSource,
	importCode: () => Promise<T | undefined>,
): Promise<T | undefined> {
	if (loadedSources.has(source.path)) return importCode();
	const identity = await readSourceIdentity(source);
	const code = await importCode();
	if (code !== undefined && !loadedSources.has(source.path)) loadedSources.set(source.path, identity);
	return code;
}

/** Forget every remembered source. The extension cache was cleared, so the next load imports the code again. */
export function forgetLoadedSources(): void {
	loadedSources.clear();
}

/** The identity of `source` as this process loaded it, or as it is on disk now when it imported no code of it. */
export async function describeLoadedSource(source: CodeSource): Promise<SourceIdentity> {
	return loadedSources.get(source.path) ?? readSourceIdentity(source);
}

/** The sources of `extensions` whose code on disk differs from what this process imported, each listed once. */
export async function findStaleSources(extensions: Extension[]): Promise<StaleSource[]> {
	// Every git package costs one subprocess, so all sources are read at once, as for the runtime record.
	const compared = new Map<string, Promise<StaleSource[]>>();
	for (const { resolvedPath, sourceInfo } of extensions) {
		const source = getCodeSource(sourceInfo, resolvedPath);
		const loaded = loadedSources.get(source.path);
		// Extensions built from a factory were never imported from disk.
		if (!loaded || compared.has(source.path)) continue;
		compared.set(
			source.path,
			readSourceIdentity(source).then((current) =>
				loaded.version === current.version && loaded.commit === current.commit && loaded.sha256 === current.sha256
					? []
					: [{ ...source, source: sourceInfo.source, scope: sourceInfo.scope, loaded, current }],
			),
		);
	}
	return (await Promise.all(compared.values())).flat();
}

async function readSourceIdentity({ kind, path }: CodeSource): Promise<SourceIdentity> {
	if (kind === "package") {
		const [version, commit] = await Promise.all([readPackageVersion(path), readGitHead(path)]);
		return { ...(version === undefined ? {} : { version }), ...(commit === undefined ? {} : { commit }) };
	}
	if (isSyntheticPath(path)) return {};
	try {
		return {
			sha256: createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		};
	} catch {
		// An extension built from a factory can carry a path that is no file, as SDK hosts and tests do.
		return {};
	}
}

async function readPackageVersion(packageDir: string): Promise<string | undefined> {
	try {
		const manifest: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
		const version = (manifest as { version?: unknown } | null)?.version;
		return typeof version === "string" ? version : undefined;
	} catch {
		// No manifest, or one that does not parse: the package has no version.
		return undefined;
	}
}

/** The commit `git` reports for a checkout rooted at `dir`, as the package manager reads it. */
function readGitHead(dir: string): Promise<string | undefined> {
	// Packages inside another checkout, such as npm installs, are not asked: its commit is not theirs.
	if (!existsSync(join(dir, ".git"))) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "HEAD"], { cwd: dir }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim() || undefined);
		});
	});
}
