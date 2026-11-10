import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type ChangelogEntry,
	getForkChangelog,
	getNewEntries,
	normalizeChangelogLinks,
} from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/earendil-works/pi/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/earendil-works/pi/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("canonicalizes old repository URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/earendil-works/pi/pull/5167)",
				"[#4163](https://github.com/earendil-works/pi/issues/4163)",
				"[Agent README](https://github.com/earendil-works/pi/blob/v0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});

describe("getForkChangelog", () => {
	const commit = "3c5823a7110f5ab73ae782aed162289eac7e3c89";
	let tempDir: string;

	function writeChangelog(lines: string[]): string {
		const changelogPath = join(tempDir, "CHANGELOG.md");
		writeFileSync(changelogPath, lines.join("\n"));
		return changelogPath;
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-fork-changelog-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("returns the unreleased entries headed as fork changes, with relative links pinned to the fork commit", () => {
		const changelogPath = writeChangelog([
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Added managed restart. See [Restart](docs/restart.md#work-that-outlives-a-worker) ([#251](https://github.com/fitchmultz/pi/issues/251))",
			"- Kept an upstream fix ([#11060](https://github.com/earendil-works/pi/issues/11060))",
			"",
			"## [1.5.1] - 2026-11-09",
			"",
			"- Released change. See [Settings](docs/settings.md)",
			"",
		]);

		expect(getForkChangelog(changelogPath, commit)).toBe(
			[
				"## Fork changes (fitchmultz/pi@3c5823a)",
				"",
				"### Added",
				"",
				`- Added managed restart. See [Restart](https://github.com/fitchmultz/pi/blob/${commit}/packages/coding-agent/docs/restart.md#work-that-outlives-a-worker) ([#251](https://github.com/fitchmultz/pi/issues/251))`,
				"- Kept an upstream fix ([#11060](https://github.com/earendil-works/pi/issues/11060))",
			].join("\n"),
		);
	});

	test("returns undefined when the changelog has no unreleased entries", () => {
		expect(
			getForkChangelog(writeChangelog(["## [Unreleased]", "", "## [1.5.1]", "", "- Released change"]), commit),
		).toBe(undefined);
		expect(getForkChangelog(writeChangelog(["## [1.5.1]", "", "- Released change"]), commit)).toBe(undefined);
	});
});

describe("getNewEntries", () => {
	const entries: ChangelogEntry[] = [
		{ major: 0, minor: 1, patch: 5, content: "0.1.5" },
		{ major: 0, minor: 1, patch: 4, content: "0.1.4" },
	];
	const newContent = (lastVersion: string) => getNewEntries(entries, lastVersion)?.map((e) => e.content);

	// #11703
	test("ignores prerelease and build suffixes of the last seen version", () => {
		expect(newContent("0.1.5-20261020.7")).toEqual([]);
		expect(newContent("0.1.5+build.3")).toEqual([]);
		expect(newContent("0.1.4-beta.1")).toEqual(["0.1.5"]);
	});

	test("compares release versions numerically", () => {
		expect(newContent("0.1.5")).toEqual([]);
		expect(newContent("0.1.3")).toEqual(["0.1.5", "0.1.4"]);
		expect(getNewEntries([{ major: 0, minor: 10, patch: 0, content: "0.10.0" }], "0.9.0")?.length).toBe(1);
	});

	test("returns undefined for a last seen version without major.minor.patch", () => {
		expect(newContent("latest")).toBeUndefined();
		expect(newContent("0.1")).toBeUndefined();
		expect(newContent("")).toBeUndefined();
	});
});
