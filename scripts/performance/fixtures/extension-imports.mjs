import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadExtensions } from "/pi-performance-source/packages/coding-agent/dist/core/extensions/loader.js";

const [mode, fixtureArg, entry = "dist/bundle/cli.js"] = process.argv.slice(2);
const fixture = resolve(fixtureArg);
const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const paths = names.map((name) => join(fixture, `${name}.ts`));
const tracePath = process.env.PI_PERF_EXTENSION_TRACE;
assert(tracePath, "PI_PERF_EXTENSION_TRACE must select a task-owned synthetic trace");
const started = performance.now();
let elapsedMs;
let stderr = "";
const responses = [];
if (mode === "micro") {
	const result = await loadExtensions(paths, fixture);
	elapsedMs = performance.now() - started;
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.extensions.flatMap((extension) => [...extension.tools.keys()]), names);
	assert.deepEqual(result.extensions.flatMap((extension) => [...extension.commands.keys()]), names);
	assert.deepEqual([...result.runtime.flagValues], names.map((name) => [`${name}-flag`, name]));
} else if (mode === "rpc") {
	const args = [
		"--import", new URL("../source-hook.mjs", import.meta.url).pathname,
		...(process.env.PI_PERF_PROFILE_DIR ? ["--cpu-prof", `--cpu-prof-dir=${process.env.PI_PERF_PROFILE_DIR}`] : []),
		join(process.env.PI_PERF_REPO, "packages/coding-agent", entry),
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
		...paths.flatMap((path) => ["--extension", path]),
	];
	const child = spawn(process.execPath, args, { cwd: fixture, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
	let buffer = "";
	let failure;
	const deadline = setTimeout(() => {
		failure = "RPC startup deadline exceeded";
		child.kill("SIGTERM");
	}, 30000);
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
				responses.push(response);
				if (response.id === "ready") {
					assert.equal(response.success, true);
					assert.equal(response.command, "get_commands");
					assert.deepEqual(response.data.commands.filter((command) => names.includes(command.name)).map((command) => command.name), names);
					elapsedMs = performance.now() - started;
					child.stdin.end();
				}
			} catch (error) {
				failure = String(error);
				child.stdin.end();
			}
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdin.on("error", (error) => { failure = String(error); });
	child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n${JSON.stringify({ id: "ready", type: "get_commands" })}\n`);
	const status = await new Promise((done, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => done({ code, signal }));
	}).finally(() => clearTimeout(deadline));
	assert.equal(status.code, 0, JSON.stringify({ status, failure, stderr }));
	assert.equal(failure, undefined, failure);
	assert.equal(responses.filter((response) => response.type === "response" && response.success).length, 2);
} else {
	throw new Error("mode must be micro or rpc");
}
assert.equal(typeof elapsedMs, "number");
const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const count = (type) => trace.filter((event) => event.type === type).length;
assert.equal(count("import:start"), names.length);
assert.equal(count("import:end"), names.length);
assert.deepEqual(trace.filter((event) => event.type.startsWith("factory:")).map((event) => `${event.type}:${event.name}`), names.flatMap((name) => [`factory:start:${name}`, `factory:end:${name}`]));
console.log(JSON.stringify({ mode, entry, elapsedMs, imports: count("import:end"), factories: count("factory:end"), tools: names, errors: 0, responses, trace, stderr }));
