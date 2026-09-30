import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { JsonRecordLayout } from "../../core/json-record-writer.ts";
import { JsonlRecordDecoder } from "../../core/session-journal.ts";
import { jsonEventLayout } from "../json-event.ts";

const treeNodeLayout: JsonRecordLayout = { fields: {} };
const treeLayout: JsonRecordLayout = { items: treeNodeLayout };
Object.assign(treeNodeLayout.fields!, { children: treeLayout });
const rpcDataLayout: JsonRecordLayout = {
	fields: {
		entries: { items: {} },
		tree: treeLayout,
		messages: { items: {} },
		commands: { items: {} },
		models: { items: {} },
		steering: { items: {} },
		followUp: { items: {} },
		pendingExtensionUIRequests: { items: {} },
	},
};
export const rpcOutputLayout: JsonRecordLayout = {
	fields: {
		...jsonEventLayout.fields,
		data: rpcDataLayout,
		state: rpcDataLayout,
		options: { items: {} },
		widgetLines: { items: {} },
	},
};

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/** Receive full objects token-by-token; no whole-line string or JSON.parse allocation. */
export function attachJsonlRecordReader(
	stream: Readable,
	onRecord: (record: Record<string, unknown>) => void,
	onError: (error: Error) => void,
): () => void {
	// ponytail: full RPC/event consumers still need heap for their requested objects and individual strings.
	// Use selective projection/paging at the consumer if that becomes a demonstrated limit.
	const decoder = new JsonlRecordDecoder({
		policy: "tolerant",
		fatalUtf8: true,
		onRecord: (record) => onRecord(record.value),
		onError,
	});
	const onData = (chunk: string | Buffer) => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		for (let offset = 0; offset < bytes.length; offset += 65536) {
			decoder.feed(bytes.subarray(offset, offset + 65536));
		}
	};
	const onEnd = () => {
		decoder.finish();
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
