import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { RemoteExecutionEnv } from "/pi-performance-source/packages/env/src/remote-env.ts";
import { witness } from "../proof.mjs";

// Measures client algorithms against an in-memory Connection-shaped fixture.
// This deliberately excludes protocol, daemon, filesystem and SSH cost.
const mode = process.argv[2] ?? "probe";
const n = Number(process.argv[3] ?? (mode === "probe" ? 1 : 5));
const size = Number(process.argv[4] ?? (mode === "list" ? 50000 : 1024));
const context = {};
const info = {
	protocol: 1,
	os: "linux",
	arch: "x86_64",
	home: "/fixture",
	cwd: "/fixture",
	driveCwds: {},
	features: ["listFiles"],
};
const bytes = Buffer.alloc(size, 97);
const entries = Array.from({ length: mode === "list" ? size : 0 }, (_, i) => {
	// Bijective permutation for unsorted, repeatable, ASCII + Unicode byte-order names.
	const name = `${((i * 7919) % size).toString().padStart(8, "0")}-é😀`;
	return { name, info: { name, kind: "file", size: 0, mtimeSec: 0, mtimeNsec: 0 } };
});
let position = 0;
let histogram = {};
const connection = {
	info: async () => info,
	request: async (op, json) => {
		histogram[op] = (histogram[op] ?? 0) + 1;
		switch (op) {
			case "open":
				return { session: 1, json: { handle: 1, stat: { kind: "file", size } }, payload: new Uint8Array() };
			case "pread":
				return {
					session: 1,
					json: {},
					payload: new Uint8Array(bytes.subarray(json.offset ?? 0, (json.offset ?? 0) + json.length)),
				};
			case "opendir":
				position = 0;
				return { session: 1, json: { handle: 1 }, payload: new Uint8Array() };
			case "readdir": {
				const page = entries.slice(position, position + json.max);
				position += page.length;
				return {
					session: 1,
					json: { entries: page, done: position === entries.length },
					payload: new Uint8Array(),
				};
			}
			case "close":
				return { session: 1, json: {}, payload: new Uint8Array() };
			default:
				throw new Error(`Unexpected op ${op}`);
		}
	},
};
const env = new RemoteExecutionEnv({ connection, id: "env-benchmark", cwd: "/fixture" });
const samples = [];
let result;
let bufferFromCalls = 0;
const originalFrom = Buffer.from;
if (mode === "list") {
	Buffer.from = function (...args) {
		bufferFromCalls++;
		return originalFrom.apply(this, args);
	};
}
try {
	for (let i = 0; i < n; i++) {
		histogram = {};
		const started = performance.now();
		if (mode === "list") result = await env.listDir(".", context);
		else if (mode === "longline") {
			const opened = await env.openTextLineReader("a.txt", context);
			assert.equal(opened.ok, true);
			try {
				const line = await opened.value.readLine(context);
				assert.equal(line.ok, true);
				result = { ok: true, value: line.value.text };
			} finally {
				await opened.value.close(context);
			}
		} else result = await env.readTextFile("a.txt", context);
		samples.push(performance.now() - started);
		assert.equal(result.ok, true);
		if (mode === "list") {
			assert.equal(result.value.length, size);
			const expected = entries.map((entry) => entry.name).sort((a, b) => originalFrom(a).compare(originalFrom(b)));
			assert.deepEqual(
				result.value.map((entry) => entry.name),
				expected,
			);
		} else assert.equal(result.value, "a".repeat(size));
	}
} finally {
	Buffer.from = originalFrom;
}
console.log(
	JSON.stringify({
		mode,
		n,
		size,
		samplesMs: samples,
		lastRequestHistogram: histogram,
		bufferFromCalls,
		memory: process.memoryUsage(),
		cpu: process.cpuUsage(),
	}),
);

witness(mode, { mode, size, entries: entries.map((e) => e.name) }, result);
