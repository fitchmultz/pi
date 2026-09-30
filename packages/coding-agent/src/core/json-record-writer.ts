import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRawStdout, writeRawStdoutChunks } from "./output-guard.ts";

/** Only native envelope fields and aggregate arrays are split; arbitrary payloads remain native leaves. */
export interface JsonRecordLayout {
	readonly fields?: Readonly<Record<string, JsonRecordLayout>>;
	readonly items?: JsonRecordLayout;
}

function hasAggregate(value: unknown, layout: JsonRecordLayout): boolean {
	if (layout.items !== undefined) return true;
	if (value === null || typeof value !== "object") return false;
	for (const [key, field] of Object.entries(layout.fields ?? {})) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		// Do not invoke payload getters or hooks merely to choose a serialization path.
		if (descriptor && (!("value" in descriptor) || hasAggregate(descriptor.value, field))) return true;
	}
	return false;
}

type ValueFrame = {
	kind: "value";
	value: unknown;
	key: string;
	layout?: JsonRecordLayout;
	arrayMember: boolean;
	prefix: () => void;
};
type ObjectFrame = {
	kind: "object";
	value: Record<string, unknown>;
	keys: string[];
	index: number;
	first: boolean;
	layout: JsonRecordLayout;
};
type ArrayFrame = {
	kind: "array";
	value: object;
	array?: unknown[];
	length: number;
	iterator?: Iterator<unknown>;
	index: number;
	layout: JsonRecordLayout;
};

/**
 * Write a native JSON value without constructing aggregate strings.
 * `items` also accepts an explicitly supplied iterable for file entry traversal.
 * The sink must be private until this function succeeds: a late leaf can throw.
 */
export function writeJsonValue(
	value: unknown,
	write: (chunk: string) => void,
	layout?: JsonRecordLayout,
	key = "",
): void {
	const ancestors = new Set<object>();
	const stack: Array<ValueFrame | ObjectFrame | ArrayFrame> = [
		{ kind: "value", value, key, layout, arrayMember: false, prefix: () => {} },
	];
	const checkAncestor = (_key: string, member: unknown): unknown => {
		if (member !== null && typeof member === "object" && ancestors.has(member)) {
			throw new TypeError("Converting circular structure to JSON");
		}
		return member;
	};
	while (stack.length) {
		const frame = stack.pop()!;
		if (frame.kind === "object") {
			if (frame.index === frame.keys.length) {
				write("}");
				ancestors.delete(frame.value);
				continue;
			}
			const key = frame.keys[frame.index++];
			stack.push(frame, {
				kind: "value",
				value: frame.value[key],
				key,
				layout: Object.hasOwn(frame.layout.fields ?? {}, key) ? frame.layout.fields?.[key] : undefined,
				arrayMember: false,
				prefix: () => {
					if (!frame.first) write(",");
					frame.first = false;
					write(`${JSON.stringify(key)}:`);
				},
			});
			continue;
		}
		if (frame.kind === "array") {
			const next = frame.array
				? frame.index >= frame.length
					? { done: true, value: undefined }
					: { done: false, value: frame.array[frame.index] }
				: frame.iterator!.next();
			if (next.done) {
				write("]");
				ancestors.delete(frame.value);
				continue;
			}
			const index = frame.index++;
			stack.push(frame, {
				kind: "value",
				value: next.value,
				key: String(index),
				layout: frame.layout.items,
				arrayMember: true,
				prefix: () => {
					if (index) write(",");
				},
			});
			continue;
		}

		const member = frame.value;
		const split =
			member !== null &&
			typeof member === "object" &&
			((frame.layout?.items !== undefined && (Array.isArray(member) || Symbol.iterator in member)) ||
				(frame.layout?.fields !== undefined &&
					!Array.isArray(member) &&
					(Object.getPrototypeOf(member) === Object.prototype || Object.getPrototypeOf(member) === null)));
		let nativeValue = member;
		let splitContainer = split;
		if (split) {
			const toJSON: unknown = Reflect.get(member, "toJSON");
			if (typeof toJSON === "function") {
				const transformed: unknown = Reflect.apply(toJSON, member, [frame.key]);
				nativeValue = { toJSON: () => transformed };
				splitContainer = false;
			}
		}
		if (!splitContainer) {
			// ponytail: a single leaf/custom-toJSON aggregate retains V8's string/heap ceiling.
			// Split a demonstrated native aggregate with an explicit layout rather than a general serializer.
			const keyJSON = JSON.stringify(frame.key);
			// Return the holder from a hook so a callable member named "toJSON" is not a holder hook.
			const holder = { [frame.key]: nativeValue };
			const wrapped = JSON.stringify({ toJSON: () => holder }, checkAncestor);
			const encoded = wrapped === "{}" ? undefined : wrapped.slice(keyJSON.length + 2, -1);
			if (encoded === undefined && !frame.arrayMember) continue;
			frame.prefix();
			write(encoded ?? "null");
			continue;
		}
		const container = member as object;
		if (ancestors.has(container)) throw new TypeError("Converting circular structure to JSON");
		ancestors.add(container);
		frame.prefix();
		if (frame.layout?.items !== undefined) {
			write("[");
			stack.push({
				kind: "array",
				value: container,
				array: Array.isArray(member) ? member : undefined,
				length: Array.isArray(member) ? member.length : 0,
				iterator: Array.isArray(member) ? undefined : (member as Iterable<unknown>)[Symbol.iterator](),
				index: 0,
				layout: frame.layout,
			});
		} else {
			write("{");
			stack.push({
				kind: "object",
				value: member as Record<string, unknown>,
				keys: Object.keys(member as object),
				index: 0,
				first: true,
				layout: frame.layout!,
			});
		}
	}
}

/** Serialize synchronously so later event listeners cannot mutate the wire snapshot. */
export function writeJsonRecordToStdout(value: object, layout: JsonRecordLayout, prefix = ""): void {
	if (!hasAggregate(value, layout)) {
		writeRawStdout(`${prefix}${JSON.stringify(value)}\n`);
		return;
	}
	const directory = mkdtempSync(join(tmpdir(), "pi-json-record-"));
	const path = join(directory, "record");
	let fd: number | undefined;
	try {
		fd = openSync(path, "wx", 0o600);
		if (prefix) writeFileSync(fd, prefix);
		writeJsonValue(
			value,
			(text) => {
				for (let start = 0; start < text.length; ) {
					let end = Math.min(start + 65536, text.length);
					// Do not split a surrogate pair when encoding native strings.
					const last = text.charCodeAt(end - 1);
					if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
					writeFileSync(fd!, text.slice(start, end));
					start = end;
				}
			},
			layout,
		);
		writeFileSync(fd, "\n");
		closeSync(fd);
		fd = undefined;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	async function* chunks(): AsyncIterable<Uint8Array> {
		yield* createReadStream(path, { highWaterMark: 65536 });
	}
	writeRawStdoutChunks(chunks(), () => rmSync(directory, { recursive: true, force: true }));
}
