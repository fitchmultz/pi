import { expect, it } from "vitest";
import { jsonChunks } from "../src/utils/streaming-file.ts";

it("serializes nested JSON without imposing an additional call-stack ceiling", () => {
	// A validated tree can reach this depth after the existing codec is JIT-optimized.
	// Test serialization directly so cold validation's separate stack limit cannot mask it.
	let value: unknown = null;
	for (let index = 0; index < 4096; index++) value = { nested: value };
	expect(Array.from(jsonChunks(value)).join("")).toBe(JSON.stringify(value));
});
