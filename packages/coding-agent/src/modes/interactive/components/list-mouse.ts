import {
	type Component,
	Container,
	MouseRegion,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export const UNCHANGED_LIST_WHEEL = { handled: true, render: false } as const;

export function handleListWheel(
	event: TuiMouseEvent,
	currentIndex: number,
	itemCount: number,
	onIndexChange: (index: number) => void,
): TuiMouseEventResult {
	if (itemCount === 0) return UNCHANGED_LIST_WHEEL;
	const step = (event.wheelDelta ?? 0) < 0 ? -1 : 1;
	const index = Math.max(0, Math.min(itemCount - 1, currentIndex + step));
	if (index === currentIndex) return UNCHANGED_LIST_WHEEL;
	onIndexChange(index);
	return { handled: true, render: true };
}

/** Routes wheel anywhere in the frame to the list and lets Container dispatch other events to exact child bounds. */
export class ListContainer extends Container {
	private readonly onWheel?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

	constructor(onWheel?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined) {
		super();
		this.onWheel = onWheel;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "wheel") return super.handleMouse(event);
		const result = this.onWheel?.(event);
		if (!result) return undefined;
		// The frame, rather than a child row, owns wheel handling; never steal focus onto a non-input wrapper.
		return {
			handled: true,
			render: result.render,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}
}

/** Wraps a row so a tap anywhere on its rendered lines activates that same row after the press redraw. */
export function listMouseRegion(row: Component, onPress: () => void, onClick: () => void): MouseRegion {
	return new MouseRegion(row, (event) => handleListRow(event, onPress, onClick));
}

/** Maps rendered lines to items when a list renders its own lines rather than child components. */
export class ListMouseRows<Item> {
	private readonly rows = new Map<number, Item>();
	private pressedItem?: Item;

	clear(): void {
		this.rows.clear();
	}

	set(row: number, item: Item): void {
		this.rows.set(row, item);
	}

	handleMouse(
		event: TuiMouseEvent,
		onPress: (item: Item) => void,
		onClick: (item: Item) => void,
	): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		// Highlighting a row can move the visible window before the click arrives.
		const item = (event.type === "click" ? this.pressedItem : undefined) ?? this.rows.get(event.y);
		this.pressedItem = event.type === "press" ? item : undefined;
		if (item === undefined) return undefined;
		return handleListRow(
			event,
			() => onPress(item),
			() => onClick(item),
		);
	}
}

function handleListRow(
	event: TuiMouseEvent,
	onPress: () => void,
	onClick: () => void,
): TuiMouseEventResult | undefined {
	if (event.button !== "left") return undefined;
	if (event.type === "press") {
		onPress();
		return { handled: true, focus: true };
	}
	if (event.type === "click") {
		onClick();
		return { handled: true };
	}
	return undefined;
}
