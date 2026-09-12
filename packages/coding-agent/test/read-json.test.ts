import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, createReadTool as createHarnessReadTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool, type ReadToolInput } from "../src/core/tools/read.ts";

const invocation = {
	invocationId: "read-json",
	operationId: "read-json",
	turnId: "read-json",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

it("exposes the same optional JSON selection schema through both read factories", () => {
	const schemas = [createHarnessReadTool().parameters, createReadTool(process.cwd()).parameters];
	expect(schemas[0].properties.json).toEqual(schemas[1].properties.json);
	for (const schema of schemas) {
		expect(schema.properties.json).toMatchObject({
			type: "object",
			properties: { path: { type: "string" }, fields: { type: "array", items: { type: "string" } } },
		});
		expect(Check(schema, { path: "data.json" })).toBe(true);
		expect(Check(schema, { path: "data.json", json: {} })).toBe(true);
		expect(Check(schema, { path: "data.json", json: { path: 1 } })).toBe(false);
		expect(Check(schema, { path: "data.json", json: { fields: [1] } })).toBe(false);
	}
});

describe.each(["coding-agent", "agent harness"])("%s read JSON selection", (runtime) => {
	let directory: string;
	let path: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-read-json-"));
		path = join(directory, "data.json");
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	function read(input: ReadToolInput) {
		if (runtime === "coding-agent") return createReadTool(directory).execute("read-json", input);
		return createHarnessReadTool().execute(
			"read-json",
			input,
			() => {},
			{ env: new NodeExecutionEnv({ cwd: directory }) },
			invocation,
			BACKGROUND_CONTEXT,
		);
	}

	it("leaves unselected text unchanged and pretty-prints the whole document for json:{}", async () => {
		const source = '  {"ok":true,"rows":[0,null]}\r\n';
		writeFileSync(path, source);
		expect(textOutput(await read({ path }))).toBe(source);
		expect(textOutput(await read({ path, json: {} }))).toBe(
			'{\n  "ok": true,\n  "rows": [\n    0,\n    null\n  ]\n}',
		);
	});

	it("selects from complete minified input beyond the 50KB source limit", async () => {
		const source = JSON.stringify({ padding: "x".repeat(60_000), result: { id: 42, name: "kept" } });
		expect(Buffer.byteLength(source)).toBeGreaterThan(50 * 1024);
		writeFileSync(path, source);
		const result = await read({ path, json: { path: "/result", fields: ["name"] } });
		expect(textOutput(result)).toBe('{\n  "name": "kept"\n}');
		expect(result.details).toBeUndefined();
	});

	it("selects subtrees and array indices, then projects fields across arrays of objects", async () => {
		writeFileSync(path, '{"rows":[{"id":0,"name":"A"},{"id":1,"name":"B"}],"meta":{"count":2}}');
		expect(JSON.parse(textOutput(await read({ path, json: { path: "/meta" } })))).toEqual({ count: 2 });
		expect(JSON.parse(textOutput(await read({ path, json: { path: "/rows/1", fields: ["name"] } })))).toEqual({
			name: "B",
		});
		expect(JSON.parse(textOutput(await read({ path, json: { path: "/rows", fields: ["id"] } })))).toEqual([
			{ id: 0 },
			{ id: 1 },
		]);
	});

	it("omits absent or inherited fields while preserving literal keys and null, false, and zero", async () => {
		writeFileSync(path, '{"rows":[{"id":0,"flag":false,"value":null,"a.b":3,"a/b":4,"*":5},{"id":2},{}]}');
		const json = { path: "/rows", fields: ["id", "flag", "value", "absent", "toString", "a.b", "a/b", "*"] };
		expect(JSON.parse(textOutput(await read({ path, json })))).toEqual([
			{ id: 0, flag: false, value: null, "a.b": 3, "a/b": 4, "*": 5 },
			{ id: 2 },
			{},
		]);
	});

	it.each([
		["", '{\n  "": {\n    "a/b": {\n      "~key": false,\n      "~1": 0\n    }\n  }\n}'],
		["/", '{\n  "a/b": {\n    "~key": false,\n    "~1": 0\n  }\n}'],
		["//a~1b/~0key", "false"],
		["//a~1b/~01", "0"],
	])("decodes JSON Pointer %j once and supports empty keys", async (pointer, expected) => {
		writeFileSync(path, '{"":{"a/b":{"~key":false,"~1":0}}}');
		expect(textOutput(await read({ path, json: { path: pointer } }))).toBe(expected);
	});

	it("allows own constructor and __proto__ keys in both paths and field projection", async () => {
		writeFileSync(path, '{"constructor":0,"__proto__":false,"prototype":null}');
		expect(textOutput(await read({ path, json: { path: "/constructor" } }))).toBe("0");
		expect(textOutput(await read({ path, json: { path: "/__proto__" } }))).toBe("false");
		expect(textOutput(await read({ path, json: { fields: ["constructor", "__proto__", "prototype"] } }))).toBe(
			'{\n  "constructor": 0,\n  "__proto__": false,\n  "prototype": null\n}',
		);
	});

	it("accepts a leading BOM for selection without changing the unselected decoder", async () => {
		const source = '\uFEFF{"rows":[{"id":0}]}';
		writeFileSync(path, source);
		expect(textOutput(await read({ path, json: { path: "/rows/0" } }))).toBe('{\n  "id": 0\n}');
		expect(textOutput(await read({ path }))).toBe(runtime === "agent harness" ? source.slice(1) : source);
	});

	it("supports scalar JSON selections without fields and empty field lists on objects", async () => {
		for (const source of ["null", "false", "0", '"text"']) {
			writeFileSync(path, source);
			expect(textOutput(await read({ path, json: {} }))).toBe(source);
		}
		writeFileSync(path, '[{"id":1},{}]');
		expect(textOutput(await read({ path, json: { fields: [] } }))).toBe("[\n  {},\n  {}\n]");
	});

	it("reports invalid JSON as a JSON selection error", async () => {
		writeFileSync(path, '{"rows":');
		await expect(read({ path, json: {} })).rejects.toThrow(/JSON selection.*valid JSON/);
	});

	it.each(["rows/0", "#/rows/0", "/rows/~2", "/rows/~", "\n"])(
		"rejects invalid pointer syntax %j",
		async (pointer) => {
			writeFileSync(path, '{"rows":[{}]}');
			await expect(read({ path, json: { path: pointer } })).rejects.toThrow(
				/JSON selection.*json.path.*JSON Pointer/,
			);
		},
	);

	it.each([
		"/missing",
		"/toString",
		"/constructor",
		"/__proto__",
		"/rows/length",
		"/rows/01",
		"/rows/-1",
		"/rows/2",
		"/rows/0/id/x",
	])("rejects missing, inherited, or non-index array paths %j", async (pointer) => {
		writeFileSync(path, '{"rows":[{"id":0},{"id":1}]}');
		await expect(read({ path, json: { path: pointer } })).rejects.toThrow(
			/JSON selection.*json.path.*does not exist/,
		);
	});

	it.each(["null", "0", '"text"', '[{"id":1},false]', '[{"id":1},null]', '[{"id":1},[]]'])(
		"rejects fields on a scalar or a non-object array member: %s",
		async (source) => {
			writeFileSync(path, source);
			await expect(read({ path, json: { fields: ["id"] } })).rejects.toThrow(
				/JSON selection.*json.fields.*object.*json.path.*omit json.fields/,
			);
		},
	);

	it("pages the selected output and repeats the same selector in continuation notices", async () => {
		writeFileSync(path, '{"rows":[{"id":0,"ignored":true},{"id":1}],"ignored":true}');
		const json = { path: "/rows", fields: ["id"] };
		const first = await read({ path, json, limit: 4 });
		expect(textOutput(first)).toBe(
			'[\n  {\n    "id": 0\n  },\n\n[4 more lines in JSON selection. Use offset=5 with the same json={"path":"/rows","fields":["id"]} to continue.]',
		);
		expect(textOutput(await read({ path, json, offset: 5 }))).toBe('  {\n    "id": 1\n  }\n]');
		await expect(read({ path, json, offset: 9 })).rejects.toThrow(
			"Offset 9 is beyond end of JSON selection (8 lines total)",
		);
	});

	it("truncates selected lines and resumes without skipping or repeating values", async () => {
		const rows = Array.from({ length: 2100 }, (_, index) => index);
		writeFileSync(path, JSON.stringify({ rows }));
		const json = { path: "/rows" };
		const first = await read({ path, json });
		expect(first.details?.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
			totalLines: 2102,
			outputLines: 2000,
		});
		expect(textOutput(first)).toContain(
			'[Showing JSON selection lines 1-2000 of 2102. Use offset=2001 with the same json={"path":"/rows"} to continue.]',
		);
		const next = await read({ path, json, offset: 2001 });
		expect(next.details).toBeUndefined();
		expect(JSON.parse(`${first.details?.truncation?.content}\n${textOutput(next)}`)).toEqual(rows);
	});

	it("applies the byte cap to formatted JSON and keeps continuation within that selection", async () => {
		const rows = Array.from({ length: 100 }, (_, index) => `${index}:${"é".repeat(500)}`);
		writeFileSync(path, JSON.stringify({ rows }));
		const json = { path: "/rows" };
		const first = await read({ path, json });
		const truncation = first.details?.truncation;
		expect(truncation).toMatchObject({ truncated: true, truncatedBy: "bytes" });
		expect(Buffer.byteLength(truncation!.content)).toBeLessThanOrEqual(50 * 1024);
		expect(textOutput(first)).toContain(
			`[Showing JSON selection lines 1-${truncation!.outputLines} of 102 (50.0KB limit). Use offset=${truncation!.outputLines + 1} with the same json={"path":"/rows"} to continue.]`,
		);
		const next = await read({ path, json, offset: truncation!.outputLines + 1 });
		expect(next.details).toBeUndefined();
		expect(JSON.parse(`${truncation!.content}\n${textOutput(next)}`)).toEqual(rows);
	});

	it("does not suggest source-file sed offsets for an oversized selected scalar", async () => {
		writeFileSync(path, JSON.stringify({ payload: "x".repeat(60_000) }));
		const result = await read({ path, json: { path: "/payload" } });
		expect(result.details?.truncation).toMatchObject({ firstLineExceedsLimit: true, outputLines: 0 });
		expect(textOutput(result)).toContain("JSON selection line 1");
		expect(textOutput(result)).toContain("json.path/json.fields");
		expect(textOutput(result)).toContain("bash");
		expect(textOutput(result)).not.toContain("sed");
	});

	it("rejects JSON selection on an actual image regardless of its extension", async () => {
		writeFileSync(
			path,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		await expect(read({ path, json: {} })).rejects.toThrow(/JSON selection.*image.*Omit json/);
	});
});
