// File setup is excluded; samples reopen cached files and time only readLine(), not validation or close.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getOrThrow } from "/pi-performance-source/packages/durable/src/env/index.ts";
import { NodeExecutionEnv } from "/pi-performance-source/packages/durable/src/env/node.ts";
import { witness } from "../proof.mjs";

const sizesKiB = (process.argv[2] ?? "256").split(",").map(Number);
const samples = Number(process.argv[3] ?? "1");
assert(sizesKiB.every((n) => Number.isSafeInteger(n) && n > 0));
assert(Number.isSafeInteger(samples) && samples > 0);
const directory = mkdtempSync(join(tmpdir(), "pi-line-probe-"));
try {
	const env = new NodeExecutionEnv({ cwd: directory });
	// UTF8 at a 64KiB boundary, leading vs internal BOM, CRLF, empty lines, and a final partial line.
	const first = `${"a".repeat(64 * 1024 - 5)}😀\ufefftail\r`;
	writeFileSync(join(directory, "semantics.txt"), `\ufeff${first}\n\npartial`);
	const semantics = getOrThrow(await env.openTextLineReader("semantics.txt", context));
	try {
		assert.deepEqual(getOrThrow(await semantics.readLine(context)), { text: first, terminated: true });
		assert.deepEqual(getOrThrow(await semantics.readLine(context)), { text: "", terminated: true });
		assert.deepEqual(getOrThrow(await semantics.readLine(context)), { text: "partial", terminated: false });
		assert.equal(getOrThrow(await semantics.readLine(context)), undefined);
	} finally {
		await semantics.close(context);
	}
	for (const sizeKiB of sizesKiB) {
		const expected = "x".repeat(sizeKiB * 1024);
		for (const terminated of [false, true]) {
			writeFileSync(join(directory, "long.txt"), expected + (terminated ? "\n" : ""));
			const times: number[] = [];
			for (let i = 0; i <= samples; i++) {
				const reader = getOrThrow(await env.openTextLineReader("long.txt", context));
				try {
					const start = performance.now();
					const line = getOrThrow(await reader.readLine(context));
					const ms = performance.now() - start;
					assert.deepEqual(line, { text: expected, terminated });
					if (i > 0) witness("line", { sizeKiB, terminated }, line);
					assert.equal(getOrThrow(await reader.readLine(context)), undefined);
					if (i > 0) times.push(ms);
				} finally {
					await reader.close(context);
				}
			}
			times.sort((a, b) => a - b);
			console.log(
				JSON.stringify({
					sizeKiB,
					terminated,
					samples,
					p50Ms: times[Math.ceil(samples / 2) - 1],
					maxMs: times.at(-1),
				}),
			);
		}
	}
	// Fixed 256KiB short-line control for ordinary I/O/decoder cost (not a same-size scaling comparison).
	const count = 1024;
	const short = `${"x".repeat(255)}\n`;
	writeFileSync(join(directory, "short.txt"), short.repeat(count));
	const reader = getOrThrow(await env.openTextLineReader("short.txt", context));
	try {
		const start = performance.now();
		for (let i = 0; i < count; i++) {
			const line = getOrThrow(await reader.readLine(context));
			assert.equal(line?.text.length, 255);
			assert.equal(line?.terminated, true);
		}
		assert.equal(getOrThrow(await reader.readLine(context)), undefined);
		console.log(JSON.stringify({ shortLineCount: count, bytes: count * 256, ms: performance.now() - start }));
	} finally {
		await reader.close(context);
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
