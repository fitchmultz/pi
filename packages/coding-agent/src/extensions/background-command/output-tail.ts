import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { truncateTail } from "../../core/tools/truncate.ts";
import { MAX_PENDING_ANSI_LENGTH, splitIncompleteAnsiSuffix, stripAnsi } from "../../utils/ansi.ts";
import { type BackgroundCommandJob, backgroundCommandFinished } from "./jobs.ts";

export function backgroundCommandOutputTail(
	job: BackgroundCommandJob,
	{ maxLines = 100, maxBytes = 16_384 } = {},
): string {
	if (job.status === "unknown" && !existsSync(job.logFile)) return "";
	let fd: number | undefined;
	try {
		fd = openSync(job.logFile, "r");
		const size = fstatSync(fd).size;
		if (size === 0 || maxBytes <= 0 || maxLines <= 0) return "";
		const window = Math.min(size, maxBytes);
		const offset = size - window;
		const lookbehind = Math.min(offset, MAX_PENDING_ANSI_LENGTH);
		const bytes = Buffer.alloc(window + lookbehind);
		const count = readSync(fd, bytes, 0, bytes.length, offset - lookbehind);
		let cursor = Math.min(lookbehind, count);
		let beforePending = cursor;
		if (offset > 0) {
			let scan = 0;
			while (scan < cursor && (bytes[scan] & 0xc0) === 0x80) scan++;
			const pending = splitIncompleteAnsiSuffix(bytes.subarray(scan, cursor).toString("utf8")).pending;
			if (pending.length > 0) {
				const pendingBytes = Buffer.byteLength(pending, "utf8");
				if (pendingBytes <= cursor) {
					let leadStart = cursor;
					while (leadStart < count && (bytes[leadStart] & 0xc0) === 0x80) leadStart++;
					const lead = bytes
						.subarray(leadStart, Math.min(count, leadStart + MAX_PENDING_ANSI_LENGTH))
						.toString("utf8");
					if (!stripAnsi(pending + lead).startsWith("\u001b")) {
						cursor -= pendingBytes;
						beforePending = cursor;
					} else {
						beforePending = cursor - pendingBytes;
					}
				}
			}
			while (cursor < count && (bytes[cursor] & 0xc0) === 0x80) cursor++;
		}
		let stripped = stripAnsi(
			new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(cursor, count), {
				stream: !backgroundCommandFinished(job),
			}),
		);
		const prefixStart = offset - lookbehind;
		const lastNewline = bytes.subarray(0, beforePending).lastIndexOf(0x0a);
		const hasVisibleLinePrefix =
			cursor > 0 &&
			(lastNewline !== -1
				? stripAnsi(bytes.subarray(lastNewline + 1, beforePending).toString("utf8")).length > 0
				: prefixStart > 0 || stripAnsi(bytes.subarray(0, beforePending).toString("utf8")).length > 0);
		if (hasVisibleLinePrefix) {
			const newline = stripped.indexOf("\n");
			if (newline !== -1 && newline + 1 < stripped.length) {
				const after = stripped.slice(newline + 1);
				const firstLineBytes = Buffer.byteLength(stripped.slice(0, newline + 1), "utf8");
				const afterBytes = Buffer.byteLength(after, "utf8");
				if (afterBytes >= maxBytes || (after.trimEnd().includes("\n") && afterBytes >= firstLineBytes)) {
					stripped = after;
				}
			}
		}
		return truncateTail(stripped, { maxLines, maxBytes }).content;
	} catch (error) {
		return truncateTail(
			stripAnsi(`Output unavailable: ${String(error).slice(0, 512)}. Inspect logFile for this job.`),
			{ maxLines, maxBytes },
		).content;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
