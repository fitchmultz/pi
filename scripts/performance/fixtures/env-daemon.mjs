import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Connection } from "/pi-performance-source/packages/env/src/connection.ts";
import { RemoteExecutionEnv } from "/pi-performance-source/packages/env/src/remote-env.ts";
import { sha256, witness } from "../proof.mjs";

const daemon = process.env.PI_ENV_DAEMON;
if (!daemon) throw new Error("Set PI_ENV_DAEMON to a release daemon built from the measured revision");
const daemonSha256 = sha256(readFileSync(daemon));
console.log(
	JSON.stringify({ sourceArtifact: { name: "packages/env/daemon/target/release/pi-env", sha256: daemonSha256 } }),
);
const samples = Number(process.argv[2] ?? 5);
const byteCount = Number(process.argv[3] ?? 16 * 1024 * 1024);
const fileCount = Number(process.argv[4] ?? 10000);
const root = mkdtempSync(join(tmpdir(), "pi-performance-env-data-"));
const connection = new Connection({ command: [daemon] });
const env = new RemoteExecutionEnv({ connection, id: "env-benchmark", cwd: root });
const context = {};
const result = {};
const measure = async (name, run) => {
	if (process.env.PI_PERF_DAEMON_CONTROLS === "1" && ["longLine", "scanLines"].includes(name)) return;
	await run(); // warmup; fixture and startup excluded from steady-state timings
	const times = [];
	const cpu = process.cpuUsage();
	for (let i = 0; i < samples; i++) {
		const start = performance.now();
		await run();
		times.push(performance.now() - start);
	}
	result[name] = { samplesMs: times, clientCpu: process.cpuUsage(cpu), clientMemory: process.memoryUsage() };
};
try {
	writeFileSync(join(root, "text"), Buffer.alloc(byteCount, 97));
	writeFileSync(join(root, "lines"), "short line é😀\n".repeat(Math.ceil(byteCount / 18)));
	mkdirSync(join(root, "tree"));
	for (let i = 0; i < fileCount; i++) writeFileSync(join(root, "tree", `f-${i.toString().padStart(8, "0")}`), "");
	const startup = performance.now();
	const hello = await connection.info();
	result.startup = { ms: performance.now() - startup, daemonPid: hello.pid, version: hello.version };
	await measure("readTextFile", async () => {
		const read = await env.readTextFile("text", context);
		assert.equal(read.ok, true);
		assert.equal(read.value.length, byteCount);
	});
	await measure("readBinaryFile", async () => {
		const read = await env.readBinaryFile("text", context);
		assert.equal(read.ok, true);
		assert.equal(read.value.length, byteCount);
	});
	const writeContent = Buffer.alloc(byteCount, 98);
	await measure("writeFile", async () => {
		const written = await env.writeFile("write-output", writeContent, context);
		assert.equal(written.ok, true);
	});
	const written = await env.readBinaryFile("write-output", context);
	assert.equal(written.ok, true);
	assert.equal(Buffer.compare(Buffer.from(written.value), writeContent), 0);
	await measure("longLine", async () => {
		const opened = await env.openTextLineReader("text", context);
		assert.equal(opened.ok, true);
		try {
			const read = await opened.value.readLine(context);
			assert.equal(read.ok, true);
			assert.equal(read.value.text.length, byteCount);
		} finally {
			await opened.value.close(context);
		}
	});
	await measure("scanLines", async () => {
		const opened = await env.openBinaryReader("lines", undefined, context);
		assert.equal(opened.ok, true);
		try {
			const scan = await opened.value.scanLines({ startLine: 0 }, context);
			assert.equal(scan.ok, true);
			assert.equal(scan.value.newlines, Math.ceil(byteCount / 18));
		} finally {
			await opened.value.close(context);
		}
	});
	await measure("listDir", async () => {
		const listing = await env.listDir("tree", context);
		assert.equal(listing.ok, true);
		assert.equal(listing.value.length, fileCount);
	});
	await measure("listFiles", async () => {
		const listing = await env.listFiles("tree", { gitignore: false, maxEntries: fileCount + 1 }, context);
		assert.equal(listing.ok, true);
		assert.equal(listing.value.entries.length, fileCount);
		assert.equal(listing.value.truncated, false);
	});
	const textResult = await env.readTextFile("text", context);
	const binaryResult = await env.readBinaryFile("write-output", context);
	const listing = await env.listDir("tree", context);
	const readBinaryControl = await env.readBinaryFile("text", context);
	const listFilesControl = await env.listFiles("tree", { gitignore: false, maxEntries: fileCount + 1 }, context);
	assert.equal(readBinaryControl.ok, true);
	assert.equal(listFilesControl.ok, true);
	assert.equal(Buffer.compare(Buffer.from(readBinaryControl.value), Buffer.alloc(byteCount, 97)), 0);
	assert.deepEqual(
		listFilesControl.value.entries.map((entry) => entry.path).sort(),
		Array.from({ length: fileCount }, (_, i) => `f-${i.toString().padStart(8, "0")}`).sort(),
	);
	witness(
		"daemon",
		{ byteCount, fileCount },
		{
			text: textResult.value,
			binarySha256: sha256(binaryResult.value),
			files: listing.value.map((e) => e.name),
			readBinaryControlSha256: sha256(readBinaryControl.value),
			listFilesControl: listFilesControl.value,
		},
	);
	assert.equal(sha256(readFileSync(daemon)), daemonSha256, "Daemon changed during measurement");
	console.log(JSON.stringify(result));
} finally {
	connection.close();
	rmSync(root, { recursive: true, force: true });
}
