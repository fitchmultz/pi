import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

export type ScrollViewScrollbar = "hidden" | "auto" | "always";

export interface ScrollViewOptions {
	axis?: "vertical";
	follow?: "none" | "start" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarTrackStyle?: (text: string) => string;
	scrollbarThumbStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
}

export interface ScrollViewScrollToOptions {
	/** Keep following disabled even when the target is the configured follow edge. */
	disableFollow?: boolean;
}

export class ScrollView extends Container {
	private readonly child: Component;
	private follow: "none" | "start" | "end";
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarTrackStyle: (text: string) => string;
	readonly scrollbarThumbStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	private currentScrollTop = 0;
	private contentHeight = 0;
	private currentViewportHeight = 0;
	private following: boolean;
	private followSuppressed = false;
	private previousContentLines: readonly string[] | undefined;
	private rowChange: { start: number; oldEnd: number; newEnd: number; retained: Map<number, number> } | undefined;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;

	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		this.child = component;
		this.children.push(component);
		this.follow = options.follow ?? "none";
		this.following = this.follow !== "none";
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.currentScrollbar = options.scrollbar ?? "hidden";
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => `\x1b[90m${text}\x1b[39m`);
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => `\x1b[37m${text}\x1b[39m`);
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	get scrollTop(): number {
		return this.currentScrollTop;
	}

	get followEnd(): boolean {
		return this.follow === "end";
	}

	get followStart(): boolean {
		return this.follow === "start";
	}

	get isFollowingEnd(): boolean {
		return this.followEnd && this.following;
	}

	get isFollowingStart(): boolean {
		return this.followStart && this.following;
	}

	/** Change the followed edge and immediately return to it. "none" preserves the current offset. */
	setFollow(follow: "none" | "start" | "end"): void {
		if (this.follow === follow) return;
		this.follow = follow;
		this.previousContentLines = undefined;
		this.rowChange = undefined;
		this.followSuppressed = false;
		this.following = follow !== "none";
		if (follow === "start") this.scrollToStart();
		else if (follow === "end") this.scrollToEnd();
		this.requestRenderCallback?.();
	}

	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return (
			this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible
		);
	}

	get isScrollbarActive(): boolean {
		return this.scrollbarActive;
	}

	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	private markScrollbarActivity(): void {
		if (this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight) return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		const atFollowEdge = this.followStart ? next === 0 : this.followEnd && next === maxScrollTop;
		const nextFollowSuppressed = options.disableFollow === true && atFollowEdge;
		const nextFollowing = !nextFollowSuppressed && atFollowEdge;
		if (
			next === this.currentScrollTop &&
			nextFollowing === this.following &&
			nextFollowSuppressed === this.followSuppressed
		) {
			return;
		}
		const moved = next !== this.currentScrollTop;
		this.currentScrollTop = next;
		this.following = nextFollowing;
		this.followSuppressed = nextFollowSuppressed;
		if (moved) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		const start = this.currentScrollTop;
		this.scrollTo(start + requested);
		return requested - (this.currentScrollTop - start);
	}

	scrollToStart(): void {
		this.scrollTo(0);
	}

	scrollToEnd(): void {
		this.scrollTo(Math.max(0, this.contentHeight - this.currentViewportHeight));
	}

	/** Map an unchanged row from the previous layout; edited/deleted rows have no stable position. */
	rebaseContentRow(row: number): number | undefined {
		const change = this.rowChange;
		if (!change || row < change.start) return row;
		if (row >= change.oldEnd) return row + change.newEnd - change.oldEnd;
		return change.retained.get(row);
	}

	updateLayout(
		contentHeight: number,
		viewportHeight: number,
		requestRender: () => void,
		contentLines?: readonly string[],
	): void {
		this.rowChange = undefined;
		if (this.followStart && contentLines) {
			const previous = this.previousContentLines;
			if (previous) {
				let oldEnd = previous.length;
				let newEnd = contentLines.length;
				while (oldEnd > 0 && newEnd > 0 && previous[oldEnd - 1] === contentLines[newEnd - 1]) {
					oldEnd--;
					newEnd--;
				}
				let start = 0;
				while (start < oldEnd && start < newEnd && previous[start] === contentLines[start]) start++;
				// Coalesced tool updates can change both ends around an unchanged middle.
				// Shared unique rows anchor that middle; equal neighbors retain repeated detail rows.
				const oldRows = new Map<string, number>();
				const newRows = new Map<string, number>();
				for (let row = start; row < oldEnd; row++) {
					const line = previous[row]!;
					oldRows.set(line, oldRows.has(line) ? -1 : row);
				}
				for (let row = start; row < newEnd; row++) {
					const line = contentLines[row]!;
					newRows.set(line, newRows.has(line) ? -1 : row);
				}
				const retained = new Map<number, number>();
				const claimed = new Set<number>();
				for (const [line, oldRow] of oldRows) {
					const newRow = newRows.get(line);
					if (oldRow < 0 || newRow === undefined || newRow < 0 || retained.has(oldRow) || claimed.has(newRow)) {
						continue;
					}
					retained.set(oldRow, newRow);
					claimed.add(newRow);
					for (const direction of [-1, 1]) {
						let before = oldRow + direction;
						let after = newRow + direction;
						while (
							before >= start &&
							before < oldEnd &&
							after >= start &&
							after < newEnd &&
							!retained.has(before) &&
							!claimed.has(after) &&
							previous[before] === contentLines[after]
						) {
							retained.set(before, after);
							claimed.add(after);
							before += direction;
							after += direction;
						}
					}
				}
				this.rowChange = { start, oldEnd, newEnd, retained };
				if (!this.following) {
					this.currentScrollTop = this.rebaseContentRow(this.currentScrollTop) ?? this.currentScrollTop;
				}
			}
			this.previousContentLines = [...contentLines];
		}
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		if (this.isFollowingEnd) this.currentScrollTop = maxScrollTop;
		else if (this.isFollowingStart) this.currentScrollTop = 0;
		else this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		const atFollowEdge = this.followStart
			? this.currentScrollTop === 0
			: this.followEnd && this.currentScrollTop === maxScrollTop;
		if (!atFollowEdge) this.followSuppressed = false;
		this.following = atFollowEdge && !this.followSuppressed;
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	override render(width: number): string[] {
		return renderScrollView(this[LAYOUT_NODE](), width);
	}

	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this };
	}
}

export function renderScrollView(
	node: ScrollLayoutNode,
	width: number,
	renderChild = (component: Component, childWidth: number): string[] => component.render(childWidth),
): string[] {
	const contentWidth = node.state.getContentWidth(width);
	const lines = renderChild(node.component, contentWidth);
	return contentWidth === width ? lines : lines.map((line) => `${line} `);
}
