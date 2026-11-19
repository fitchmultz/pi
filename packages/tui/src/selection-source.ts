import {
	SELECTION_METADATA,
	SELECTION_SOURCE_END,
	SelectionSourceTracker,
	selectionRunMarker,
} from "./selection-markers.ts";
import { extractAnsiCode, getGraphemeSegmenter, sliceByColumn, stripTerminalSequences, visibleWidth } from "./utils.ts";

interface SourceSpan {
	start: number;
	end: number;
	sourceStart: number;
	sourceEnd: number;
	atomic?: boolean;
}

/** Text after a declared rendering transformation, with positions in the original source. */
export class SourceText {
	readonly text: string;
	readonly spans: readonly SourceSpan[];
	readonly unmapped: boolean;

	constructor(
		text: string,
		spans: readonly SourceSpan[] = [{ start: 0, end: text.length, sourceStart: 0, sourceEnd: text.length }],
		unmapped = false,
	) {
		this.text = text;
		this.spans = spans;
		this.unmapped = unmapped;
	}

	slice(start: number, end = this.text.length): SourceText {
		const spans: SourceSpan[] = [];
		for (const span of this.spans) {
			const from = Math.max(start, span.start);
			const to = Math.min(end, span.end);
			if (to <= from) continue;
			const identity = !span.atomic && span.end - span.start === span.sourceEnd - span.sourceStart;
			spans.push({
				start: from - start,
				end: to - start,
				sourceStart: identity ? span.sourceStart + from - span.start : span.sourceStart,
				sourceEnd: identity ? span.sourceStart + to - span.start : span.sourceEnd,
				...(identity ? {} : { atomic: true }),
			});
		}
		return new SourceText(this.text.slice(start, end), spans, this.unmapped);
	}

	replace(pattern: RegExp, replacement: string): SourceText {
		const parts: SourceText[] = [];
		let cursor = 0;
		for (const match of this.text.matchAll(
			new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
		)) {
			parts.push(this.slice(cursor, match.index));
			const replaced = this.slice(match.index, match.index + match[0].length);
			if (replacement && replaced.spans.length) {
				parts.push(
					new SourceText(replacement, [
						{
							start: 0,
							end: replacement.length,
							sourceStart: replaced.spans[0].sourceStart,
							sourceEnd: replaced.spans[replaced.spans.length - 1].sourceEnd,
							atomic: true,
						},
					]),
				);
			}
			cursor = match.index + match[0].length;
		}
		parts.push(this.slice(cursor));
		return SourceText.concat(parts);
	}

	trim(): SourceText {
		const start = this.text.length - this.text.trimStart().length;
		return this.slice(start, this.text.trimEnd().length);
	}

	/** Marked supplies the dedented lines; each still belongs to the corresponding source line. */
	lines(text: string, firstLine = 0): SourceText {
		const rawLines = this.text.split("\n");
		const parts: SourceText[] = [];
		let offset = rawLines.slice(0, firstLine).reduce((total, line) => total + line.length + 1, 0);
		for (const [index, line] of text.split("\n").entries()) {
			const raw = rawLines[firstLine + index] ?? "";
			const start = raw.lastIndexOf(line);
			if (start < 0) return new SourceText(text, [], true);
			if (index > 0) parts.push(this.slice(offset - 1, offset));
			parts.push(this.slice(offset + start, offset + start + line.length));
			offset += raw.length + 1;
		}
		return SourceText.concat(parts);
	}

	static concat(parts: readonly SourceText[]): SourceText {
		let text = "";
		const spans: SourceSpan[] = [];
		let unmapped = false;
		for (const part of parts) {
			if (part.unmapped) unmapped = true;
			for (const span of part.spans) {
				const start = text.length + span.start;
				const end = text.length + span.end;
				const prev = spans[spans.length - 1];
				const prevIdentity = prev && !prev.atomic && prev.end - prev.start === prev.sourceEnd - prev.sourceStart;
				const nextIdentity = !span.atomic && end - start === span.sourceEnd - span.sourceStart;
				if (prev && prev.end === start && prevIdentity && nextIdentity && prev.sourceEnd === span.sourceStart) {
					prev.end = end;
					prev.sourceEnd = span.sourceEnd;
				} else if (
					prev &&
					prev.end === start &&
					!prevIdentity &&
					!nextIdentity &&
					prev.sourceStart === span.sourceStart &&
					prev.sourceEnd === span.sourceEnd
				) {
					prev.end = end;
				} else {
					spans.push({ ...span, start, end });
				}
			}
			text += part.text;
		}
		return new SourceText(text, spans, unmapped);
	}
}

// Set only while a renderer that reads selection sources renders its components.
let readerRendering = false;

/**
 * Run a render whose Text and Markdown lines carry selection sources. Only for a renderer that reads the sources and
 * removes their markers before output. Every other caller of render() gets lines without private markers.
 */
export function renderForSelectionReader<T>(render: () => T): T {
	const outer = readerRendering;
	readerRendering = true;
	try {
		return render();
	} finally {
		readerRendering = outer;
	}
}

/** Whether the current render is for a selection reader, so components attach sources to their lines. */
export function isRenderingForSelectionReader(): boolean {
	return readerRendering;
}

let nextSourceId = 0;
const sourceRecords = new Map<number, WeakRef<SelectionSource>>();
const sourceCleanup = new FinalizationRegistry<number>((id) => sourceRecords.delete(id));
const PROMPT_MARKER = /^\x1b\]133;[ABC](?:\x07|\x1b\\)$/;

/** Original document and the source blocks owned by its current rendered frame. */
export class SelectionDocument {
	text: string;
	complete = true;
	readonly sources: SelectionSource[] = [];

	constructor(text = "") {
		this.text = text;
	}
}

/** One cached rendered block owns its source once, not once per wrapped screen row. */
export class SelectionSource {
	readonly id = ++nextSourceId;
	readonly text: string;
	readonly document: SelectionDocument;
	readonly offset: number;
	readonly formats: Array<readonly [number, number, number, number]> = [];
	private readonly kind: "content" | "trivia";
	private contentRanges: SourceRange[] = [];
	private fullyMapped = true;

	constructor(text: string, document?: SelectionDocument, offset = 0, kind: "content" | "trivia" = "content") {
		this.text = text;
		this.document = document ?? new SelectionDocument(text);
		this.offset = offset;
		this.kind = kind;
		if (!document) this.document.sources.push(this);
		sourceRecords.set(this.id, new WeakRef(this));
		sourceCleanup.register(this, this.id);
	}

	format(outer: SourceText, inner: SourceText): void {
		if (!outer.spans.length || !inner.spans.length) return;
		this.formats.push([
			outer.spans[0].sourceStart,
			inner.spans[0].sourceStart,
			inner.spans[inner.spans.length - 1].sourceEnd,
			outer.spans[outer.spans.length - 1].sourceEnd,
		]);
	}

	annotate(styled: string, source: SourceText): string {
		if (source.text.includes("\x1b")) source = stripAnsiSourceText(source);
		if (!source.spans.length) {
			if (source.unmapped && stripTerminalSequences(styled).trim()) this.fullyMapped = false;
			return styled;
		}
		for (const span of source.spans) this.contentRanges.push({ start: span.sourceStart, end: span.sourceEnd });
		styled = styled.replace(SELECTION_METADATA, "");
		if (source.spans.length === 1 && source.spans[0].start === 0 && source.spans[0].end === source.text.length) {
			const span = source.spans[0];
			const identity = !span.atomic && span.end - span.start === span.sourceEnd - span.sourceStart;
			return (
				selectionRunMarker(
					identity
						? { kind: "identity", id: this.id, offset: span.sourceStart }
						: { kind: "atomic", id: this.id, start: span.sourceStart, end: span.sourceEnd },
				) +
				styled +
				SELECTION_SOURCE_END
			);
		}
		let result = "";
		let position = 0;
		let spanIndex = 0;
		let activeSpan = -1;
		for (let i = 0; i < styled.length; ) {
			const ansi = extractAnsiCode(styled, i);
			if (ansi) {
				result += ansi.code;
				i += ansi.length;
				continue;
			}
			while (spanIndex < source.spans.length && position >= source.spans[spanIndex].end) spanIndex++;
			const span = source.spans[spanIndex];
			if (span && position >= span.start && activeSpan !== spanIndex) {
				const identity = !span.atomic && span.end - span.start === span.sourceEnd - span.sourceStart;
				result += selectionRunMarker(
					identity
						? { kind: "identity", id: this.id, offset: span.sourceStart + position - span.start }
						: { kind: "atomic", id: this.id, start: span.sourceStart, end: span.sourceEnd },
				);
				activeSpan = spanIndex;
			} else if ((!span || position < span.start) && activeSpan !== -1) {
				result += SELECTION_SOURCE_END;
				activeSpan = -1;
			}
			let end = styled.indexOf("\x1b", i + 1);
			if (end < 0) end = styled.length;
			if (span) end = Math.min(end, i + (position < span.start ? span.start : span.end) - position);
			result += styled.slice(i, end);
			position += end - i;
			i = end;
		}
		return activeSpan !== -1 ? result + SELECTION_SOURCE_END : result;
	}

	atomic(styled: string, source: SourceText, kind: "atomic" | "generated" = "atomic"): string {
		if (!source.spans.length || !styled) return styled;
		const start = source.spans[0].sourceStart;
		const end = source.spans[source.spans.length - 1].sourceEnd;
		if (kind === "atomic") this.contentRanges.push({ start, end });
		return selectionRunMarker({ kind, id: this.id, start, end }) + styled + SELECTION_SOURCE_END;
	}

	wrap(lines: string[]): string[] {
		if (!lines.length) return lines;
		if (!this.contentRanges.length && lines.some((line) => stripTerminalSequences(line).trim())) {
			this.fullyMapped = false;
		}
		if (!this.fullyMapped) return lines.map((line) => line.replace(SELECTION_METADATA, ""));
		this.contentRanges = mergeRanges(this.contentRanges);
		return lines.map((line, index) => {
			let prompt = "";
			let prefix = "";
			let offset = 0;
			for (let ansi = extractAnsiCode(line, offset); ansi; ansi = extractAnsiCode(line, offset)) {
				if (PROMPT_MARKER.test(ansi.code)) prompt += ansi.code;
				else prefix += ansi.code;
				offset += ansi.length;
			}
			const definition = index === 0 ? `\x1b]pi:sd;${this.id}\x07` : "";
			return `${prompt}${definition}\x1b]pi:sc;${this.id}\x07${prefix}${line.slice(offset)}\x1b]pi:sz;${this.id}\x07`;
		});
	}

	covers(ranges: readonly SourceRange[], target: SourceRange): boolean {
		const selected = this.resolveRanges(ranges);
		return this.contentRanges.every((content) => {
			const start = Math.max(content.start, target.start);
			const end = Math.min(content.end, target.end);
			return end <= start || selected.some((range) => range.start <= start && range.end >= end);
		});
	}

	select(ranges: readonly SourceRange[]): { text: string; start: number; end: number; complete: boolean } {
		const selected = this.resolveRanges(ranges);
		if (!selected.length) {
			return {
				text: this.text.trim() ? "" : this.text,
				start: 0,
				end: this.text.length,
				complete: this.fullyMapped && this.kind === "trivia",
			};
		}
		if (
			this.contentRanges.every((content) =>
				selected.some((range) => range.start <= content.start && range.end >= content.end),
			)
		) {
			return { text: this.text, start: 0, end: this.text.length, complete: this.fullyMapped };
		}
		let start = selected[0].start;
		let end = selected[selected.length - 1].end;
		for (const [outerStart, contentStart, contentEnd, outerEnd] of this.formats) {
			if (contentStart >= start) start = Math.min(start, outerStart);
			if (contentEnd <= end) end = Math.max(end, outerEnd);
		}
		return {
			text: selected.map(({ start, end }) => this.text.slice(start, end)).join("\n"),
			start,
			end,
			complete: false,
		};
	}

	private resolveRanges(ranges: readonly SourceRange[]): SourceRange[] {
		const bridged: SourceRange[] = [];
		for (const range of mergeRanges(ranges)) {
			const previous = bridged[bridged.length - 1];
			const gapHasContent =
				previous &&
				this.contentRanges.some(
					(content) =>
						content.start < range.start &&
						content.end > previous.end &&
						this.text.slice(Math.max(content.start, previous.end), Math.min(content.end, range.start)).trim(),
				);
			if (previous && !gapHasContent) previous.end = range.end;
			else bridged.push({ ...range });
		}
		let selected = bridged;
		for (const [start, contentStart, contentEnd, end] of this.formats) {
			if (selected.some((range) => range.start <= contentStart && range.end >= contentEnd)) {
				selected = mergeRanges([...selected, { start, end }]);
			}
		}
		return selected;
	}
}

export interface SelectionColumns {
	row: number;
	start: number;
	end: number;
}

interface SelectedSource {
	source: SelectionSource;
	ranges: SourceRange[];
}

/** Extract source ranges; components without source annotations keep terminal-cell copying. */
export function copySelectionSource(lines: readonly string[], selection: readonly SelectionColumns[]): string {
	const sources = new Map<number, SelectedSource>();
	const parts: Array<SelectedSource | string> = [];
	const generated = new Map<SourceRange, SelectedSource>();
	const displayedText = () =>
		selection
			.map(({ row, start, end }) =>
				stripTerminalSequences(sliceByColumn(lines[row] ?? "", start, Math.max(0, end - start), true)).trimEnd(),
			)
			.join("\n");
	const selectedSource = (id: number): SelectedSource | undefined => {
		let selected = sources.get(id);
		if (!selected) {
			const source = sourceRecords.get(id)?.deref();
			if (!source) return undefined;
			selected = { source, ranges: [] };
			sources.set(id, selected);
		}
		return selected;
	};
	for (const columns of selection) {
		const line = lines[columns.row] ?? "";
		const tracker = new SelectionSourceTracker();
		const activeSources = new Set<number>();
		let column = 0;
		let fallback = "";
		let mappedRow = false;
		let rowDocument: SelectionDocument | undefined;
		let mixedDocuments = false;
		for (let i = 0; i < line.length; ) {
			const ansi = extractAnsiCode(line, i);
			if (ansi) {
				const definition = /^\x1b]pi:sd;(\d+)\x07$/.exec(ansi.code);
				const scope = /^\x1b]pi:sc;(\d+)\x07$/.exec(ansi.code);
				const end = /^\x1b]pi:sz;(\d+)\x07$/.exec(ansi.code);
				if (definition) sources.delete(Number(definition[1]));
				if (scope) {
					const id = Number(scope[1]);
					const selected = selectedSource(id);
					if (selected) {
						activeSources.add(id);
						mappedRow = true;
						if (!selected.source.text.trim() && !parts.includes(selected)) parts.push(selected);
					}
				} else if (end) {
					activeSources.delete(Number(end[1]));
				}
				tracker.process(ansi.code);
				i += ansi.length;
				continue;
			}
			let textEnd = line.indexOf("\x1b", i);
			if (textEnd < 0) textEnd = line.length;
			if (textEnd === i) textEnd++;
			for (const { segment } of getGraphemeSegmenter().segment(line.slice(i, textEnd))) {
				const width = visibleWidth(segment);
				const selected = column >= columns.start && column + width <= columns.end;
				const run = tracker.run;
				const source = run && selectedSource(run.id);
				if (source) {
					mappedRow = true;
					if (selected) {
						if (rowDocument && rowDocument !== source.source.document) mixedDocuments = true;
						rowDocument = source.source.document;
						if (run.kind === "generated") {
							generated.set(run, source);
						} else {
							if (!source.ranges.length) parts.push(source);
							const start = run.kind === "identity" ? run.offset : run.start;
							const end = run.kind === "identity" ? run.offset + segment.length : run.end;
							const previous = source.ranges[source.ranges.length - 1];
							if (previous && start <= previous.end && end >= previous.start) {
								previous.start = Math.min(previous.start, start);
								previous.end = Math.max(previous.end, end);
							} else source.ranges.push({ start, end });
						}
					}
				} else if (selected && activeSources.size === 0) {
					fallback += segment;
				}
				tracker.advance(segment.length);
				column += width;
			}
			i = textEnd;
		}
		// Independent side-by-side components have no shared source order or separator.
		if (mixedDocuments || (rowDocument && fallback.trim())) {
			return displayedText();
		}
		if (!mappedRow || fallback.trim()) parts.push(`${fallback.trimEnd()}\n`);
	}
	// A generated link URL belongs to its label's source only when that label is fully selected.
	for (const [range, selected] of generated) {
		if (!selected.source.covers(selected.ranges, range)) return displayedText();
	}
	let text = "";
	let previousDocument: SelectionDocument | undefined;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (typeof part === "string") {
			if (previousDocument && text && !text.endsWith("\n")) text += "\n";
			text += index === parts.length - 1 ? part.slice(0, -1) : part;
			previousDocument = undefined;
		} else {
			const document = part.source.document;
			const group = [part];
			while (index + 1 < parts.length) {
				const next = parts[index + 1];
				if (typeof next === "string" || next.source.document !== document) break;
				group.push(next);
				index++;
			}
			if (previousDocument && previousDocument !== document && !text.endsWith("\n")) text += "\n";
			text += copyDocumentSelection(document, group);
			previousDocument = document;
		}
	}
	if (text.trim()) return text;
	const displayed = displayedText();
	return displayed.trim() ? displayed : text;
}

function copyDocumentSelection(document: SelectionDocument, parts: readonly SelectedSource[]): string {
	const selected = new Map(parts.map((part) => [part.source, part.source.select(part.ranges)]));
	if (
		document.complete &&
		parts.some((part) => part.ranges.length > 0) &&
		document.sources.every((source) => (selected.get(source) ?? source.select([])).complete)
	)
		return document.text;

	let text = "";
	let previousEnd: number | undefined;
	for (const [source, selection] of selected) {
		const start = source.offset + selection.start;
		if (previousEnd !== undefined) text += document.text.slice(previousEnd, start);
		text += selection.text;
		previousEnd = source.offset + selection.end;
	}
	return text;
}

interface SourceRange {
	start: number;
	end: number;
}

function mergeRanges(ranges: readonly SourceRange[]): SourceRange[] {
	const result: SourceRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const previous = result[result.length - 1];
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else result.push({ ...range });
	}
	return result;
}

function stripAnsiSourceText(source: SourceText): SourceText {
	const parts: SourceText[] = [];
	let plainStart = 0;
	for (let i = 0; i < source.text.length; ) {
		const ansi = extractAnsiCode(source.text, i);
		if (!ansi) {
			i++;
			continue;
		}
		if (i > plainStart) parts.push(source.slice(plainStart, i));
		i += ansi.length;
		plainStart = i;
	}
	if (plainStart === 0) return source;
	if (plainStart < source.text.length) parts.push(source.slice(plainStart));
	return SourceText.concat(parts);
}

interface VisibleRun {
	rawStart: number;
	rawEnd: number;
	visStart: number;
	visEnd: number;
}

interface VisibleText {
	text: string;
	runs: VisibleRun[];
}

function decomposeVisibleText(raw: string, rawOffset: number): VisibleText {
	if (!raw.includes("\x1b")) {
		return {
			text: raw,
			runs:
				raw.length > 0
					? [{ rawStart: rawOffset, rawEnd: rawOffset + raw.length, visStart: 0, visEnd: raw.length }]
					: [],
		};
	}
	let text = "";
	const runs: VisibleRun[] = [];
	let plainStart = 0;
	for (let i = 0; i < raw.length; ) {
		const ansi = extractAnsiCode(raw, i);
		if (!ansi) {
			i++;
			continue;
		}
		if (i > plainStart) {
			const visStart = text.length;
			text += raw.slice(plainStart, i);
			runs.push({ rawStart: rawOffset + plainStart, rawEnd: rawOffset + i, visStart, visEnd: text.length });
		}
		i += ansi.length;
		plainStart = i;
	}
	if (plainStart < raw.length) {
		const visStart = text.length;
		text += raw.slice(plainStart);
		runs.push({ rawStart: rawOffset + plainStart, rawEnd: rawOffset + raw.length, visStart, visEnd: text.length });
	}
	return { text, runs };
}

function emitMappedRange(
	spans: SourceSpan[],
	runs: readonly VisibleRun[],
	visStart: number,
	visEnd: number,
	sourceStart: number,
	sourceEnd: number,
	atomic: boolean,
): void {
	if (visEnd <= visStart || sourceEnd <= sourceStart) return;
	for (const run of runs) {
		if (run.visEnd <= visStart) continue;
		if (run.visStart >= visEnd) break;
		const from = Math.max(visStart, run.visStart);
		const to = Math.min(visEnd, run.visEnd);
		const rawStart = run.rawStart + (from - run.visStart);
		const rawEnd = run.rawStart + (to - run.visStart);
		if (atomic) {
			spans.push({ start: rawStart, end: rawEnd, sourceStart, sourceEnd, atomic: true });
		} else {
			spans.push({
				start: rawStart,
				end: rawEnd,
				sourceStart: sourceStart + (from - visStart),
				sourceEnd: sourceStart + (to - visStart),
			});
		}
	}
}

interface TextSegment {
	text: string;
	start: number;
	end: number;
}

function splitLinesWithOffsets(text: string): TextSegment[] {
	const lines: TextSegment[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			lines.push({ text: text.slice(start, i + 1), start, end: i + 1 });
			start = i + 1;
		}
	}
	if (start < text.length || lines.length === 0) {
		lines.push({ text: text.slice(start), start, end: text.length });
	}
	return lines;
}

// Split on ASCII spaces/tabs/newlines (never NBSP) and Markdown delimiter punctuation so decorated tokens like
// `**\uf012 Status:**` align their `**` and `Status:` independently while NBSP-joined pills stay atomic.
const ALIGN_TOKEN_REGEX = /\*\*|__|[`~*_[\]()#]+|[^ \t\r\n`~*_[\]()#]+/g;

function tokenizeForAlign(text: string): TextSegment[] {
	const tokens: TextSegment[] = [];
	for (const match of text.matchAll(ALIGN_TOKEN_REGEX)) {
		tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
	}
	return tokens;
}

const MAX_LCS_CELLS = 250_000;

/** Return matched index pairs `[aIndex, bIndex]` in strictly increasing order. */
function matchSequence(a: readonly string[], b: readonly string[]): Array<[number, number]> {
	let prefix = 0;
	const minLen = Math.min(a.length, b.length);
	while (prefix < minLen && a[prefix] === b[prefix]) prefix++;

	let suffix = 0;
	while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

	const pairs: Array<[number, number]> = [];
	for (let i = 0; i < prefix; i++) pairs.push([i, i]);

	const aMid = a.slice(prefix, a.length - suffix);
	const bMid = b.slice(prefix, b.length - suffix);
	const m = aMid.length;
	const n = bMid.length;

	if (m > 0 && n > 0) {
		if (m * n <= MAX_LCS_CELLS) {
			const cols = n + 1;
			const dp = new Int32Array((m + 1) * cols);
			for (let i = m - 1; i >= 0; i--) {
				const row = i * cols;
				const nextRow = (i + 1) * cols;
				for (let j = n - 1; j >= 0; j--) {
					dp[row + j] = aMid[i] === bMid[j] ? dp[nextRow + j + 1] + 1 : Math.max(dp[nextRow + j], dp[row + j + 1]);
				}
			}
			let i = 0;
			let j = 0;
			while (i < m && j < n) {
				if (aMid[i] === bMid[j]) {
					pairs.push([prefix + i, prefix + j]);
					i++;
					j++;
				} else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
					i++;
				} else {
					j++;
				}
			}
		} else {
			// Bounded O(N log N) patience fallback for very large changed regions: match unique items and take LIS.
			const aCounts = new Map<string, number>();
			const bCounts = new Map<string, number>();
			const bPos = new Map<string, number>();
			for (let i = 0; i < m; i++) aCounts.set(aMid[i], (aCounts.get(aMid[i]) ?? 0) + 1);
			for (let j = 0; j < n; j++) {
				bCounts.set(bMid[j], (bCounts.get(bMid[j]) ?? 0) + 1);
				bPos.set(bMid[j], j);
			}
			const candidates: Array<[number, number]> = [];
			for (let i = 0; i < m; i++) {
				const key = aMid[i];
				if (aCounts.get(key) === 1 && bCounts.get(key) === 1) {
					candidates.push([i, bPos.get(key)!]);
				}
			}
			if (candidates.length > 0) {
				const tails: number[] = [];
				const prev = new Int32Array(candidates.length).fill(-1);
				for (let k = 0; k < candidates.length; k++) {
					const bIdx = candidates[k][1];
					let lo = 0;
					let hi = tails.length;
					while (lo < hi) {
						const mid = (lo + hi) >> 1;
						if (candidates[tails[mid]][1] < bIdx) lo = mid + 1;
						else hi = mid;
					}
					if (lo > 0) prev[k] = tails[lo - 1];
					tails[lo] = k;
				}
				const lis: Array<[number, number]> = [];
				for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) {
					lis.push([prefix + candidates[k][0], prefix + candidates[k][1]]);
				}
				for (let k = lis.length - 1; k >= 0; k--) pairs.push(lis[k]);
			}
		}
	}

	for (let i = 0; i < suffix; i++) {
		pairs.push([a.length - suffix + i, b.length - suffix + i]);
	}
	return pairs;
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

function commonSuffixLength(a: string, b: string, maxLen: number): number {
	let i = 0;
	while (i < maxLen && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
	return i;
}

function sharesWord(a: string, b: string): boolean {
	const words = a.match(/[A-Za-z0-9]{2,}/g);
	if (!words) return false;
	for (const word of words) {
		if (b.includes(word)) return true;
	}
	return false;
}

interface AlignStats {
	matchedAnchors: number;
	deletedNonWhitespace: boolean;
}

function emitGap(
	spans: SourceSpan[],
	runs: readonly VisibleRun[],
	origText: string,
	origOffset: number,
	visText: string,
	visOffset: number,
	stats: AlignStats,
	allowUnanchoredAtomic: boolean,
): void {
	const prefix = commonPrefixLength(origText, visText);
	const suffix = commonSuffixLength(origText, visText, Math.min(origText.length, visText.length) - prefix);
	if (prefix > 0) {
		emitMappedRange(spans, runs, visOffset, visOffset + prefix, origOffset, origOffset + prefix, false);
		if (origText.slice(0, prefix).trim()) stats.matchedAnchors++;
	}
	const origRemStart = prefix;
	const origRemEnd = origText.length - suffix;
	const visRemStart = prefix;
	const visRemEnd = visText.length - suffix;
	const origRem = origText.slice(origRemStart, origRemEnd);
	const visRem = visText.slice(visRemStart, visRemEnd);
	if (origRem.length > 0 && visRem.length > 0) {
		if (allowUnanchoredAtomic || stats.matchedAnchors > 0 || sharesWord(origRem, visRem)) {
			emitMappedRange(
				spans,
				runs,
				visOffset + visRemStart,
				visOffset + visRemEnd,
				origOffset + origRemStart,
				origOffset + origRemEnd,
				true,
			);
		} else if (origRem.trim()) {
			stats.deletedNonWhitespace = true;
		}
	} else if (origRem.trim()) {
		stats.deletedNonWhitespace = true;
	}
	if (suffix > 0) {
		emitMappedRange(
			spans,
			runs,
			visOffset + visRemEnd,
			visOffset + visText.length,
			origOffset + origRemEnd,
			origOffset + origText.length,
			false,
		);
		if (origText.slice(origRemEnd).trim()) stats.matchedAnchors++;
	}
}

function alignRange(
	spans: SourceSpan[],
	origText: string,
	origOffset: number,
	transText: string,
	transOffset: number,
	stats: AlignStats,
	hasOuterAnchor: boolean,
): void {
	if (origText === transText) {
		if (origText.length > 0) {
			spans.push({
				start: transOffset,
				end: transOffset + transText.length,
				sourceStart: origOffset,
				sourceEnd: origOffset + origText.length,
			});
			if (origText.trim()) stats.matchedAnchors++;
		}
		return;
	}
	const visible = decomposeVisibleText(transText, transOffset);
	if (visible.text === origText) {
		emitMappedRange(spans, visible.runs, 0, visible.text.length, origOffset, origOffset + origText.length, false);
		if (origText.trim()) stats.matchedAnchors++;
		return;
	}
	const origTokens = tokenizeForAlign(origText);
	const visTokens = tokenizeForAlign(visible.text);
	const matches = matchSequence(
		origTokens.map((t) => t.text),
		visTokens.map((t) => t.text),
	);
	const anchored = hasOuterAnchor || stats.matchedAnchors > 0 || matches.length > 0;
	if (!anchored && !sharesWord(origText, visible.text)) {
		if (origText.trim()) stats.deletedNonWhitespace = true;
		return;
	}
	let origCursor = 0;
	let visCursor = 0;
	for (const [oi, vi] of matches) {
		const ot = origTokens[oi];
		const vt = visTokens[vi];
		emitGap(
			spans,
			visible.runs,
			origText.slice(origCursor, ot.start),
			origOffset + origCursor,
			visible.text.slice(visCursor, vt.start),
			visCursor,
			stats,
			anchored,
		);
		emitMappedRange(spans, visible.runs, vt.start, vt.end, origOffset + ot.start, origOffset + ot.end, false);
		stats.matchedAnchors++;
		origCursor = ot.end;
		visCursor = vt.end;
	}
	emitGap(
		spans,
		visible.runs,
		origText.slice(origCursor),
		origOffset + origCursor,
		visible.text.slice(visCursor),
		visCursor,
		stats,
		anchored,
	);
}

/**
 * Map transformed Markdown text back to positions in `original` while ignoring injected ANSI codes and
 * preserving atomic replacements (e.g. status pills) and unmapped visual decorations (e.g. prefix icons).
 */
export function alignSourceText(original: string, transformed: string): { source: SourceText; complete: boolean } {
	if (transformed === original) {
		return { source: new SourceText(transformed), complete: true };
	}
	const origLines = splitLinesWithOffsets(original);
	const transLines = splitLinesWithOffsets(transformed);
	const spans: SourceSpan[] = [];
	const stats: AlignStats = { matchedAnchors: 0, deletedNonWhitespace: false };

	if (origLines.length === transLines.length) {
		// Pre-check whether any line matches so localized substitutions on earlier lines still anchor cleanly.
		const hasLineAnchor = origLines.some(
			(line, idx) => line.text.trim().length > 0 && stripTerminalSequences(transLines[idx].text) === line.text,
		);
		for (let i = 0; i < origLines.length; i++) {
			alignRange(
				spans,
				origLines[i].text,
				origLines[i].start,
				transLines[i].text,
				transLines[i].start,
				stats,
				hasLineAnchor,
			);
		}
	} else {
		const transVisibleLines = transLines.map((line) => stripTerminalSequences(line.text));
		const lineMatches = matchSequence(
			origLines.map((line) => line.text),
			transVisibleLines,
		);
		const hasLineAnchor = lineMatches.some(([oi]) => origLines[oi].text.trim().length > 0);
		let origCursor = 0;
		let transCursor = 0;
		const alignHunk = (origEnd: number, transEnd: number): void => {
			if (origEnd === origCursor && transEnd === transCursor) return;
			const origStartOffset = origCursor < origLines.length ? origLines[origCursor].start : original.length;
			const origEndOffset = origEnd > origCursor ? origLines[origEnd - 1].end : origStartOffset;
			const transStartOffset = transCursor < transLines.length ? transLines[transCursor].start : transformed.length;
			const transEndOffset = transEnd > transCursor ? transLines[transEnd - 1].end : transStartOffset;
			if (origEndOffset === origStartOffset) return;
			if (transEndOffset === transStartOffset) {
				if (original.slice(origStartOffset, origEndOffset).trim()) stats.deletedNonWhitespace = true;
				return;
			}
			alignRange(
				spans,
				original.slice(origStartOffset, origEndOffset),
				origStartOffset,
				transformed.slice(transStartOffset, transEndOffset),
				transStartOffset,
				stats,
				hasLineAnchor,
			);
		};
		for (const [oi, ti] of lineMatches) {
			alignHunk(oi, ti);
			alignRange(
				spans,
				origLines[oi].text,
				origLines[oi].start,
				transLines[ti].text,
				transLines[ti].start,
				stats,
				hasLineAnchor,
			);
			origCursor = oi + 1;
			transCursor = ti + 1;
		}
		alignHunk(origLines.length, transLines.length);
	}

	return {
		source: new SourceText(transformed, spans),
		complete: spans.length > 0 && !stats.deletedNonWhitespace,
	};
}
