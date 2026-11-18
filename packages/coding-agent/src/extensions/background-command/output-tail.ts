import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
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
		if (offset > 0) {
			let scan = 0;
			while (scan < cursor && (bytes[scan] & 0xc0) === 0x80) scan++;
			const pending = splitIncompleteAnsiSuffix(bytes.subarray(scan, cursor).toString("utf8")).pending;
			if (pending.length > 0) {
				const pendingBytes = Buffer.byteLength(pending, "utf8");
				if (pendingBytes <= cursor) {
					let leadStart = cursor;
					while (leadStart < count && (bytes[leadStart] & 0xc0) === 0x80) leadStart++;
					const lead = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
						bytes.subarray(leadStart, Math.min(count, leadStart + MAX_PENDING_ANSI_LENGTH)),
						{ stream: true },
					);
					const candidate = pending + lead;
					const strippedLead = stripVTControlCharacters(candidate);
					// Pull pending bytes only when the window actually completes a VT sequence at byte 0.
					const completesIntroducer =
						(pending !== "\u001b" || /^[[(\])#;?]/.test(lead)) &&
						(!pending.startsWith("\u001b]") || /(?:\u0007|\u001b\\|\u009c)/.test(lead));
					if (
						completesIntroducer &&
						!strippedLead.startsWith("\u001b") &&
						!stripAnsi(candidate).startsWith("\u001b") &&
						stripAnsi(candidate) !== candidate
					) {
						cursor -= pendingBytes;
					}
				}
			}
			while (cursor < count && (bytes[cursor] & 0xc0) === 0x80) cursor++;
		}
		let stripped = stripVTControlCharacters(
			new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(cursor, count), {
				stream: !backgroundCommandFinished(job),
			}),
		);
		if (cursor > 0 && bytes[cursor - 1] !== 0x0a) {
			const newline = stripped.indexOf("\n");
			if (newline !== -1 && newline + 1 < stripped.length) {
				const after = stripped.slice(newline + 1);
				if (
					Buffer.byteLength(after, "utf8") >= maxBytes ||
					(after.trimEnd().includes("\n") && newline < maxBytes / 2)
				) {
					stripped = after;
				}
			}
		}
		return truncateTail(stripped, { maxLines, maxBytes }).content;
	} catch (error) {
		return truncateTail(
			stripVTControlCharacters(`Output unavailable: ${String(error).slice(0, 512)}. Inspect logFile for this job.`),
			{ maxLines, maxBytes },
		).content;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
