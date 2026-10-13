import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createModels, createProvider } from "/pi-performance-source/packages/ai/src/models.ts";
import { witness } from "../proof.mjs";

const smoke = process.argv.includes("--smoke");
const option = (name, fallback) =>
	Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const count = option("models", smoke ? 4 : 3000);
const samples = option("samples", smoke ? 1 : 7);
const iterations = option("iterations", smoke ? 1 : 10);
for (const value of [count, samples, iterations]) assert.ok(Number.isSafeInteger(value) && value > 0);
const model = (id, name) => ({
	id,
	name,
	api: "offline",
	provider: "perf",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
});
const baseline = Array.from({ length: count }, (_, index) => model(String(index), `baseline-${index}`));
const overlay = [...baseline.map((item) => ({ ...item, name: `overlay-${item.id}` })), model("added", "added")];
const models = createModels({
	modelsStore: {
		read: async () => ({ models: overlay }),
		write: async () => {
			throw new Error("unexpected write");
		},
		delete: async () => {
			throw new Error("unexpected delete");
		},
	},
});
models.setProvider(
	createProvider({
		id: "perf",
		auth: { apiKey: { name: "offline", resolve: async () => ({ auth: {} }) } },
		models: baseline,
		fetchModels: async () => {
			throw new Error("network disabled");
		},
		api: {
			stream: () => {
				throw new Error("provider calls disabled");
			},
			streamSimple: () => {
				throw new Error("provider calls disabled");
			},
		},
	}),
);
const refreshed = await models.refresh({ providers: ["perf"], allowNetwork: false });
assert.equal(refreshed.errors.size, 0);
assert.equal(refreshed.aborted, false);
const rows = [];
let result;
for (let sample = 0; sample < samples; sample++) {
	globalThis.gc?.();
	const start = performance.now();
	const cpu = process.cpuUsage();
	const heap = process.memoryUsage().heapUsed;
	for (let index = 0; index < iterations; index++) result = models.getAllModels("perf");
	const elapsed = performance.now() - start;
	const used = process.cpuUsage(cpu);
	rows.push({
		msPerRead: elapsed / iterations,
		cpuMsPerRead: (used.user + used.system) / 1000 / iterations,
		transientHeapDelta: process.memoryUsage().heapUsed - heap,
	});
	// Independently specified overlay contract: replace in baseline order, then append genuinely new IDs.
	assert.equal(result.length, count + 1);
	for (let index = 0; index < count; index++) {
		assert.equal(result[index].id, String(index));
		assert.equal(result[index].name, `overlay-${index}`);
	}
	assert.equal(result.at(-1).id, "added");
}
console.log(JSON.stringify({ node: process.version, smoke, count, samples, iterations, rows }));

witness("catalog", { baseline, overlay }, result);
