import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { executeBashWithOperations } from "/pi-performance-source/packages/coding-agent/src/core/bash-executor.ts";
import {
	createBashTool,
	createLocalBashOperations,
} from "/pi-performance-source/packages/coding-agent/src/core/tools/bash.ts";
import { witness } from "../proof.mjs";

const [sink = "normal", mib = "8", owner = "tool"] = process.argv.slice(2);
const totalBytes = Number(mib) * 1024 * 1024;
assert.ok(Number.isSafeInteger(totalBytes) && totalBytes > 51200, "Use a payload exceeding the spill threshold");
assert.ok(sink === "normal" || sink === "slow");
assert.ok(owner === "tool" || owner === "executor");
const unit = Buffer.from("0123456789abcdef\n");
const tile = Buffer.alloc(65536);
for (let i = 0; i < tile.length; i++) tile[i] = unit[i % unit.length];
const hash = createHash("sha256");
for (let remaining = totalBytes; remaining > 0; remaining -= tile.length)
	hash.update(tile.subarray(0, Math.min(remaining, tile.length)));
const expectedHash = hash.digest("hex");
const producer = `const unit=Buffer.from('0123456789abcdef\\n');const tile=Buffer.alloc(65536);for(let i=0;i<tile.length;i++)tile[i]=unit[i%unit.length];let left=${totalBytes};function pump(){while(left>0){const part=tile.subarray(0,Math.min(left,tile.length));left-=part.length;if(!process.stdout.write(part)){process.stdout.once('drain',pump);return;}}}pump();`;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const command = `${quote(process.execPath)} -e ${quote(producer)}`;
const streams = [];
const original = fs.createWriteStream;
let maxWritableLength = 0;
let maxRSS = 0;
let maxExternal = 0;
let maxArrayBuffers = 0;
let falseWrites = 0;
let closedAt;
const observe = (stream) => {
	maxWritableLength = Math.max(maxWritableLength, stream.writableLength);
	const memory = process.memoryUsage();
	maxRSS = Math.max(maxRSS, memory.rss);
	maxExternal = Math.max(maxExternal, memory.external);
	maxArrayBuffers = Math.max(maxArrayBuffers, memory.arrayBuffers);
};
fs.createWriteStream = function (path, options) {
	const stream = original.call(this, path, options);
	if (basename(String(path)).startsWith("pi-bash-")) {
		streams.push(stream);
		stream.once("close", () => {
			closedAt = performance.now();
		});
		for (const method of ["_write", "_writev"]) {
			const originalMethod = stream[method];
			stream[method] = function (...args) {
				if (sink === "slow") setTimeout(() => originalMethod.apply(this, args), 20);
				else originalMethod.apply(this, args);
			};
		}
		const write = stream.write;
		stream.write = function (...args) {
			const result = write.apply(this, args);
			if (!result) falseWrites++;
			observe(this);
			return result;
		};
	}
	return stream;
};
syncBuiltinESMExports();
const sourcePaths = [
	"packages/coding-agent/src/core/tools/bash.ts",
	"packages/coding-agent/src/core/tools/output-accumulator.ts",
	"packages/coding-agent/src/core/bash-executor.ts",
	"packages/coding-agent/src/utils/child-process.ts",
	"packages/coding-agent/src/utils/output-files.ts",
	"packages/coding-agent/src/utils/shell.ts",
];
const sourceHashes = Object.fromEntries(
	sourcePaths.map((path) => [path, createHash("sha256").update(fs.readFileSync(path)).digest("hex")]),
);
console.log(
	JSON.stringify({
		kind: "environment",
		note: "native operation clock excludes fixture setup, hashing and process startup; compare persisted completion",
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		sourceHashes,
		sink,
		owner,
		fixture: { totalBytes, tileBytes: tile.length, sha256: expectedHash },
		sinkDelayMs: sink === "slow" ? 20 : 0,
		highWaterMark: "unchanged Node fs default",
	}),
);
const before = process.memoryUsage();
const started = performance.now();
const result =
	owner === "tool"
		? await createBashTool(process.cwd()).execute("native-probe", { command })
		: await executeBashWithOperations(command, process.cwd(), createLocalBashOperations());
const returnedAt = performance.now();
const atReturnStreamState = streams.map((stream) => ({
	closed: stream.closed,
	writableFinished: stream.writableFinished,
	writableLength: stream.writableLength,
	highWaterMark: stream.writableHighWaterMark,
}));
const path = owner === "tool" ? result.details.fullOutputPath : result.fullOutputPath;
const atReturn = fs.existsSync(path) ? fs.statSync(path).size : 0;
// Baseline executor returns before finish. Observe both the public return and final persisted bytes.
await Promise.all(
	streams.map((stream) =>
		stream.closed
			? undefined
			: new Promise((resolve, reject) => {
					stream.once("close", resolve);
					stream.once("error", reject);
				}),
	),
);
assert.ok(Number.isFinite(closedAt), "The private spill file must close");
const output = fs.readFileSync(path);
const checksum = createHash("sha256").update(output).digest("hex");
const display = owner === "tool" ? result.content.map((block) => block.text ?? "").join("") : result.output;
const diagnostic = {
	kind: "result",
	owner,
	sink,
	atReturnBytes: atReturn,
	atReturnStreamState,
	finalBytes: output.length,
	expectedBytes: totalBytes,
	checksum,
	exact: output.length === totalBytes && checksum === expectedHash,
	timing: { publicReturnMs: returnedAt - started, persistedCompletionMs: closedAt - started },
	maxWritableLength,
	falseWrites,
	memoryBefore: before,
	memoryAfter: process.memoryUsage(),
	maxRSS,
	maxExternal,
	maxArrayBuffers,
	maxRssKiB: process.resourceUsage().maxRSS,
	streamState: streams.map((s) => ({
		closed: s.closed,
		writableFinished: s.writableFinished,
		writableLength: s.writableLength,
		highWaterMark: s.writableHighWaterMark,
	})),
	displayChecksum: createHash("sha256").update(display.replaceAll(path, "<output-path>")).digest("hex"),
	truncation:
		owner === "tool"
			? {
					...result.details.truncation,
					content: undefined,
					contentSha256: createHash("sha256").update(result.details.truncation.content).digest("hex"),
				}
			: result.truncated,
	structured:
		owner === "tool"
			? {
					...result.structuredContent,
					outputSha256: createHash("sha256").update(result.structuredContent.output).digest("hex"),
					output: undefined,
					wall_time_seconds: undefined,
					full_output_path: result.structuredContent.full_output_path ? "<output-path>" : undefined,
				}
			: undefined,
};
console.log(JSON.stringify(diagnostic));
witness(
	"bash-spill",
	{ sink, owner, totalBytes, expectedHash },
	{
		finalBytes: output.length,
		checksum,
		displayChecksum: diagnostic.displayChecksum,
		truncation: diagnostic.truncation,
		structured: diagnostic.structured,
	},
);
fs.rmSync(path, { force: true });
fs.createWriteStream = original;
syncBuiltinESMExports();
if (!diagnostic.exact) process.exitCode = 1;
