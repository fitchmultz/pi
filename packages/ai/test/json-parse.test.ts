import { describe, expect, it, test } from "vitest";
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
		[String.raw`{"value":"\u12`, String.raw`{"value":"\\u12`],
		[String.raw`{"value":"\u12QZ"}`, String.raw`{"value":"\\u12QZ"}`],
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

describe("parseStreamingJson", () => {
	// #10868
	it("keeps invalid \\u escapes as literal text without dropping fields", () => {
		expect(parseStreamingJson(String.raw`{"text":"\url{x}"}`)).toEqual({ text: "\\url{x}" });
		expect(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`)).toEqual({
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
	});

	it("decodes valid \\u escapes", () => {
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`)).toEqual({ text: "café \\url" });
	});

	it("omits a \\u escape that is cut off mid-stream", () => {
		expect(parseStreamingJson(String.raw`{"text":"ab\u00`)).toEqual({ text: "ab" });
	});
});
