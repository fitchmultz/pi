import { expect, it } from "vitest";
import { jsonChunks } from "../src/utils/streaming-file.ts";

it("serializes nested JSON without imposing an additional call-stack ceiling", () => {
	const expected = `${'{"nested":'.repeat(4096)}null${"}".repeat(4096)}`;
	const value: unknown = JSON.parse(expected);
	expect(Array.from(jsonChunks(value)).join("")).toBe(expected);
});
