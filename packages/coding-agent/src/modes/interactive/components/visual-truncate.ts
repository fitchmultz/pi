import { type Component, stripSelectionMetadata, Text, truncateToWidth } from "@earendil-works/pi-tui";

export interface VisualTruncateResult {
	visualLines: string[];
	skippedCount: number;
}

/**
 * Return a styled visual-line snapshot. Its Text is discarded, so inside a fullscreen frame the lines are detached
 * from that Text's selection source. Retained components use Text directly to keep the source alive.
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX = 0,
	keep: "start" | "end" = "end",
): VisualTruncateResult {
	const allLines = new Text(text, paddingX, 0).render(width).map(stripSelectionMetadata);
	const skippedCount = Math.max(0, allLines.length - maxVisualLines);
	const visualLines =
		skippedCount === 0
			? allLines
			: keep === "start"
				? allLines.slice(0, maxVisualLines)
				: allLines.slice(-maxVisualLines);
	return { visualLines, skippedCount };
}

export interface VisualLinePreviewOptions {
	/** Styled text; may contain newlines. */
	text: string;
	maxVisualLines: number;
	/** Which visual lines to keep. The hint goes before kept end lines and after kept start lines. */
	keep: "start" | "end";
	/** Styled hint line for the given number of hidden visual lines. */
	formatHint: (hidden: number) => string;
}

/**
 * Collapsed tool output limited to a number of visual lines, like bash output. Limiting logical
 * lines instead lets a single long line (such as minified JSON) wrap across the whole screen.
 * Caches its lines per width, since it renders on every frame for every result in the transcript.
 */
export class VisualLinePreview implements Component {
	private options: VisualLinePreviewOptions;
	private readonly text: Text;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: VisualLinePreviewOptions) {
		this.options = options;
		this.text = new Text(options.text, 0, 0);
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			const { maxVisualLines, keep, formatHint } = this.options;
			const allLines = this.text.render(width);
			const skippedCount = Math.max(0, allLines.length - maxVisualLines);
			const lines =
				skippedCount > 0
					? keep === "start"
						? allLines.slice(0, maxVisualLines)
						: allLines.slice(-maxVisualLines)
					: allLines;
			if (skippedCount > 0) {
				const hint = truncateToWidth(formatHint(skippedCount), width, "...");
				this.cachedLines = keep === "start" ? [...lines, hint] : [hint, ...lines];
			} else {
				this.cachedLines = lines;
			}
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.text.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
