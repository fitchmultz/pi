import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { CompactPreview } from "./compact-preview.ts";
import { keyText } from "./keybinding-hints.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

/**
 * Shared base for collapsible summary message cards (`[compaction]` and `[branch]`).
 * Uses the same background color as custom messages for visual consistency.
 */
export abstract class SummaryMessageComponent<TMessage extends { summary: string }> extends Box {
	private expanded = false;
	protected readonly message: TMessage;
	private markdownTheme: MarkdownTheme;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	private compactView: boolean;
	private readonly compactPreview = new CompactPreview();

	/** The first six arguments are upstream's, in upstream's positions. The fork's display option follows them. */
	constructor(
		message: TMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		compactView = false,
	) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.compactView = compactView;
		this.updateDisplay();
	}

	protected abstract getSummaryDisplay(): {
		tag: string;
		expandedHeader: string;
		collapsedLabel: string;
	};

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	setCompactView(compactView: boolean): void {
		this.compactView = compactView;
	}

	/**
	 * The card with its blank row above it. Compact view shows an unexpanded summary as its two-row preview:
	 * the label and the summary row. The preview skips blank rows, so the row above the card goes too.
	 */
	override render(width: number): string[] {
		const lines = ["", ...super.render(width)];
		return this.compactView && !this.expanded ? this.compactPreview.render(lines, width) : lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Box["handleMouse"]> {
		const native = this.compactView && !this.expanded ? this.compactPreview.toNative(event) : event;
		// The box starts one row down, below the blank row.
		return native && super.handleMouse({ ...native, y: native.y - 1, height: native.height - 1 });
	}

	private updateDisplay(): void {
		this.compactPreview.reset();
		this.clear();
		const content = new Container();
		const { tag, expandedHeader, collapsedLabel } = this.getSummaryDisplay();

		const label = theme.fg("customMessageLabel", `\x1b[1m[${tag}]\x1b[22m`);
		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(1));

		if (this.expanded) {
			const transform = createMarkdownTransform(
				"summary",
				() => false,
				this.markdownTransformers,
				this.messageId,
				this.timestamp,
			);
			content.addChild(
				new Markdown(
					this.message.summary,
					0,
					0,
					this.markdownTheme,
					{ color: (text: string) => theme.fg("customMessageText", text) },
					// Transformers see only the summary content, not Pi's header.
					{ transform: (markdown, width) => expandedHeader + transform(markdown, width) },
				),
			);
		} else {
			content.addChild(
				new Text(
					theme.fg("customMessageText", `${collapsedLabel} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
