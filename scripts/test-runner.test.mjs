import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-command.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
// These keys escaped past denylists; an unknown key must be isolated too.
const credentialNames = ["KIMI_API_KEY", "HF_TOKEN", "FIREWORKS_API_KEY", "NVIDIA_API_KEY", "ANT_LING_API_KEY", "FUTURE_PROVIDER_API_KEY"];

function fixture(t, failurePhase) {
	const root = mkdtempSync(join(tmpdir(), "pi-test-runner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const callerHome = join(root, "caller home");
	const auth = join(callerHome, ".pi", "agent", "auth.json");
	mkdirSync(dirname(auth), { recursive: true });
	writeFileSync(auth, "caller credentials must not be touched");
	mkdirSync(join(root, "packages", "fixture"), { recursive: true });
	copyFileSync(join(repo, "test.sh"), join(root, "test.sh"));
	writeFileSync(join(root, "package.json"), JSON.stringify({
		private: true,
		workspaces: ["packages/*"],
		scripts: { test: manifest.scripts.test, "test:scripts": "node probe.mjs scripts" },
	}));
	writeFileSync(join(root, "packages", "fixture", "package.json"), JSON.stringify({
		name: "test-runner-fixture",
		scripts: { test: "node ../../probe.mjs workspace" },
	}));
	writeFileSync(join(root, "probe.mjs"), `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [phase, ...args] = process.argv.slice(2);
appendFileSync(new URL("observed.jsonl", import.meta.url), JSON.stringify({
	phase, args, home: process.env.HOME,
	authVisible: existsSync(join(process.env.HOME, ".pi", "agent", "auth.json")),
	credentials: Object.fromEntries(${JSON.stringify(credentialNames)}.map(name => [name, process.env[name]])),
}) + "\\n");
if (phase === ${JSON.stringify(failurePhase) ?? "undefined"}) process.exitCode = 17;
`);
	const env = {
		...process.env,
		HOME: callerHome,
		USERPROFILE: callerHome,
		...Object.fromEntries(credentialNames.map((name) => [name, "harmless-test-sentinel"])),
	};
	return {
		callerHome, auth,
		run: (command, args) => spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 30000 }),
		runNpm: () => {
			try {
				return { status: 0, stdout: execNpmSync(["test"], { cwd: root, env, encoding: "utf8", timeout: 30000 }), stderr: "" };
			} catch (error) {
				return error;
			}
		},
		observed: () => readFileSync(join(root, "observed.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
	};
}

for (const entry of ["npm test", "./test.sh"]) {
	test(`${entry} isolates both script and workspace tests from caller credentials`, (t) => {
		const f = fixture(t);
		const result = entry === "npm test" ? f.runNpm() : f.run("bash", ["./test.sh"]);
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
		const observed = f.observed();
		for (const run of observed) {
			for (const name of credentialNames) {
				assert.equal(run.credentials[name], undefined, `${entry} leaked ${name} into ${run.phase}`);
			}
			assert.notEqual(run.home, f.callerHome);
			assert.equal(run.authVisible, false);
			assert.equal(existsSync(run.home), false, "isolated home must be cleaned after the run");
		}
		assert.deepEqual(observed.map((run) => run.phase), ["scripts", "workspace"]);
		assert.equal(readFileSync(f.auth, "utf8"), "caller credentials must not be touched");
	});
}

test("stops before workspace tests when script tests fail and returns their exit status", (t) => {
	const f = fixture(t, "scripts");
	const result = f.runNpm();
	assert.equal(result.status, 17, `${result.stdout}${result.stderr}`);
	assert.deepEqual(f.observed().map((run) => run.phase), ["scripts"]);
	assert.equal(existsSync(f.observed()[0].home), false);
});

test("focused commands preserve arguments and failure status without running the full suite", (t) => {
	const f = fixture(t, "focused");
	const result = f.run("bash", ["./test.sh", "--", "node", "probe.mjs", "focused", "with spaces", "$literal"]);
	assert.equal(result.status, 17, `${result.stdout}${result.stderr}`);
	const observed = f.observed();
	assert.equal(observed.length, 1);
	const [run] = observed;
	assert.equal(run.phase, "focused");
	assert.deepEqual(run.args, ["with spaces", "$literal"]);
	assert.deepEqual(run.credentials, {});
	assert.equal(run.authVisible, false);
	assert.equal(existsSync(run.home), false);
	assert.equal(readFileSync(f.auth, "utf8"), "caller credentials must not be touched");
});
