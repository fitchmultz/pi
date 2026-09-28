import { type Component, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
	setInverted(inverted: boolean): void;
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dockEntries = [
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	];
	const dock = new VStack(dockEntries);
	const rootEntries = [
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto" as const, grow: 0, shrink: 1, minSize: 1 },
	];
	const root = new VStack(rootEntries);
	return {
		transcript,
		root,
		setInverted(inverted) {
			dock.clear();
			for (const entry of inverted ? [...dockEntries].reverse() : dockEntries) {
				dock.addChild(entry.component, entry);
			}
			root.clear();
			for (const entry of inverted ? [...rootEntries].reverse() : rootEntries) {
				root.addChild(entry.component, entry);
			}
		},
	};
}
