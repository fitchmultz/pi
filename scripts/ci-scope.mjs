#!/usr/bin/env node

// Decide whether `.github/workflows/ci.yml` needs `macos-restart-background`.
// Every Linux job always runs; this script skips only the macOS job when all
// changed paths are outside its macOS process/PTY/socket/case-aliased-build surface.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const help = `Usage:
  node scripts/ci-scope.mjs --event pull_request|push|workflow_dispatch [--base SHA --head SHA]

Compare immutable Git commits (the merge base on pull_request), print JSON,
and write macos-required=true|false to GITHUB_OUTPUT and a reason to
GITHUB_STEP_SUMMARY when set. Any unclassified path, workspace manifest or
tsconfig, CI workflow/script change, or manual dispatch requires macOS CI.

Options:
  --event  GitHub event name (pull_request, push, workflow_dispatch)
  --base   Base commit SHA (required for pull_request and push)
  --head   Head commit SHA (required for pull_request and push)
  -h, --help  Show this help`;

const ZERO_SHA = "0".repeat(40);
const SHA_PATTERN = /^[a-f0-9]{40}$/;

const ROOT_DOC_FILES = new Set(["AGENTS.md", "CONTRIBUTING.md", "FORK.md", "LICENSE", "README.md", "SECURITY.md"]);

const git = (...args) =>
	execFileSync("git", args, {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 64 * 1024 * 1024,
	});

const isWorkspaceConfig = (path) => /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(path);

const fastPaths = [
	[
		"documentation and non-CI metadata",
		(path) =>
			!isWorkspaceConfig(path) &&
			(ROOT_DOC_FILES.has(path) ||
				path.startsWith("docs/") ||
				path.startsWith(".pi/") ||
				path === ".github/APPROVED_CONTRIBUTORS" ||
				path.startsWith(".github/ISSUE_TEMPLATE/") ||
				(path.startsWith(".github/workflows/") && path !== ".github/workflows/ci.yml") ||
				/^packages\/[^/]+\/(README\.md|CHANGELOG\.md|containerization\.md)$/.test(path) ||
				/^packages\/[^/]+\/(docs|THIRD_PARTY_NOTICES|schemas)\//.test(path) ||
				path === "packages/tui/native/darwin/README.md" ||
				/^packages\/chord\/src\/.+\/README\.md$/.test(path)),
	],
	[
		"isolated packages",
		(path) =>
			!isWorkspaceConfig(path) &&
			(/^packages\/ai\/(src|catalog|test|vitest\.config\.ts)(\/|$)/.test(path) ||
				/^packages\/(agent|schema|telemetry)\/(src|test|examples|vitest\.config\.ts)(\/|$)/.test(path) ||
				/^packages\/env\/(src|daemon|test|vitest\.config\.ts)(\/|$)/.test(path) ||
				path.startsWith("packages/evals/") ||
				path.startsWith("apps/") ||
				path.startsWith("nix/") ||
				path === "flake.nix" ||
				path === "flake.lock"),
	],
	[
		"non-macOS-job package tests",
		(path) =>
			!isWorkspaceConfig(path) &&
			/^packages\/(tui|chord|codemode|durable|mcp)\/(test|test-workers|examples|vitest[^/]*\.config\.ts)(\/|$)/.test(
				path,
			),
	],
];

function assertShaFormat(label, sha) {
	if (!SHA_PATTERN.test(sha ?? "")) {
		throw new Error(`${label} must be a 40-character lowercase hex commit SHA`);
	}
}

function hasCommit(sha) {
	return spawnSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { timeout: 30_000 }).status === 0;
}

function resolveScope({ event, base, head }) {
	if (event === "workflow_dispatch") {
		return {
			macosRequired: true,
			reason: "Manual dispatch runs macos-restart-background.",
			files: [],
		};
	}
	if (event !== "pull_request" && event !== "push") {
		throw new Error("Event must be pull_request, push, or workflow_dispatch");
	}
	assertShaFormat("head", head);
	if (!hasCommit(head)) {
		throw new Error(`head commit ${head} is not in local history`);
	}
	if (event === "push" && base === ZERO_SHA) {
		return {
			macosRequired: true,
			reason: "Branch creation push has no previous commit to compare.",
			files: [],
		};
	}
	assertShaFormat("base", base);
	if (!hasCommit(base)) {
		return {
			macosRequired: true,
			reason: "Base commit is not in local history; running macos-restart-background by default.",
			files: [],
		};
	}

	let before = base;
	if (event === "pull_request") {
		const mergeBase = spawnSync("git", ["merge-base", base, head], { encoding: "utf8", timeout: 30_000 });
		if (mergeBase.status !== 0) {
			return {
				macosRequired: true,
				reason: "Pull request has no merge base with the target branch.",
				files: [],
			};
		}
		before = mergeBase.stdout.trim();
	}

	// NUL-delimited output with rename detection disabled preserves unusual filenames and deleted paths.
	const files = git("diff", "--name-only", "-z", "--no-renames", before, head, "--").split("\0").filter(Boolean);
	if (files.length === 0) {
		return {
			macosRequired: true,
			reason: "No changed paths between compared commits; running macos-restart-background by default.",
			files,
		};
	}

	const requiredPaths = files.filter((path) => !fastPaths.some(([, matches]) => matches(path)));
	if (requiredPaths.length > 0) {
		const preview = requiredPaths.slice(0, 10).map((path) => JSON.stringify(path)).join(", ");
		const suffix = requiredPaths.length > 10 ? ` (+${requiredPaths.length - 10} more)` : "";
		return {
			macosRequired: true,
			reason: `Default rule: these changed paths require macos-restart-background: ${preview}${suffix}.`,
			files,
		};
	}

	const applied = fastPaths.filter(([, matches]) => files.some(matches)).map(([name]) => name);
	return {
		macosRequired: false,
		reason: `Skipping macos-restart-background; every changed path is on a fast path: ${applied.join("; ")}.`,
		files,
	};
}

try {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			event: { type: "string" },
			base: { type: "string" },
			head: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(help);
	} else {
		if (positionals.length > 0) {
			throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}; use --help for usage`);
		}
		const plan = resolveScope(values);
		if (process.env.GITHUB_OUTPUT) {
			appendFileSync(process.env.GITHUB_OUTPUT, `macos-required=${plan.macosRequired}\n`);
		}
		if (process.env.GITHUB_STEP_SUMMARY) {
			appendFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				`macOS restart/background CI required: **${plan.macosRequired}**. ${plan.reason}\n`,
			);
		}
		console.log(JSON.stringify(plan, null, 2));
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
