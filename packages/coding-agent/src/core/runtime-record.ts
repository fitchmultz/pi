/**
 * The `pi.runtime` session entry: the build, packages, extensions and context files one session start
 * ran with. Core appends one before each `session_start` so later analysis can tell what was running
 * when. It is a plain custom entry, so it never enters model context.
 */

import { createHash } from "node:crypto";
import { getBuildInfo } from "../config.ts";
import type { Extension, ExtensionMode, SessionStartEvent } from "./extensions/types.ts";
import { describeLoadedSource } from "./loaded-sources.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { getSourcePackageKey, type SourceInfo, type SourceScope } from "./source-info.ts";

/** Custom entry type of the runtime record. */
export const RUNTIME_RECORD_ENTRY = "pi.runtime";

/** A package that supplied at least one loaded extension, skill, prompt template or theme. */
export interface RuntimeRecordPackage {
	/** Source as configured, such as `git:github.com/user/repo` or `npm:name@1.2.3`. */
	source: string;
	scope: SourceScope;
	/** Directory the package's resources were loaded from. */
	path: string;
	/** `version` of the `package.json` in `path`, if there is one, when the package's extension code was imported. */
	version?: string;
	/** Checked-out commit, if `path` is the root of a git checkout, when the package's extension code was imported. */
	commit?: string;
}

/** A loaded extension that no package supplied. */
export interface RuntimeRecordExtension {
	/** Entry file, or a name without a file such as `builtin:mcp` or `<inline:name>`. */
	path: string;
	/** Where it was found: `auto` (extension directories), `local` (settings), `cli` (`-e`), `builtin` or `inline`. */
	source: string;
	scope: SourceScope;
	/** SHA-256 of the entry file's bytes when it was imported. Absent for names without a file. */
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
	/** Reason of the `session_start` event this record precedes, or `"restart"` when resuming from a managed restart handoff. */
	trigger: SessionStartEvent["reason"] | "restart";
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
			sha256: createHash("sha256").update(content).digest("hex"),
		})),
	};
}

/** A package as its extension code was imported, or as it is on disk now when it supplied no extension. */
async function describePackage({
	source,
	scope,
	baseDir,
}: SourceInfo & { baseDir: string }): Promise<RuntimeRecordPackage> {
	return { source, scope, path: baseDir, ...(await describeLoadedSource({ kind: "package", path: baseDir })) };
}

/** An extension that no package supplied, as its entry file was imported. */
async function describeExtension({ resolvedPath, sourceInfo }: Extension): Promise<RuntimeRecordExtension> {
	const { source, scope } = sourceInfo;
	return {
		path: resolvedPath,
		source,
		scope,
		...(await describeLoadedSource({ kind: "extension", path: resolvedPath })),
	};
}
