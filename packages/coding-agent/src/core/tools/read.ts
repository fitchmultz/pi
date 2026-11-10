import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { TextDecoder } from "util";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { extractReadJson, type ReadJsonOptions, readJsonSchema } from "./read-json.ts";
import { readRenderers } from "./renderers/read.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	json: Type.Optional(readJsonSchema),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: [
		"Use read to examine files instead of cat or sed.",
		"Reuse docs already in context; reread only after they change or leave context, paging unread sections instead of the visible prefix.",
	],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * How many remaining pages a continuation notice names. Measured on 30 days of session journals: notices
 * that left up to 5 pages preceded 95% of the page-by-page follow-up reads and were continued 22-30% of
 * the time; notices that left more were continued 7% of the time.
 */
const MAX_NAMED_PAGES = 5;

/**
 * Lines shown from the end of the file when the offset is past the end and the call gave no limit. Measured
 * on 30 days of session journals: after this case, retries without a limit asked for the last 62 lines at
 * most, and 100 was the median limit of the calls that gave one.
 */
const PAST_END_LINES = 100;

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/**
	 * Stream file contents in chunks. When present, text files are read through it and only the lines
	 * that will be shown are kept in memory; otherwise readFile loads the whole file. Stop reading when
	 * the signal aborts; the read tool also stops consuming the stream then.
	 */
	createReadStream?: (absolutePath: string, options: { signal?: AbortSignal }) => AsyncIterable<Uint8Array>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	createReadStream: readLocalFileChunks,
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

/**
 * Stream a local file the way fs.readFile reads it: a regular file up to its size when opened, so text
 * appended during the read is not counted and a growing file still ends; a file reporting size 0 (such
 * as /proc files) and other file types until EOF.
 */
async function* readLocalFileChunks(path: string, { signal }: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
	const handle = await fsOpen(path, "r");
	try {
		const stats = await handle.stat();
		// A stream created with an already-aborted signal emits its AbortError as an unhandled "error" event.
		signal?.throwIfAborted();
		const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
		yield* handle.createReadStream({ end, signal, autoClose: false });
	} finally {
		await handle.close();
	}
}

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

/** The lines a read shows, with the file's line count; line counts follow `text.split("\n")`. */
interface SelectedLines {
	totalFileLines: number;
	truncation: TruncationResult;
	/** Bytes of the first selected line, for the notice when it alone exceeds the byte limit. */
	firstLineBytes: number;
	/** UTF-8 size of a 0-indexed line from the first selected line on, or undefined when it was not measured. */
	lineBytes: (line: number) => number | undefined;
}

/**
 * Whether a range can be streamed and its remaining pages named. Other values (fractional, negative limit)
 * keep the whole-file path, whose array slicing defines what they select, for example limit -1 as all
 * lines but the last.
 */
function isStreamableRange(offset: number | undefined, limit: number | undefined): boolean {
	return (
		(offset === undefined || Number.isInteger(offset)) &&
		(limit === undefined || (Number.isInteger(limit) && limit >= 0))
	);
}

/**
 * The 1-indexed offsets of the reads without limit that return every line from `start` (0-indexed) to the
 * end of the file, or undefined when that takes more than MAX_NAMED_PAGES reads, a line was not measured,
 * or a line exceeds the byte limit, so no read returns it. A page ends where truncateHead ends it.
 */
function remainingPageOffsets(
	lineBytes: SelectedLines["lineBytes"],
	start: number,
	totalFileLines: number,
): number[] | undefined {
	const offsets = [start + 1];
	let pageLines = 0;
	let pageBytes = 0;
	for (let line = start; line < totalFileLines; line++) {
		const size = lineBytes(line);
		if (size === undefined || size > DEFAULT_MAX_BYTES) return undefined;
		const joinedBytes = pageBytes + size + (pageLines > 0 ? 1 : 0);
		if (pageLines < DEFAULT_MAX_LINES && joinedBytes <= DEFAULT_MAX_BYTES) {
			pageLines++;
			pageBytes = joinedBytes;
			continue;
		}
		// truncateHead does not count an empty last line: it stays on a page that has room for its newline.
		if (line === totalFileLines - 1 && size === 0 && pageBytes < DEFAULT_MAX_BYTES) break;
		if (offsets.length === MAX_NAMED_PAGES) return undefined;
		offsets.push(line + 1);
		pageLines = 1;
		pageBytes = size;
	}
	return offsets;
}

/** The instruction naming the reads that return every remaining line: "call read at offsets 5 and 9 in one response". */
function readCallsAt(offsets: number[], qualifiers: string[]): string {
	const list =
		offsets.length === 1
			? `offset ${offsets[0]}`
			: `offsets ${offsets.slice(0, -1).join(", ")} and ${offsets[offsets.length - 1]}`;
	const conditions = qualifiers.length > 0 ? ` with ${qualifiers.join(" and ")}` : "";
	return `call read at ${list}${conditions}${offsets.length > 1 ? " in one response" : ""}`;
}

/** Select lines by streaming when the operations and the range allow it, else from the whole file. */
async function selectLines(
	ops: ReadOperations,
	absolutePath: string,
	startLine: number,
	limit: number | undefined,
	json: ReadJsonOptions | undefined,
	streamableRange: boolean,
	signal: AbortSignal | undefined,
): Promise<SelectedLines> {
	// A JSON selection parses the whole document, so it is never streamed.
	return json === undefined && ops.createReadStream && streamableRange
		? selectLinesFromStream(ops.createReadStream(absolutePath, { signal }), startLine, limit, signal)
		: selectLinesFromBuffer(await ops.readFile(absolutePath), startLine, limit, json);
}

/**
 * Select lines from a whole file in memory: for JSON selections, operations without createReadStream and
 * unusual ranges. A JSON selection is pretty-printed first, so lines and limits apply to that text.
 */
function selectLinesFromBuffer(
	buffer: Buffer,
	startLine: number,
	limit: number | undefined,
	json: ReadJsonOptions | undefined,
): SelectedLines {
	const text = buffer.toString("utf-8");
	const allLines = (json === undefined ? text : extractReadJson(text, json)).split("\n");
	const endLine = limit === undefined ? undefined : Math.min(startLine + limit, allLines.length);
	const truncation = truncateHead(allLines.slice(startLine, endLine).join("\n"));
	const firstLineBytes = truncation.firstLineExceedsLimit ? Buffer.byteLength(allLines[startLine], "utf-8") : 0;
	return {
		totalFileLines: allLines.length,
		truncation,
		firstLineBytes,
		lineBytes: (line) => Buffer.byteLength(allLines[line], "utf-8"),
	};
}

// Lines and bytes measured past the first selected line: the shown page and the pages a notice can name.
const MEASURED_LINES = (MAX_NAMED_PAGES + 1) * DEFAULT_MAX_LINES;
const MEASURED_BYTES = (MAX_NAMED_PAGES + 1) * DEFAULT_MAX_BYTES;

/**
 * Select lines from a file read in chunks. Only lines truncateHead can show are stored; of the rest, the
 * sizes of the lines that the pages named in a notice can hold are kept and the others are counted, so
 * memory does not grow with the file. Stops reading when the signal aborts.
 */
async function selectLinesFromStream(
	chunks: AsyncIterable<Uint8Array>,
	startLine: number,
	limit: number | undefined,
	signal: AbortSignal | undefined,
): Promise<SelectedLines> {
	const endLine = limit === undefined ? Number.POSITIVE_INFINITY : startLine + limit;
	// Non-fatal UTF-8 that keeps a byte order mark decodes like Buffer.toString("utf-8").
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	const storedLines: string[] = [];
	let storedBytes = 0;
	let storedPastCaps = false;
	let line = 0;
	let selectedLines = 0;
	let selectedBytes = 0;
	let firstLineBytes = 0;
	let lastLineEmpty = true;
	// Sizes of the lines from startLine on, until MEASURED_LINES lines or MEASURED_BYTES bytes are measured.
	const lineSizes: number[] = [];
	let measuredBytes = 0;
	// The selected line being read: its text, while it is stored, and its size.
	let pieces: string[] | undefined = [];
	let lineBytes = 0;
	let lineHasText = false;

	const measuring = () => lineSizes.length < MEASURED_LINES && measuredBytes <= MEASURED_BYTES;
	const appendToLine = (text: string, start: number, end: number) => {
		lineHasText = true;
		const storing = line < endLine ? pieces : undefined;
		// A line that is not stored is measured only as far as telling that it exceeds the byte cap.
		if (!storing && (!measuring() || lineBytes > DEFAULT_MAX_BYTES)) return;
		const piece = text.slice(start, end);
		// A line over the byte cap is never shown, and a first line over it is only measured: never store
		// all of a 1 GB line.
		if (storing && lineBytes <= DEFAULT_MAX_BYTES) storing.push(piece);
		lineBytes += Buffer.byteLength(piece, "utf-8");
	};
	const finishLine = () => {
		if (measuring()) {
			lineSizes.push(lineBytes);
			measuredBytes += lineBytes;
		}
		if (line < endLine) {
			if (pieces) {
				if (selectedLines === 0) firstLineBytes = lineBytes;
				// Storing continues one line past the caps: truncateHead ignores a trailing empty line, so the
				// line after the cap must be there for it to decide truncation as for the full text.
				if (storedLines.length > DEFAULT_MAX_LINES || storedBytes > DEFAULT_MAX_BYTES) storedPastCaps = true;
				const text = pieces.join("");
				storedBytes += Buffer.byteLength(text, "utf-8") + (storedLines.length > 0 ? 1 : 0);
				storedLines.push(text);
			}
			selectedLines++;
			lastLineEmpty = !lineHasText;
			pieces = storedPastCaps ? undefined : [];
		}
		lineBytes = 0;
		lineHasText = false;
	};
	const select = (text: string) => {
		let position = 0;
		// Start of the selected text in this piece, measured as a whole: the joined lines' size.
		let selectionStart = -1;
		while (true) {
			const selected = line >= startLine && line < endLine;
			const tracked = selected || (line >= endLine && measuring());
			if (selected && selectionStart === -1) selectionStart = position;
			const newline = text.indexOf("\n", position);
			const end = newline === -1 ? text.length : newline;
			if (tracked && end > position) appendToLine(text, position, end);
			if (newline === -1) break;
			if (tracked) finishLine();
			if (selected && line + 1 === endLine) {
				selectedBytes += Buffer.byteLength(text.slice(selectionStart, newline), "utf-8");
				selectionStart = -1;
			}
			line++;
			position = newline + 1;
		}
		if (selectionStart !== -1) selectedBytes += Buffer.byteLength(text.slice(selectionStart), "utf-8");
	};

	for await (const chunk of chunks) {
		// Leaving the loop closes the stream.
		if (signal?.aborted) throw new Error("Operation aborted");
		select(decoder.decode(chunk, { stream: true }));
	}
	select(decoder.decode());
	if (line >= startLine && (line < endLine || measuring())) finishLine();
	const truncation: TruncationResult = {
		...truncateHead(storedLines.join("\n")),
		// truncateHead's counts for the joined selected lines, which drop a trailing empty line.
		totalLines: selectedBytes === 0 ? 0 : selectedLines - (lastLineEmpty ? 1 : 0),
		totalBytes: selectedBytes,
	};
	return { totalFileLines: line + 1, truncation, firstLineBytes, lineBytes: (index) => lineSizes[index - startLine] };
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. Use json.path/json.fields to select a JSON subtree or object fields before truncation; offset/limit then page the formatted selection.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit, json }: ReadToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								if (json !== undefined) {
									throw new Error("JSON selection is not supported for images. Omit json to read this image.");
								}
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, {
									autoResizeImages,
									resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
								});
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content. Convert offset from 1-indexed input to 0-indexed line access.
								const source = json === undefined ? "file" : "JSON selection";
								const continuation = json === undefined ? "" : ` with the same json=${JSON.stringify(json)}`;
								const usualRange = isStreamableRange(offset, limit);
								let startLine = offset ? Math.max(0, offset - 1) : 0;
								let lineLimit = limit;
								let selection = await selectLines(
									ops,
									absolutePath,
									startLine,
									limit,
									json,
									usualRange,
									signal,
								);
								if (aborted) return;
								let pastEndNote = "";
								if (startLine >= selection.totalFileLines) {
									// An offset past the end is answered with the end of the file: the last `limit` lines,
									// which covered 285 of 293 measured retries. An error would also end a codemode script
									// and lose its other calls.
									startLine = Math.max(
										0,
										selection.totalFileLines - (usualRange && limit ? limit : PAST_END_LINES),
									);
									lineLimit = undefined;
									pastEndNote = `[Offset ${offset} is past the end: the ${source} has ${selection.totalFileLines} lines. Reading from line ${startLine + 1} instead.]\n\n`;
									selection = await selectLines(ops, absolutePath, startLine, undefined, json, true, signal);
									if (aborted) return;
								}
								const { totalFileLines, truncation, firstLineBytes, lineBytes } = selection;
								const startLineDisplay = startLine + 1;
								// A user-specified limit is honored before truncation.
								const userLimitedLines =
									lineLimit === undefined
										? undefined
										: Math.min(startLine + lineLimit, totalFileLines) - startLine;
								// What a notice names for reading every line after the shown ones.
								const pageOffsets = (nextOffset: number) =>
									usualRange ? remainingPageOffsets(lineBytes, nextOffset - 1, totalFileLines) : undefined;
								const qualifiers = [
									...(json === undefined ? [] : ["the same json"]),
									...(limit === undefined ? [] : ["no limit"]),
								];
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(firstLineBytes);
									outputText =
										json === undefined
											? `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`
											: `[JSON selection line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Narrow json.path/json.fields or use bash for JSON extraction.]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									const remaining = totalFileLines - endLineDisplay;
									const byteLimit =
										truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
									const offsets = pageOffsets(nextOffset);
									const shown = `Showing ${json === undefined ? "" : "JSON selection "}lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${byteLimit}.`;
									const next = `Use offset=${nextOffset}${continuation} to continue.`;
									let notice: string;
									if (offsets === undefined) {
										notice = `${shown} ${remaining} lines remain. ${next}`;
									} else if (offsets.length === 1 && limit === undefined) {
										// The next offset already returns everything that is left.
										notice = `${shown} ${next}`;
									} else {
										// The reads for everything come before the single offset: in real runs a model that
										// read the single offset first followed it and fetched one page per request.
										notice = `${shown} ${remaining} lines remain: to read them all, ${readCallsAt(offsets, qualifiers)}. For a part, use offset=${nextOffset} and a limit${continuation}.`;
									}
									outputText = `${truncation.content}\n\n[${notice}]`;
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = totalFileLines - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									const offsets = pageOffsets(nextOffset);
									const notice = offsets
										? `${remaining} more lines in ${source}: to read them all, ${readCallsAt(offsets, qualifiers)}. For a part, use offset=${nextOffset} and a limit${continuation}.`
										: `${remaining} more lines in ${source}. Use offset=${nextOffset}${continuation} to continue.`;
									outputText = `${truncation.content}\n\n[${notice}]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								content = [{ type: "text", text: pastEndNote + outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			).then((result) => ({ ...result, structuredContent: toReadOutput(result.content) }));
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): TypeBoxAgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
