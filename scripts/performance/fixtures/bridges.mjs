import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { copyJson, isJsonValue } from "/pi-performance-source/packages/chord/src/json.ts";
import { enqueue, holdPublications } from "/pi-performance-source/packages/chord/src/publish.ts";
import { isFrame } from "/pi-performance-source/packages/chord/src/wire.ts";
import { renderToolSample } from "/pi-performance-source/packages/codemode/src/declarations.ts";
import { CodemodeSandbox } from "/pi-performance-source/packages/codemode/src/runtime/host.ts";
import { loadQuickJSWasm } from "/pi-performance-source/packages/codemode/src/wasm.ts";
import { StdioTransport } from "/pi-performance-source/packages/mcp/src/transports/stdio.ts";
import {
	consumeSseStream,
	StreamableHttpTransport,
} from "/pi-performance-source/packages/mcp/src/transports/streamable-http.ts";
import { witness } from "../proof.mjs";

const root = process.env.PI_PERF_REPO;
const mode = process.argv[2] ?? "stdio";
const smoke = process.argv.includes("--smoke");
function number(name, fallback) {
	const value = Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
	assert.ok(Number.isSafeInteger(value) && value > 0, name);
	return value;
}
const size = number("size", smoke ? 4096 : 1024 * 1024);
const chunkSize = number("chunk", smoke ? 127 : 4096);
const iterations = number("iterations", smoke ? 8 : 100000);
const repeat = number("repeat", smoke ? 1 : 5);
const instrument = process.argv.includes("--instrument");
const sources = [
	"packages/codemode/src/runtime/host.ts",
	"packages/codemode/src/runtime/execution.ts",
	"packages/codemode/src/runtime/vm.ts",
	"packages/codemode/src/runtime/prelude-source.ts",
	"packages/codemode/src/declarations.ts",
	"packages/chord/src/wire.ts",
	"packages/chord/src/publish.ts",
	"packages/chord/src/json.ts",
	"packages/mcp/src/transports/stdio.ts",
	"packages/mcp/src/transports/streamable-http.ts",
];
const hashes = Object.fromEntries(
	sources.map((path) => [
		path,
		createHash("sha256")
			.update(readFileSync(`${root}/${path}`))
			.digest("hex"),
	]),
);
const payload = "x".repeat(size);
const chunks = (bytes) =>
	Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, i) =>
		bytes.subarray(i * chunkSize, (i + 1) * chunkSize),
	);
const rpcBytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload })}\n`);
const sseBytes = Buffer.from(`id: item\r\ndata: ${payload}\r\n\r\n`);
const framedChunks = chunks(rpcBytes);
const sseChunks = chunks(sseBytes);
const fixtures = [
	{ t: "state", id: 1, ops: [["a", ["output"], "text"]] },
	{ t: "call", id: 1, hold: 1, member: "append", args: { text: "text" } },
	{ t: "result", id: 1, value: { done: true } },
	{ t: "ping", n: 1 },
	{ t: "state", id: 0, ops: [] },
	{ t: "call", id: 1, hold: "1", member: "append", args: null },
	{ t: "unknown" },
	null,
];
const frameExpectations = [true, true, true, true, false, false, false, false];
const tools = Array.from({ length: number("tools", smoke ? 2 : 200) }, (_, i) => ({
	name: `mcp__example__tool_${i}`,
	description: `Example tool ${i}`,
	inputSchema: {
		type: "object",
		properties: Object.fromEntries(
			Array.from({ length: number("properties", smoke ? 2 : 20) }, (_, j) => [
				`p${j}`,
				{ type: "integer", minimum: 0, maximum: 100, description: `Argument ${j}` },
			]),
		),
	},
	outputSchema: {
		type: "object",
		properties: { content: { type: "array", items: { type: "object", properties: { text: { type: "string" } } } } },
	},
}));
const jsonFixture = {
	messages: Array.from({ length: number("objects", smoke ? 2 : 10000) }, (_, i) => ({
		id: i,
		text: "example",
		nested: [true, null, { value: i }],
	})),
};
let copiedJson;
let sandbox;
if (mode === "sandbox") {
	const started = performance.now();
	await loadQuickJSWasm();
	console.log(JSON.stringify({ mode: "wasm-load-and-compile", ms: performance.now() - started }));
	sandbox = new CodemodeSandbox({ tools: [{ name: "echo", execute: (args) => args }], timeoutMs: 30000 });
}
async function work() {
	switch (mode) {
		case "stdio": {
			const transport = new StdioTransport({ command: process.execPath });
			let received = 0;
			transport.onError((error) => {
				throw error;
			});
			transport.onMessage((message) => {
				received++;
				assert.equal(message.result, payload);
			});
			let concatenatedBytes = 0;
			const concat = Buffer.concat;
			if (instrument)
				Buffer.concat = (parts, total) => {
					concatenatedBytes += total ?? parts.reduce((sum, part) => sum + part.length, 0);
					return concat(parts, total);
				};
			try {
				// TypeScript-private ingestion function: isolate actual framing cost from process startup and pipe coalescing.
				// No production export or test-only seam is added.
				for (const chunk of framedChunks) transport.handleStdout(chunk);
				assert.equal(received, 1);
			} finally {
				Buffer.concat = concat;
			}
			return {
				chunks: framedChunks.length,
				wireBytes: rpcBytes.length,
				...(instrument ? { concatenatedBytes } : {}),
			};
		}
		case "sse": {
			let at = 0;
			let received = 0;
			let byteLengthCharacters = 0;
			const byteLength = Buffer.byteLength;
			if (instrument)
				Buffer.byteLength = (value, encoding) => {
					if (typeof value === "string") byteLengthCharacters += value.length;
					return byteLength(value, encoding);
				};
			try {
				const stream = new ReadableStream({
					pull(controller) {
						if (at < sseChunks.length) controller.enqueue(sseChunks[at++]);
						else controller.close();
					},
				});
				await consumeSseStream(stream, {
					onEvent(event) {
						received++;
						assert.equal(event.data, payload);
						assert.equal(event.id, "item");
					},
				});
				assert.equal(received, 1);
			} finally {
				Buffer.byteLength = byteLength;
			}
			return {
				chunks: sseChunks.length,
				wireBytes: sseBytes.length,
				...(instrument ? { byteLengthCharacters } : {}),
			};
		}
		case "http-error": {
			let pulledBytes = 0;
			let at = 0;
			const bytes = chunks(Buffer.from(payload));
			const transport = new StreamableHttpTransport({
				url: "http://unused.invalid/mcp",
				fetch: async () =>
					new Response(
						new ReadableStream({
							pull(controller) {
								if (at < bytes.length) {
									pulledBytes += bytes[at].length;
									controller.enqueue(bytes[at++]);
								} else controller.close();
							},
						}),
						{ status: 503 },
					),
			});
			await transport.start();
			await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }), (error) => {
				assert.equal(error.status, 503);
				assert.equal(error.body, payload.slice(0, 8192));
				return true;
			});
			await transport.close();
			return { pulledBytes, bodyCharacters: Math.min(size, 8192) };
		}
		case "frame": {
			const check = isFrame;
			for (let i = 0; i < fixtures.length; i++) assert.equal(check(fixtures[i]), frameExpectations[i]);
			let accepted = 0;
			for (let i = 0; i < iterations; i++) accepted += Number(check(fixtures[i % fixtures.length]));
			assert.equal(accepted, Math.floor(iterations / 8) * 4 + Math.min(iterations % 8, 4));
			return { iterations, accepted };
		}
		case "publish": {
			let delivered = 0;
			holdPublications(() => {
				for (let i = 0; i < iterations; i++)
					enqueue(() => {
						assert.equal(delivered++, i);
					});
			});
			assert.equal(delivered, iterations);
			return { iterations, delivered };
		}
		case "metadata": {
			let characters = 0;
			for (const tool of tools) characters += renderToolSample(tool).length;
			return { tools: tools.length, characters };
		}
		case "sandbox": {
			const result = await sandbox.execute(
				`const outputs = await Promise.all(Array.from({length:${number("calls", smoke ? 1 : 100)}}, (_, i) => tools.echo({i}))); return outputs.length;`,
			);
			assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
			assert.equal(result.value, number("calls", smoke ? 1 : 100));
			return { calls: result.calls.length };
		}
		case "json": {
			assert.equal(isJsonValue(jsonFixture), true);
			const copied = copyJson(jsonFixture);
			copiedJson = copied;
			assert.equal(copied.messages.length, jsonFixture.messages.length);
			assert.notEqual(copied, jsonFixture);
			return { objects: jsonFixture.messages.length };
		}
		default:
			throw new Error(`Unknown mode ${mode}`);
	}
}
console.log(
	JSON.stringify({
		mode,
		node: process.version,
		size,
		chunkSize,
		iterations,
		repeat,
		instrument,
		sourceHashes: hashes,
	}),
);
try {
	for (let trial = -1; trial < repeat; trial++) {
		global.gc?.();
		const before = process.memoryUsage();
		const started = performance.now();
		const result = await work();
		const ms = performance.now() - started;
		const after = process.memoryUsage();
		const output = Object.fromEntries(
			Object.entries(result).filter(
				([key]) => !["concatenatedBytes", "byteLengthCharacters", "pulledBytes"].includes(key),
			),
		);
		if (trial >= 0) {
			if (mode === "json") assert.deepEqual(copiedJson, jsonFixture);
			witness(
				mode,
				{ size, chunkSize, iterations, tools, jsonFixture, fixtures },
				mode === "json"
					? { ...output, copied: copiedJson }
					: mode === "metadata"
						? { ...output, samples: tools.map((tool) => renderToolSample(tool)) }
						: output,
			);
		}
		if (trial >= 0)
			console.log(
				JSON.stringify({
					trial,
					ms,
					heapDelta: after.heapUsed - before.heapUsed,
					externalDelta: after.external - before.external,
					maxRssKiB: process.resourceUsage().maxRSS,
					...result,
				}),
			);
	}
} finally {
	await sandbox?.close();
}
