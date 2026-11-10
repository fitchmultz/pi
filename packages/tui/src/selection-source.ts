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
}

/** Text after a declared rendering transformation, with positions in the original source. */
export class SourceText {
	readonly text: string;
	readonly spans: readonly SourceSpan[];

	constructor(
		text: string,
		spans: readonly SourceSpan[] = [{ start: 0, end: text.length, sourceStart: 0, sourceEnd: text.length }],
	) {
		this.text = text;
		this.spans = spans;
	}

	slice(start: number, end = this.text.length): SourceText {
		const spans: SourceSpan[] = [];
		for (const span of this.spans) {
			const from = Math.max(start, span.start);
			const to = Math.min(end, span.end);
			if (to <= from) continue;
			const identity = span.end - span.start === span.sourceEnd - span.sourceStart;
			spans.push({
				start: from - start,
				end: to - start,
				sourceStart: identity ? span.sourceStart + from - span.start : span.sourceStart,
				sourceEnd: identity ? span.sourceStart + to - span.start : span.sourceEnd,
			});
		}
		return new SourceText(this.text.slice(start, end), spans);
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
			if (start < 0) return new SourceText(text, []);
			if (index > 0) parts.push(this.slice(offset - 1, offset));
			parts.push(this.slice(offset + start, offset + start + line.length));
			offset += raw.length + 1;
		}
		return SourceText.concat(parts);
	}

	static concat(parts: readonly SourceText[]): SourceText {
		let text = "";
		const spans: SourceSpan[] = [];
		for (const part of parts) {
			for (const span of part.spans)
				spans.push({ ...span, start: text.length + span.start, end: text.length + span.end });
			text += part.text;
		}
		return new SourceText(text, spans);
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
		if (!source.spans.length) {
			if (stripTerminalSequences(styled).trim()) this.fullyMapped = false;
			return styled;
		}
		for (const span of source.spans) this.contentRanges.push({ start: span.sourceStart, end: span.sourceEnd });
		styled = styled.replace(SELECTION_METADATA, "");
		if (source.spans.length === 1) {
			const span = source.spans[0];
			return (
				selectionRunMarker(
					span.end - span.start === span.sourceEnd - span.sourceStart
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
				const identity = span.end - span.start === span.sourceEnd - span.sourceStart;
				result += selectionRunMarker(
					identity
						? { kind: "identity", id: this.id, offset: span.sourceStart + position - span.start }
						: { kind: "atomic", id: this.id, start: span.sourceStart, end: span.sourceEnd },
				);
				activeSpan = spanIndex;
			} else if (!span && activeSpan !== -1) {
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
		return result + SELECTION_SOURCE_END;
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
