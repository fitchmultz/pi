#!/usr/bin/env node
// Opt-in, offline session-scaling benchmark. Never builds or changes the selected runtime.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HELP = `Usage: node scripts/bench-session.mjs <generate|drive|summarize|heap> [options]

Local, offline, opt-in benchmark; never builds, installs, copies user settings, or uses real providers.
--runtime DIR selects a coding-agent package directory: packages/coding-agent in an already built
checkout, or an installed release's node_modules/@earendil-works/pi-coding-agent directory.
Missing artifacts fail with guidance. All writes stay in a new temp directory or a NEW --out DIR.
Input journals are copied, never modified. Output directories are retained for inspection.

  generate --runtime DIR [--out DIR] [--windows 32] [--turns 60] [--active-turns N]
           [--result-kb 30] [--thinking-chars 1000] [--signature-chars 4000]
    Generate a journal with usage/custom noise and compactions. The final active window has
    identical message payloads regardless of archived window count. Prints {file, entries, out}.
    --active-turns defaults to --turns; each turn has two assistant messages. Thinking/signature
    sizes apply to EACH assistant. Use --active-turns 120 --signature-chars 12000 for 240 large
    retained assistants. --result-kb uses 1024 bytes; character counts are ASCII bytes.
  drive --runtime DIR [--out DIR] [--session FILE] [--runs 20] [--tps 600]
        [--cols 160] [--rows 48] [--mode fullscreen|regular] [--ext PATH]... [--package DIR]...
        [--cpu-profile]
    Requires tmux. Run one read tool call + streamed answer per prompt using the bundled faux
    extension. Each run is recorded in bench.jsonl; terminal output in pane.out. Only explicit
    local extensions/packages load; they are trusted code and can perform external work.
    --cpu-profile adds overhead; omit it for headline measurements.
  summarize [--skip 5] FILE.jsonl...
    Print per-file p50/p90 milliseconds and memory (MiB), excluding the first N runs.
  heap --runtime DIR --session FILE [--out DIR] [--iterations 20] [--appends 0]
    Use node --expose-gc. Measure open/retained heap, warmed per-call costs, and optional appends
    to a private copy. Full-result costs are output-sensitive; newest-32 is bounded.

Examples:
  node scripts/bench-session.mjs generate --runtime packages/coding-agent --windows 1 --out /tmp/bench-small
  node scripts/bench-session.mjs generate --runtime packages/coding-agent --windows 55 --out /tmp/bench-xl
  node scripts/bench-session.mjs drive --runtime /path/to/release/package --session /tmp/bench-xl/SESSION.jsonl --out /tmp/bench-run
  node scripts/bench-session.mjs summarize --skip 5 /tmp/bench-run/bench.jsonl
  node --expose-gc scripts/bench-session.mjs heap --runtime packages/coding-agent --session /tmp/bench-xl/SESSION.jsonl --appends 100

-h, --help: show this help (also accepted after any subcommand).
Exit codes: 0 success/help, 1 invalid arguments or missing prerequisites, 2 runtime failure/timeout.
`;
const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const optionSets = {
	generate: {
		runtime: {},
		out: {},
		windows: {},
		turns: {},
		"active-turns": {},
		"result-kb": {},
		"thinking-chars": {},
		"signature-chars": {},
	},
	drive: {
		runtime: {},
		out: {},
		session: {},
		runs: {},
		tps: {},
		cols: {},
		rows: {},
		mode: {},
		ext: { multiple: true },
		package: { multiple: true },
		"cpu-profile": { type: "boolean" },
	},
	summarize: { skip: {} },
	heap: { runtime: {}, session: {}, out: {}, iterations: {}, appends: {} },
};

function integer(value, fallback, name, minimum = 1) {
	const number = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
	return number;
}
function runtimeDirectory(value, command) {
	if (!value)
		throw new Error(
			"--runtime is required; select an installed release package or an already built packages/coding-agent directory.",
		);
	const dir = resolve(value);
	const artifact = join(dir, command === "drive" ? "dist/bundle/cli.js" : "dist/core/session-manager.js");
	if (!existsSync(artifact))
		throw new Error(
			`Missing runtime artifact: ${artifact}. Select an installed release or build the checkout separately; this benchmark never builds.`,
		);
	return dir;
}
function outputDirectory(value) {
	if (!value) return mkdtempSync(join(tmpdir(), "pi-session-bench-"));
	const dir = resolve(value);
	mkdirSync(dirname(dir), { recursive: true });
	mkdirSync(dir); // Refuse reuse: never delete another run or overwrite its evidence.
	return dir;
}
function sessionManager(runtime) {
	return require(join(runtime, "dist/core/session-manager.js")).SessionManager;
}
function filler(size, seed) {
	const words = ["render", "session", "buffer", "history", "width", "line", "token", "cache", "frame", "layout"];
	let text = "";
	for (let i = seed; text.length < size; i++) text += `${words[i % words.length]}${i % 7 === 0 ? "\n" : " "}`;
	return text.slice(0, size);
}
const usage = (input) => ({
	input: 900,
	output: 700,
	cacheRead: input,
	cacheWrite: 1200,
	totalTokens: input + 2800,
	cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.001, total: 0.007 },
});

function generate(runtime, out, options) {
	const manager = sessionManager(runtime).create(out, out);
	manager.appendModelChange("bench", "bench-1");
	let contribution = 0;
	for (let window = 0; window < options.windows; window++) {
		// A reset even for S makes the final active window identical at every history size.
		manager.appendCompaction("", null, 180_000);
		const turns = window === options.windows - 1 ? options.activeTurns : options.turns;
		for (let turn = 0; turn < turns; turn++) {
			const seed = turn;
			const timestamp = 1_700_000_000_000 + turn * 4;
			const id = `call_${window === options.windows - 1 ? "active" : window}_${turn}`;
			manager.appendMessage({ role: "user", content: `Please check part ${seed}. ${filler(300, seed)}`, timestamp });
			const assistant = {
				role: "assistant",
				api: "bench",
				provider: "bench",
				model: "bench-1",
				usage: usage(20_000 + turn * 1500),
			};
			const thinking = (offset) => ({
				type: "thinking",
				thinking: filler(options.thinkingChars, seed + offset),
				thinkingSignature: Buffer.from(filler(Math.ceil((options.signatureChars * 3) / 4), seed + offset + 1))
					.toString("base64")
					.slice(0, options.signatureChars),
			});
			manager.appendMessage({
				...assistant,
				content: [
					thinking(1),
					{ type: "text", text: filler(200, seed + 3) },
					{ type: "toolCall", id, name: "read", arguments: { path: `src/file-${seed % 50}.ts` } },
				],
				stopReason: "toolUse",
				timestamp: timestamp + 1,
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: filler(options.resultKb * 1024, seed + 4) }],
				details: {
					truncation: { truncated: false, totalLines: 400, outputLines: 400 },
					preview: filler(options.resultKb * 256, seed + 5),
				},
				isError: false,
				timestamp: timestamp + 2,
			});
			manager.appendMessage({
				...assistant,
				usage: usage(22_000 + turn * 1500),
				content: [thinking(6), { type: "text", text: filler(1500, seed + 8) }],
				stopReason: "stop",
				timestamp: timestamp + 3,
			});
			for (let i = 0; i < 5; i++)
				manager.appendUsage("side-request", "bench", "bench-1", usage(3000), undefined, `contrib-${++contribution}`);
			for (let i = 0; i < (turn % 2 === 0 ? 4 : 3); i++)
				manager.appendCustomEntry("bench-noise", { turn, i, note: filler(120, seed + i) });
			if (turn % 2 === 0) manager.appendCustomMessageEntry("bench-note", filler(500, seed + 9), false, { turn });
		}
	}
	manager.flush();
	console.log(JSON.stringify({ file: manager.getSessionFile(), entries: manager.getEntries().length, out }));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
async function drive(runtime, out, options) {
	const project = join(out, "project");
	const agent = join(out, "agent");
	const home = join(out, "home");
	for (const dir of [project, agent, home]) mkdirSync(dir);
	writeFileSync(join(project, "bench-input.ts"), `// Offline benchmark input\n${filler(4096, 0)}\n`);
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify({
			tuiMode: options.mode,
			hideThinkingBlock: true,
			packages: options.packages,
			compaction: { enabled: false },
		}),
	);
	const sessionArgs = [];
	if (options.session) {
		const copy = join(out, "session.jsonl");
		copyFileSync(options.session, copy);
		sessionArgs.push("--session", copy, "--session-cwd", project);
	}
	const log = join(out, "bench.jsonl");
	const profiles = join(out, "profiles");
	if (options.profile) mkdirSync(profiles);
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
		TMPDIR: out,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agent,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		BENCH_LOG: log,
		BENCH_TPS: String(options.tps),
	};
	const command = [
		"env",
		"-i",
		...Object.entries(env).map(([key, value]) => `${key}=${value}`),
		process.execPath,
		...(options.profile ? ["--cpu-prof", `--cpu-prof-dir=${profiles}`] : []),
		join(runtime, "dist/bundle/cli.js"),
		...(options.packages.length ? [] : ["--no-extensions"]),
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		resolve(scriptDir, "../packages/coding-agent/examples/extensions/session-benchmark.ts"),
		...options.extensions.flatMap((extension) => ["-e", extension]),
		"--provider",
		"bench",
		"--model",
		"bench-1",
		"--thinking",
		"off",
		...sessionArgs,
	];
	writeFileSync(join(out, "run.json"), JSON.stringify({ runtime, node: process.version, options, out }, null, 2));
	const launch = join(out, "launch.sh");
	writeFileSync(launch, `#!/bin/sh\nexec ${command.map(quote).join(" ")}\n`);
	// A private server prevents existing tmux server environment/config from leaking into the run.
	const socket = join(out, "tmux.sock");
	if (Buffer.byteLength(socket) > 100)
		throw new Error("tmux socket path is too long; use a short --out path under /tmp.");
	const tmux = (...args) =>
		execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	const records = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	async function waitFor(predicate, label) {
		const deadline = Date.now() + 300_000;
		while (Date.now() < deadline) {
			const found = records().find(predicate);
			if (found) return found;
			try {
				tmux("has-session", "-t", "bench");
			} catch {
				throw new Error(`Pi exited while waiting for ${label}; inspect ${join(out, "pane.out")}`);
			}
			await sleep(50);
		}
		throw new Error(`Timeout waiting for ${label}; inspect ${join(out, "pane.out")}`);
	}
	const started = performance.now();
	const interrupt = () => {
		try {
			tmux("kill-server");
		} finally {
			process.exit(130);
		}
	};
	const terminate = () => {
		try {
			tmux("kill-server");
		} finally {
			process.exit(143);
		}
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	console.log(JSON.stringify({ out }));
	try {
		tmux(
			"new-session",
			"-d",
			"-s",
			"bench",
			"-x",
			String(options.cols),
			"-y",
			String(options.rows),
			"-c",
			project,
			"/bin/sh",
		);
		tmux("pipe-pane", "-t", "bench", `cat >> ${quote(join(out, "pane.out"))}`);
		tmux("send-keys", "-t", "bench", "-l", `exec /bin/sh ${quote(launch)}`);
		tmux("send-keys", "-t", "bench", "Enter");
		await waitFor((record) => record.ready, "session_start");
		console.log(JSON.stringify({ startupMs: performance.now() - started, out }));
		await sleep(1500);
		for (let run = 1; run <= options.runs; run++) {
			tmux("send-keys", "-t", "bench", "-l", `bench prompt ${run}`);
			tmux("send-keys", "-t", "bench", "Enter");
			console.log(JSON.stringify(await waitFor((record) => record.run === run, `run ${run}`)));
			await sleep(300);
		}
		// Graceful shutdown flushes Node CPU profiles before the private server is removed.
		tmux("send-keys", "-t", "bench", "-l", "/quit");
		tmux("send-keys", "-t", "bench", "Enter");
		for (let i = 0; i < 100; i++) {
			await sleep(100);
			try {
				tmux("has-session", "-t", "bench");
			} catch {
				break;
			}
		}
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
		try {
			tmux("kill-server");
		} catch {
			/* The runtime may already have closed the server. */
		}
	}
}

function summarize(files, skip) {
	const metrics = {
		e2e: (r) => r.e2e,
		prep1: (r) => r.prep1,
		prep2: (r) => r.prep2,
		dispatch: (r) => r.dispatch,
		tail: (r) => r.tail,
		eldMax: (r) => r.eld?.max,
		rss: (r) => r.rssMb,
		heap: (r) => r.heapUsedMb,
	};
	console.log(["file", "runs", ...Object.keys(metrics).map((name) => `${name}(p50/p90)`)].join("\t"));
	for (const file of files) {
		const rows = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((row) => row.run > skip);
		if (!rows.length) throw new Error(`No measured runs remain in ${file} after --skip ${skip}`);
		const cells = Object.values(metrics).map((pick) => {
			const values = rows
				.map(pick)
				.filter((value) => typeof value === "number" && Number.isFinite(value))
				.sort((a, b) => a - b);
			const quantile = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))].toFixed(2);
			return values.length ? `${quantile(0.5)}/${quantile(0.9)}` : "-";
		});
		console.log([file, rows.length, ...cells].join("\t"));
	}
}

function heap(runtime, out, options) {
	const SessionManager = sessionManager(runtime);
	const file = join(out, "session.jsonl");
	copyFileSync(options.session, file);
	const live = () => {
		globalThis.gc();
		globalThis.gc();
		return process.memoryUsage().heapUsed / 1048576;
	};
	const baseline = live();
	let started = performance.now();
	const manager = SessionManager.open(file, undefined, out);
	const result = {
		openMs: performance.now() - started,
		retainedMiB: live() - baseline,
		bytes: statSync(file).size,
		callsMs: {},
	};
	const calls = {
		getEntries: () => manager.getEntries(),
		getBranch: () => manager.getBranch(),
		metadataAll: () => {
			for (const entry of manager.iterateEntryMetadata()) void entry;
		},
		metadataBranch: () => {
			for (const entry of manager.iterateEntryMetadata({ branchFrom: manager.getLeafId() })) void entry;
		},
		metadata32: () => {
			let visited = 0;
			for (const entry of manager.iterateEntryMetadata({ branchFrom: manager.getLeafId(), reverse: true, limit: 32 })) {
				void entry;
				if (++visited === 32) break;
			}
		},
		buildContextEntries: () => manager.buildContextEntries(),
		buildSessionProjection: () => manager.buildSessionProjection(),
	};
	if (typeof manager.getBranchState === "function") calls.getBranchState = () => manager.getBranchState();
	result.metadata32Order = calls.getBranchState ? "newest-first" : "oldest-first (runtime predates reverse queries)";
	for (const [name, call] of Object.entries(calls)) {
		call();
		started = performance.now();
		for (let i = 0; i < options.iterations; i++) call();
		result.callsMs[name] = (performance.now() - started) / options.iterations;
	}
	result.afterProjectionMiB = live() - baseline;
	if (options.appends) {
		started = performance.now();
		for (let i = 0; i < options.appends; i++)
			manager.appendMessage({ role: "user", content: `bench append ${i}`, timestamp: Date.now() });
		result.appendMs = (performance.now() - started) / options.appends;
	}
	writeFileSync(join(out, "heap.json"), JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ ...result, out }));
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return;
	}
	let command, values, positionals, runtime, options;
	try {
		command = args.shift();
		if (!Object.hasOwn(optionSets, command))
			throw new Error("Choose generate, drive, summarize, or heap. Use --help for examples.");
		({ values, positionals } = parseArgs({
			args,
			allowPositionals: command === "summarize",
			options: Object.fromEntries(
				Object.entries(optionSets[command]).map(([name, value]) => [name, { type: "string", ...value }]),
			),
		}));
		if (command === "summarize") {
			if (!positionals.length) throw new Error("summarize requires at least one JSONL file");
			options = { skip: integer(values.skip, 5, "skip", 0) };
		} else {
			runtime = runtimeDirectory(values.runtime, command);
			if (values.session && !statSync(resolve(values.session)).isFile()) throw new Error("--session must be a file");
			if (command === "generate")
				options = {
					windows: integer(values.windows, 32, "windows"),
					turns: integer(values.turns, 60, "turns"),
					activeTurns: integer(values["active-turns"], integer(values.turns, 60, "turns"), "active-turns"),
					resultKb: integer(values["result-kb"], 30, "result-kb", 0),
					thinkingChars: integer(values["thinking-chars"], 1000, "thinking-chars", 0),
					signatureChars: integer(values["signature-chars"], 4000, "signature-chars", 0),
				};
			if (command === "heap") {
				if (!values.session) throw new Error("heap requires --session FILE");
				if (typeof globalThis.gc !== "function")
					throw new Error("heap requires node --expose-gc scripts/bench-session.mjs heap ...");
				options = {
					session: resolve(values.session),
					iterations: integer(values.iterations, 20, "iterations"),
					appends: integer(values.appends, 0, "appends", 0),
				};
			}
			if (command === "drive") {
				execFileSync("tmux", ["-V"], { stdio: "pipe" });
				const localPaths = (paths) =>
					(paths ?? []).map((path) => {
						const absolute = resolve(path);
						if (!existsSync(absolute)) throw new Error(`Explicit extension/package does not exist: ${absolute}`);
						return absolute;
					});
				options = {
					runs: integer(values.runs, 20, "runs"),
					tps: integer(values.tps, 600, "tps"),
					cols: integer(values.cols, 160, "cols", 20),
					rows: integer(values.rows, 48, "rows", 10),
					mode: values.mode ?? "fullscreen",
					profile: values["cpu-profile"] ?? false,
					extensions: localPaths(values.ext),
					packages: localPaths(values.package),
					session: values.session ? resolve(values.session) : undefined,
				};
				if (!["fullscreen", "regular"].includes(options.mode)) throw new Error("--mode must be fullscreen or regular");
			}
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
		return;
	}
	try {
		if (command === "summarize") summarize(positionals, options.skip);
		else {
			const out = outputDirectory(values.out);
			if (command === "generate") generate(runtime, out, options);
			else if (command === "drive") await drive(runtime, out, options);
			else heap(runtime, out, options);
		}
	} catch (error) {
		console.error(error.stack ?? String(error));
		process.exitCode = 2;
	}
}
await main();
