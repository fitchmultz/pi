import { type Component, type Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";

const INLINE_IMAGE = /\x1b(?:_G|\]1337;File=)/;

/** Handled mouse dispatch receipt targeting `component` at `event`'s origin and bounds. */
export function handledMouseTarget(
	component: Component,
	event: TuiMouseEvent,
): NonNullable<ReturnType<Container["handleMouse"]>> {
	return {
		handled: true,
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/**
 * The collapsed form of a card in compact view: at most two rows of the card's native rendering.
 * The card keeps rendering natively, so its child layouts stay live for inner clicks and asynchronous renderers.
 */
export class CompactPreview {
	/** Native row of each preview row. */
	private rows: number[] = [];
	private nativeHeight = 0;
	private cache?: { width: number; source: string[]; resultStart: number; lines: string[] };

	/**
	 * Cut the native lines to their first non-blank row and one more: the first non-blank row from `resultStart`
	 * on, so a wrapping call cannot crowd out its result, else the next non-blank row. Rows are truncated to
	 * `width` and an inline image becomes `[image]`. Unchanged input returns the previous array.
	 */
	render(source: string[], width: number, resultStart = 0): string[] {
		const cached = this.cache;
		if (
			cached?.width === width &&
			cached.resultStart === resultStart &&
			cached.source.length === source.length &&
			cached.source.every((line, i) => line === source[i])
		) {
			return cached.lines;
		}
		const rows = source.flatMap((line, y) => (INLINE_IMAGE.test(line) || stripAnsi(line).trim() ? [y] : []));
		const second = rows.find((y) => y > rows[0] && y >= resultStart) ?? rows[1];
		this.rows = [rows[0], second].filter((y) => y !== undefined);
		this.nativeHeight = source.length;
		const lines = this.rows.map((y) => {
			const line = source[y];
			const imageStart = line.search(INLINE_IMAGE);
			return truncateToWidth(
				imageStart === -1 ? line : stripAnsi(line.slice(0, imageStart)) + theme.fg("muted", "[image]"),
				width,
			);
		});
		this.cache = { width, source, resultStart, lines };
		return lines;
	}

	/** The event moved to the native row behind its preview row; undefined outside the preview. */
	toNative(event: TuiMouseEvent): TuiMouseEvent | undefined {
		const y = this.rows[event.y];
		return y === undefined ? undefined : { ...event, y, height: this.nativeHeight };
	}

	/** Forget the last preview, for example after a theme change. */
	reset(): void {
		this.cache = undefined;
	}
}
