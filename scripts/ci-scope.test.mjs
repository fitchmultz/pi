import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = join(repoRoot, "scripts/ci-scope.mjs");

function createRepoFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-ci-scope-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });

	const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");

	const write = (relPath, content = "seed\n") => {
		const target = join(repo, relPath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	};
	const remove = (relPath) => {
		unlinkSync(join(repo, relPath));
	};
	const commit = (message = "change") => {
		git("add", "-A");
		git("commit", "-q", "--allow-empty", "-m", message);
		return git("rev-parse", "HEAD");
	};

	write("packages/coding-agent/src/cli.ts", "export const v = 1;\n");
	write("README.md", "# pi\n");
	const base = commit("initial");

	let callId = 0;
	const invoke = (args) => {
		callId += 1;
		const outputFile = join(root, `output-${callId}.txt`);
		const summaryFile = join(root, `summary-${callId}.md`);
		const result = spawnSync(process.execPath, [scriptPath, ...args], {
			cwd: repo,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_OUTPUT: outputFile,
				GITHUB_STEP_SUMMARY: summaryFile,
			},
		});
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			output: existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
			summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "",
		};
	};

	return { git, write, remove, commit, base, invoke };
}

function assertPlanned(result, expectedRequired) {
	assert.equal(result.status, 0, result.stderr);
	const plan = JSON.parse(result.stdout);
	assert.equal(plan.macosRequired, expectedRequired);
	assert.equal(result.output, `macos-required=${expectedRequired}\n`);
	assert.match(result.summary, new RegExp(`macOS restart/background CI required: \\*\\*${expectedRequired}\\*\\*`));
	assert.ok(result.summary.includes(plan.reason));
	return plan;
}

function collectFiles(dir, prefix = "") {
	const results = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			results.push(...collectFiles(join(dir, entry.name), rel));
		} else if (entry.isFile()) {
			results.push(rel);
		}
	}
	return results;
}

function collectMacosJobReachableFiles() {
	const ciWorkflow = YAML.parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
	const macosJob = ciWorkflow.jobs["macos-restart-background"];
	assert.ok(macosJob, "ci.yml must define jobs.macos-restart-background");
	assert.equal(macosJob.needs, "scope");
	assert.equal(macosJob.if, "needs.scope.outputs.macos-required == 'true'");

	const tracked = new Set(
		execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean),
	);
	const seeds = new Set([".github/workflows/ci.yml", "scripts/build.mjs", "test.sh"]);

	for (const step of macosJob.steps) {
		if (typeof step.run !== "string") continue;
		for (const match of step.run.matchAll(/scripts\/[\w.-]+\.m?js/g)) {
			if (tracked.has(match[0])) seeds.add(match[0]);
		}
		if (step["working-directory"] === "packages/coding-agent" && step.run.includes("vitest")) {
			const tokens = step.run.trim().split(/\s+/);
			const reporterIndex = tokens.findLastIndex((token) => token.startsWith("--"));
			const filters = tokens.slice(reporterIndex + 1);
			assert.ok(filters.length > 0, "vitest step must declare test filters");
			for (const rel of collectFiles(join(repoRoot, "packages/coding-agent/test"))) {
				if (rel.endsWith(".test.ts") && filters.some((filter) => rel.includes(filter))) {
					seeds.add(`packages/coding-agent/test/${rel}`);
				}
			}
		}
	}

	// Follow relative imports up to two hops from the workflow's scripts and tests so transitive
	// helpers (such as scripts/install-fork.mjs and coding-agent examples/) are verified directly.
	const depths = new Map([...seeds].map((path) => [path, 0]));
	const queue = [...seeds];
	while (queue.length > 0) {
		const current = queue.pop();
		const depth = depths.get(current) ?? 0;
		if (depth >= 2 || !/\.(m?js|ts)$/.test(current)) continue;
		const source = readFileSync(join(repoRoot, current), "utf8");
		for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
			const baseCandidate = posix.normalize(posix.join(posix.dirname(current), match[1]));
			for (const candidate of [
				baseCandidate,
				`${baseCandidate}.ts`,
				`${baseCandidate}.mjs`,
				`${baseCandidate}/index.ts`,
			]) {
				if (tracked.has(candidate) && !seeds.has(candidate)) {
					seeds.add(candidate);
					depths.set(candidate, depth + 1);
					queue.push(candidate);
				}
			}
		}
	}
	return [...seeds].sort();
}

test("skips macos-restart-background when changes stay in isolated packages, docs, or non-macOS test suites", (t) => {
	const f = createRepoFixture(t);
	for (const path of [
		"FORK.md",
		"README.md",
		"docs/upstream-sync-1.5.2.md",
		".pi/skills/github-work.md",
		".github/workflows/env.yml",
		"packages/ai/src/api/anthropic-messages.ts",
		"packages/ai/catalog/families/anthropic.ts",
		"packages/ai/test/anthropic-sse-parsing.test.ts",
		"packages/ai/CHANGELOG.md",
		"packages/tui/README.md",
		"packages/tui/CHANGELOG.md",
		"packages/tui/docs/overview.md",
		"packages/tui/native/darwin/README.md",
		"packages/tui/test/markdown.test.ts",
		"packages/coding-agent/docs/tui.md",
		"packages/coding-agent/CHANGELOG.md",
		"packages/coding-agent/schemas/settings.schema.json",
		"packages/agent/src/agent.ts",
		"packages/env/src/remote-env.ts",
		"packages/env/daemon/src/exec.rs",
		"packages/evals/src/cli.ts",
		"packages/durable/test/harness-view.test.ts",
		"apps/p2/src/hosts/server.ts",
		"nix/package.nix",
		"flake.lock",
	]) {
		f.write(path, "updated\n");
	}
	const head = f.commit("fast-path changes");

	for (const event of ["pull_request", "push"]) {
		const plan = assertPlanned(f.invoke(["--event", event, "--base", f.base, "--head", head]), false);
		assert.match(plan.reason, /documentation and non-CI metadata/);
		assert.match(plan.reason, /isolated packages/);
		assert.match(plan.reason, /non-macOS-job package tests/);
	}
});

test("pull_request compares against merge-base so concurrent main runtime commits do not mask a PR fast path", (t) => {
	const f = createRepoFixture(t);
	f.git("checkout", "-q", "-b", "feature");
	f.write("packages/ai/src/provider-summary.ts", "export const ok = true;\n");
	f.write("packages/tui/README.md", "updated docs\n");
	const prHead = f.commit("isolated PR");

	f.git("checkout", "-q", f.base);
	f.write("packages/coding-agent/src/cli/launcher.ts", "export const mainChanged = true;\n");
	const mainHead = f.commit("main runtime commit");

	assertPlanned(f.invoke(["--event", "pull_request", "--base", mainHead, "--head", prHead]), false);
});

test("requires macos-restart-background for workspace configs, runtime sources, CI changes, deletions, and unknown paths", async (t) => {
	const requiringPaths = [
		"package.json",
		"package-lock.json",
		"tsconfig.base.json",
		"packages/ai/package.json",
		"packages/ai/tsconfig.build.json",
		"packages/ai/scripts/hydrate-model-catalog.ts",
		"packages/tui/package.json",
		"packages/tui/src/tui-alt-screen.ts",
		"packages/tui/native/darwin/src/darwin-platform.m",
		"packages/coding-agent/src/extensions/restart/index.ts",
		"packages/coding-agent/test/export-html-cost.test.ts",
		"packages/durable/src/env/node.ts",
		"packages/chord/src/index.ts",
		"packages/codemode/src/runtime/host.ts",
		"packages/mcp/src/transports/stdio.ts",
		"apps/p2/package.json",
		"packages/evals/package.json",
		"scripts/ci-scope.mjs",
		".github/workflows/ci.yml",
		"unclassified-root-file.txt",
		"dir with spaces/file\nnewline.ts",
	];
	for (const path of requiringPaths) {
		await t.test(path, (t) => {
			const f = createRepoFixture(t);
			f.write("FORK.md", "docs change alongside\n");
			f.write("packages/ai/src/index.ts", "isolated change alongside\n");
			f.write(path, "requires macOS\n");
			const head = f.commit();
			const plan = assertPlanned(f.invoke(["--event", "pull_request", "--base", f.base, "--head", head]), true);
			assert.ok(plan.reason.includes(JSON.stringify(path)), `reason should name ${path}: ${plan.reason}`);
		});
	}

	await t.test("deleted runtime file", (t) => {
		const f = createRepoFixture(t);
		f.remove("packages/coding-agent/src/cli.ts");
		const head = f.commit("delete runtime file");
		const plan = assertPlanned(f.invoke(["--event", "push", "--base", f.base, "--head", head]), true);
		assert.ok(plan.reason.includes(JSON.stringify("packages/coding-agent/src/cli.ts")));
	});
});

test("fails closed on workflow_dispatch, empty diffs, and initial-branch pushes, and rejects invalid arguments", (t) => {
	const f = createRepoFixture(t);
	assertPlanned(f.invoke(["--event", "workflow_dispatch", "--base", "", "--head", f.base]), true);

	const emptyCommit = f.commit("empty");
	assertPlanned(f.invoke(["--event", "push", "--base", f.base, "--head", emptyCommit]), true);
	assertPlanned(f.invoke(["--event", "push", "--base", "0".repeat(40), "--head", emptyCommit]), true);

	const helpResult = f.invoke(["--help"]);
	assert.equal(helpResult.status, 0);
	assert.match(helpResult.stdout, /Usage:/);

	for (const badArgs of [
		["--event", "schedule", "--base", f.base, "--head", emptyCommit],
		["--event", "push", "--base", "not-a-sha", "--head", emptyCommit],
		["--event", "push", "--base", "a".repeat(40), "--head", emptyCommit],
		["extra-positional", "--event", "workflow_dispatch"],
	]) {
		const bad = f.invoke(badArgs);
		assert.equal(bad.status, 1, `expected failure for ${JSON.stringify(badArgs)}`);
	}
});

test("every file reached by macos-restart-background in ci.yml requires macos-restart-background", async (t) => {
	const reachable = collectMacosJobReachableFiles();
	assert.ok(
		reachable.includes("packages/coding-agent/examples/extensions/permission-gate.ts"),
		"reachability walk must follow test imports into coding-agent examples",
	);
	assert.ok(reachable.includes("scripts/install-fork.mjs"), "reachability walk must follow script imports");

	const f = createRepoFixture(t);
	for (const path of reachable) {
		await t.test(path, () => {
			f.write(path, `touched ${path}\n`);
			const head = f.commit(`touch ${path}`);
			const plan = assertPlanned(f.invoke(["--event", "push", "--base", f.base, "--head", head]), true);
			assert.ok(plan.reason.includes(JSON.stringify(path)));
			f.base = head;
		});
	}
});

test("every Linux apt-get step in ci.yml and env.yml configures backup DNS resolvers beforehand", () => {
	for (const workflowFile of [".github/workflows/ci.yml", ".github/workflows/env.yml"]) {
		const parsed = YAML.parse(readFileSync(join(repoRoot, workflowFile), "utf8"));
		for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
			const steps = job.steps ?? [];
			for (let index = 0; index < steps.length; index += 1) {
				const step = steps[index];
				if (typeof step.run !== "string" || !step.run.includes("apt-get")) continue;
				const prior = steps.slice(0, index);
				const dnsStep = prior.findLast(
					(candidate) =>
						typeof candidate.uses === "string" &&
						/^fitchmultz\/\.github\/\.github\/actions\/setup-linux-dns@[a-f0-9]{40}$/.test(candidate.uses),
				);
				assert.ok(dnsStep, `${workflowFile} jobs.${jobName} step "${step.name}" runs apt-get without setup-linux-dns`);
				assert.equal(
					dnsStep.if ?? null,
					step.if ?? null,
					`${workflowFile} jobs.${jobName} setup-linux-dns condition must match "${step.name}"`,
				);
			}
		}
	}
});
