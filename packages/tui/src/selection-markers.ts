// Private render metadata. It follows text through wrapping and is removed before terminal output.
export const SELECTION_SOURCE_END = "\x1b]pi:se\x07";
export const SELECTION_METADATA = /\x1b]pi:(?:sd|sc|sr|sa|sg|se|sz);?[^\x07]*\x07/g;

/** Remove private selection annotations while preserving terminal colors and hyperlinks. */
export function stripSelectionMetadata(text: string): string {
	return text.replace(SELECTION_METADATA, "");
}

export type SelectionRun =
	| { kind: "identity"; id: number; offset: number }
	| { kind: "atomic" | "generated"; id: number; start: number; end: number };

export function selectionRunMarker(run: SelectionRun): string {
	return run.kind === "identity"
		? `\x1b]pi:sr;${run.id};${run.offset}\x07`
		: `\x1b]pi:${run.kind === "atomic" ? "sa" : "sg"};${run.id};${run.start};${run.end}\x07`;
}

export class SelectionSourceTracker {
	run: SelectionRun | undefined;

	process(code: string): boolean {
		if (code === SELECTION_SOURCE_END) {
			this.run = undefined;
			return true;
		}
		const match = /^\x1b]pi:(sr|sa|sg);(\d+);(\d+)(?:;(\d+))?\x07$/.exec(code);
		if (!match) return false;
		this.run =
			match[1] === "sr"
				? { kind: "identity", id: Number(match[2]), offset: Number(match[3]) }
				: {
						kind: match[1] === "sa" ? "atomic" : "generated",
						id: Number(match[2]),
						start: Number(match[3]),
						end: Number(match[4]),
					};
		return true;
	}

	advance(length: number): void {
		if (this.run?.kind === "identity") this.run.offset += length;
	}

	get marker(): string {
		return this.run ? selectionRunMarker(this.run) : "";
	}
}
