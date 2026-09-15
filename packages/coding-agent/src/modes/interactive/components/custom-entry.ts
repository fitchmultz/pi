import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";

/**
 * Component that renders a custom session entry from extensions.
 * The host owns transcript spacing; renderer output should provide only its content.
 */
export class CustomEntryComponent extends Container {
	private entry: CustomEntry<unknown>;
	private renderer: EntryRenderer;
	private customComponent?: Component;
	private _expanded = false;
	private compactView: boolean;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer, compactView = false) {
		super();
		this.entry = entry;
		this.compactView = compactView;
		this.renderer = renderer;
		this.rebuild();
	}

	hasContent(): boolean {
		return this.customComponent !== undefined;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setCompactView(compactView: boolean): void {
		this.compactView = compactView;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const result = super.handleMouse(event);
		if (result || !this.compactView || event.type !== "click" || event.button !== "left") return result;
		this.setExpanded(!this._expanded);
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.customComponent = undefined;

		let component: Component | undefined;
		try {
			component = this.renderer(this.entry, { expanded: this._expanded }, theme);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("error", `[${this.entry.customType}] renderer failed: ${message}`), 0, 0));
			component = box;
		}

		if (!component) {
			return;
		}

		this.customComponent = component;
		this.addChild(new Spacer(1));
		this.addChild(component);
	}
}
