import { ChangeSet, type Range, RangeSet, RangeValue, Text } from "@codemirror/state";

/** Exclusive boundaries keep typing beside a collapsed paste outside its payload. */
class Fold extends RangeValue {
	startSide = 1;
	endSide = -1;
}
const fold = new Fold();

export interface EditorDocument {
	readonly text: Text;
	readonly folds: RangeSet<Fold>;
}

export function document(text: string | Text, collapsed = false): EditorDocument {
	const value = typeof text === "string" ? Text.of(text.split("\n")) : text;
	return {
		text: value,
		folds: collapsed && value.length ? RangeSet.of([fold.range(0, value.length)]) : RangeSet.empty,
	};
}

export function replaceDocument(
	value: EditorDocument,
	from: number,
	to: number,
	insert: EditorDocument = document(""),
): EditorDocument {
	const changes = ChangeSet.of({ from, to, insert: insert.text }, value.text.length);
	// Mapping alone retains partially replaced ranges. An edit inside a fold unfolds it.
	const surviving = value.folds
		.update({
			filter: (a, b) => !(from === to ? a < from && from < b : from < b && to > a),
		})
		.map(changes);
	const add = [];
	for (const i = insert.folds.iter(); i.value; i.next()) add.push(fold.range(from + i.from, from + i.to));
	return { text: changes.apply(value.text), folds: surviving.update({ add, sort: true }) };
}

export function sliceDocument(value: EditorDocument, from: number, to: number): EditorDocument {
	const ranges: Range<Fold>[] = [];
	value.folds.between(from, to, (a, b) => {
		if (a >= from && b <= to) ranges.push(fold.range(a - from, b - from));
	});
	return { text: value.text.slice(from, to), folds: RangeSet.of(ranges) };
}

export function appendDocument(left: EditorDocument, right: EditorDocument): EditorDocument {
	return replaceDocument(left, left.text.length, left.text.length, right);
}

interface ProjectionPiece {
	from: number;
	to: number;
	start: number;
	end: number;
	atomic: boolean;
}

export interface EditorSegment extends Intl.SegmentData {
	atomic?: boolean;
}

/** Read-only geometry derived from the source and its explicit folds. */
export class EditorProjection {
	readonly text: Text;
	readonly pieces: ProjectionPiece[] = [];

	constructor(value: EditorDocument) {
		const parts: string[] = [];
		let source = 0;
		let projected = 0;
		let number = 0;
		const add = (text: string, from: number, to: number, atomic: boolean) => {
			parts.push(text);
			this.pieces.push({ from, to, start: projected, end: projected + text.length, atomic });
			projected += text.length;
		};
		for (const i = value.folds.iter(); i.value; i.next()) {
			if (source < i.from) add(value.text.sliceString(source, i.from), source, i.from, false);
			const lines = value.text.lineAt(i.to).number - value.text.lineAt(i.from).number + 1;
			const label = lines > 10 ? `+${lines} lines` : `${i.to - i.from} chars`;
			add(`[paste #${++number} ${label}]`, i.from, i.to, true);
			source = i.to;
		}
		if (source < value.text.length) add(value.text.sliceString(source), source, value.text.length, false);
		this.text = Text.of(parts.join("").split("\n"));
	}

	toSource(position: number, bias: -1 | 1 = -1): number {
		for (const p of this.pieces) {
			if (position < p.start || position > p.end) continue;
			if (!p.atomic) return p.from + position - p.start;
			return position === p.end || (position > p.start && bias > 0) ? p.to : p.from;
		}
		return this.pieces.at(-1)?.to ?? 0;
	}

	fromSource(position: number): number {
		for (const p of this.pieces) {
			if (position < p.from || position > p.to) continue;
			return p.atomic ? (position === p.to ? p.end : p.start) : p.start + position - p.from;
		}
		return this.text.length;
	}

	segments(from: number, to: number, segmenter: Intl.Segmenter): EditorSegment[] {
		const result: EditorSegment[] = [];
		const input = this.text.sliceString(from, to);
		let at = from;
		const plain = (end: number) => {
			for (const s of segmenter.segment(this.text.sliceString(at, end))) {
				result.push({ ...s, input, index: at - from + s.index });
			}
			at = end;
		};
		for (const p of this.pieces) {
			if (!p.atomic || p.end <= from || p.start >= to) continue;
			if (at < p.start) plain(p.start);
			const end = Math.min(p.end, to);
			result.push({ segment: this.text.sliceString(at, end), index: at - from, input, atomic: true });
			at = end;
		}
		plain(to);
		return result;
	}
}

/** Adapt whole-document providers without deriving fold identity from equal text. */
export function changedInterval(before: string, after: string): { from: number; to: number; insert: string } {
	const block = 4096;
	const limit = Math.min(before.length, after.length);
	let from = 0;
	while (from + block <= limit && before.slice(from, from + block) === after.slice(from, from + block)) from += block;
	while (from < limit && before.charCodeAt(from) === after.charCodeAt(from)) from++;
	let to = before.length;
	let end = after.length;
	while (to - from >= block && end - from >= block && before.slice(to - block, to) === after.slice(end - block, end)) {
		to -= block;
		end -= block;
	}
	while (to > from && end > from && before.charCodeAt(to - 1) === after.charCodeAt(end - 1)) {
		to--;
		end--;
	}
	return { from, to, insert: after.slice(from, end) };
}
