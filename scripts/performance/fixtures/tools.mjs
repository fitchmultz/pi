import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DefaultResourceLoader } from "/pi-performance-source/packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "/pi-performance-source/packages/coding-agent/src/core/settings-manager.ts";
import { createGrepToolDefinition } from "/pi-performance-source/packages/coding-agent/src/core/tools/grep.ts";
import { createLsToolDefinition } from "/pi-performance-source/packages/coding-agent/src/core/tools/ls.ts";
import { OutputAccumulator } from "/pi-performance-source/packages/coding-agent/src/core/tools/output-accumulator.ts";
import { createReadToolDefinition } from "/pi-performance-source/packages/coding-agent/src/core/tools/read.ts";
import { listBackgroundCommands } from "/pi-performance-source/packages/coding-agent/src/extensions/background-command/jobs.ts";
import { witness } from "../proof.mjs";

// read-head/read-page/read-limit/read-json/grep-context; sizes are MiB.
// For grep-context ensure rg is installed on PATH; this script refuses missing rg to avoid downloads.
const [mode = "read-limit", sizeArg = "32", runsArg = "5"] = process.argv.slice(2);
const size = Number(sizeArg),
	runs = Number(runsArg);
if (!(size > 0) || !Number.isInteger(runs) || runs < 1) throw new Error("invalid workload");
const root = mkdtempSync(join(tmpdir(), "pi-tools-"));
const sha = (text) => createHash("sha256").update(text).digest("hex");
let operation;
let workload;
const owned = [];
let verification = (result) => result;
try {
	if (mode.startsWith("read-") || mode === "grep-context") {
		const line = `${"0123456789".repeat(9)}\n`;
		const lineCount = Math.ceil((size * 1024 * 1024) / line.length);
		let text = line.repeat(lineCount);
		if (mode === "grep-context") text = `needle-target\n${text}`;
		const path = join(root, mode === "read-json" ? "fixture.json" : "fixture.txt");
		if (mode === "read-json")
			text = JSON.stringify({
				rows: Array.from({ length: Math.ceil((size * 1024 * 1024) / 128) }, (_, i) => ({
					id: i,
					ignored: "x".repeat(96),
				})),
			});
		writeFileSync(path, text);
		workload = { mode, bytes: statSync(path).size, lineCount, inputSha256: sha(text) };
		text = undefined;
		const read = createReadToolDefinition(root);
		const args =
			mode === "read-page"
				? { path, offset: Math.floor(lineCount / 2) }
				: mode === "read-limit"
					? { path, offset: 1, limit: 10 }
					: mode === "read-json"
						? { path, json: { path: "/rows/0", fields: ["id"] } }
						: { path };
		if (mode === "grep-context") {
			if (
				!(process.env.PATH ?? "").split(delimiter).some((dir) => {
					try {
						return statSync(join(dir, process.platform === "win32" ? "rg.exe" : "rg")).isFile();
					} catch {
						return false;
					}
				})
			)
				throw new Error("rg must already be installed; no downloads");
			const grep = createGrepToolDefinition(root);
			operation = async () => {
				const result = await grep.execute("benchmark", { path, pattern: "needle-target", context: 1, limit: 1 });
				return { checksum: sha(JSON.stringify(result)), contentBytes: JSON.stringify(result).length };
			};
		} else
			operation = async () => {
				const result = await read.execute("benchmark", args);
				return { checksum: sha(JSON.stringify(result)), contentBytes: JSON.stringify(result).length };
			};
	} else if (mode === "ls") {
		for (let i = 0; i < size; i++) writeFileSync(join(root, `file-${String(i).padStart(6, "0")}.txt`), "");
		const ls = createLsToolDefinition(root);
		let lastResult;
		workload = { mode, entries: size, limit: 500 };
		operation = async () => {
			lastResult = await ls.execute("benchmark", { path: root });
			return { checksum: sha(JSON.stringify(lastResult)), contentBytes: JSON.stringify(lastResult).length };
		};
		verification = () => {
			const expected = Array.from(
				{ length: Math.min(size, 500) },
				(_, i) => `file-${String(i).padStart(6, "0")}.txt`,
			).join("\n");
			assert.equal(
				lastResult.content[0].text,
				expected + (size > 500 ? "\n\n[500 entries limit reached. Use limit=1000 for more]" : ""),
			);
			assert.equal(lastResult.details?.entryLimitReached, size > 500 ? 500 : undefined);
			return lastResult;
		};
	} else if (mode === "background") {
		const ids = new Map();
		for (let i = 0; i < size; i++) {
			const id = randomUUID();
			const dir = join(root, id);
			mkdirSync(dir);
			ids.set(id, `job-${i}`);
			const job = {
				id,
				command: "true",
				cwd: root,
				createdAt: new Date(i).toISOString(),
				logFile: join(dir, "output.log"),
				status: "starting",
			};
			writeFileSync(join(dir, "job.json"), JSON.stringify({ job, command: "true", launcherPid: process.pid }));
			writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "succeeded", exitCode: 0 }));
		}
		let jobs;
		workload = { mode, completedJobs: size };
		operation = () => {
			jobs = listBackgroundCommands(root);
			return { count: jobs.length };
		};
		verification = () => {
			assert.equal(jobs.length, size);
			assert.ok(jobs.every((job) => job.status === "succeeded" && job.exitCode === 0));
			assert.deepEqual(
				jobs.map((job) => job.createdAt),
				Array.from({ length: size }, (_, i) => new Date(size - i - 1).toISOString()),
			);
			let text = JSON.stringify(jobs).replaceAll(root, "<fixture>");
			for (const [id, label] of ids) text = text.replaceAll(id, label);
			return JSON.parse(text);
		};
	} else if (mode === "resources") {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		mkdirSync(cwd);
		for (let i = 0; i < size; i++) {
			const dir = join(agentDir, "skills", `skill-${i}`);
			mkdirSync(dir);
			writeFileSync(
				join(dir, "SKILL.md"),
				`---\nname: skill-${i}\ndescription: benchmark skill\n---\n# Benchmark\n`,
			);
		}
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
			noContextFiles: true,
		});
		workload = { mode, skills: size, note: "same legacy reload; isolated HOME/agent/cwd" };
		operation = async () => {
			await loader.reload();
			return { count: loader.getSkills().skills.length };
		};
		verification = () => {
			const result = loader.getSkills();
			assert.equal(result.skills.length, size);
			assert.deepEqual(
				result.skills.map((skill) => skill.name).sort(),
				Array.from({ length: size }, (_, i) => `skill-${i}`).sort(),
			);
			return JSON.parse(JSON.stringify(result).replaceAll(root, "<fixture>"));
		};
	} else if (mode === "spill") {
		const chunk = Buffer.from(`${"0123456789".repeat(6553)}\n`);
		const chunks = Math.ceil((size * 1024 * 1024) / chunk.length);
		const expectedHash = createHash("sha256");
		for (let i = 0; i < chunks; i++) expectedHash.update(chunk);
		const expectedSha256 = expectedHash.digest("hex");
		let snapshot;
		workload = {
			mode,
			totalBytes: chunks * chunk.length,
			chunks,
			inputSha256: expectedSha256,
			note: "legacy synchronous push-only append; not native Bash throughput",
		};
		operation = async () => {
			const accumulator = new OutputAccumulator();
			for (let i = 0; i < chunks; i++) accumulator.append(Buffer.from(chunk));
			const beforeDrain = process.memoryUsage();
			const queuedBytes = accumulator.tempFileStream?.writableLength;
			accumulator.finish();
			snapshot = accumulator.snapshot();
			owned.push(snapshot.fullOutputPath);
			await accumulator.closeTempFile();
			return {
				beforeDrain,
				queuedBytes,
				resultBytes: snapshot.content.length,
				fullBytes: statSync(snapshot.fullOutputPath).size,
				checksum: sha(snapshot.content),
			};
		};
		verification = () => {
			const bytes = readFileSync(snapshot.fullOutputPath);
			const checksum = sha(bytes);
			assert.equal(bytes.length, workload.totalBytes);
			assert.equal(checksum, expectedSha256);
			return { fullBytes: bytes.length, checksum, content: snapshot.content, truncation: snapshot.truncation };
		};
	} else throw new Error("unknown case");
	console.log(JSON.stringify({ workload, node: process.version }));
	for (let run = 0; run < runs; run++) {
		global.gc?.();
		const before = process.memoryUsage(),
			start = performance.now();
		const result = await operation();
		const elapsedMs = performance.now() - start,
			after = process.memoryUsage();
		witness(mode, workload, verification(result));
		console.log(
			JSON.stringify({
				run,
				elapsedMs,
				heapDelta: after.heapUsed - before.heapUsed,
				externalDelta: after.external - before.external,
				rss: after.rss,
				maxRssKiB: process.resourceUsage().maxRSS,
				result,
			}),
		);
	}
} finally {
	for (const path of owned) rmSync(path, { force: true });
	rmSync(root, { force: true, recursive: true });
}
