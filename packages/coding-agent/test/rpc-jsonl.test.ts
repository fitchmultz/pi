import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, attachJsonlRecordReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	test("receives token-framed records across one-byte Unicode splits with native duplicate-key semantics", async () => {
		const text = '{"data":{"old":1},"data":{"text":"🙂a\\nb\u2028c\u2029"},"__proto__":{"kept":true}}\r\n{"last":2}';
		const records: Record<string, unknown>[] = [];
		const errors: Error[] = [];
		const stream = Readable.from([...Buffer.from(text)].map((byte) => Buffer.from([byte])));
		attachJsonlRecordReader(
			stream,
			(record) => records.push(record),
			(error) => errors.push(error),
		);
		await new Promise<void>((resolve) => stream.on("end", resolve));
		expect(records).toEqual(text.split("\r\n").map((line) => JSON.parse(line)));
		expect(Object.hasOwn(records[0], "__proto__")).toBe(true);
		expect(errors).toEqual([]);
	});

	test("reports malformed, unexpected BOM, invalid UTF-8 and truncated records and resumes at the next LF", async () => {
		const records: Record<string, unknown>[] = [];
		const errors: Error[] = [];
		const stream = Readable.from([
			Buffer.from(' \r\n{"ok":1}\n{"a":}\n{}{}\n[]\n'),
			Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]),
			Buffer.from('{"ok":2}\n\ufeff{"unexpected":"bom"}\n{"unfinished":'),
		]);
		attachJsonlRecordReader(
			stream,
			(record) => records.push(record),
			(error) => errors.push(error),
		);
		await new Promise<void>((resolve) => stream.on("end", resolve));
		expect(records).toEqual([{ ok: 1 }, { ok: 2 }]);
		expect(errors).toHaveLength(6);
		expect(errors.map((error) => error.message)).toEqual([
			expect.stringContaining("line 3"),
			expect.stringContaining("line 4"),
			expect.stringContaining("line 5"),
			expect.stringContaining("line 6"),
			expect.stringContaining("line 8"),
			expect.stringContaining("line 9"),
		]);
	});
});
