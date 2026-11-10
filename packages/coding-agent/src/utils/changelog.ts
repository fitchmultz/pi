import path from "node:path";
import { existsSync, readFileSync } from "fs";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

/** The repository and ref that a changelog section's relative links are read from. */
interface LinkSource {
	repo: string;
	ref: string;
}

const GITHUB_REPO = "earendil-works/pi";
const FORK_GITHUB_REPO = "fitchmultz/pi";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

/** The entry's version as major.minor.patch. */
export function entryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, source: LinkSource): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${source.repo}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${source.ref}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `${repoUrl}/${route}/${source.ref}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

function normalizeLinks(markdown: string, source: LinkSource): string {
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, source)}${suffix}`;
	});
}

/** Point a released entry's links at the upstream repository, pinned to the entry's version tag. */
export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	return normalizeLinks(markdown, { repo: GITHUB_REPO, ref: normalizeTag(version) });
}

/**
 * Read the "## " sections of a changelog in file order. Each section's text starts with its heading line
 * and runs to the next heading or EOF.
 */
function readSections(changelogPath: string): { heading: string; text: string }[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		return readFileSync(changelogPath, "utf-8")
			.split(/(?<=\n)(?=## )/)
			.filter((section) => section.startsWith("## "))
			.map((section) => ({ heading: section.split("\n", 1)[0], text: section.trim() }));
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Parse the released entries from CHANGELOG.md: the sections with a version heading (## [x.y.z] ...).
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	const entries: ChangelogEntry[] = [];

	for (const { heading, text } of readSections(changelogPath)) {
		const versionMatch = heading.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
		if (versionMatch) {
			entries.push({
				major: Number.parseInt(versionMatch[1], 10),
				minor: Number.parseInt(versionMatch[2], 10),
				patch: Number.parseInt(versionMatch[3], 10),
				content: text,
			});
		}
	}

	return entries;
}

/**
 * Get the fork's own entries. They stay under "## [Unreleased]" because the released sections mirror
 * upstream's, so parseChangelog never returns them. The section is headed as fork changes and its relative
 * links point at the fork repository, pinned to the installed commit. Returns undefined when it has no entries.
 */
export function getForkChangelog(changelogPath: string, commit: string): string | undefined {
	const section = readSections(changelogPath).find(({ heading }) => /^##\s+\[Unreleased\]/.test(heading));
	const entries = section?.text.slice(section.heading.length).trim();
	if (!entries) {
		return undefined;
	}

	// Seven characters is Git's default abbreviation of a commit (core.abbrev).
	const heading = `## Fork changes (${FORK_GITHUB_REPO}@${commit.slice(0, 7)})`;
	return `${heading}\n\n${normalizeLinks(entries, { repo: FORK_GITHUB_REPO, ref: commit })}`;
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Get entries newer than lastVersion, or undefined when lastVersion has no major.minor.patch to compare against
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] | undefined {
	// Read only the leading major.minor.patch, like the changelog headings, so a prerelease such as
	// 0.1.5-20261020.7 counts as 0.1.5 and its notes are not shown again on every launch (#11703).
	// Alternatives considered: plain string comparison orders 0.10.0 before 0.9.0; numeric localeCompare
	// works by accident and is locale-dependent; strict semver orders 0.1.5-x before 0.1.5, which repeats
	// the [0.1.5] notes forever.
	const parts = lastVersion.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!parts) return undefined;
	const last: ChangelogEntry = {
		major: Number(parts[1]),
		minor: Number(parts[2]),
		patch: Number(parts[3]),
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config.ts";
