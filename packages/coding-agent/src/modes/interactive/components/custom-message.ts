import type { TextContent } from "@earendil-works/pi-ai";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	Box,
	Container,
	getCapabilities,
	Image,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private compactView: boolean;
	private showImages: boolean;
	private imageWidthCells: number;
	private imageChildren: Component[] = [];

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		compactView = false,
		showImages = true,
		imageWidthCells = 60,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.compactView = compactView;
		this.showImages = showImages;
		this.imageWidthCells = imageWidthCells;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	setCompactView(compactView: boolean): void {
		if (this.compactView === compactView) return;
		this.compactView = compactView;
		this.rebuild();
	}

	setShowImages(show: boolean): void {
		if (this.showImages === show) return;
		this.showImages = show;
		this.rebuild();
	}

	setImageWidthCells(width: number): void {
		const cells = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === cells) return;
		this.imageWidthCells = cells;
		this.rebuild();
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

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);
		for (const child of this.imageChildren) this.removeChild(child);
		this.imageChildren = [];

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad, compactView: this.compactView },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					this.addImages();
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();
		this.box.setPaddingX(this.outputPad);

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);

		this.addImages();
	}

	/** Image blocks of the message, drawn like the images of a tool result. */
	private addImages(): void {
		if (typeof this.message.content === "string") return;
		if (!getCapabilities().images || !this.showImages || (this.compactView && !this._expanded)) return;
		for (const block of this.message.content) {
			if (block.type !== "image" || !block.data || !block.mimeType) continue;
			const spacer = new Spacer(1);
			const image = new Image(
				block.data,
				block.mimeType,
				{ fallbackColor: (text: string) => theme.fg("customMessageText", text) },
				{ maxWidthCells: this.imageWidthCells },
			);
			if (block.mimeType !== "image/png") ensurePngTranscoder(() => this.invalidate());
			this.imageChildren.push(spacer, image);
			this.addChild(spacer);
			this.addChild(image);
		}
	}
}
