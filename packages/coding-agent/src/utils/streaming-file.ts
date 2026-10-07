import { createHash, type Hash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { isJsonValue } from "@earendil-works/chord";
import { getManyValues, type Many, none } from "stream-chain/core";
import { Assembler } from "stream-json/core/assembler.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";
import * as streamJson from "stream-json/core/parser.js";

// ponytail: 3.7 omits its public synchronous factory's types; drop this narrowing when upstream includes them.
const { jsonParser } = streamJson as typeof streamJson & {
	jsonParser(options?: ParserOptions): (input: string | typeof none) => Many<Token> | typeof none;
};

const CHUNK_SIZE = 64 * 1024;

/** Chunks share a read buffer and must be consumed before advancing the iterator. */
export function* readFileChunksSync(path: string): Generator<Buffer> {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
		while (true) {
			const size = readSync(fd, buffer, 0, buffer.length, null);
			if (size === 0) break;
			yield buffer.subarray(0, size);
		}
	} finally {
		closeSync(fd);
	}
}

export function hashFileSync(path: string): string {
	const hash = createHash("sha256");
	for (const chunk of readFileChunksSync(path)) hash.update(chunk);
	return hash.digest("hex");
}

/** Parse a full JSON value without constructing a string for the whole document. */
export function readJsonFileSync(path: string, hash?: Hash): unknown {
	const parse = jsonParser({ streamValues: false });
	const assembler = new Assembler();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let nonFiniteNumber = false;
	const consume = (input: string | typeof none) => {
		const tokens = parse(input);
		if (tokens === none) return;
		for (const token of getManyValues(tokens)) {
			if (token.name === "numberValue" && !Number.isFinite(Number(token.value))) nonFiniteNumber = true;
			// Detach parser ropes/slices from input buffers; UTF-16 preserves lone surrogates as well.
			if (token.name === "stringValue" || token.name === "keyValue")
				token.value = Buffer.from(token.value, "utf16le").toString("utf16le");
			assembler.consume(token);
		}
	};
	for (const chunk of readFileChunksSync(path)) {
		hash?.update(chunk);
		consume(decoder.decode(chunk, { stream: true }));
	}
	consume(decoder.decode());
	consume(none);
	// An overflowing value may have been discarded by a later duplicate key.
	if (nonFiniteNumber && !isJsonValue(assembler.current))
		throw new TypeError("Value contains a non-finite number and is not strict JSON");
	return assembler.current;
}

function* jsonStringChunks(value: string): Generator<string> {
	yield '"';
	for (let start = 0; start < value.length; ) {
		let end = Math.min(start + CHUNK_SIZE, value.length);
		// Do not turn a surrogate pair across the chunk boundary into two escaped code units.
		if (
			end < value.length &&
			value.charCodeAt(end - 1) >= 0xd800 &&
			value.charCodeAt(end - 1) <= 0xdbff &&
			value.charCodeAt(end) >= 0xdc00 &&
			value.charCodeAt(end) <= 0xdfff
		)
			end--;
		yield JSON.stringify(value.slice(start, end)).slice(1, -1);
		start = end;
	}
	yield '"';
}

/** Serialize an already validated JSON tree with JSON.stringify's ordering and escaping, in bounded chunks. */
export function* jsonChunks(value: unknown): Generator<string> {
	const stack: Array<{ items: Iterator<[string | number, unknown]>; array: boolean; first: boolean }> = [];
	let current = value;
	while (true) {
		if (typeof current === "string") yield* jsonStringChunks(current);
		else if (Array.isArray(current)) {
			yield "[";
			stack.push({ items: current.entries(), array: true, first: true });
		} else if (current !== null && typeof current === "object") {
			yield "{";
			stack.push({ items: Object.entries(current)[Symbol.iterator](), array: false, first: true });
		} else {
			const text = JSON.stringify(current);
			if (text === undefined) throw new TypeError("Expected a JSON value");
			yield text;
		}
		while (true) {
			const frame = stack.at(-1);
			if (!frame) return;
			const item = frame.items.next();
			if (item.done) {
				yield frame.array ? "]" : "}";
				stack.pop();
				continue;
			}
			if (!frame.first) yield ",";
			frame.first = false;
			if (!frame.array) {
				yield* jsonStringChunks(String(item.value[0]));
				yield ":";
			}
			current = item.value[1];
			break;
		}
	}
}
