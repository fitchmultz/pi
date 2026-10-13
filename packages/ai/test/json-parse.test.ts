import { describe, expect, test } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/utils/json-parse.ts";

describe("JSON string repair", () => {
	test.each([
		['{"path":"🍎/file","content":"plain"}', '{"path":"🍎/file","content":"plain"}'],
		[
			String.raw`{"value":"quote\" slash\\ unicode\uD83C\uDF4E"}`,
			String.raw`{"value":"quote\" slash\\ unicode\uD83C\uDF4E"}`,
		],
		['\n{"value":"line\n\ttab\u0000\u001f"}\r', '\n{"value":"line\\n\\ttab\\u0000\\u001f"}\r'],
		[String.raw`{"path":"A\H","next":"B\Q"}`, String.raw`{"path":"A\\H","next":"B\\Q"}`],
		['{"value":"end\\', '{"value":"end\\\\'],
		[String.raw`{"value":"\u12`, String.raw`{"value":"\u12`],
		[String.raw`{"value":"\u12QZ"}`, String.raw`{"value":"\u12QZ"}`],
		[String.raw`{"value":"escaped quote \" then \H 🍎"}`, String.raw`{"value":"escaped quote \" then \\H 🍎"}`],
	])("preserves untouched spans and repairs only malformed string characters (%s)", (input, expected) => {
		expect(repairJson(input)).toBe(expected);
	});

	test("repairs complete malformed JSON before permissive partial parsing", () => {
		expect(parseJsonWithRepair(String.raw`{"path":"A\H","content":"line	tab"}`)).toEqual({
			path: "A\\H",
			content: "line\ttab",
		});
		expect(parseStreamingJson(String.raw`{"path":"A\H","content":"line	tab"}`)).toEqual({
			path: "A\\H",
			content: "line\ttab",
		});
	});

	test("keeps progressive arguments and the original partial-parser fallback order", () => {
		expect(parseStreamingJson('{"path":"🍎/file","content":"fir')).toEqual({ path: "🍎/file", content: "fir" });
		expect(parseStreamingJson('{"path":"🍎/file","content":"first line')).toEqual({
			path: "🍎/file",
			content: "first line",
		});
		expect(parseStreamingJson(String.raw`{"path":"A\H`)).toEqual({ path: "A" });
		expect(parseStreamingJson(String.raw`{"path":"\u12`)).toEqual({ path: "" });
	});
});
