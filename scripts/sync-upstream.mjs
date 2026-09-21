#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "sync-upstream.sh");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (mode, worktree) => `${quote(entry)} ${mode} ${quote(worktree)}`;

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function run(cwd, program, args) {
	execFileSync(program, args, { cwd, stdio: "inherit" });
}
function ancestor(cwd, before, after) {
	const result = spawnSync("git", ["merge-base", "--is-ancestor", before, after], { cwd });
	if (result.error || ![0, 1].includes(result.status)) throw result.error ?? new Error(result.stderr.toString());
	return result.status === 0;
}
function task(worktree) {
	const branch = git(worktree, "branch", "--show-current");
	if (!branch.startsWith("sync/upstream-")) throw new Error("Not an upstream sync task branch");
	const target = git(worktree, "config", "--local", "--get", `branch.${branch}.piSyncTarget`);
	const base = git(worktree, "config", "--local", "--get", `branch.${branch}.piSyncBase`);
	return { branch, target, base };
}
function requireStaged(worktree) {
	if (git(worktree, "diff", "--name-only", "--diff-filter=U")) {
		throw new Error("Unresolved conflicts remain. Resolve each file and git add its explicit path first.");
	}
	if (git(worktree, "diff", "--name-only") || git(worktree, "ls-files", "--others", "--exclude-standard")) {
		throw new Error("Unstaged or untracked task changes remain. Review and stage explicit paths first.");
	}
}

export function prepareSync(repo, ref = "origin/main") {
	// Fetch the requested upstream ref once; FETCH_HEAD is immediately pinned.
	const upstreamRef = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
	if (!upstreamRef || upstreamRef.startsWith("-")) throw new Error("Invalid upstream ref");
	run(repo, "git", ["fetch", "--no-tags", "--no-prune", "--no-prune-tags", "origin", upstreamRef]);
	const target = git(repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}");
	run(repo, "git", ["fetch", "--no-tags", "--no-prune", "--no-prune-tags", "fork", "refs/heads/main:refs/remotes/fork/main"]);
	const base = git(repo, "rev-parse", "refs/remotes/fork/main^{commit}");
	if (ancestor(repo, target, base)) {
		console.log(`No-op: fork/main already contains ${target}.`);
		return undefined;
	}
	git(repo, "config", "--local", "rerere.enabled", "true");
	git(repo, "config", "--local", "rerere.autoupdate", "false");
	const checkout = dirname(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
	const tasks = join(dirname(checkout), "worktrees", basename(checkout));
	mkdirSync(tasks, { recursive: true });
	const worktree = mkdtempSync(join(tasks, `upstream-${target.slice(0, 12)}-`));
	const branch = `sync/upstream-${target.slice(0, 12)}-${worktree.split("-").at(-1)}`;
	run(repo, "git", ["worktree", "add", "-b", branch, worktree, base]);
	git(worktree, "config", "--local", `branch.${branch}.piSyncTarget`, target);
	git(worktree, "config", "--local", `branch.${branch}.piSyncBase`, base);
	console.log(`Task worktree: ${worktree}\nBranch: ${branch}\nPinned upstream: ${target}`);
	const merged = spawnSync("git", ["-c", "rerere.autoupdate=false", "merge", "--no-ff", "--no-commit", target], {
		cwd: worktree, stdio: "inherit",
	});
	console.log(`\nInspect the merge in ${quote(worktree)}. Resolve conflicts and stage explicit paths (git add -- <path>).
Resume without fetching or changing the pinned target:
  ${command("--continue", worktree)}`);
	if (merged.error) throw merged.error;
	if (merged.status !== 0 && !git(worktree, "diff", "--name-only", "--diff-filter=U")) {
		throw new Error(`Merge failed; task retained at ${worktree}. Inspect git status before continuing.`);
	}
	return { worktree, branch, target, base };
}

function verifyTask(worktree) {
	// Resolve npm in this Node distribution, not a HOME-dependent version shim.
	const npm = realpathSync(join(dirname(process.execPath), "npm"));
	const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
	const npmRun = (...args) => execFileSync(npm, args, { cwd: worktree, env, stdio: "inherit" });
	npmRun("ci", "--ignore-scripts");
	// This is the sole automatic tracked edit; make it explicit before validation
	// and PR review. Conflict resolutions are always staged by the operator.
	run(worktree, process.execPath, ["scripts/generate-extension-provider-modules.mjs"]);
	git(worktree, "add", "--", "packages/coding-agent/src/core/extensions/provider-modules.generated.ts");
	if (!existsSync(join(worktree, "packages/ai/src/providers/data/.manifest.json"))) {
		npmRun("run", "hydrate:model-data");
	}
	npmRun("run", "verify:fork");
}

// Verification is injected only by real-Git fixture tests; the CLI cannot skip it.
export function continueSync(worktree, verify = verifyTask) {
	worktree = resolve(worktree);
	const { target, base } = task(worktree);
	requireStaged(worktree);
	const mergeHead = git(worktree, "rev-parse", "--git-path", "MERGE_HEAD");
	if (!existsSync(resolve(worktree, mergeHead))) throw new Error("No merge in progress; use --pr for a validated completed task.");
	if (git(worktree, "rev-parse", "MERGE_HEAD") !== target || git(worktree, "rev-parse", "HEAD") !== base) {
		throw new Error("Task HEAD/MERGE_HEAD differs from its recorded base/target. Inspect the native Git merge state.");
	}
	try {
		verify(worktree);
		requireStaged(worktree);
		run(worktree, "git", ["diff", "--cached", "--check"]);
		execFileSync("git", ["commit", "-m", `Merge upstream ${target}`], {
			cwd: worktree, stdio: "inherit", env: { ...process.env, PI_ALLOW_LOCKFILE_CHANGE: "1" },
		});
		const commit = git(worktree, "rev-parse", "HEAD");
		console.log(`Validated merge: ${commit}\nPublish for review (never auto-merges):\n  ${command("--pr", worktree)}`);
		return commit;
	} catch (error) {
		console.error(`Task retained. Resume:\n  ${command("--continue", worktree)}`);
		throw error;
	}
}

export function publishSync(worktree) {
	worktree = resolve(worktree);
	const { branch, target, base } = task(worktree);
	if (git(worktree, "status", "--porcelain")) throw new Error("Commit and validate task changes before publishing.");
	const commit = git(worktree, "rev-parse", "HEAD");
	if (!ancestor(worktree, target, commit) || !ancestor(worktree, base, commit)) {
		throw new Error("Task does not contain its pinned upstream and fork base.");
	}
	run(worktree, "git", ["push", "--no-follow-tags", "--set-upstream", "fork", `${branch}:refs/heads/${branch}`]);
	const existing = execFileSync("gh-personal", ["pr", "list", "--repo", "fitchmultz/pi", "--head", branch,
		"--json", "url", "--jq", ".[0].url // empty"], { cwd: worktree, encoding: "utf8" }).trim();
	if (existing) console.log(existing);
	else {
		const body = resolve(worktree, git(worktree, "rev-parse", "--git-path", "pi-sync-pr.md"));
		writeFileSync(body, `Merge pinned upstream commit ${target}, preserving fork ancestry.\n\nRun npm run verify:fork for local validation with frozen dependencies, offline build, nonmutating checks and isolated bundled tests. Required CI and independent review must pass before native merge approval.\n`);
		run(worktree, "gh-personal", ["pr", "create", "--repo", "fitchmultz/pi", "--base", "main", "--head", branch,
			"--title", `Merge upstream ${target.slice(0, 12)}`, "--body-file", body]);
	}
	console.log(`Run local reviewers and gh-personal pr checks --repo fitchmultz/pi ${quote(branch)} --watch.\nMerge requires separate native approval. No runtime has been installed or selected.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	try {
		if (args.length === 0 || (args.length === 2 && args[0] === "--ref")) {
			const prepared = prepareSync(root, args[1]);
			if (prepared && !git(prepared.worktree, "diff", "--name-only", "--diff-filter=U")) {
				continueSync(prepared.worktree);
				publishSync(prepared.worktree);
			}
		} else if (args.length === 2 && args[0] === "--continue") {
			continueSync(args[1]);
			publishSync(args[1]);
		}
		else if (args.length === 2 && args[0] === "--pr") publishSync(args[1]);
		else if (args.length === 1 && args[0] === "--help") {
			console.log("Usage: ./sync-upstream.sh [--ref origin/main|<upstream-ref>]\n       ./sync-upstream.sh --continue <worktree>\n       ./sync-upstream.sh --pr <worktree>");
		} else throw new Error("Invalid arguments. Use ./sync-upstream.sh --help");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
