import { createHash, type Hash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { Tokenizer, TokenParser } from "@streamparser/json";

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
	const tokenizer = new Tokenizer();
	// Its initial BOM handling accepts BOMs even after whitespace/opening braces.
	// Prime that state before connecting the parser; only TextDecoder may strip a leading BOM.
	tokenizer.onToken = () => {};
	tokenizer.write('""');
	const parser = new TokenParser({ paths: ["$"] });
	tokenizer.onToken = parser.write.bind(parser);
	tokenizer.onEnd = () => {
		if (!parser.isEnded) parser.end();
	};
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let result: unknown;
	parser.onValue = ({ value }) => {
		result = value;
	};
	for (const chunk of readFileChunksSync(path)) {
		hash?.update(chunk);
		tokenizer.write(decoder.decode(chunk, { stream: true }));
	}
	tokenizer.write(decoder.decode());
	tokenizer.end();
	return result;
}

/** Serialize an already validated JSON tree with JSON.stringify's ordering and escaping, in bounded chunks. */
export function* jsonChunks(value: unknown): Generator<string> {
	if (typeof value === "string") {
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
	} else if (Array.isArray(value)) {
		yield "[";
		for (let index = 0; index < value.length; index++) {
			if (index) yield ",";
			yield* jsonChunks(value[index]);
		}
		yield "]";
	} else if (value !== null && typeof value === "object") {
		yield "{";
		let first = true;
		for (const [key, item] of Object.entries(value)) {
			if (!first) yield ",";
			first = false;
			yield* jsonChunks(key);
			yield ":";
			yield* jsonChunks(item);
		}
		yield "}";
	} else {
		const text = JSON.stringify(value);
		if (text === undefined) throw new TypeError("Expected a JSON value");
		yield text;
	}
}
