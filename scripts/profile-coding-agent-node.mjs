import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCliPath = join(packageDir, "dist", "cli.js");
const bundledDistCliPath = join(packageDir, "dist", "bundle", "cli.js");
const srcCliPath = join(packageDir, "src", "cli.ts");
const defaultNodeProfileDir = join(repoRoot, "profiles-node");
const defaultBunProfileDir = join(repoRoot, "profiles-bun");
const agentDirEnvName = "PI_CODING_AGENT_DIR";
const startupBenchmarkEnvName = "PI_STARTUP_BENCHMARK";

function printHelp() {
	console.log(`Usage:
  node scripts/profile-coding-agent-node.mjs [options]

Profiles coding-agent startup with the runtime selected below:
- npm run profile:tui     -> builds packages/coding-agent and profiles TUI startup with Node
- npm run profile:rpc     -> builds packages/coding-agent and profiles RPC startup with Node
- bun run profile:tui     -> profiles TUI startup from src/cli.ts directly with Bun
- bun run profile:rpc     -> profiles RPC startup from src/cli.ts directly with Bun

Options:
  --mode <name>          tui or rpc (default: tui)
  --runs <n>             Number of measured runs (default: 1)
  --warmup <n>           Number of warmup runs before measurements (default: 0)
  --profile-dir <dir>    CPU profile output directory
                         Default: profiles-node for Node, profiles-bun for Bun
  --label <name>         Profile name prefix (default: <mode>-startup)
  --runtime <name>       node, bun, or auto (default: auto)
  --entry <file>         Profile this CLI entrypoint without building it
  --cwd <dir>            Child working directory (default: packages/coding-agent)
  --agent-dir <dir>      Use a specific PI_CODING_AGENT_DIR for the benchmark run
  --isolated-agent-dir   Use a fresh temporary agent dir instead of the normal one
  --bundle               Build and profile the bundled Node entrypoint instead of dist/cli.js
  --no-offline           Do not force PI_OFFLINE=1 / PI_SKIP_VERSION_CHECK=1
  --skip-build           Reuse the selected build output without rebuilding first (Node only)
  --cpu-profile          Write CPU profiles for benchmark runs
  --help                 Show this help

Notes:
  - By default the benchmark uses your normal configured agent dir, so global models/auth/settings work.
  - TUI readiness is InteractiveMode.init completion, including awaited session_start handlers and startup render.
  - The benchmark then drains terminal replies for 150ms before stopping; this is excluded from ready time.
  - Background extension work is excluded unless its session_start handler awaits it.
  - Process-to-ready wall time includes launch/import overhead; initialization spans and exit time are separate.
  - --no-offline preserves inherited PI_OFFLINE / PI_SKIP_VERSION_CHECK rather than clearing them.
  - RPC mode measures startup until a real get_state request receives a response, then closes stdin to exit cleanly.
  - CPU profiles are kept in the selected profile directory for later analysis.
`);
}

function parseIntegerFlag(value, name) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	return parsed;
}

function parseRuntime(value) {
	if (value === "auto" || value === "node" || value === "bun") {
		return value;
	}
	throw new Error(`Invalid --runtime: ${value}`);
}

function parseMode(value) {
	if (value === "tui" || value === "rpc") {
		return value;
	}
	throw new Error(`Invalid --mode: ${value}`);
}

function parseArgs(argv) {
	const options = {
		mode: "tui",
		bundle: false,
		runs: 1,
		warmup: 0,
		profileDir: undefined,
		label: undefined,
		offline: true,
		build: true,
		runtime: "auto",
		entry: undefined,
		cwd: packageDir,
		agentDir: undefined,
		isolatedAgentDir: false,
		cpuProfile: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];

		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		if (arg === "--no-offline") {
			options.offline = false;
			continue;
		}

		if (arg === "--isolated-agent-dir") {
			options.isolatedAgentDir = true;
			continue;
		}

		if (arg === "--bundle") {
			options.bundle = true;
			continue;
		}

		if (arg === "--skip-build") {
			options.build = false;
			continue;
		}

		if (arg === "--cpu-profile") {
			options.cpuProfile = true;
			continue;
		}

		if (
			(arg === "--mode" ||
				arg === "--runs" ||
				arg === "--warmup" ||
				arg === "--profile-dir" ||
				arg === "--label" ||
				arg === "--runtime" ||
				arg === "--entry" ||
				arg === "--cwd" ||
				arg === "--agent-dir") &&
			index + 1 >= argv.length
		) {
			throw new Error(`Missing value for ${arg}`);
		}

		if (arg === "--mode") {
			options.mode = parseMode(argv[++index]);
			continue;
		}

		if (arg === "--runs") {
			options.runs = parseIntegerFlag(argv[++index], "--runs");
			continue;
		}

		if (arg === "--warmup") {
			options.warmup = parseIntegerFlag(argv[++index], "--warmup");
			continue;
		}

		if (arg === "--profile-dir") {
			options.profileDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--label") {
			options.label = argv[++index];
			continue;
		}

		if (arg === "--runtime") {
			options.runtime = parseRuntime(argv[++index]);
			continue;
		}

		if (arg === "--agent-dir") {
			options.agentDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--entry" || arg === "--cwd") {
			options[arg.slice(2)] = resolve(argv[++index]);
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function detectRuntimeFromPackageManager() {
	const userAgent = process.env.npm_config_user_agent ?? "";
	return userAgent.startsWith("bun/") ? "bun" : "node";
}

function resolveRuntime(requestedRuntime) {
	if (requestedRuntime === "auto") {
		return detectRuntimeFromPackageManager();
	}
	return requestedRuntime;
}

function resolveProfileDir(runtime, requestedProfileDir) {
	if (requestedProfileDir) {
		return requestedProfileDir;
	}
	return runtime === "bun" ? defaultBunProfileDir : defaultNodeProfileDir;
}

function resolveLabel(mode, requestedLabel) {
	return requestedLabel ?? `${mode}-startup`;
}

function formatMs(value) {
	return `${value.toFixed(1)}ms`;
}

function toDisplayPath(path) {
	const relativePath = relative(repoRoot, path);
	if (relativePath !== "" && !relativePath.startsWith("..")) {
		return relativePath.replaceAll("\\", "/");
	}
	return path;
}

function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return {
		min: sorted[0],
		max: sorted[sorted.length - 1],
		avg: total / sorted.length,
		median,
	};
}

export function parseStartupTimings(stderr) {
	const timings = new Map();
	let namespace;
	for (const line of stderr.split(/\r?\n/)) {
		const header = line.trim().match(/^--- Startup Timings(?:: (.+))? ---$/);
		if (header) {
			namespace = header[1] ?? "main";
			continue;
		}
		if (!namespace) continue;
		if (/^-+$/.test(line.trim())) {
			namespace = undefined;
			continue;
		}
		const match = line.match(/^\s+(.+):\s+(\d+(?:\.\d+)?)ms$/);
		if (match) timings.set(`${namespace}.${match[1]}`, Number.parseFloat(match[2]));
	}
	return timings;
}

function summarizeTimingMaps(runs) {
	const valuesByLabel = new Map();
	for (const run of runs) {
		for (const [label, value] of run.timings.entries()) {
			const values = valuesByLabel.get(label);
			if (values) {
				values.push(value);
			} else {
				valuesByLabel.set(label, [value]);
			}
		}
	}

	const summaries = new Map();
	for (const [label, values] of valuesByLabel.entries()) {
		summaries.set(label, summarize(values));
	}
	return summaries;
}

function toMetricName(label) {
	return `${label.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")}_ms`;
}

async function waitForExit(child, errorPrefix) {
	return await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (signal) {
				reject(new Error(`${errorPrefix} exited from signal ${signal}`));
				return;
			}
			resolve(code ?? 0);
		});
	});
}

async function runBuild(bundle) {
	process.stdout.write(
		`Building dependencies and the ${bundle ? "bundled" : "unbundled"} coding-agent Node entrypoint...\n`,
	);
	const startedAt = performance.now();
	const commands = [
		{
			label: "Dependency build",
			args: [
				"run",
				"build",
				"--workspace",
				"packages/tui",
				"--workspace",
				"packages/telemetry",
				"--workspace",
				"packages/ai",
				"--workspace",
				"packages/agent",
				"--workspace",
				"packages/protocol",
				"--workspace",
				"packages/client",
			],
		},
		{
			label: "Coding-agent build",
			args: ["run", bundle ? "build" : "build:unbundled", "--workspace", "packages/coding-agent"],
		},
	];

	for (const command of commands) {
		const child = spawn("npm", command.args, {
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const exitCode = await waitForExit(child, command.label);
		if (exitCode !== 0) {
			if (stdout.trim()) {
				process.stdout.write(`${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
			}
			if (stderr.trim()) {
				process.stderr.write(`${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
			}
			throw new Error(`${command.label} failed with exit code ${exitCode}`);
		}
	}

	process.stdout.write(`Build completed in ${formatMs(performance.now() - startedAt)}\n`);
}

function getRuntimeCommand(runtime, mode, profileDir, cpuProfile, entryPath) {
	const benchmarkArgs = ["--no-session"];
	if (mode === "rpc") {
		benchmarkArgs.push("--mode", "rpc");
	}

	const args = [];
	if (cpuProfile) {
		args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`);
	}
	args.push(entryPath, ...benchmarkArgs);
	return {
		executable: runtime === "bun" ? "bun" : process.execPath,
		args,
	};
}

function createBenchmarkEnv(options, isolatedAgentDir) {
	const env = { ...process.env, PI_TIMING: "1" };
	delete env[startupBenchmarkEnvName];
	if (options.agentDir) {
		env[agentDirEnvName] = options.agentDir;
	} else if (isolatedAgentDir) {
		env[agentDirEnvName] = isolatedAgentDir;
	}
	if (options.mode === "tui") {
		env[startupBenchmarkEnvName] = "1";
	}
	if (options.offline) {
		env.PI_OFFLINE = "1";
		env.PI_SKIP_VERSION_CHECK = "1";
	}
	return env;
}

function collectProfiles(profileDir) {
	if (!profileDir) return [];
	const paths = readdirSync(profileDir).filter((name) => name.endsWith(".cpuprofile")).sort();
	if (paths.length === 0) throw new Error(`No CPU profiles were written: ${profileDir}`);
	return paths.map((name) => join(profileDir, name));
}

export async function runTuiBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const runProfileDir = options.cpuProfile ? mkdtempSync(join(profileDir, `${options.label}-${suffix}-`)) : undefined;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(runtime, "tui", runProfileDir, options.cpuProfile, options.entry);
	const startedAt = performance.now();
	const child = spawn(command.executable, command.args, {
		cwd: options.cwd,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["inherit", "inherit", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stderr = "";
	let stderrBuffer = "";
	let readyElapsedMs;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		stderrBuffer = splitLines(stderrBuffer + chunk, (line) => {
			if (line === "PI_STARTUP_READY" && readyElapsedMs === undefined) {
				readyElapsedMs = performance.now() - startedAt;
			}
		});
	});
	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);
	const exitElapsedMs = performance.now() - startedAt;

	try {
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		if (readyElapsedMs === undefined) {
			throw new Error("TUI benchmark did not report PI_STARTUP_READY; use a CLI with startup readiness instrumentation.");
		}
		return {
			elapsedMs: readyElapsedMs,
			exitElapsedMs,
			profilePaths: collectProfiles(runProfileDir),
			timings: parseStartupTimings(stderr),
		};
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

function splitLines(buffer, onLine) {
	let remaining = buffer;
	while (true) {
		const newlineIndex = remaining.indexOf("\n");
		if (newlineIndex === -1) {
			return remaining;
		}
		const line = remaining.slice(0, newlineIndex);
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		remaining = remaining.slice(newlineIndex + 1);
	}
}

export async function runRpcBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const runProfileDir = options.cpuProfile ? mkdtempSync(join(profileDir, `${options.label}-${suffix}-`)) : undefined;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(runtime, "rpc", runProfileDir, options.cpuProfile, options.entry);
	const startedAt = performance.now();
	const child = spawn(command.executable, command.args, {
		cwd: options.cwd,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["pipe", "pipe", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stdoutBuffer = "";
	let stderr = "";
	let readyElapsedMs;
	let responseError;
	const requestId = `startup-benchmark-${runNumber}`;

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer = splitLines(stdoutBuffer + chunk, (line) => {
			if (line.trim() === "") {
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				responseError = error instanceof Error ? error.message : String(error);
				return;
			}

			if (parsed?.type !== "response" || parsed.id !== requestId || parsed.command !== "get_state") {
				return;
			}

			if (parsed.success !== true) {
				responseError = typeof parsed.error === "string" ? parsed.error : "get_state failed";
				return;
			}

			if (readyElapsedMs === undefined) {
				readyElapsedMs = performance.now() - startedAt;
				child.stdin.end();
			}
		});
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	child.stdin.setDefaultEncoding("utf8");
	child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);

	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);
	const exitElapsedMs = performance.now() - startedAt;

	try {
		if (responseError) {
			throw new Error(responseError);
		}
		if (readyElapsedMs === undefined) {
			throw new Error(stderr.trim() || "RPC benchmark did not receive get_state response");
		}
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		return {
			elapsedMs: readyElapsedMs,
			exitElapsedMs,
			profilePaths: collectProfiles(runProfileDir),
			timings: parseStartupTimings(stderr),
		};
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

async function runBenchmarkRun(params) {
	if (params.options.mode === "rpc") {
		return await runRpcBenchmarkRun(params);
	}
	return await runTuiBenchmarkRun(params);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	if (options.agentDir && options.isolatedAgentDir) {
		throw new Error("--agent-dir and --isolated-agent-dir cannot be combined");
	}

	if (options.entry && options.bundle) throw new Error("--entry and --bundle cannot be combined");
	if (options.entry) options.build = false;

	if (options.mode === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
		throw new Error("TUI benchmark must be run from an interactive terminal.");
	}

	const runtime = resolveRuntime(options.runtime);
	if (options.bundle && runtime !== "node") {
		throw new Error("--bundle only supports the Node runtime");
	}
	options.label = resolveLabel(options.mode, options.label);
	const profileDir = resolveProfileDir(runtime, options.profileDir);

	if (runtime === "node" && options.build) {
		await runBuild(options.bundle);
	}

	const entryPath = options.entry ?? (runtime === "bun" ? srcCliPath : options.bundle ? bundledDistCliPath : distCliPath);
	if (
		runtime === "node" &&
		!options.entry &&
		!options.bundle &&
		!options.build &&
		existsSync(distCliPath) &&
		readFileSync(distCliPath, "utf8").includes('import "./bundle/cli.js";')
	) {
		throw new Error("dist/cli.js is a bundled facade; rerun without --skip-build for an unbundled profile");
	}
	if (!existsSync(entryPath)) {
		throw new Error(`CLI entrypoint not found: ${entryPath}`);
	}

	options.entry = entryPath;
	const env = createBenchmarkEnv(options);
	process.stdout.write(`\nTarget: ${entryPath}\nRuntime: ${runtime} (${runtime === "node" ? process.execPath : "bun"})\nCwd: ${options.cwd}\n`);
	process.stdout.write(`Agent dir: ${options.isolatedAgentDir ? "temporary per run" : env[agentDirEnvName] ?? "default (~/.pi/agent)"}\nPI_OFFLINE=${env.PI_OFFLINE ?? "(unset)"} PI_SKIP_VERSION_CHECK=${env.PI_SKIP_VERSION_CHECK ?? "(unset)"}\nCPU profiling: ${options.cpuProfile ? "enabled (adds overhead)" : "disabled"}\n`);
	process.stdout.write(`Readiness: ${options.mode === "tui" ? "InteractiveMode.init complete (awaited lifecycle handlers and startup render); terminal drain: 150ms after ready" : "successful get_state response; no terminal drain"}\nInitialization spans exclude process launch/imports; exit includes post-ready work and shutdown.\n`);

	mkdirSync(profileDir, { recursive: true });

	const measuredRuns = [];
	const totalRuns = options.warmup + options.runs;
	for (let runIndex = 0; runIndex < totalRuns; runIndex++) {
		const measuredIndex = runIndex >= options.warmup ? runIndex - options.warmup + 1 : undefined;
		const result = await runBenchmarkRun({
			runtime,
			runIndex,
			measuredIndex,
			options,
			profileDir,
		});

		process.stdout.write(
			`[${measuredIndex === undefined ? `warmup ${runIndex + 1}` : `run ${measuredIndex}`}] ready=${formatMs(result.elapsedMs)} exit=${formatMs(result.exitElapsedMs)} after-ready=${formatMs(result.exitElapsedMs - result.elapsedMs)}\n`,
		);

		if (measuredIndex !== undefined) {
			measuredRuns.push(result);
		}
	}

	if (measuredRuns.length === 0) {
		process.stdout.write("\nNo measured runs requested.\n");
		return;
	}

	const elapsedSummary = summarize(measuredRuns.map((run) => run.elapsedMs));
	const timingSummaries = summarizeTimingMaps(measuredRuns);
	const maxElapsedRun = measuredRuns.reduce((slowest, run) => (run.elapsedMs > slowest.elapsedMs ? run : slowest));
	if (measuredRuns.length === 1) {
		process.stdout.write("\nResult\n");
		process.stdout.write(`  runtime:          ${runtime}${options.bundle ? " (bundle)" : ""}\n`);
		process.stdout.write(`  mode:             ${options.mode}\n`);
		process.stdout.write(`  process-to-ready: ${formatMs(measuredRuns[0].elapsedMs)}\n`);
		process.stdout.write(`  process-to-exit:  ${formatMs(measuredRuns[0].exitElapsedMs)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`  ${label}: ${formatMs(summary.median)}\n`);
		}
		if (options.cpuProfile) {
			for (const path of maxElapsedRun.profilePaths) process.stdout.write(`  slowest run profile: ${toDisplayPath(path)}\n`);
			process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
		}
		process.stdout.write(`METRIC startup_time_ms=${measuredRuns[0].elapsedMs.toFixed(1)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
		}
		return;
	}

	process.stdout.write("\nSummary\n");
	process.stdout.write(`  runtime:          ${runtime}${options.bundle ? " (bundle)" : ""}\n`);
	process.stdout.write(`  mode:             ${options.mode}\n`);
	process.stdout.write(`  ready min:        ${formatMs(elapsedSummary.min)}\n`);
	process.stdout.write(`  ready median:     ${formatMs(elapsedSummary.median)}\n`);
	process.stdout.write(`  ready avg:        ${formatMs(elapsedSummary.avg)}\n`);
	process.stdout.write(`  ready max:        ${formatMs(elapsedSummary.max)}\n`);
	process.stdout.write(`  exit median:      ${formatMs(summarize(measuredRuns.map((run) => run.exitElapsedMs)).median)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`  ${label} median: ${formatMs(summary.median)}\n`);
	}
	if (options.cpuProfile) {
		for (const path of maxElapsedRun.profilePaths) process.stdout.write(`  slowest run profile: ${toDisplayPath(path)}\n`);
		process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
	}
	process.stdout.write(`METRIC startup_time_ms=${elapsedSummary.median.toFixed(1)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	});
}
