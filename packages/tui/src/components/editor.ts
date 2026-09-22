import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.ts";
import {
	appendDocument,
	changedInterval,
	document,
	type EditorDocument,
	EditorProjection,
	type EditorSegment,
	replaceDocument,
	sliceDocument,
} from "../editor-document.ts";
import { getKeybindings } from "../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../keys.ts";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";
import {
	autocompleteBoundaryRegex,
	autocompleteSeparatorRegex,
	cjkBreakRegex,
	getGraphemeSegmenter,
	getWordSegmenter,
	isWhitespaceChar,
	sliceByColumn,
	visibleWidth,
} from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.ts";

const graphemeSegmenter = getGraphemeSegmenter();
const wordSegmenter = getWordSegmenter();

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional segments with explicit `atomic` fold metadata.
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: EditorSegment[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments: EditorSegment[] = preSegmented ?? [...graphemeSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !seg.atomic && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// A wide grapheme cannot be split. Keep its source boundaries and
			// let rendering clip it when the terminal has only one cell.
			if ([...graphemeSegmenter.segment(grapheme)].length === 1) {
				chunks.push({ text: grapheme, startIndex: charIndex, endIndex: charIndex + grapheme.length });
				chunkStart = charIndex + grapheme.length;
				currentWidth = 0;
				continue;
			}
			// Fold labels can span narrow rows, but retain atomic caret boundaries.
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace
		// (multiple spaces join; the break point is after the last space),
		// or at a boundary where either side is CJK (CJK allows breaking
		// between any adjacent characters).
		const next = segments[i + 1];
		if (isWs && next && (next.atomic || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		} else if (!isWs && next && !isWhitespaceChar(next.segment)) {
			const isCjk = !seg.atomic && cjkBreakRegex.test(grapheme);
			const nextIsCjk = !next.atomic && cjkBreakRegex.test(next.segment);
			if (isCjk || nextIsCjk) {
				wrapOppIndex = next.index;
				wrapOppWidth = currentWidth;
			}
		}
	}

	// Push final chunk.
	if (chunkStart < line.length) {
		chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	}

	return chunks;
}

interface EditorSnapshot {
	readonly value: EditorDocument;
	readonly cursor: number;
}

/** In-memory draft; library instances must never be serialized or structured-cloned. */
export interface EditorDraft {
	readonly snapshot: EditorSnapshot;
	readonly undo: readonly EditorSnapshot[];
	readonly historyDraft: EditorSnapshot | null;
	readonly historyIndex: number;
	readonly scrollOffset: number;
	readonly lastAction: "kill" | "yank" | "type-word" | null;
	readonly preferredVisualCol: number | null;
	readonly verticalIntent: number | null;
}

interface VisualLine {
	from: number;
	to: number;
	text: string;
	last: boolean;
}

interface CompletionContext {
	provider: AutocompleteProvider;
	revision: number;
	cursor: number;
	from: number;
	to: number;
	lines: string[];
	line: number;
	col: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];
// Unquoted completions end at whitespace or CJK punctuation; quoted paths may contain either.
const unquotedAutocompleteSuffixRegex = new RegExp(`(?:(?!${autocompleteSeparatorRegex.source}).)*`, "u");

function escapeCharacterClass(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

function buildTriggerPattern(triggerCharacters: string[]): RegExp {
	return new RegExp(
		`${autocompleteBoundaryRegex.source}(?:@"[^"]*|[${triggerCharacters.map(escapeCharacterClass).join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

function buildDebouncePattern(triggerCharacters: string[]): RegExp {
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	return new RegExp(
		`${autocompleteBoundaryRegex.source}(?:@(?:"[^"]*|${unquotedAutocompleteSuffixRegex.source})|[${escapedWithoutAt.join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

function createScrollBorder(direction: "↑" | "↓", hiddenLineCount: number, width: number): string {
	const availableWidth = Math.max(0, width);
	const label = ` ${direction} ${hiddenLineCount} more `;
	const labelWidth = visibleWidth(label);
	if (labelWidth + 2 <= availableWidth) {
		const leftWidth = Math.floor((availableWidth - labelWidth) / 2);
		return "─".repeat(leftWidth) + label + "─".repeat(availableWidth - leftWidth - labelWidth);
	}

	const indicator = `─── ${direction} ${hiddenLineCount} more `;
	const remaining = availableWidth - visibleWidth(indicator);
	if (remaining >= 0) return indicator + "─".repeat(remaining);

	const ellipsis = "...".slice(0, availableWidth);
	const indicatorWidth = availableWidth - visibleWidth(ellipsis);
	return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}

export class Editor implements Component, Focusable {
	private value = document("");
	private cursor = 0;
	private revision = 0;
	private projectionValue?: EditorDocument;
	private projection?: EditorProjection;
	private completionContext?: CompletionContext;

	private get view(): EditorProjection {
		if (this.projectionValue !== this.value) {
			this.projectionValue = this.value;
			this.projection = new EditorProjection(this.value);
		}
		return this.projection!;
	}

	private get lines(): string[] {
		return this.view.text.toJSON();
	}
	private get projectedCursor(): number {
		return this.view.fromSource(this.cursor);
	}
	private get position(): { line: number; col: number } {
		const at = this.projectedCursor;
		const line = this.view.text.lineAt(at);
		return { line: line.number - 1, col: at - line.from };
	}

	private setProjectedCursor(at: number): void {
		this.cursor = this.view.toSource(at);
		this.preferredVisualCol = null;
		this.verticalIntent = null;
	}

	private change(
		from: number,
		to: number,
		insert = document(""),
		cursor = from + insert.text.length,
		notify = true,
	): void {
		const value = replaceDocument(this.value, from, to, insert);
		// A provider can select an interior source position without changing its text.
		this.value = {
			text: value.text,
			folds: value.folds.update({
				filterFrom: cursor,
				filterTo: cursor,
				filter: (a, b) => cursor <= a || cursor >= b,
			}),
		};
		this.cursor = cursor;
		this.revision++;
		this.preferredVisualCol = null;
		this.verticalIntent = null;
		if (notify) this.onChange?.(this.getText());
	}

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;

	// Store last render geometry for cursor navigation and mouse hit-testing.
	private lastWidth: number = 80;
	private renderedVisibleLineCount = 1;
	private renderedAutocompleteHeight = 0;

	// Vertical scrolling support
	private scrollOffset: number = 0;

	// Border color (can be changed dynamically)
	public borderColor: (str: string) => string;

	// Autocomplete support
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteTriggerCharacters = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
	private autocompleteTriggerPattern = buildTriggerPattern(this.autocompleteTriggerCharacters);
	private autocompleteDebouncePattern = buildDebouncePattern(this.autocompleteTriggerCharacters);
	private autocompleteList?: SelectList;
	private autocompleteState: "regular" | "force" | null = null;
	private autocompletePrefix: string = "";
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Prompt history for up/down navigation
	private history: string[] = [];
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	private historyDraft: EditorSnapshot | null = null;

	// Kill ring for Emacs-style kill/yank operations
	private killRing: EditorDocument[] = [];
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Character jump mode
	private jumpMode: "forward" | "backward" | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	private preferredVisualCol: number | null = null;

	// Intended projected offset before snapping a vertical move to a fold.
	// Resolve it against the current layout after a resize.
	private verticalIntent: number | null = null;

	// Undo support
	private undoStack: EditorSnapshot[] = [];

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
		this.setAutocompleteTriggerCharacters(provider.triggerCharacters ?? []);
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		// Limit history size
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	private isEditorEmpty(): boolean {
		return this.value.text.length === 0;
	}

	private isOnFirstVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	private navigateHistory(direction: 1 | -1): void {
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// Capture state when first entering history browsing mode
		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
			this.historyDraft = { value: this.value, cursor: this.cursor };
		}

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			const draft = this.historyDraft;
			this.historyDraft = null;
			if (draft) {
				this.value = draft.value;
				this.cursor = draft.cursor;
				this.revision++;
				this.preferredVisualCol = null;
				this.verticalIntent = null;
				this.scrollOffset = 0;
				if (this.onChange) this.onChange(this.getText());
			} else {
				this.setTextInternal("");
			}
		} else {
			this.setTextInternal(this.history[this.historyIndex] || "", direction === -1 ? "start" : "end");
		}
	}

	private exitHistoryBrowsing(): void {
		this.historyIndex = -1;
		this.historyDraft = null;
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	private setTextInternal(text: string, cursorPlacement: "start" | "end" = "end"): void {
		this.value = document(text);
		this.cursor = cursorPlacement === "start" ? 0 : this.value.text.length;
		this.revision++;
		this.preferredVisualCol = null;
		this.verticalIntent = null;
		this.scrollOffset = 0;
		this.onChange?.(this.getText());
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		const border = hiddenLineCount > 0 ? createScrollBorder("↑", hiddenLineCount, width) : "─".repeat(width);
		return this.borderColor(border);
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		const border = hiddenLineCount > 0 ? createScrollBorder("↓", hiddenLineCount, width) : "─".repeat(width);
		return this.borderColor(border);
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Store for cursor navigation (must match wrapping width)
		this.lastWidth = layoutWidth;

		// Layout the text
		const layoutLines = this.buildVisualLineMap(layoutWidth);
		const cursorLineIndex = this.findCurrentVisualLine(layoutLines);
		const projectedCursor = this.projectedCursor;

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// Adjust scroll offset to keep cursor visible
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		// Get visible lines slice
		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
		this.renderedVisibleLineCount = visibleLines.length;

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// Render top border (with scroll indicator if scrolled down)
		result.push(this.renderTopBorder(width, this.scrollOffset));

		// Render each visible layout line
		// Emit hardware cursor marker when focused so TUI can position the
		// hardware cursor for IME candidate-window placement even while
		// autocomplete (e.g. slash-command menu) is visible.
		const emitCursorMarker = this.focused;

		for (let i = 0; i < visibleLines.length; i++) {
			const layoutLine = visibleLines[i];
			let displayText = sliceByColumn(layoutLine.text, 0, layoutWidth, true);
			let lineVisibleWidth = visibleWidth(displayText);
			let cursorInPadding = false;

			// Add cursor if this line has it
			if (this.scrollOffset + i === cursorLineIndex) {
				const cursorPos = projectedCursor - layoutLine.from;
				const before = displayText.slice(0, cursorPos);
				const after = displayText.slice(cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					const afterGraphemes = this.view.segments(
						this.projectedCursor,
						this.projectedCursor + after.length,
						graphemeSegmenter,
					);
					const firstGrapheme = afterGraphemes.next().value?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
				} else {
					// Cursor is at the end - add highlighted space
					const cursor = "\x1b[7m \x1b[0m";
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					// If cursor overflows content width into the padding, flag it
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			// Calculate padding based on actual visible width
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// Render bottom border (with scroll indicator if more content below)
		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		result.push(this.renderBottomBorder(width, linesBelow));

		// Add autocomplete list if active
		this.renderedAutocompleteHeight = 0;
		if (this.autocompleteState && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(contentWidth);
			this.renderedAutocompleteHeight = autocompleteResult.length;
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const autocompleteStartRow = this.renderedVisibleLineCount + 2;
		if (
			this.autocompleteState &&
			this.autocompleteList &&
			event.y >= autocompleteStartRow &&
			event.y < autocompleteStartRow + this.renderedAutocompleteHeight
		) {
			const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
			const paddingX = Math.min(this.paddingX, maxPadding);
			const contentWidth = Math.max(1, event.width - paddingX * 2);
			const result = this.autocompleteList.handleMouse?.({
				...event,
				x: event.x - paddingX,
				y: event.y - autocompleteStartRow,
				width: contentWidth,
				height: this.renderedAutocompleteHeight,
			});
			return result ? { ...result, focus: true } : undefined;
		}

		// Leave press/drag/release unhandled so the renderer's screen-level text
		// selection can run over the editor rows (drag to select, release to copy).
		// The renderer synthesizes a click when press and release land on the same
		// cell without movement, which is the gesture that positions the cursor.
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y <= 0 || event.y > this.renderedVisibleLineCount) return { handled: true, focus: true };

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const visualLineIndex = this.scrollOffset + event.y - 1;
		const visualLine = visualLines[visualLineIndex];
		if (!visualLine) return { handled: true, focus: true };
		const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		this.setProjectedCursor(this.positionAtCell(visualLine, Math.max(0, event.x - paddingX)));
		this.lastAction = null;
		this.exitHistoryBrowsing();
		if (this.autocompleteState) this.updateAutocomplete();
		return { handled: true, focus: true };
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Handle character jump mode (awaiting next character to jump to)
		if (this.jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.jumpMode = null;
				return;
			}

			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
			if (printable !== undefined) {
				// Printable character - perform the jump
				const direction = this.jumpMode;
				this.jumpMode = null;
				this.jumpToChar(printable, direction);
				return;
			}

			// Control character - cancel and fall through to normal handling
			this.jumpMode = null;
		}

		// Handle bracketed paste mode
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				if (pasteContent.length > 0) {
					this.handlePaste(pasteContent);
				}
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			return;
		}

		// Ctrl+C - let parent handle (exit/clear)
		if (kb.matches(data, "tui.input.copy")) {
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// Handle autocomplete mode
		if (this.autocompleteState && this.autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}

			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.autocompleteList.handleInput(data);
				return;
			}

			if (kb.matches(data, "tui.input.tab") || kb.matches(data, "tui.select.confirm")) {
				const selected = this.autocompleteList.getSelectedItem();
				const submit = kb.matches(data, "tui.select.confirm") && this.autocompletePrefix.startsWith("/");
				if (selected) this.acceptCompletion(selected, this.autocompletePrefix, !submit);
				this.cancelAutocomplete();
				if (!submit) return;
			}
		}

		// Tab - trigger completion
		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			this.handleTabCompletion();
			return;
		}

		// Deletion actions
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToEndOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToStartOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.handleBackspace();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.handleForwardDelete();
			return;
		}

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// Dedicated history actions always browse entries instead of moving the cursor.
		if (kb.matches(data, "tui.editor.historyPrevious")) {
			this.cancelAutocomplete();
			this.navigateHistory(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.historyNext")) {
			this.cancelAutocomplete();
			this.navigateHistory(1);
			return;
		}

		// Cursor movement actions
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.moveToLineStart();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveToLineEnd();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// New line
		if (
			kb.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1)
		) {
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				this.handleBackspace();
				this.submitValue();
				return;
			}
			this.addNewLine();
			return;
		}

		// Submit (Enter)
		if (kb.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;

			// Workaround for terminals without Shift+Enter support:
			// If char before cursor is \, delete it and insert newline instead of submitting.
			const currentLine = this.lines[this.position.line] || "";
			if (this.position.col > 0 && currentLine[this.position.col - 1] === "\\") {
				this.handleBackspace();
				this.addNewLine();
				return;
			}

			this.submitValue();
			return;
		}

		// Arrow key navigation (with history support)
		if (kb.matches(data, "tui.editor.cursorUp")) {
			if (
				this.isOnFirstVisualLine() &&
				(this.isEditorEmpty() || this.historyIndex > -1 || this.position.col === 0)
			) {
				this.navigateHistory(-1);
			} else if (this.isOnFirstVisualLine()) {
				// Already at top - jump to start of line
				this.moveToLineStart();
			} else {
				this.moveCursor(-1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
				this.navigateHistory(1);
			} else if (this.isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				this.moveToLineEnd();
			} else {
				this.moveCursor(1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.moveCursor(0, 1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCursor(0, -1);
			return;
		}

		// Page up/down - scroll by page and move cursor
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.pageScroll(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.pageScroll(1);
			return;
		}

		// Character jump mode triggers
		if (kb.matches(data, "tui.editor.jumpForward")) {
			this.jumpMode = "forward";
			return;
		}
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = "backward";
			return;
		}

		// Shift+Space - insert regular space
		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}

		const printable = decodePrintableKey(data);
		if (printable !== undefined) {
			this.insertCharacter(printable);
			return;
		}

		// Regular characters
		if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	/** Canonical source text, including collapsed pastes. */
	getText(): string {
		return this.value.text.toString();
	}
	getExpandedText(): string {
		return this.getText();
	}
	getLines(): string[] {
		return this.value.text.toJSON();
	}
	getCursor(): { line: number; col: number } {
		const line = this.value.text.lineAt(this.cursor);
		return { line: line.number - 1, col: this.cursor - line.from };
	}

	saveDraft(): EditorDraft {
		return {
			snapshot: { value: this.value, cursor: this.cursor },
			undo: [...this.undoStack],
			historyDraft: this.historyDraft,
			historyIndex: this.historyIndex,
			scrollOffset: this.scrollOffset,
			lastAction: this.lastAction,
			preferredVisualCol: this.preferredVisualCol,
			verticalIntent: this.verticalIntent,
		};
	}

	restoreDraft(draft: EditorDraft): void {
		this.cancelAutocomplete();
		this.value = draft.snapshot.value;
		this.cursor = draft.snapshot.cursor;
		this.undoStack = [...draft.undo];
		this.historyDraft = draft.historyDraft;
		this.historyIndex = draft.historyIndex;
		this.scrollOffset = draft.scrollOffset;
		this.revision++;
		this.lastAction = draft.lastAction;
		this.preferredVisualCol = draft.preferredVisualCol;
		this.verticalIntent = draft.verticalIntent;
		this.onChange?.(this.getText());
	}

	setText(text: string): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		const normalized = this.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		if (this.value.folds.size > 0 || this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		this.change(this.cursor, this.cursor, document(this.normalizeText(text)));
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	private normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.exitHistoryBrowsing();

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		this.change(this.cursor, this.cursor, document(char));

		// Check if we should trigger or update autocomplete
		if (!this.autocompleteState) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries
			else if (this.autocompleteTriggerCharacters.includes(char)) {
				const textBeforeCursor = this.editableBeforeCursor();
				if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
			}
			// Also auto-trigger when typing letters in a slash command or symbol completion context
			else if (/[a-zA-Z0-9.\-_]/.test(char) || cjkBreakRegex.test(char)) {
				const textBeforeCursor = this.editableBeforeCursor();
				// Check if we're in a slash command (with or without space for arguments)
				if (this.isInSlashCommandContext(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
				// Check if we're in a symbol-based completion context like @, #, or provider triggers
				else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.updateAutocomplete();
		}
	}

	private handlePaste(pastedText: string): void {
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.lastAction = null;

		this.pushUndoSnapshot();

		// Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
		// control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
		// (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
		// per-char filter below preserves newlines instead of stripping ESC and
		// leaking the printable tail (e.g. "[106;5u") into the editor.
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});

		// Clean the pasted text: normalize line endings, expand tabs
		const cleanText = this.normalizeText(decodedText);

		// Filter out non-printable characters except newlines
		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");
		if (!filteredText) return;

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.lines[this.position.line] || "";
			const charBeforeCursor = this.position.col > 0 ? currentLine[this.position.col - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		const collapsed = filteredText.split("\n").length > 10 || filteredText.length > 1000;
		this.change(this.cursor, this.cursor, document(filteredText, collapsed));
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.lastAction = null;
		this.pushUndoSnapshot();
		this.change(this.cursor, this.cursor, document("\n"));
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.lines[this.position.line] || "";
		return this.position.col > 0 && currentLine[this.position.col - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const result = this.getText().trim();

		this.value = document("");
		this.cursor = 0;
		this.revision++;
		this.exitHistoryBrowsing();
		this.scrollOffset = 0;
		this.undoStack.length = 0;
		this.lastAction = null;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	private adjacentPosition(direction: -1 | 1): number {
		const at = this.projectedCursor;
		const line = this.view.text.lineAt(at);
		if (direction < 0) {
			if (at === line.from) return Math.max(0, at - 1);
			const segments = [...this.view.segments(line.from, at, graphemeSegmenter)];
			return line.from + (segments.at(-1)?.index ?? 0);
		}
		if (at === line.to) return Math.min(this.view.text.length, at + 1);
		return at + (this.view.segments(at, line.to, graphemeSegmenter).next().value?.segment.length ?? 1);
	}

	private handleBackspace(): void {
		this.deleteCharacter(-1);
	}
	private handleForwardDelete(): void {
		this.deleteCharacter(1);
	}

	private deleteCharacter(direction: -1 | 1): void {
		this.exitHistoryBrowsing();
		this.lastAction = null;
		const target = this.view.toSource(this.adjacentPosition(direction));
		if (target !== this.cursor) {
			this.pushUndoSnapshot();
			this.change(Math.min(target, this.cursor), Math.max(target, this.cursor));
		} else this.onChange?.(this.getText());
		if (this.autocompleteState) this.updateAutocomplete();
		else {
			const before = this.editableBeforeCursor();
			if (this.isInSlashCommandContext(before) || this.autocompleteTriggerPattern.test(before)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		this.setProjectedCursor(this.view.text.lineAt(this.projectedCursor).from);
		if (this.autocompleteState) this.updateAutocomplete();
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		this.setProjectedCursor(this.view.text.lineAt(this.projectedCursor).to);
		if (this.autocompleteState) this.updateAutocomplete();
	}

	private killTo(projected: number): void {
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		const target = this.view.toSource(projected);
		const from = Math.min(this.cursor, target);
		const to = Math.max(this.cursor, target);
		if (from !== to) {
			this.pushUndoSnapshot();
			const fragment = sliceDocument(this.value, from, to);
			const previous = this.lastAction === "kill" ? this.killRing.pop() : undefined;
			this.killRing.push(
				previous
					? target < this.cursor
						? appendDocument(fragment, previous)
						: appendDocument(previous, fragment)
					: fragment,
			);
			this.lastAction = "kill";
			this.change(from, to);
		} else this.onChange?.(this.getText());
	}

	private deleteToStartOfLine(): void {
		const at = this.projectedCursor;
		const line = this.view.text.lineAt(at);
		this.killTo(at === line.from ? Math.max(0, at - 1) : line.from);
	}

	private deleteToEndOfLine(): void {
		const at = this.projectedCursor;
		const line = this.view.text.lineAt(at);
		this.killTo(at === line.to ? Math.min(this.view.text.length, at + 1) : line.to);
	}

	private wordPosition(direction: -1 | 1): number {
		const at = this.projectedCursor;
		const line = this.view.text.lineAt(at);
		if ((direction < 0 && at === line.from) || (direction > 0 && at === line.to))
			return this.adjacentPosition(direction);
		const start = direction < 0 ? line.from : at;
		const end = direction < 0 ? at : line.to;
		const text = this.view.text.sliceString(start, end);
		const options = {
			segment: () => this.view.segments(start, end, wordSegmenter),
			isAtomicSegment: (_text: string, index: number) =>
				this.view.pieces.some((piece) => piece.atomic && piece.start === start + index),
		};
		return start + (direction < 0 ? findWordBackward(text, text.length, options) : findWordForward(text, 0, options));
	}

	private deleteWordBackwards(): void {
		this.killTo(this.wordPosition(-1));
	}
	private deleteWordForward(): void {
		this.killTo(this.wordPosition(1));
	}
	private moveWordBackwards(): void {
		this.moveWord(-1);
	}
	private moveWordForwards(): void {
		this.moveWord(1);
	}
	private moveWord(direction: -1 | 1): void {
		this.lastAction = null;
		this.setProjectedCursor(this.wordPosition(direction));
		if (this.autocompleteState) this.updateAutocomplete();
	}

	private buildVisualLineMap(width: number): VisualLine[] {
		const rows: VisualLine[] = [];
		let from = 0;
		for (const line of this.lines) {
			const chunks = wordWrapLine(line, width, [...this.view.segments(from, from + line.length, graphemeSegmenter)]);
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				rows.push({
					from: from + chunk.startIndex,
					to: from + chunk.endIndex,
					text: chunk.text,
					last: i === chunks.length - 1,
				});
			}
			from += line.length + 1;
		}
		return rows;
	}

	private findVisualLineAt(rows: VisualLine[], at: number): number {
		const index = rows.findIndex((row) => at >= row.from && (at < row.to || (row.last && at === row.to)));
		return index < 0 ? rows.length - 1 : index;
	}

	private findCurrentVisualLine(rows: VisualLine[]): number {
		return this.findVisualLineAt(rows, this.projectedCursor);
	}

	private positionAtCell(row: VisualLine, cell: number): number {
		let column = 0;
		let last = row.from;
		for (const segment of graphemeSegmenter.segment(row.text)) {
			last = row.from + segment.index;
			column += visibleWidth(segment.segment);
			if (cell < column) return last;
		}
		return row.last ? row.to : last;
	}

	private maxCell(row: VisualLine): number {
		const end = row.last ? row.to : this.positionAtCell(row, Number.POSITIVE_INFINITY);
		return visibleWidth(this.view.text.sliceString(row.from, end));
	}

	private moveToVisualLine(rows: VisualLine[], current: number, target: number): void {
		const sourceAt = this.verticalIntent ?? this.projectedCursor;
		const source = rows[this.findVisualLineAt(rows, sourceAt)];
		const row = rows[target];
		if (!source || !row) return;
		const cell = visibleWidth(this.view.text.sliceString(source.from, sourceAt));
		const desired = this.computeVerticalMoveColumn(cell, this.maxCell(source), this.maxCell(row));
		let at = this.positionAtCell(row, desired);
		let mapped = this.view.fromSource(this.view.toSource(at));
		// A label may span several narrow rows, but its interior has no caret stops.
		if (target > current && mapped < row.from) {
			while (target < rows.length - 1 && mapped < rows[target].from) {
				target++;
				at = this.positionAtCell(rows[target], desired);
				mapped = this.view.fromSource(this.view.toSource(at));
			}
			if (mapped < rows[target].from) {
				at = rows[target].to;
				mapped = this.view.fromSource(this.view.toSource(at, 1));
			}
		}
		this.cursor = this.view.toSource(mapped);
		this.verticalIntent = mapped === at ? null : at;
		if (this.autocompleteState) this.updateAutocomplete();
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		this.lastAction = null;
		const rows = this.buildVisualLineMap(this.lastWidth);
		const current = this.findCurrentVisualLine(rows);
		if (deltaLine !== 0 && current + deltaLine >= 0 && current + deltaLine < rows.length) {
			this.moveToVisualLine(rows, current, current + deltaLine);
		}
		if (deltaCol !== 0) {
			const previous = this.projectedCursor;
			const at = this.adjacentPosition(deltaCol < 0 ? -1 : 1);
			this.setProjectedCursor(at);
			if (deltaCol > 0 && previous === this.view.text.length) {
				this.preferredVisualCol = visibleWidth(this.view.text.sliceString(rows[current].from, at));
			}
			if (this.autocompleteState) this.updateAutocomplete();
		}
	}

	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const rows = this.buildVisualLineMap(this.lastWidth);
		const current = this.findCurrentVisualLine(rows);
		const size = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		this.moveToVisualLine(rows, current, Math.max(0, Math.min(rows.length - 1, current + direction * size)));
	}

	private yank(): void {
		const fragment = this.killRing.at(-1);
		if (!fragment) return;
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.pushUndoSnapshot();
		this.change(this.cursor, this.cursor, fragment);
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;
		this.pushUndoSnapshot();
		const previous = this.killRing.pop()!;
		this.killRing.unshift(previous);
		this.change(this.cursor - previous.text.length, this.cursor, this.killRing.at(-1)!);
		this.lastAction = "yank";
	}

	private pushUndoSnapshot(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		this.exitHistoryBrowsing();
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.cancelAutocomplete();
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.revision++;
		this.lastAction = null;
		this.preferredVisualCol = null;
		this.verticalIntent = null;
		this.onChange?.(this.getText());
	}

	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.lastAction = null;
		const text = this.view.text.toString();
		const at = this.projectedCursor;
		const forward = direction === "forward";
		let searchFrom = at + (forward ? 1 : -1);
		while (searchFrom >= 0 && searchFrom < text.length) {
			const found = forward ? text.indexOf(char, searchFrom) : text.lastIndexOf(char, searchFrom);
			if (found < 0) break;
			const fold = this.view.pieces.find((piece) => piece.atomic && piece.start <= found && found < piece.end);
			const segment = fold ? undefined : graphemeSegmenter.segment(text).containing(found);
			const start = fold?.start ?? segment!.index;
			const end = fold?.end ?? start + segment!.segment.length;
			if (forward ? start > at : start < at) {
				this.setProjectedCursor(start);
				break;
			}
			searchFrom = forward ? end : start - 1;
		}
		if (this.autocompleteState) this.updateAutocomplete();
	}

	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// Cases 2 and 7
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			return targetMaxVisualCol;
		}

		// Case 3
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	// Slash menu only allowed on the first line of the editor
	private isSlashMenuAllowed(): boolean {
		if (this.value.text.lineAt(this.cursor).number !== 1) return false;
		for (const i = this.value.folds.iter(); i.value; i.next()) if (i.from < this.cursor) return false;
		return true;
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	private isAtStartOfMessage(): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const beforeCursor = this.editableBeforeCursor();
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// Autocomplete methods
	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		const list = new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
		list.onSelect = (selected) => {
			this.acceptCompletion(selected, this.autocompletePrefix);
			this.cancelAutocomplete();
		};
		return list;
	}

	private editableBounds(): { from: number; to: number } | undefined {
		const line = this.value.text.lineAt(this.cursor);
		let from = line.from;
		let to = line.to;
		for (const i = this.value.folds.iter(); i.value; i.next()) {
			if (i.to <= this.cursor) from = Math.max(from, i.to);
			else if (i.from >= this.cursor) {
				to = Math.min(to, i.from);
				break;
			} else return undefined;
		}
		return { from, to };
	}

	private editableBeforeCursor(): string {
		const bounds = this.editableBounds();
		return bounds ? this.value.text.sliceString(bounds.from, this.cursor) : "";
	}

	private captureCompletion(): CompletionContext | undefined {
		const provider = this.autocompleteProvider;
		if (!provider) return undefined;
		const bounds = provider.inputContext === "line" ? this.editableBounds() : { from: 0, to: this.value.text.length };
		if (!bounds) return undefined;
		const text = this.value.text.slice(bounds.from, bounds.to);
		const line = text.lineAt(this.cursor - bounds.from);
		return {
			provider,
			revision: this.revision,
			cursor: this.cursor,
			...bounds,
			lines: text.toJSON(),
			line: line.number - 1,
			col: this.cursor - bounds.from - line.from,
		};
	}

	private completionIsCurrent(context: CompletionContext): boolean {
		return (
			context.provider === this.autocompleteProvider &&
			context.revision === this.revision &&
			context.cursor === this.cursor
		);
	}

	private prefixIsEditable(context: CompletionContext, prefix: string): boolean {
		const from = context.cursor - prefix.length;
		if (from < context.from) return false;
		let editable = true;
		this.value.folds.between(from, context.cursor, (a, b) => {
			if (from < b && context.cursor > a) editable = false;
		});
		return editable;
	}

	private acceptCompletion(
		item: { value: string; label: string; description?: string },
		prefix: string,
		notify = true,
	): void {
		const context = this.completionContext;
		if (!context || !this.completionIsCurrent(context) || !this.prefixIsEditable(context, prefix)) return;
		const result = context.provider.applyCompletion(context.lines, context.line, context.col, item, prefix);
		const text = result.lines.join("\n");
		const cursor =
			context.from +
			result.lines.slice(0, result.cursorLine).reduce((n, line) => n + line.length + 1, 0) +
			result.cursorCol;
		const before = this.value.text.sliceString(context.from, context.to);
		const diff = changedInterval(before, text);
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		this.change(context.from + diff.from, context.from + diff.to, document(diff.insert), cursor, notify);
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const beforeCursor = this.editableBeforeCursor();

		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;

		const context = this.captureCompletion();
		if (!context) return;
		if (
			options.force &&
			context.provider.shouldTriggerFileCompletion &&
			!context.provider.shouldTriggerFileCompletion(context.lines, context.line, context.col, {
				slashCommands: this.isSlashMenuAllowed(),
			})
		)
			return;

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, context, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, context, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		context: CompletionContext,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			await previousTask;
			if (startToken !== this.autocompleteStartToken || !this.completionIsCurrent(context)) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			await this.runAutocompleteRequest(requestId, controller, context, options);
		})();
		await this.autocompleteRequestTask;
	}

	private setAutocompleteTriggerCharacters(triggerCharacters: string[]): void {
		const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
		for (const character of triggerCharacters) {
			if (character.length !== 1 || character === "/" || isWhitespaceChar(character) || next.includes(character)) {
				continue;
			}
			next.push(character);
		}
		this.autocompleteTriggerCharacters = next;
		this.autocompleteTriggerPattern = buildTriggerPattern(next);
		this.autocompleteDebouncePattern = buildDebouncePattern(next);
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const textBeforeCursor = this.editableBeforeCursor();
		return this.autocompleteDebouncePattern.test(textBeforeCursor) ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		context: CompletionContext,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const suggestions = await context.provider.getSuggestions(context.lines, context.line, context.col, {
			signal: controller.signal,
			force: options.force,
			slashCommands: this.isSlashMenuAllowed(),
		});
		if (controller.signal.aborted || requestId !== this.autocompleteRequestId || !this.completionIsCurrent(context))
			return;
		this.autocompleteAbort = undefined;
		if (
			!suggestions ||
			!Array.isArray(suggestions.items) ||
			!suggestions.items.length ||
			!this.prefixIsEditable(context, suggestions.prefix)
		) {
			this.cancelAutocomplete();
			this.tui.requestRender();
			return;
		}
		this.completionContext = context;
		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			this.acceptCompletion(suggestions.items[0], suggestions.prefix);
			this.cancelAutocomplete();
		} else this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestRender();
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
		this.completionContext = undefined;
	}

	private cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
