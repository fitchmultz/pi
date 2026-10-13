import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { sha256, witness } from "../proof.mjs";

// Profiles deliberately use Node's default PID-specific filenames. The launcher forwards execArgv
// to its worker, so an explicit --cpu-prof-name would let the launcher overwrite the worker profile.
const [entryArg, runsArg = "9", warmupArg = "2", variant = "isolated", profileArg, cwdArg] = process.argv.slice(2);
if (!entryArg) throw new Error("CLI entry path is required");
const entry = resolve(entryArg),
	runs = Number(runsArg),
	warmup = Number(warmupArg);
for (const name of ["packages/coding-agent/dist/cli.js", "packages/coding-agent/dist/bundle/cli.js"]) {
	const path = join(process.env.PI_PERF_REPO, name);
	if (existsSync(path)) console.log(JSON.stringify({ sourceArtifact: { name, sha256: sha256(readFileSync(path)) } }));
}
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(warmup) || warmup < 0)
	throw new Error("invalid run count");
if (variant !== "isolated")
	throw new Error("only isolated startup is portable; configured extension startup needs separate private evidence");
const profileDir = profileArg && profileArg !== "-" ? resolve(profileArg) : undefined;
const cwd = cwdArg ? resolve(cwdArg) : process.env.HOME;
if (profileDir) mkdirSync(profileDir, { recursive: true });
console.log(
	JSON.stringify({
		entry: entry.slice(process.env.PI_PERF_REPO.length + 1),
		runs,
		warmup,
		variant,
		node: process.version,
		note: "fresh process per sample; filesystem/Jiti caches not evicted",
	}),
);
const samples = [];
for (let i = 0; i < warmup + runs; i++) {
	const temp = variant === "isolated" ? mkdtempSync(join(tmpdir(), "pi-startup-")) : undefined;
	const agentDir = temp ? join(temp, "agent") : undefined;
	if (agentDir) mkdirSync(agentDir);
	const env = { ...process.env, PI_TIMING: "1", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
	if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
	const args = [
		"--import",
		new URL("../source-hook.mjs", import.meta.url).pathname,
		...(profileDir ? ["--cpu-prof", `--cpu-prof-dir=${profileDir}`] : []),
		entry,
		"--mode",
		"rpc",
		"--no-session",
	];
	const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	let buffer = "",
		stderr = "",
		elapsedMs,
		failure;
	const id = `startup-${i}`,
		started = performance.now();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				const response = JSON.parse(line);
				if (response.type !== "response" || response.id !== id || response.command !== "get_state") continue;
				if (!response.success) {
					failure = response.error ?? "get_state failed";
					child.stdin.end();
					continue;
				}
				if (elapsedMs === undefined) {
					elapsedMs = performance.now() - started;
					child.stdin.end();
				}
			} catch (error) {
				failure = String(error);
				child.stdin.end();
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdin.on("error", (error) => {
		failure = String(error);
	});
	const exited = new Promise((done, fail) => {
		child.once("error", fail);
		child.once("exit", (code, signal) => done({ code, signal }));
	});
	child.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
	try {
		const status = await exited;
		if (status.code !== 0 || failure || elapsedMs === undefined)
			throw new Error(JSON.stringify({ status, failure, stderr }));
		witness("startup", { runs, warmup, variant }, { command: "get_state", success: true });
		const sample = {
			run: i - warmup,
			warmup: i < warmup,
			elapsedMs,
			timings: stderr.match(/--- Startup Timings[\s\S]*?------------------------/)?.[0],
		};
		console.log(JSON.stringify(sample));
		if (i >= warmup) samples.push(elapsedMs);
	} finally {
		if (temp) rmSync(temp, { recursive: true, force: true });
	}
}
const ordered = samples.toSorted((a, b) => a - b),
	middle = Math.floor(ordered.length / 2);
console.log(
	JSON.stringify({
		minMs: ordered[0],
		medianMs: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
		maxMs: ordered.at(-1),
	}),
);
