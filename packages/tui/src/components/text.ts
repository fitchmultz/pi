import { isRenderingForSelectionReader, SelectionSource, SourceText } from "../selection-source.ts";
import type { Component } from "../tui.ts";
import {
	applyBackgroundToLine,
	flattenLines,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils.ts";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	// Whether the cached lines carry selection sources. Only a selection reader's render gets such lines.
	private cachedForSelectionReader = false;
	// Source of the last render for a selection reader. Other renders leave it alone: that frame may still be selected.
	private selectionSource?: SelectionSource;

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		// Renderers often set the same text on every update; keep the wrapped lines then.
		if (text === this.text) return;
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const forSelectionReader = isRenderingForSelectionReader();
		// Check cache
		if (
			this.cachedLines &&
			this.cachedText === this.text &&
			this.cachedWidth === width &&
			this.cachedForSelectionReader === forSelectionReader
		) {
			return this.cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			if (forSelectionReader) this.selectionSource = undefined;
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			this.cachedForSelectionReader = forSelectionReader;
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = this.text.replace(/\r\n?/g, "\n").replace(/\t/g, "   ");
		if (forSelectionReader) this.selectionSource = new SelectionSource(stripTerminalSequences(this.text));
		const selectionSource = forSelectionReader ? this.selectionSource : undefined;

		// Reduce margins when necessary so content and padding fit within the available width.
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = wrapTextWithAnsi(
			selectionSource
				? selectionSource.annotate(
						normalizedText,
						new SourceText(selectionSource.text).replace(/\r\n?/g, "\n").replace(/\t/g, "   "),
					)
				: normalizedText,
			contentWidth,
		);

		// Add margins and background to each line
		const leftMargin = " ".repeat(paddingX);
		const rightMargin = " ".repeat(paddingX);
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			// Add margins
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			if (this.customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
			} else {
				// No background - just pad to width with spaces
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const lines = [...emptyLines, ...contentLines, ...emptyLines];
		const result = selectionSource?.wrap(lines) ?? lines;
		flattenLines(result);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;
		this.cachedForSelectionReader = forSelectionReader;

		return result.length > 0 ? result : [""];
	}
}
