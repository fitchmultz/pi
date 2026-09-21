import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { continueSync, prepareSync, publishSync } from "./sync-upstream.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(repo, path, content) {
	writeFileSync(join(repo, path), content);
	git(repo, "add", "--", path);
	git(repo, "commit", "-m", `Update ${path}`);
	return git(repo, "rev-parse", "HEAD");
}
function fixture(t, conflict = true) {
	const directory = mkdtempSync(join(tmpdir(), "pi-sync-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const upstream = join(directory, "upstream");
	const fork = join(directory, "fork.git");
	const repo = join(directory, "checkout");
	mkdirSync(upstream);
	git(upstream, "init", "--initial-branch=main");
	git(upstream, "config", "user.name", "Sync fixture");
	git(upstream, "config", "user.email", "fixture@example.test");
	commit(upstream, "shared.txt", "base\n");
	git(directory, "clone", "--bare", upstream, fork);
	git(directory, "clone", fork, repo);
	git(repo, "remote", "rename", "origin", "fork");
	git(repo, "remote", "add", "origin", upstream);
	git(repo, "config", "user.name", "Sync fixture");
	git(repo, "config", "user.email", "fixture@example.test");
	git(repo, "config", "commit.gpgsign", "false");
	if (conflict) commit(repo, "shared.txt", "fork behavior\n");
	else commit(repo, "fork.txt", "fork behavior\n");
	git(repo, "push", "fork", "main");
	const target = commit(upstream, "shared.txt", "upstream behavior\n");
	const release = join(directory, "immutable-release");
	mkdirSync(release);
	writeFileSync(join(release, "cli.js"), "running version\n");
	const current = join(directory, "current");
	symlinkSync(release, current);
	const journal = join(directory, "real-session.jsonl");
	writeFileSync(journal, '{"id":"preserve-history"}\n');
	const main = git(repo, "rev-parse", "main");
	return { directory, upstream, fork, repo, target, main, release, current, journal };
}

test("conflict task leaves dirty main, installed selection and journals untouched; resume pins original target", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.repo, "shared.txt"), "staged local work\n");
	git(f.repo, "add", "--", "shared.txt");
	writeFileSync(join(f.repo, "shared.txt"), "unstaged local work\n");
	writeFileSync(join(f.repo, "unrelated.txt"), "another helper\n");
	const index = git(f.repo, "diff", "--cached");
	const working = git(f.repo, "diff");
	const task = prepareSync(f.repo);
	assert.equal(realpathSync(dirname(task.worktree)), realpathSync(join(f.directory, "worktrees", "checkout")));
	assert.equal(task.target, f.target);
	assert.equal(git(task.worktree, "rev-parse", "MERGE_HEAD"), f.target);
	assert.equal(git(f.repo, "config", "--local", "rerere.enabled"), "true");
	assert.equal(git(f.repo, "config", "--local", "rerere.autoupdate"), "false");
	assert.match(readFileSync(join(task.worktree, "shared.txt"), "utf8"), /<<<<<<< HEAD/);
	assert.throws(() => continueSync(task.worktree, () => assert.fail("must reject before verification")), /Unresolved conflicts/);
	const newer = commit(f.upstream, "shared.txt", "upstream moved again\n");
	git(f.repo, "fetch", "--no-tags", "origin");
	writeFileSync(join(task.worktree, "shared.txt"), "fork behavior\nupstream behavior\n");
	assert.throws(() => continueSync(task.worktree, () => assert.fail("must require explicit staging")), /Unresolved conflicts/);
	git(task.worktree, "add", "--", "shared.txt");
	let verified = false;
	const merged = continueSync(task.worktree, (cwd) => {
		assert.equal(git(cwd, "rev-parse", "MERGE_HEAD"), f.target);
		assert.equal(readFileSync(join(cwd, "shared.txt"), "utf8"), "fork behavior\nupstream behavior\n");
		verified = true;
	});
	assert.equal(verified, true);
	assert.equal(git(task.worktree, "show", "-s", "--format=%P", merged), `${f.main} ${f.target}`);
	assert.notEqual(f.target, newer);
	assert.equal(git(f.repo, "rev-parse", "main"), f.main);
	assert.equal(git(f.repo, "branch", "--show-current"), "main");
	assert.equal(git(f.repo, "diff", "--cached"), index);
	assert.equal(git(f.repo, "diff"), working);
	assert.equal(readFileSync(join(f.repo, "unrelated.txt"), "utf8"), "another helper\n");
	assert.equal(readlinkSync(f.current), f.release);
	assert.equal(readFileSync(join(f.release, "cli.js"), "utf8"), "running version\n");
	assert.equal(readFileSync(f.journal, "utf8"), '{"id":"preserve-history"}\n');
});

test("prepared merge preserves native state on failed verification; successful integration is a repeated no-op", (t) => {
	const f = fixture(t, false);
	const task = prepareSync(f.repo, f.target);
	assert.equal(git(task.worktree, "rev-parse", "HEAD"), f.main);
	assert.equal(git(task.worktree, "rev-parse", "MERGE_HEAD"), f.target);
	assert.throws(() => continueSync(task.worktree, () => { throw new Error("fixture check failure"); }), /fixture check failure/);
	assert.equal(git(task.worktree, "rev-parse", "HEAD"), f.main);
	assert.equal(git(task.worktree, "rev-parse", "MERGE_HEAD"), f.target);
	assert.throws(() => publishSync(task.worktree), /Commit and validate/);
	continueSync(task.worktree, (cwd) => {
		assert.equal(readFileSync(join(cwd, "fork.txt"), "utf8"), "fork behavior\n");
		assert.equal(readFileSync(join(cwd, "shared.txt"), "utf8"), "upstream behavior\n");
	});
	// Simulate native PR merge by updating ONLY the disposable bare fork fixture.
	git(f.fork, "fetch", task.worktree, "HEAD:refs/heads/main");
	const worktrees = git(f.repo, "worktree", "list", "--porcelain");
	assert.equal(prepareSync(f.repo), undefined);
	assert.equal(prepareSync(f.repo), undefined);
	assert.equal(git(f.repo, "worktree", "list", "--porcelain"), worktrees);
	assert.equal(git(f.repo, "rev-parse", "main"), f.main);
});

test("verified upstream dependency updates pass the repository's lockfile commit policy", (t) => {
	const f = fixture(t, false);
	const target = commit(f.upstream, "package-lock.json", JSON.stringify({
		lockfileVersion: 3, packages: { "node_modules/example": { version: "1.0.0" } },
	}));
	const hooks = join(f.repo, ".git/hooks");
	git(f.repo, "config", "core.hooksPath", hooks);
	writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nexec '${process.execPath}' '${join(root, "scripts/check-lockfile-commit.mjs")}'\n`, { mode: 0o755 });
	const task = prepareSync(f.repo);
	const merged = continueSync(task.worktree, (cwd) => {
		assert.equal(JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8")).packages["node_modules/example"].version, "1.0.0");
	});
	assert.equal(git(task.worktree, "show", "-s", "--format=%P", merged), `${f.main} ${target}`);
	assert.equal(git(f.repo, "rev-parse", "main"), f.main);
});

test("delivery verification fails rather than skipping terminal coverage without tmux", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-no-tmux-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, [join(root, "scripts/verify-fork.mjs"), "--suite", "runtime"], {
		encoding: "utf8", env: { ...process.env, PATH: directory },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Fork verification failed:.*tmux/);
	assert.doesNotMatch(result.stdout, /build:offline/);
});

test("isolated focused tests resolve Node/npm before HOME changes and strip runtime credentials", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-isolation-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const shim = join(directory, "bin");
	mkdirSync(shim);
	// A real executable shim models the reported mise failure, not mocked spawn.
	writeFileSync(join(shim, "node"), `#!/bin/sh\n[ "$HOME" = '${directory}' ] || exit 97\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
	writeFileSync(join(shim, "npm"), "#!/bin/sh\nexit 98\n", { mode: 0o755 });
	const probe = join(directory, "probe.mjs");
	const evidence = join(directory, "evidence.json");
	writeFileSync(probe, `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
assert.equal(process.env.PI_CACHE_RETENTION, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.PI_SESSION_FILE, undefined);
assert.equal(process.env.PI_TEST_CLI, '/fixture/bundled-cli.js');
assert.notEqual(process.env.HOME, ${JSON.stringify(directory)});
assert.equal(execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(), process.execPath);
assert.match(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), /^\\d+\\./);
writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ home: process.env.HOME }));
`);
	const result = spawnSync("bash", [join(root, "test.sh"), "--", "node", probe], {
		cwd: root, encoding: "utf8", env: {
			...process.env, HOME: directory, PATH: `${shim}:${process.env.PATH}`,
			PI_CACHE_RETENTION: "long", ANTHROPIC_API_KEY: "must-not-leak", PI_SESSION_FILE: "/real/journal",
			PI_TEST_CLI: "/fixture/bundled-cli.js",
		},
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(existsSync(JSON.parse(readFileSync(evidence, "utf8")).home), false, "owned isolated home cleaned up");
	// Also exercise the default npm-test route, including distribution npm wrappers.
	writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node probe.mjs" } }));
	const defaultRun = spawnSync("bash", [join(root, "test.sh")], {
		cwd: directory, encoding: "utf8", env: {
			...process.env, HOME: directory, PATH: `${shim}:${process.env.PATH}`,
			PI_CACHE_RETENTION: "long", ANTHROPIC_API_KEY: "must-not-leak", PI_SESSION_FILE: "/real/journal",
			PI_TEST_CLI: "/fixture/bundled-cli.js",
		},
	});
	assert.equal(defaultRun.status, 0, `${defaultRun.stdout}\n${defaultRun.stderr}`);
	assert.equal(existsSync(JSON.parse(readFileSync(evidence, "utf8")).home), false);
});
