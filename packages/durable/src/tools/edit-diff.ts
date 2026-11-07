/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Apply replacements matched in `normalizeToLF(originalContent)` to `originalContent` itself.
 * Text outside the replaced ranges keeps its bytes, including its line endings. Line breaks in
 * the new text get the line ending of the line where the replaced range starts. The result,
 * normalized to LF, equals the replacements applied to the normalized content.
 */
export function applyReplacementsToOriginal(originalContent: string, replacements: TextReplacement[]): string {
	// Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is at
	// p - n in the normalized text. Adding the number of CRLFs before a normalized offset gives the
	// original offset, and a range that covers that LF covers the whole CRLF.
	let crlfBefore = 0;
	let nextCrlf = originalContent.indexOf("\r\n");
	const toOriginal = (offset: number): number => {
		while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
			crlfBefore++;
			nextCrlf = originalContent.indexOf("\r\n", nextCrlf + 2);
		}
		return offset + crlfBefore;
	};

	const parts: string[] = [];
	let endsWithCr = false;
	const push = (part: string): void => {
		if (part.length === 0) return;
		// A CR before a seam and an LF after it would merge into one CRLF line break, for example a kept
		// lone CR followed by inserted text that starts with LF, or both sides of a deleted range. Adding
		// an LF turns the CR into a CRLF of its own, so the written file has the line breaks the diff shows.
		if (endsWithCr && part[0] === "\n") parts.push("\n");
		parts.push(part);
		endsWithCr = part[part.length - 1] === "\r";
	};
	let position = 0;
	for (const replacement of replacements) {
		const start = toOriginal(replacement.matchIndex);
		push(originalContent.slice(position, start));
		const ending = getLineEndingAt(originalContent, start);
		push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
		position = toOriginal(replacement.matchIndex + replacement.matchLength);
	}
	push(originalContent.slice(position));
	return parts.join("");
}

/**
 * Line ending of the line containing `offset`: its own LF or CRLF, or that of the line before
 * for an unterminated last line. A lone CR only counts in files without any LF (classic Mac
 * line endings); elsewhere it is more likely a control character inside a line.
 */
function getLineEndingAt(content: string, offset: number): "\r\n" | "\n" | "\r" {
	let lineFeed = content.indexOf("\n", offset);
	if (lineFeed === -1) lineFeed = content.lastIndexOf("\n", offset);
	if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n";
	return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return normalizeUnicode(text)
		.split("\n")
		.map((line) => line.replace(/[^\S\r\n]+$/u, ""))
		.join("\n");
}

function normalizeUnicode(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/** Replacement of `matchLength` characters at `matchIndex` with `newText`. */
export type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function applyReplacements(content: string, replacements: TextReplacement[]): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		result =
			result.substring(0, replacement.matchIndex) +
			replacement.newText +
			result.substring(replacement.matchIndex + replacement.matchLength);
	}
	return result;
}

/** Find an original code-point boundary, then verify that normalization does not cross it. */
function originalLineOffset(line: string, offset: number): number {
	const normalized = normalizeUnicode(line);
	if (line === normalized) return offset;
	const decomposedOffset = line.normalize("NFKC").slice(0, offset).normalize("NFKD").length;
	let decomposedLength = 0;
	let boundary = 0;
	for (const char of line) {
		if (decomposedLength >= decomposedOffset) break;
		decomposedLength += char.normalize("NFKD").length;
		boundary += char.length;
	}
	// Lengths nominate a candidate; composition and canonical reordering can invalidate it.
	if (
		decomposedLength === decomposedOffset &&
		normalizeUnicode(line.slice(0, boundary)) === normalized.slice(0, offset) &&
		normalizeUnicode(line.slice(boundary)) === normalized.slice(offset)
	)
		return boundary;
	throw new Error(
		"Cannot split a Unicode normalization expansion at the match boundary. Include the whole character in oldText.",
	);
}

function originalFuzzyOffset(content: string, fuzzyContent: string, offset: number, side: "start" | "end"): number {
	let originalStart = 0;
	let fuzzyStart = 0;
	// Fuzzy normalization preserves LF boundaries; reuse its line lengths while scanning original offsets.
	while (originalStart <= content.length) {
		const originalNewline = content.indexOf("\n", originalStart);
		const fuzzyNewline = fuzzyContent.indexOf("\n", fuzzyStart);
		const originalEnd = originalNewline === -1 ? content.length : originalNewline;
		const fuzzyEnd = fuzzyNewline === -1 ? fuzzyContent.length : fuzzyNewline;
		const fuzzyLineLength = fuzzyEnd - fuzzyStart;
		const localOffset = offset - fuzzyStart;
		if (localOffset <= fuzzyLineLength) {
			// Starting at a newline skips its preceding spaces; ending there leaves those spaces intact.
			if (side === "start" && localOffset === fuzzyLineLength) return originalEnd;
			return originalStart + originalLineOffset(content.slice(originalStart, originalEnd), localOffset);
		}
		originalStart = originalEnd + 1;
		fuzzyStart = fuzzyEnd + 1;
	}
	throw new Error("Replacement range is outside the original content.");
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	/** Sorted replacements of `baseContent` that turn it into `newContent` */
	replacements: TextReplacement[];
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. Fuzzy boundaries are
 * mapped back to the original content so only the matched spans change.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
		if (!normalizedEdits[i].oldText.isWellFormed() || !normalizedEdits[i].newText.isWellFormed()) {
			throw new Error("Edit text must not split Unicode surrogate pairs.");
		}
	}

	const matchedEdits: MatchedEdit[] = [];
	const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText);
		const exactIndex = normalizedContent.indexOf(edit.oldText);
		const usedFuzzyMatch = exactIndex === -1;
		const matchIndex = usedFuzzyMatch
			? fuzzyOldText.length > 0
				? fuzzyContent.indexOf(fuzzyOldText)
				: -1
			: exactIndex;
		const matchLength = usedFuzzyMatch ? fuzzyOldText.length : edit.oldText.length;
		if (matchIndex === -1) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		const matchStart = usedFuzzyMatch
			? originalFuzzyOffset(normalizedContent, fuzzyContent, matchIndex, "start")
			: matchIndex;
		const matchEnd = usedFuzzyMatch
			? originalFuzzyOffset(normalizedContent, fuzzyContent, matchIndex + matchLength, "end")
			: matchIndex + matchLength;
		matchedEdits.push({
			editIndex: i,
			matchIndex: matchStart,
			matchLength: matchEnd - matchStart,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = applyReplacements(normalizedContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent, replacements: matchedEdits };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const lineNumWidth = String(Math.max(countLines(oldContent), countLines(newContent))).length;
	const { output, firstChangedLine } = formatDisplayDiff(
		Diff.diffLines(oldContent, newContent),
		1,
		1,
		lineNumWidth,
		contextLines,
	);
	return { diff: output.join("\n"), firstChangedLine };
}

/** Number of lines as `text.split("\n").length` counts them, without building the array. */
function countLines(text: string): number {
	return countLineFeeds(text, 0, text.length) + 1;
}

function countLineFeeds(text: string, start: number, end: number): number {
	let count = 0;
	for (let index = text.indexOf("\n", start); index !== -1 && index < end; index = text.indexOf("\n", index + 1)) {
		count++;
	}
	return count;
}

/** Format jsdiff line parts as display diff lines, numbering from the given 1-based old and new lines. */
function formatDisplayDiff(
	parts: Diff.ChangeObject<string>[],
	oldStartLine: number,
	newStartLine: number,
	lineNumWidth: number,
	contextLines: number,
): { output: string[]; firstChangedLine: number | undefined } {
	const output: string[] = [];

	let oldLineNum = oldStartLine;
	let newLineNum = newStartLine;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { output, firstChangedLine };
}

/** Display diff and unified patch of an edit, as returned in the edit tool's details. */
export interface EditDiff {
	diff: string;
	patch: string;
	firstChangedLine: number | undefined;
}

/**
 * Unchanged lines diffed on each side of a replacement. Well above the 4 context lines shown, so jsdiff
 * aligns a change within its window as it would over the whole file.
 */
const DIFF_WINDOW_MARGIN_LINES = 32;

/**
 * Diff an edit only around its replacements, so time and memory follow the size of the change instead of
 * the file. The result matches generateDiffString and generateUnifiedPatch over the whole contents, except
 * that jsdiff may align runs of repeated lines differently within a window.
 */
export function generateEditDiff(
	path: string,
	baseContent: string,
	newContent: string,
	replacements: TextReplacement[],
	contextLines = 4,
): EditDiff {
	const lineNumWidth = String(Math.max(countLines(baseContent), countLines(newContent))).length;
	const skipMarker = ` ${"".padStart(lineNumWidth, " ")} ...`;
	const output: string[] = [];
	const hunks: Diff.StructuredPatchHunk[] = [];
	let firstChangedLine: number | undefined;
	for (const window of getDiffWindows(baseContent, replacements)) {
		const oldText = baseContent.slice(window.oldStart, window.oldEnd);
		const newText = newContent.slice(window.newStart, window.newEnd);
		const shown = formatDisplayDiff(
			Diff.diffLines(oldText, newText),
			window.oldLine + 1,
			window.newLine + 1,
			lineNumWidth,
			contextLines,
		);
		firstChangedLine ??= shown.firstChangedLine;
		// Both windows around a run of unchanged lines mark it as skipped; the whole-file diff shows one marker.
		if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) shown.output.shift();
		// A loop, not push(...lines): spreading a replacement of many lines overflows the call stack.
		for (const line of shown.output) output.push(line);
		const patch = Diff.structuredPatch(path, path, oldText, newText, undefined, undefined, { context: contextLines });
		for (const hunk of patch.hunks) {
			hunks.push({ ...hunk, oldStart: hunk.oldStart + window.oldLine, newStart: hunk.newStart + window.newLine });
		}
	}
	const patch = Diff.formatPatch(
		{ oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
		Diff.FILE_HEADERS_ONLY,
	);
	return { diff: output.join("\n"), patch, firstChangedLine };
}

/** Matching ranges of the old and new contents around one or more replacements: offsets and 0-based first lines. */
interface DiffWindow {
	oldStart: number;
	oldEnd: number;
	oldLine: number;
	newStart: number;
	newEnd: number;
	newLine: number;
}

/** Start of the line that contains `offset`. */
function lineStartBefore(text: string, offset: number): number {
	// lastIndexOf treats a negative position as 0 and would find a line feed at offset 0.
	return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** Whole-line windows with margin around the replacements, which are sorted and disjoint; overlapping windows merge. */
function getDiffWindows(baseContent: string, replacements: TextReplacement[]): DiffWindow[] {
	const windows: DiffWindow[] = [];
	// Offset and line deltas of the replacements before the current one, and a line-counting cursor.
	let offsetDelta = 0;
	let lineDelta = 0;
	let cursorOffset = 0;
	let cursorLine = 0;
	for (const replacement of replacements) {
		const matchEnd = replacement.matchIndex + replacement.matchLength;
		let start = lineStartBefore(baseContent, replacement.matchIndex);
		for (let i = 0; i < DIFF_WINDOW_MARGIN_LINES && start > 0; i++) {
			start = lineStartBefore(baseContent, start - 1);
		}
		let end = matchEnd;
		for (let i = 0; i <= DIFF_WINDOW_MARGIN_LINES && end < baseContent.length; i++) {
			const lineFeed = baseContent.indexOf("\n", i === 0 ? Math.max(matchEnd - 1, replacement.matchIndex) : end);
			end = lineFeed === -1 ? baseContent.length : lineFeed + 1;
		}
		const replacementOffsetDelta = replacement.newText.length - replacement.matchLength;
		const replacementLineDelta =
			countLineFeeds(replacement.newText, 0, replacement.newText.length) -
			countLineFeeds(baseContent, replacement.matchIndex, matchEnd);
		const previous = windows.at(-1);
		if (previous && start <= previous.oldEnd) {
			previous.oldEnd = Math.max(previous.oldEnd, end);
			previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta;
		} else {
			cursorLine += countLineFeeds(baseContent, cursorOffset, start);
			cursorOffset = start;
			windows.push({
				oldStart: start,
				oldEnd: end,
				oldLine: cursorLine,
				newStart: start + offsetDelta,
				newEnd: end + offsetDelta + replacementOffsetDelta,
				newLine: cursorLine + lineDelta,
			});
		}
		offsetDelta += replacementOffsetDelta;
		lineDelta += replacementLineDelta;
	}
	return windows;
}
