import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	availableParallelism,
	cpus,
	homedir,
	hostname,
	loadavg,
	networkInterfaces,
	release,
	tmpdir,
	totalmem,
} from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const directory = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
	options: {
		repo: { type: "string" },
		before: { type: "string" },
		after: { type: "string" },
		out: { type: "string" },
		groups: { type: "string" },
		repeat: { type: "string", default: "3" },
		"artifact-repo": { type: "string" },
		smoke: { type: "boolean" },
		list: { type: "boolean" },
		help: { type: "boolean" },
	},
});
if (values.help) {
	console.log(`node scripts/performance/run.mjs --repo ROOT --groups GROUPS --out NEW_DIRECTORY [--repeat 3] [--smoke]
node scripts/performance/run.mjs --before ROOT --after ROOT --groups GROUPS --out NEW_DIRECTORY
--list lists cases/inputs without executing. Groups or individual case names are comma-separated.
Every case runs serially in a fresh process; before/after order alternates between repeats.
--artifact-repo ROOT fixes one payload for pack/Nix and the scan cwd for Biome comparisons.
Build, pack, nix-pack, startup, extension-imports, extension-import-diagnostics, env-daemon, env-scan and biome are explicit opt-in groups.
Extension cases retain raw JSONL/inputs under OUT/artifacts; embedded cases require the documented task-local binary build.
Diagnostic cases enable jiti/PI_TIMING and Node CPU profiles; their elapsed times are not comparative evidence.`);
	process.exit(0);
}
const repeats = Number(values.repeat);
assert.ok(Number.isSafeInteger(repeats) && repeats > 0, "--repeat must be a positive integer");
const smoke = values.smoke ?? false;
const cases = [];
function add(group, name, fixture, args = [], env = {}) {
	cases.push({ group, name, fixture, args, env });
}
const samples = smoke ? "1" : "7";
for (const mode of ["read-head", "read-page", "read-limit", "read-json", "grep-context"]) {
	add("tools", mode, "tools.mjs", [mode, smoke ? "0.01" : mode === "read-json" ? "8" : "32", samples]);
}
for (const mode of ["exact", "fuzzy", "diff"])
	add("tools", `edit-${mode}`, "cpu.mjs", ["edit", smoke ? "0.01" : "8", smoke ? "2" : "32", samples, mode]);
for (const limit of [4718592, 50000])
	add("images", `image-${limit}`, "cpu.mjs", [
		"image",
		smoke ? "40" : "1600",
		smoke ? "30" : "1000",
		samples,
		"inprocess",
		String(limit),
	]);
add("ai", "ai-common", "ai.mjs", [
	smoke ? "--smoke" : "--iterations=3",
	`--samples=${samples}`,
	"--cases=parse,repair,tools,transform,estimate,validate,frames,queued-frames,agent",
]);
add("ai", "ai-queue-control", "ai.mjs", [
	smoke ? "--smoke" : "--iterations=1",
	`--samples=${samples}`,
	"--cases=queue",
]);
for (const count of smoke ? [4] : [30, 3000, 10000])
	add("ai", `catalog-${count}`, "catalog.mjs", [
		`--models=${count}`,
		`--samples=${samples}`,
		`--iterations=${smoke ? 1 : count === 30 ? 100 : 10}`,
	]);
for (const [name, messages, bytes, burst] of [
	["cached", 3000, 1024, 1],
	["burst-1000", 20, 128, 1000],
	["burst-50000", 20, 128, 50000],
])
	add("ai", `codex-${name}`, "codex.mjs", [
		`--messages=${smoke ? 4 : messages}`,
		`--bytes=${smoke ? 128 : bytes}`,
		`--burst=${smoke ? 4 : burst}`,
		`--samples=${samples}`,
		...(smoke ? ["--smoke"] : []),
	]);
for (const scenario of ["stream", "wrap", "preview", "editor", "input", "tree", "mermaid", "primitives"]) {
	add("tui", `tui-${scenario}`, "tui.ts", [scenario], {
		N: smoke ? "2" : scenario === "tree" ? "5" : "40",
		SIZE: smoke ? "80" : "16000",
		DEPTH: smoke ? "10" : "1000",
		LEAVES: smoke ? "3" : "1000",
	});
}
add("tui", "tui-highlight", "tui.ts", ["stream"], {
	N: smoke ? "2" : "40",
	SIZE: smoke ? "80" : "16000",
	REAL_HIGHLIGHT: "1",
});
add("tui", "mermaid-65536", "tui.ts", ["mermaid"], { N: smoke ? "2" : "40", SIZE: smoke ? "80" : "65536" });
for (const mode of ["stdio", "sse"])
	for (const size of smoke ? [4096] : [1048576, 8388608]) {
		add("bridges", `${mode}-${size}`, "bridges.mjs", [
			mode,
			`--size=${size}`,
			`--repeat=${samples}`,
			...(smoke ? ["--smoke"] : []),
		]);
	}
for (const mode of ["frame", "publish", "metadata", "sandbox", "json", "http-error"]) {
	add("bridges", `bridge-${mode}`, "bridges.mjs", [
		mode,
		`--repeat=${samples}`,
		...(smoke ? ["--smoke"] : mode === "http-error" ? ["--size=8388608"] : []),
	]);
}
add("bridges", "publish-10000", "bridges.mjs", [
	"publish",
	`--iterations=${smoke ? 8 : 10000}`,
	`--repeat=${samples}`,
	...(smoke ? ["--smoke"] : []),
]);
for (const count of smoke ? [20] : [10000, 100000])
	for (const mode of ["projection", "name", "branch", "boundary", "context"]) {
		add("sessions", `sessions-${mode}-${count}`, "sessions.mts", [mode, ...(smoke ? ["--smoke"] : [])], {
			SESSION_ENTRIES: String(count),
			SESSION_ITERATIONS: smoke ? "1" : "15",
		});
	}
for (const mode of ["fork", "list", "working", "split"])
	add("sessions", `sessions-${mode}`, "sessions.mts", [mode, ...(smoke ? ["--smoke"] : [])], {
		SESSION_ENTRIES: smoke ? "20" : "10000",
		SESSION_ITERATIONS: smoke ? "1" : "7",
	});
add("durable", "context-retention", "durable-context.ts", [smoke ? "0,3" : "0,100,1000,10000", smoke ? "1" : "120"]);
add("durable", "history", "durable-history.ts", [smoke ? "32" : "1024,8192,65536", smoke ? "2" : "1000"]);
add("durable", "node-longline", "durable-lines.ts", [smoke ? "1" : "1024,4096,16384", samples]);
for (const size of smoke ? [1] : [1, 1024])
	add("durable", `sqlite-${size}`, "durable-storage.ts", [String(size), smoke ? "2" : "30"]);
add("env-client", "env-small", "env-client.mjs", ["probe", smoke ? "1" : "1000", "3"]);
add("env-client", "env-tail", "env-client.mjs", ["probe", smoke ? "1" : "50", smoke ? "1025" : "524289"]);
add("env-client", "env-list", "env-client.mjs", ["list", samples, smoke ? "20" : "50000"]);
for (const size of smoke ? [1024] : [1048576, 4194304, 16777216]) {
	add("env-client", `env-longline-${size}`, "env-client.mjs", ["longline", samples, String(size)]);
	add("env-daemon", `env-daemon-${size}`, "env-daemon.mjs", [
		smoke ? "1" : "5",
		String(size),
		smoke ? "3" : size === 16777216 ? "10000" : "1000",
	]);
}
add("env-scan", "env-scan", "env-scan.mjs", [smoke ? "10" : "1000000", smoke ? "1" : "5"]);
add("env-scan", "env-frame-control", "env-scan.mjs", ["frames", smoke ? "1024" : "524288", smoke ? "2" : "1000"]);
add("evals", "eval-report", "eval-report.mjs", [
	"--runs",
	samples,
	"--sizes",
	smoke ? "2" : "100,1000,10000",
	"--report-mib",
	smoke ? "0" : "0,1,10",
]);
add("evals", "eval-persistence", "eval-persistence.mjs", [
	"--runs",
	smoke ? "1" : "3",
	"--warmup",
	smoke ? "0" : "1",
	"--pairs",
	smoke ? "2" : "100,1000",
]);
for (const updates of [20, 1000])
	add("telemetry", `telemetry-${updates}`, "telemetry.mjs", [
		"--spans",
		smoke ? "4" : "10000",
		"--updates",
		smoke ? "2" : String(updates),
		"--snapshots",
		smoke ? "1" : "10",
	]);
add("background", "background-monitor", "background.mjs", [smoke ? "3" : "1000", smoke ? "1" : "9", smoke ? "0" : "2"]);
for (const owner of ["tool", "executor"])
	for (const sink of ["normal", "slow"]) {
		add("bash", `bash-${owner}-${sink}`, "bash.mjs", [sink, smoke ? "0.125" : "64", owner]);
	}
add("pack", "pack", "artifacts.mjs", ["pack"]);
add("nix-pack", "nix-pack", "nix-pack.mjs");
add("build", "build", "artifacts.mjs", ["build"]);
add("startup", "startup", "startup.mjs", [
	"{repo}/packages/coding-agent/dist/cli.js",
	smoke ? "1" : "9",
	smoke ? "0" : "2",
	"isolated",
]);
for (const workload of ["esm", "async", "cpu"])
	for (const mode of ["loader", "unbundled", "bundled", "embedded"])
		add("extension-imports", `extension-imports-${workload}-${mode}`, "extension-imports.mjs", [workload, mode]);
for (const workload of ["esm", "async"])
	for (const mode of ["unbundled", "bundled", "embedded"])
		add("extension-import-diagnostics", `extension-imports-${workload}-${mode}-diagnostic`, "extension-imports.mjs", [
			workload,
			mode,
			"diagnostic",
		]);
add("biome", "biome-native", "biome.mjs", ["native"]);
add("biome", "biome-fallback", "biome.mjs", ["fallback"]);

add("qualification", "ai-common-controls", "ai.mjs", [
	smoke ? "--smoke" : "--iterations=3",
	`--samples=${samples}`,
	"--cases=transform,estimate,validate,frames",
]);
add("qualification", "history-current-65536", "durable-history.ts", [
	smoke ? "32" : "65536",
	smoke ? "2" : "1000",
	"--current-only",
]);
for (const [name, mode, size, smokeSize, runs] of [
	["ls-10000", "ls", "10000", "20", "7"],
	["resources-250", "resources", "250", "3", "7"],
	["background-1000", "background", "1000", "3", "7"],
	["spill-64mib", "spill", "64", "0.125", "3"],
])
	add("qualification", name, "tools.mjs", [mode, smoke ? smokeSize : size, smoke ? "1" : runs]);
add("qualification", "startup-bundled", "startup.mjs", [
	"{repo}/packages/coding-agent/dist/bundle/cli.js",
	smoke ? "1" : "9",
	smoke ? "0" : "2",
	"isolated",
]);
add(
	"qualification",
	"env-daemon-controls-16777216",
	"env-daemon.mjs",
	[smoke ? "1" : "5", smoke ? "1024" : "16777216", smoke ? "3" : "10000"],
	{ PI_PERF_DAEMON_CONTROLS: "1" },
);

const selected = new Set(values.groups?.split(",") ?? []);
const available = new Set(cases.flatMap((c) => [c.group, c.name]));
for (const name of selected) assert.ok(available.has(name), `Unknown group/case: ${name}`);
const chosen = cases.filter((c) => (selected.size === 0 ? values.list : selected.has(c.group) || selected.has(c.name)));
assert.ok(chosen.length > 0, "Select --groups (or use --list)");
if (values.list) {
	console.log(JSON.stringify(chosen, null, 2));
	process.exit(0);
}
assert.ok(values.out, "--out must name a new output directory");
assert.ok(
	values.repo ? !values.before && !values.after : values.before && values.after,
	"Use --repo or both --before and --after",
);
const roots = values.repo
	? [["repo", resolve(values.repo)]]
	: [
			["before", resolve(values.before)],
			["after", resolve(values.after)],
		];
assert.ok(
	roots.length === 1 || !chosen.some((benchmark) => benchmark.group === "biome") || values["artifact-repo"],
	"Paired Biome runs require --artifact-repo for one fixed scan payload",
);
const out = resolve(values.out);
assert.ok(!existsSync(out), "Output already exists; preserve evidence and use a new directory");
const hash = (value) => createHash("sha256").update(value).digest("hex");
function hashes(root, include) {
	const result = {};
	function visit(path) {
		for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) {
				if (!["node_modules", ".git", ".pi", ".artifacts", ".eval", "target", "dist"].includes(entry.name))
					visit(full);
			} else if (entry.isFile()) {
				const name = relative(root, full).replaceAll("\\", "/");
				if (include(name)) result[name] = hash(readFileSync(full));
			}
		}
	}
	visit(root);
	return result;
}
function sourceIdentity(root) {
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const sourceHashes = hashes(
		root,
		(path) =>
			/^(packages|apps)\/[^/]+\/(src|daemon\/src)\//.test(path) ||
			/^(scripts\/(?!performance\/).*\.(mjs|ts)|[^/]*lock[^/]*|tsconfig[^/]*|packages\/[^/]+\/package\.json|packages\/env\/daemon\/(Cargo\.(toml|lock)|rust-toolchain\.toml))$/.test(
				path,
			) ||
			/^packages\/coding-agent\/test\/(suite\/harness\.ts|utilities\.ts|model-runtime-test-utils\.ts)$/.test(path),
	);
	return { revision, sourceSha256: hash(JSON.stringify(sourceHashes)), sourceHashes };
}
const identities = Object.fromEntries(roots.map(([label, root]) => [label, sourceIdentity(root)]));
const fixtureHashes = hashes(directory, () => true);
const npmScratch = mkdtempSync(join(tmpdir(), "pi-perf-npm-"));
let npmVersion;
try {
	const toolEnv = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: npmScratch,
		USERPROFILE: npmScratch,
		npm_config_userconfig: join(npmScratch, "user-npmrc"),
		npm_config_globalconfig: join(npmScratch, "global-npmrc"),
	};
	npmVersion = execFileSync("npm", ["--version"], {
		env: toolEnv,
		encoding: "utf8",
		shell: process.platform === "win32",
	}).trim();
} finally {
	rmSync(npmScratch, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });
const manifest = {
	schemaVersion: 2,
	smoke,
	repeats,
	environment: {
		node: process.version,
		nodeSha256: hash(readFileSync(process.execPath)),
		npm: npmVersion,
		hostname: hostname(),
		availableParallelism: availableParallelism(),
		networkInterfaces: Object.keys(networkInterfaces()),
		networkNamespace: process.platform === "linux" ? readlinkSync("/proc/self/ns/net") : undefined,
		platform: process.platform,
		arch: process.arch,
		osRelease: release(),
		cpu: cpus()[0]?.model,
		cpuCount: cpus().length,
		memoryBytes: totalmem(),
	},
	identities,
	fixtureHashes,
	cases: chosen,
	results: [],
};
function saveManifest() {
	const path = join(out, "manifest.json");
	writeFileSync(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}
const witnesses = new Map();
for (const benchmark of chosen)
	for (let trial = 0; trial < (smoke ? 1 : repeats); trial++) {
		const order = trial % 2 ? [...roots].reverse() : roots;
		for (const [label, root] of order) {
			const scratch = mkdtempSync(join(tmpdir(), "pi-perf-"));
			for (const child of ["home", "tmp", "agent"]) mkdirSync(join(scratch, child));
			// Deliberate allowlist: no auth/provider variables, NODE_OPTIONS, shell startup hooks or user configuration.
			const env = {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				HOME: join(scratch, "home"),
				USERPROFILE: join(scratch, "home"),
				TMPDIR: join(scratch, "tmp"),
				TMP: join(scratch, "tmp"),
				TEMP: join(scratch, "tmp"),
				PI_CODING_AGENT_DIR: join(scratch, "agent"),
				PI_PERF_REPO: root,
				PI_PERF_EVIDENCE_DIR: join(out, "artifacts", `${benchmark.name}-${label}-${trial}`),
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PERF_SMOKE: smoke ? "1" : "0",
				PI_PERF_ARTIFACT_REPO: values["artifact-repo"] ? resolve(values["artifact-repo"]) : root,
				PI_PERF_CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
				PI_PERF_RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
				npm_execpath: process.env.npm_execpath,
				npm_config_userconfig: join(scratch, "home", ".npmrc"),
				npm_config_globalconfig: join(scratch, "home", "global-npmrc"),
				npm_config_offline: "true",
				npm_config_ignore_scripts: "true",
				PI_ENV_DAEMON: join(root, "packages/env/daemon/target/release/pi-env"),
				...benchmark.env,
			};
			const args = [
				"--expose-gc",
				"--import",
				join(root, "packages/coding-agent/src/experimental/source-resolver.ts"),
				"--import",
				join(directory, "source-hook.mjs"),
				join(directory, "fixtures", benchmark.fixture),
				...benchmark.args.map((a) => a.replaceAll("{repo}", root)),
			];
			const log = `${benchmark.name}-${label}-${trial}.log`;
			const replacements = [
				...roots.map(([, path]) => [path, "<repo>"]),
				[scratch, "<scratch>"],
				[directory, "<harness>"],
				...(values["artifact-repo"] ? [[resolve(values["artifact-repo"]), "<payload>"]] : []),
			].sort((a, b) => b[0].length - a[0].length);
			const redact = (text) => replacements.reduce((text, [path, marker]) => text.replaceAll(path, marker), text);
			const records = [];
			const load = loadavg();
			const attempt = {
				case: benchmark.name,
				label,
				trial,
				load,
				log,
				artifacts: relative(out, env.PI_PERF_EVIDENCE_DIR),
				status: "running",
				verified: false,
				command: ["node", ...args.map(redact)],
				cwd: "<repo>",
				records,
			};
			let started;
			try {
				writeFileSync(join(out, log), "", { flag: "wx" });
				manifest.results.push(attempt);
				saveManifest();
				started = performance.now();
				const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
				for (const stream of [child.stdout, child.stderr]) {
					let pending = "";
					const flush = (final) => {
						const end = final ? pending.length : pending.lastIndexOf("\n") + 1;
						if (!end) return;
						const text = redact(pending.slice(0, end));
						pending = pending.slice(end);
						appendFileSync(join(out, log), text);
						if (stream === child.stdout)
							for (const line of text.split("\n"))
								try {
									records.push(JSON.parse(line));
								} catch {
									// Human-readable product output is preserved in the log, not treated as a record.
								}
					};
					stream.setEncoding("utf8");
					stream.on("data", (chunk) => {
						pending += chunk;
						flush(false);
					});
					stream.on("end", () => flush(true));
				}
				const code = await new Promise((done, fail) => {
					child.once("error", fail);
					child.once("close", (status, signal) => done(signal ?? status));
				});
				attempt.elapsedMs = performance.now() - started;
				attempt.code = code;
				attempt.status = "verifying";
				saveManifest();
				const proof = records.filter((r) => r.verification).map((r) => r.verification);
				assert.equal(code, 0, `${benchmark.name} failed; see ${log}`);
				assert.ok(proof.length > 0, `${benchmark.name} emitted no output witness`);
				assert.equal(
					sourceIdentity(root).sourceSha256,
					identities[label].sourceSha256,
					"Measured source changed; discard this comparison",
				);
				const key = benchmark.name;
				// Build source changes legitimately change dist; pack comparisons must use --artifact-repo for one payload.
				if (benchmark.group !== "build" && !(benchmark.group === "pack" && !values["artifact-repo"])) {
					if (witnesses.has(key))
						assert.deepEqual(proof, witnesses.get(key), `${key}: input/output witnesses changed`);
					else witnesses.set(key, proof);
				}
				attempt.verified = true;
				attempt.status = "passed";
				saveManifest();
				console.log(`${benchmark.name} ${label} ${trial}: passed`);
			} catch (error) {
				attempt.status = "failed";
				attempt.elapsedMs ??= started === undefined ? 0 : performance.now() - started;
				attempt.error = redact(error.stack ?? String(error));
				appendFileSync(join(out, log), `${attempt.error}\n`);
				saveManifest();
				throw error;
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		}
	}
console.log(`Saved ${manifest.results.length} serial fresh-process cases; smoke timings are not performance evidence.`);
