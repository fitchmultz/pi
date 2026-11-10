/**
 * The `pi.runtime` session entry: the build, packages, extensions and context files one session start
 * ran with. Core appends one before each `session_start` so later analysis can tell what was running
 * when. It is a plain custom entry, so it never enters model context.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBuildInfo } from "../config.ts";
import type { Extension, ExtensionMode, SessionStartEvent } from "./extensions/types.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { getSourcePackageKey, isSyntheticPath, type SourceInfo, type SourceScope } from "./source-info.ts";

/** Custom entry type of the runtime record. */
export const RUNTIME_RECORD_ENTRY = "pi.runtime";

/** A package that supplied at least one loaded extension, skill, prompt template or theme. */
export interface RuntimeRecordPackage {
	/** Source as configured, such as `git:github.com/user/repo` or `npm:name@1.2.3`. */
	source: string;
	scope: SourceScope;
	/** Directory the package's resources were loaded from. */
	path: string;
	/** `version` of the `package.json` in `path`, if there is one. */
	version?: string;
	/** Checked-out commit, if `path` is the root of a git checkout. */
	commit?: string;
}

/** A loaded extension that no package supplied. */
export interface RuntimeRecordExtension {
	/** Entry file, or a name without a file such as `builtin:mcp` or `<inline:name>`. */
	path: string;
	/** Where it was found: `auto` (extension directories), `local` (settings), `cli` (`-e`), `builtin` or `inline`. */
	source: string;
	scope: SourceScope;
	/** SHA-256 of the entry file's bytes. Absent for names without a file. */
	sha256?: string;
}

/** A context file, such as `AGENTS.md`, that was loaded for the system prompt. */
export interface RuntimeRecordContextFile {
	path: string;
	/** UTF-8 byte length of the loaded text. */
	bytes: number;
	/** SHA-256 of the loaded text. */
	sha256: string;
}

/** `data` of a `pi.runtime` custom entry. */
export interface RuntimeRecordData {
	/** Format version of this record. */
	version: 1;
	/** Reason of the `session_start` event this record precedes. */
	trigger: SessionStartEvent["reason"];
	process: {
		pid: number;
		/** Run mode, as extensions see it in `ctx.mode`. */
		mode: ExtensionMode;
		/** Managed launcher that owns this worker. It stays the same when `pi restart` replaces the worker. */
		launcherPid?: number;
	};
	/** The running package, Node runtime and fork installer receipt, as `pi --build-info` prints them. */
	build: ReturnType<typeof getBuildInfo>;
	packages: RuntimeRecordPackage[];
	extensions: RuntimeRecordExtension[];
	contextFiles: RuntimeRecordContextFile[];
}

/** Describe what a session start runs with: this process and build, and what `resourceLoader` loaded. */
export async function describeRuntime(
	start: Pick<RuntimeRecordData, "trigger" | "process">,
	resourceLoader: ResourceLoader,
): Promise<RuntimeRecordData> {
	const extensions = resourceLoader.getExtensions().extensions;
	const packageSources = [
		...extensions.map((extension) => extension.sourceInfo),
		...resourceLoader.getSkills().skills.map((skill) => skill.sourceInfo),
		...resourceLoader.getPrompts().prompts.map((prompt) => prompt.sourceInfo),
		...resourceLoader.getThemes().themes.flatMap((theme) => theme.sourceInfo ?? []),
	].filter((sourceInfo) => sourceInfo.origin === "package");
	const packagePaths = new Map(
		packageSources.flatMap(
			(sourceInfo): Array<[string, SourceInfo & { baseDir: string }]> =>
				sourceInfo.baseDir === undefined
					? []
					: [[getSourcePackageKey(sourceInfo), { ...sourceInfo, baseDir: sourceInfo.baseDir }]],
		),
	);
	// Twenty git packages take about 180 ms one after the other, so every file and git read runs at once.
	const [packages, looseExtensions] = await Promise.all([
		Promise.all([...packagePaths.values()].map(describePackage)),
		Promise.all(extensions.filter((extension) => extension.sourceInfo.origin !== "package").map(describeExtension)),
	]);
	return {
		version: 1,
		...start,
		build: getBuildInfo(),
		packages,
		extensions: looseExtensions,
		contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map(({ path, content }) => ({
			path,
			bytes: Buffer.byteLength(content),
			sha256: sha256(content),
		})),
	};
}

async function describePackage({
	source,
	scope,
	baseDir,
}: SourceInfo & { baseDir: string }): Promise<RuntimeRecordPackage> {
	const [version, commit] = await Promise.all([readPackageVersion(baseDir), readGitHead(baseDir)]);
	return {
		source,
		scope,
		path: baseDir,
		...(version === undefined ? {} : { version }),
		...(commit === undefined ? {} : { commit }),
	};
}

async function readPackageVersion(packageDir: string): Promise<string | undefined> {
	try {
		const manifest: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
		const version = (manifest as { version?: unknown } | null)?.version;
		return typeof version === "string" ? version : undefined;
	} catch {
		// No manifest, or one that does not parse: the package has no version to record.
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

async function describeExtension(extension: Extension): Promise<RuntimeRecordExtension> {
	const { source, scope } = extension.sourceInfo;
	if (isSyntheticPath(extension.path)) return { path: extension.path, source, scope };
	try {
		return { path: extension.resolvedPath, source, scope, sha256: sha256(await readFile(extension.resolvedPath)) };
	} catch {
		// An extension built from a factory can carry a path that is no file, as SDK hosts and tests do.
		return { path: extension.resolvedPath, source, scope };
	}
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}
