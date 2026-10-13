import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
	createTypedSpanStarter,
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
} from "/pi-performance-source/packages/telemetry/src/index.ts";
import { witness } from "../proof.mjs";

const { values } = parseArgs({
	options: {
		spans: { type: "string", default: "10000" },
		updates: { type: "string", default: "20" },
		snapshots: { type: "string", default: "10" },
	},
});
const count = Number(values.spans);
const updates = Number(values.updates);
const snapshots = Number(values.snapshots);
if ([count, updates, snapshots].some((value) => !Number.isSafeInteger(value) || value < 1))
	throw new Error("Invalid workload");
const schema = [
	{
		version: 1,
		spans: {
			operation: {
				description: "benchmark",
				parents: { kind: "any" },
				startAttributes: {},
				endAttributes: {},
				status: { default: "ok", errorWhen: "never" },
			},
		},
	},
];
for (const mode of ["noop", "typed-noop", "memory"]) {
	const context = mode === "memory" ? new InMemoryTelemetryContext() : NOOP_TELEMETRY_CONTEXT;
	const typed = createTypedSpanStarter(context, schema);
	const startedAt = performance.now();
	for (let i = 0; i < count; i++) {
		const value =
			mode === "typed-noop"
				? await typed("operation", {}, () => i)
				: await context.startSpan({ name: "operation" }, () => i);
		assert.equal(value, i);
	}
	console.log(JSON.stringify({ mode, spans: count, elapsedMs: performance.now() - startedAt }));
	if (mode === "memory") {
		const startedAt = performance.now();
		for (let i = 0; i < snapshots; i++) assert.equal(context.getSpans().length, count);
		console.log(
			JSON.stringify({ mode: "snapshots", spans: count, snapshots, elapsedMs: performance.now() - startedAt }),
		);
	}
}
const context = new InMemoryTelemetryContext();
const startedAt = performance.now();
await context.startSpan(
	{ name: "many-updates", attributes: { retainedArray: Array.from({ length: count }, (_, i) => i) } },
	(span) => {
		for (let i = 0; i < updates; i++) span.setAttributes({ progress: i });
	},
);
assert.equal(context.getSpans()[0].attributes.progress, updates - 1);
console.log(
	JSON.stringify({
		mode: "retained-array-updates",
		retainedArrayLength: count,
		updates,
		elapsedMs: performance.now() - startedAt,
	}),
);

witness(
	"telemetry",
	{ count, updates, snapshots },
	context.getSpans().map(({ name, attributes }) => ({ name, attributes })),
);
