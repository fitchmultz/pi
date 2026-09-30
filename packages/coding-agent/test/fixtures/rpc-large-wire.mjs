import { writeJsonRecordToStdout } from "../../src/core/json-record-writer.ts";
import { flushRawStdout } from "../../src/core/output-guard.ts";
import { attachJsonlLineReader, rpcOutputLayout } from "../../src/modes/rpc/jsonl.ts";

const text = "x".repeat(1024 * 1024);
const message = { role: "user", content: text, timestamp: 1 };
let maximumChunk = 0;
let bytes = 0;
const rawWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, callback) => {
	maximumChunk = Math.max(maximumChunk, Buffer.byteLength(chunk));
	bytes += Buffer.byteLength(chunk);
	return rawWrite(chunk, callback);
};

attachJsonlLineReader(process.stdin, (line) => {
	const command = JSON.parse(line);
	const event = {
		type: "agent_end",
		messages: Array(Number(process.env.PI_WIRE_MESSAGE_COUNT ?? 520)).fill(message),
		willRetry: false,
	};
	if (process.env.PI_WIRE_NATIVE_STRINGIFY === "1") {
		// Regression receipt for the pre-fix owner boundary.
		process.stdout.write(`${JSON.stringify(event)}\n`);
		return;
	}
	writeJsonRecordToStdout(event, rpcOutputLayout);
	event.messages.length = 0;
	writeJsonRecordToStdout({ type: "agent_settled" }, rpcOutputLayout);
	writeJsonRecordToStdout(
		{ id: command.id, type: "response", command: command.type, success: true },
		rpcOutputLayout,
	);
	if (process.env.PI_WIRE_EXIT_BEFORE_DRAIN === "1") process.exit(143);
	void flushRawStdout().then(() => {
		process.stderr.write(`WIRE_RECEIPT ${JSON.stringify({ bytes, maximumChunk, heap: process.memoryUsage().heapUsed })}\n`);
	});
});
