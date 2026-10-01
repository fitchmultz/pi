import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	existsSync,
	fstatSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { type FunctionList, getFunctionList, isMany, none } from "stream-chain/defs.js";
import parser, { type Token } from "stream-json/core/parser.js";

export type JsonPath = readonly (string | number)[];
export type JsonSelection = (path: JsonPath) => "keep" | "descend" | "skip";
export interface JsonProjectionOptions {
	select?: JsonSelection;
	/** Return true to consume a completed selected value without retaining it in its parent. */
	onValue?: (path: JsonPath, value: unknown) => boolean;
	maxSelectedChars?: number;
	/** Native tolerant files replace invalid UTF-8; strict wire/accounting inputs reject it. */
	fatalUtf8?: boolean;
	/** Explicit preview fields may retain a prefix; required fields remain untruncated. */
	stringLimit?: (path: JsonPath) => number;
	/** Internal source-copy sink; tokens remain unpacked and do not assemble ignored values. */
	onToken?: (token: Token, path: JsonPath) => void;
	/** Scalar traits are measured before optional preview truncation. */
	onStringValue?: (path: JsonPath, hasNonWhitespace: boolean) => void;
	onStart?: () => void;
}

interface Frame {
	path: (string | number)[];
	mode: "keep" | "descend" | "skip";
	value: Record<string, unknown> | unknown[] | undefined;
	key: string;
	index: number;
	array: boolean;
}

/** Select tokens, not packed strings. Duplicate keys replace entire selected subtrees as JSON.parse does. */
export class JsonTokenProjection {
	private tokenize: (value: string | typeof none) => unknown;
	private options: JsonProjectionOptions;
	private stack: Frame[] = [];
	private key = "";
	private keyTooLong = false;
	private readingKey = false;
	private scalar:
		| { path: (string | number)[]; mode: Frame["mode"]; value: string; number: boolean; nonblank: boolean }
		| undefined;
	private result: unknown;
	private started = false;
	private selectedChars = 0;
	readonly fields: string[] = [];

	constructor(options: JsonProjectionOptions = {}) {
		this.options = options;
		options.onStart?.();
		// stream-json 3.7.0 wraps these synchronous stages in an async gen(), while
		// its bundled TokenSource declaration still describes the synchronous output.
		// Use its public function-list protocol; bytes are decoded explicitly below.
		const stages = getFunctionList(
			parser({ packValues: false, streamValues: true }) as unknown as FunctionList<
				(value: string | typeof none) => unknown
			>,
		);
		this.tokenize = stages.at(-1)!;
	}

	write(text: string): void {
		this.consume(this.tokenize(text));
	}

	finish(): unknown {
		this.consume(this.tokenize(none));
		if (!this.started) throw new Error("Expected one JSON object");
		return this.result;
	}

	private consume(output: unknown): void {
		if (isMany(output)) for (const token of output.values) this.token(token as Token);
	}

	private location(): (string | number)[] {
		const parent = this.stack.at(-1);
		return parent ? [...parent.path, parent.array ? parent.index : parent.key] : [];
	}

	private mode(path: JsonPath): Frame["mode"] {
		const parent = this.stack.at(-1);
		if (parent?.mode === "skip" || this.keyTooLong) return "skip";
		return parent?.mode === "keep" ? "keep" : (this.options.select?.(path) ?? "keep");
	}

	private complete(path: JsonPath, value: unknown, mode: Frame["mode"]): void {
		const parent = this.stack.at(-1);
		const consumed = mode !== "skip" && this.options.onValue?.(path, value);
		if (!parent) this.result = value;
		else {
			if (parent.value && mode !== "skip" && !consumed) {
				// defineProperty preserves JSON.parse's own __proto__ property semantics.
				Object.defineProperty(parent.value, path.at(-1)!, {
					value,
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			parent.index++;
		}
		this.keyTooLong = false;
	}

	private addText(text: string): void {
		if (!this.scalar || this.scalar.mode === "skip") return;
		if (this.options.onStringValue && !this.scalar.number) this.scalar.nonblank ||= text.trim().length > 0;
		const limit = this.scalar.number ? Infinity : (this.options.stringLimit?.(this.scalar.path) ?? Infinity);
		const retained = text.slice(0, Math.max(0, limit - this.scalar.value.length));
		this.selectedChars += retained.length;
		if (this.selectedChars > (this.options.maxSelectedChars ?? Infinity))
			throw new Error("Selected JSON metadata exceeds its bounded size");
		this.scalar.value += retained;
	}

	private token(token: Token): void {
		const tokenPath =
			token.name === "endObject" || token.name === "endArray"
				? (this.stack.at(-1)?.path ?? [])
				: token.name === "endKey"
					? [...this.stack.at(-1)!.path, this.key]
					: (this.scalar?.path ?? this.location());
		this.options.onToken?.(token, tokenPath);
		switch (token.name) {
			case "startKey":
				this.readingKey = true;
				this.key = "";
				this.keyTooLong = false;
				break;
			case "stringChunk":
				if (this.readingKey) {
					const parent = this.stack.at(-1)!;
					// Ignored keys need not fit a string either. Known schema paths are short.
					if (parent.mode === "keep" || parent.path.length === 0 || this.key.length + token.value.length <= 4096)
						this.key += token.value;
					else this.keyTooLong = true;
				} else this.addText(token.value);
				break;
			case "endKey":
				this.readingKey = false;
				this.stack.at(-1)!.key = this.key;
				if (this.stack.length === 1 && !this.fields.includes(this.key) && !this.keyTooLong)
					this.fields.push(this.key);
				break;
			case "startObject":
			case "startArray": {
				const path = this.location();
				if (!this.started) {
					if (token.name !== "startObject") throw new Error("Expected one JSON object");
					this.started = true;
				}
				const mode = this.mode(path);
				this.stack.push({
					path,
					mode,
					value: mode === "skip" ? undefined : token.name === "startArray" ? [] : {},
					key: "",
					index: 0,
					array: token.name === "startArray",
				});
				break;
			}
			case "endObject":
			case "endArray": {
				const frame = this.stack.pop()!;
				this.complete(frame.path, frame.value, frame.mode);
				break;
			}
			case "startString":
			case "startNumber": {
				const path = this.location();
				this.scalar = {
					path,
					mode: this.mode(path),
					value: "",
					number: token.name === "startNumber",
					nonblank: false,
				};
				break;
			}
			case "numberChunk":
				this.addText(token.value);
				break;
			case "endString":
			case "endNumber": {
				const scalar = this.scalar!;
				if (!scalar.number && scalar.mode !== "skip") this.options.onStringValue?.(scalar.path, scalar.nonblank);
				this.complete(scalar.path, scalar.number ? Number(scalar.value) : scalar.value, scalar.mode);
				this.scalar = undefined;
				break;
			}
			case "trueValue":
			case "falseValue":
			case "nullValue": {
				const path = this.location();
				this.complete(path, token.value, this.mode(path));
				break;
			}
		}
	}
}

export interface JournalSource {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	prefixDigest?: string;
	allowLeadingBom?: boolean;
	/** Captured read-only inode, shared by its views even after unlink/atomic native repair. */
	handle: { readonly fd: number; closed: boolean };
}
const sourceDescriptors = new FinalizationRegistry<number>((fd) => closeSync(fd));

/** Capture a published native write whose record index was built by its writer. */
export function openJournalSource(path: string): JournalSource {
	const fd = openSync(path, "r");
	try {
		const stats = fstatSync(fd);
		const source: JournalSource = {
			path,
			dev: stats.dev,
			ino: stats.ino,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ctimeMs: stats.ctimeMs,
			handle: { fd, closed: false },
		};
		sourceDescriptors.register(source.handle, fd, source.handle);
		return source;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/** Cold consumers release explicitly. Lazy entry views retain their source until no views remain. */
export function closeJournalSource(source: JournalSource): void {
	if (source.handle.closed) return;
	source.handle.closed = true;
	sourceDescriptors.unregister(source.handle);
	closeSync(source.handle.fd);
}
function hashDescriptor(fd: number, end: number): string {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	for (let position = 0; position < end; ) {
		const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
		if (!count) throw new Error("Journal truncated during inspection");
		hash.update(buffer.subarray(0, count));
		position += count;
	}
	return hash.digest("hex");
}

/** Strict cold publication verifies bytes and identity, including separators and ignored values. */
export function verifyJournalSource(source: JournalSource): void {
	const current = statSync(source.path);
	if (
		source.handle.closed ||
		current.dev !== source.dev ||
		current.ino !== source.ino ||
		current.size !== source.size ||
		hashDescriptor(source.handle.fd, source.size) !== source.prefixDigest
	)
		throw new Error("Journal source changed during inspection");
}

export interface JournalRecord {
	start: number;
	end: number;
	line: number;
	value: Record<string, unknown>;
	fields: string[];
	digest: string;
}
export interface JournalScan {
	source: JournalSource;
	records: JournalRecord[];
	committedEnd: number;
	pendingTail: boolean;
}
export interface JournalScanOptions extends JsonProjectionOptions {
	policy?: "tolerant" | "strict" | "live";
	/** Require LF publication while retaining the selected parse/error policy. */
	requireFinalLf?: boolean;
	signal?: AbortSignal;
	end?: number;
	chunkSize?: number;
	allowLeadingBom?: boolean;
}

export interface JsonlDecoderOptions extends JsonProjectionOptions {
	policy?: "tolerant" | "strict" | "live";
	requireFinalLf?: boolean;
	onRecord: (record: JournalRecord) => void;
	onError?: (error: Error, line: number) => void;
	start?: number;
	allowLeadingBom?: boolean;
}

/** Incremental byte/LF framing shared by native files and pipe receivers. */
export class JsonlRecordDecoder {
	private options: JsonlDecoderOptions;
	private projection: JsonTokenProjection;
	private decoder: TextDecoder;
	private hash = createHash("sha256");
	private start: number;
	private position: number;
	private line = 1;
	private nonblank = false;
	private decodedNonblank = false;
	private error: unknown;
	committedEnd: number;

	constructor(options: JsonlDecoderOptions) {
		this.options = options;
		this.start = this.position = this.committedEnd = options.start ?? 0;
		this.projection = new JsonTokenProjection(options);
		this.decoder = new TextDecoder("utf-8", {
			fatal: options.fatalUtf8 ?? options.policy !== "tolerant",
			ignoreBOM: !options.allowLeadingBom || this.start !== 0,
		});
	}

	feed(bytes: Uint8Array): void {
		let offset = 0;
		for (;;) {
			const lf = bytes.indexOf(10, offset);
			if (lf < 0) {
				this.part(bytes.subarray(offset));
				break;
			}
			this.part(bytes.subarray(offset, lf));
			this.endRecord(this.position + lf, true);
			offset = lf + 1;
			if (offset === bytes.length) break;
		}
		this.position += bytes.length;
	}

	/** Live/LF-required readers exclude any unterminated tail; sealed readers accept a valid EOF object. */
	finish(): { committedEnd: number; pendingTail: boolean } {
		const pendingTail = this.start < this.position;
		if (pendingTail) this.endRecord(this.position, false);
		return { committedEnd: this.committedEnd, pendingTail };
	}

	private part(bytes: Uint8Array): void {
		this.hash.update(bytes);
		if (!this.nonblank)
			for (const byte of bytes)
				if (byte !== 32 && byte !== 9 && byte !== 13) {
					this.nonblank = true;
					break;
				}
		if (this.error) return;
		try {
			const text = this.decoder.decode(bytes, { stream: true });
			this.decodedNonblank ||= /[^ \t\r]/.test(text);
			this.projection.write(text);
		} catch (caught) {
			this.error = caught;
		}
	}

	private endRecord(end: number, terminated: boolean): void {
		const pending = !terminated && (this.options.policy === "live" || this.options.requireFinalLf);
		if (!pending && !this.error) {
			try {
				const text = this.decoder.decode();
				this.decodedNonblank ||= /[^ \t\r]/.test(text);
				this.projection.write(text);
			} catch (error) {
				this.error = error;
			}
		}
		const nonblank =
			this.options.allowLeadingBom && this.line === 1 && this.start === 0
				? this.decodedNonblank || Boolean(this.error)
				: this.nonblank;
		if (nonblank && !pending) {
			let value: unknown;
			try {
				if (this.error) throw this.error;
				value = this.projection.finish();
			} catch (caught) {
				const error = new SyntaxError(`Invalid JSONL at line ${this.line}: ${String(caught)}`);
				if (this.options.policy !== "tolerant") throw error;
				this.options.onError?.(error, this.line);
			}
			if (value)
				this.options.onRecord({
					start: this.start,
					end,
					line: this.line,
					value: value as Record<string, unknown>,
					fields: this.projection.fields,
					digest: this.hash.digest("hex"),
				});
		}
		if (!pending) this.committedEnd = end + (terminated ? 1 : 0);
		this.start = end + 1;
		this.line++;
		this.projection = new JsonTokenProjection(this.options);
		this.decoder = new TextDecoder("utf-8", {
			fatal: this.options.fatalUtf8 ?? this.options.policy !== "tolerant",
			ignoreBOM: true,
		});
		this.hash = createHash("sha256");
		this.error = undefined;
		this.nonblank = false;
		this.decodedNonblank = false;
	}
}

/** Read one captured descriptor/end. No whole line, unread suffix, or ignored value is accumulated. */
export function scanJournal(path: string, options: JournalScanOptions = {}): JournalScan {
	const fd = openSync(path, "r");
	let retained = false;
	try {
		const initial = fstatSync(fd);
		const end = options.end ?? initial.size;
		if (end > initial.size || end < 0) throw new Error("Invalid captured journal boundary");
		const source: JournalSource = {
			path,
			dev: initial.dev,
			ino: initial.ino,
			size: end,
			mtimeMs: initial.mtimeMs,
			ctimeMs: initial.ctimeMs,
			handle: { fd, closed: false },
			allowLeadingBom: options.allowLeadingBom,
		};
		const records: JournalRecord[] = [];
		const prefix = createHash("sha256");
		const decoder = new JsonlRecordDecoder({ ...options, onRecord: (record) => records.push(record) });
		const buffer = Buffer.allocUnsafe(options.chunkSize ?? 64 * 1024);
		let position = 0;
		while (position < end) {
			options.signal?.throwIfAborted();
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
			if (!count) throw new Error("Journal truncated during inspection");
			prefix.update(buffer.subarray(0, count));
			decoder.feed(buffer.subarray(0, count));
			position += count;
		}
		const boundary = decoder.finish();
		source.prefixDigest = prefix.digest("hex");
		const final = fstatSync(fd);
		if (
			final.size < end ||
			final.dev !== initial.dev ||
			final.ino !== initial.ino ||
			(final.size === initial.size && (final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs))
		)
			throw new Error("Journal changed during inspection");
		if (final.size !== initial.size && hashDescriptor(fd, end) !== source.prefixDigest)
			throw new Error("Journal prefix changed during inspection");
		sourceDescriptors.register(source.handle, fd, source.handle);
		retained = true;
		return { source, records, ...boundary };
	} finally {
		if (!retained) closeSync(fd);
	}
}

/** Async discovery yields between bounded chunks so cancellation remains responsive. */
export async function scanJournalAsync(path: string, options: JournalScanOptions = {}): Promise<JournalScan> {
	const fd = openSync(path, "r");
	let retained = false;
	try {
		const initial = fstatSync(fd);
		const end = options.end ?? initial.size;
		if (end > initial.size || end < 0) throw new Error("Invalid captured journal boundary");
		const source: JournalSource = {
			path,
			dev: initial.dev,
			ino: initial.ino,
			size: end,
			mtimeMs: initial.mtimeMs,
			ctimeMs: initial.ctimeMs,
			handle: { fd, closed: false },
			allowLeadingBom: options.allowLeadingBom,
		};
		const records: JournalRecord[] = [];
		const prefix = createHash("sha256");
		const decoder = new JsonlRecordDecoder({ ...options, onRecord: (record) => records.push(record) });
		options.signal?.throwIfAborted();
		if (end) {
			const stream = createReadStream(path, {
				fd,
				autoClose: false,
				start: 0,
				end: end - 1,
				highWaterMark: options.chunkSize ?? 64 * 1024,
				signal: options.signal,
			});
			for await (const bytes of stream) {
				options.signal?.throwIfAborted();
				prefix.update(bytes as Buffer);
				decoder.feed(bytes as Buffer);
			}
		}
		const boundary = decoder.finish();
		source.prefixDigest = prefix.digest("hex");
		const final = fstatSync(fd);
		if (
			final.size < end ||
			(final.size === initial.size && (final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs))
		)
			throw new Error("Journal changed during inspection");
		if (final.size !== initial.size && hashDescriptor(fd, end) !== source.prefixDigest)
			throw new Error("Journal prefix changed during inspection");
		sourceDescriptors.register(source.handle, fd, source.handle);
		retained = true;
		return { source, records, ...boundary };
	} finally {
		if (!retained) closeSync(fd);
	}
}

function visitJournalRecord(
	source: JournalSource,
	record: JournalRecord,
	visit: (bytes: Buffer) => void,
	validatePath = true,
): void {
	if (source.handle.closed) throw new Error("Journal source descriptor is closed");
	const fd = source.handle.fd;
	if (validatePath && existsSync(source.path)) {
		const current = statSync(source.path);
		if (current.dev !== source.dev || current.ino !== source.ino || current.size < source.size)
			throw new Error("Journal source generation changed");
	}
	const stats = fstatSync(fd);
	if (stats.dev !== source.dev || stats.ino !== source.ino || stats.size < source.size)
		throw new Error("Journal source generation changed");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	const hash = createHash("sha256");
	let position = record.start;
	while (position < record.end) {
		const count = readSync(fd, buffer, 0, Math.min(buffer.length, record.end - position), position);
		if (!count) throw new Error("Journal record truncated");
		const bytes = buffer.subarray(0, count);
		hash.update(bytes);
		visit(bytes);
		position += count;
	}
	if (hash.digest("hex") !== record.digest) throw new Error("Journal record changed since indexing");
	if (validatePath && existsSync(source.path)) {
		const current = statSync(source.path);
		if (current.dev !== source.dev || current.ino !== source.ino || current.size < source.size)
			throw new Error("Journal source generation changed");
	}
}

/** Revalidate selected bodies and their LF framing without reparsing or one read/stat per entry. */
export function verifyJournalRecords(source: JournalSource, records: readonly JournalRecord[]): void {
	if (!records.length) return;
	if (source.handle.closed) throw new Error("Journal source descriptor is closed");
	const validate = () => {
		const stats = existsSync(source.path) ? statSync(source.path) : fstatSync(source.handle.fd);
		if (stats.dev !== source.dev || stats.ino !== source.ino || stats.size < source.size)
			throw new Error("Journal source generation changed");
	};
	validate();
	const stats = fstatSync(source.handle.fd);
	if (stats.dev !== source.dev || stats.ino !== source.ino || stats.size < source.size)
		throw new Error("Journal source generation changed");
	const ordered = records.slice().sort((a, b) => a.start - b.start);
	const end = Math.min(source.size, ordered.at(-1)!.end + 1);
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let bufferStart = -1;
	let bufferEnd = -1;
	for (const record of ordered) {
		const hash = createHash("sha256");
		const framedEnd = Math.min(source.size, record.end + 1);
		let position = record.start;
		while (position < framedEnd) {
			if (position < bufferStart || position >= bufferEnd) {
				const count = readSync(source.handle.fd, buffer, 0, Math.min(buffer.length, end - position), position);
				if (!count) throw new Error("Journal record truncated");
				bufferStart = position;
				bufferEnd = position + count;
			}
			const next = Math.min(framedEnd, bufferEnd);
			hash.update(buffer.subarray(position - bufferStart, Math.min(record.end, next) - bufferStart));
			if (next > record.end && buffer[record.end - bufferStart] !== 10)
				throw new Error("Journal record framing changed since indexing");
			position = next;
		}
		if (hash.digest("hex") !== record.digest) throw new Error("Journal record changed since indexing");
	}
	validate();
}

/** ponytail: requesting one full value still needs its consumer's heap; use selective metadata or paging for giant bodies. */
export function readJournalRecord(
	source: JournalSource,
	record: JournalRecord,
	selection?: JsonSelection | JsonProjectionOptions,
): Record<string, unknown> {
	const projection = new JsonTokenProjection(typeof selection === "function" ? { select: selection } : selection);
	const decoder = new TextDecoder("utf-8", { ignoreBOM: !(source.allowLeadingBom && record.start === 0) });
	visitJournalRecord(source, record, (bytes) => projection.write(decoder.decode(bytes, { stream: true })));
	projection.write(decoder.decode());
	return projection.finish() as Record<string, unknown>;
}

/** Copy source bytes to a private stage. The caller publishes only after complete validation. */
export function copyJournalRecord(source: JournalSource, record: JournalRecord, fd: number): JournalWrite {
	visitJournalRecord(source, record, (bytes) => writeFileSync(fd, bytes), false);
	writeFileSync(fd, "\n");
	return { bytes: record.end - record.start + 1, digest: record.digest };
}

export interface JournalWrite {
	/** Includes the terminating LF; the digest excludes it, like JournalRecord. */
	bytes: number;
	digest: string;
}

export type JsonByteSink = (bytes: string | Uint8Array) => void;
export type JournalReplacement = { value: unknown } | { write: (sink: JsonByteSink) => void };
export interface JournalRewrite {
	overrides?: Readonly<Record<string, JournalReplacement>>;
	omit?: (path: JsonPath) => boolean;
	replace?: (path: JsonPath) => JournalReplacement | undefined;
}

function tokenWriter(
	sink: JsonByteSink,
	rewrite: JournalRewrite,
	root: JsonPath = [],
): (token: Token, path: JsonPath) => void {
	const frames: { array: boolean; first: boolean }[] = [];
	const seen = new Set<string>();
	let keyChunks: string[] = [];
	let keySize = 0;
	let keyPublished = false;
	let readingKey = false;
	let omitValue = false;
	let skipEnd: Token["name"] | undefined;
	let skipDepth = 0;
	const publishKey = () => {
		const frame = frames.at(-1)!;
		if (!frame.first) sink(",");
		frame.first = false;
		sink('"');
		for (const part of keyChunks) sink(part);
		keyChunks = [];
		keyPublished = true;
	};
	const replacement = (value: JournalReplacement) => {
		if ("write" in value) value.write(sink);
		else {
			const json = JSON.stringify(value.value);
			if (json === undefined) throw new TypeError("Cannot copy an undefined JSON value");
			sink(json);
		}
	};
	return (token, path) => {
		if (skipEnd) {
			if (token.name === "startObject" || token.name === "startArray") skipDepth++;
			if (token.name === "endObject" || token.name === "endArray") skipDepth--;
			if (token.name === skipEnd && skipDepth === 0) skipEnd = undefined;
			return;
		}
		const starts = [
			"startObject",
			"startArray",
			"startString",
			"startNumber",
			"nullValue",
			"trueValue",
			"falseValue",
		].includes(token.name);
		if (starts) {
			const key = String(path.at(-1));
			const changed =
				path.length === root.length + 1 && rewrite.overrides && Object.hasOwn(rewrite.overrides, key)
					? rewrite.overrides[key]
					: rewrite.replace?.(path);
			if (!omitValue && frames.at(-1)?.array) {
				if (!frames.at(-1)!.first) sink(",");
				frames.at(-1)!.first = false;
			}
			if (omitValue || changed) {
				if (changed && !omitValue) replacement(changed);
				omitValue = false;
				if (token.name.startsWith("start")) {
					skipEnd = token.name.replace("start", "end") as Token["name"];
					skipDepth = token.name === "startObject" || token.name === "startArray" ? 1 : 0;
				}
				return;
			}
		}
		switch (token.name) {
			case "startObject":
				sink("{");
				frames.push({ array: false, first: true });
				break;
			case "startArray":
				sink("[");
				frames.push({ array: true, first: true });
				break;
			case "endObject":
				if (path.length === root.length)
					for (const [key, value] of Object.entries(rewrite.overrides ?? {})) {
						if (seen.has(key)) continue;
						if (!frames.at(-1)!.first) sink(",");
						frames.at(-1)!.first = false;
						sink(`${JSON.stringify(key)}:`);
						replacement(value);
					}
				sink("}");
				frames.pop();
				break;
			case "endArray":
				sink("]");
				frames.pop();
				break;
			case "startKey":
				keyChunks = [];
				keySize = 0;
				keyPublished = false;
				readingKey = true;
				break;
			case "endKey":
				if (path.length === root.length + 1) seen.add(String(path.at(-1)));
				omitValue = !keyPublished && (rewrite.omit?.(path) ?? false);
				if (!omitValue) {
					if (!keyPublished) publishKey();
					sink('":');
				}
				keyChunks = [];
				readingKey = false;
				break;
			case "startString":
				sink('"');
				break;
			case "endString":
				sink('"');
				break;
			case "stringChunk": {
				const encoded = JSON.stringify(token.value).slice(1, -1);
				if (readingKey) {
					keySize += encoded.length;
					if (!keyPublished) keyChunks.push(encoded);
					else sink(encoded);
					// Omitted native field names are short; unknown giant keys stream unchanged.
					if (keySize > 4096 && !keyPublished) publishKey();
				} else sink(encoded);
				break;
			}
			case "numberChunk":
				sink(token.value);
				break;
			case "nullValue":
				sink("null");
				break;
			case "trueValue":
				sink("true");
				break;
			case "falseValue":
				sink("false");
				break;
		}
	};
}

/** Transform known native fields while token-copying all unrelated values. */
export function transformJournalRecord(
	source: JournalSource,
	record: JournalRecord,
	fd: number,
	rewrite: JournalRewrite = {},
): JournalWrite {
	let parts: string[] = [];
	let size = 0;
	let bytesWritten = 0;
	const hash = createHash("sha256");
	const flush = () => {
		if (parts.length) writeFileSync(fd, parts.join(""));
		parts = [];
		size = 0;
	};
	const sink: JsonByteSink = (bytes) => {
		hash.update(bytes);
		bytesWritten += typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
		if (typeof bytes !== "string") {
			flush();
			writeFileSync(fd, bytes);
			return;
		}
		parts.push(bytes);
		size += bytes.length;
		if (size >= 64 * 1024) flush();
	};
	const projection = new JsonTokenProjection({ select: () => "skip", onToken: tokenWriter(sink, rewrite) });
	const decoder = new TextDecoder("utf-8", { ignoreBOM: !(source.allowLeadingBom && record.start === 0) });
	visitJournalRecord(source, record, (bytes) => projection.write(decoder.decode(bytes, { stream: true })), false);
	projection.write(decoder.decode());
	projection.finish();
	flush();
	writeFileSync(fd, "\n");
	return { bytes: bytesWritten + 1, digest: hash.digest("hex") };
}

export function rewriteJournalRecord(
	source: JournalSource,
	record: JournalRecord,
	fd: number,
	overrides: Record<string, string | number | boolean | null>,
): JournalWrite {
	return transformJournalRecord(source, record, fd, {
		overrides: Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value }])),
	});
}

/** Copy the last selected field, including duplicate-parent resets, through a private bounded spool. */
export function writeJournalValue(
	source: JournalSource,
	record: JournalRecord,
	path: JsonPath,
	sink: JsonByteSink,
	rewrite: JournalRewrite = {},
): void {
	const directory = mkdtempSync(join(tmpdir(), "pi-journal-value-"));
	const fd = openSync(join(directory, "value.json"), "wx+", 0o600);
	try {
		let position = 0;
		let active = false;
		let found = false;
		const write: JsonByteSink = (bytes) => {
			const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
			let offset = 0;
			while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, position + offset);
			position += data.length;
		};
		let writer = tokenWriter(write, rewrite, path);
		const projection = new JsonTokenProjection({
			select: () => "skip",
			onToken: (token, at) => {
				const prefix = at.length <= path.length && at.every((part, index) => part === path[index]);
				const starts = [
					"startObject",
					"startArray",
					"startString",
					"startNumber",
					"nullValue",
					"trueValue",
					"falseValue",
				].includes(token.name);
				if (prefix && starts) {
					position = 0;
					ftruncateSync(fd, 0);
					active = at.length === path.length;
					found = false;
					writer = tokenWriter(write, rewrite, path);
				}
				if (active) {
					writer(token, at);
					if (
						at.length === path.length &&
						(token.name.startsWith("end") || ["nullValue", "trueValue", "falseValue"].includes(token.name))
					) {
						active = false;
						found = true;
					}
				}
			},
		});
		const decoder = new TextDecoder("utf-8", { ignoreBOM: !(source.allowLeadingBom && record.start === 0) });
		visitJournalRecord(source, record, (bytes) => projection.write(decoder.decode(bytes, { stream: true })), false);
		projection.write(decoder.decode());
		projection.finish();
		if (!found) throw new Error(`Missing selected journal value: ${path.join(".")}`);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (let offset = 0; offset < position; ) {
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, position - offset), offset);
			if (!count) throw new Error("Selected journal value truncated");
			sink(buffer.subarray(0, count));
			offset += count;
		}
	} finally {
		closeSync(fd);
		rmSync(directory, { recursive: true, force: true });
	}
}
