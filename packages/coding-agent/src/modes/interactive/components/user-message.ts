import type { ImageContent } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { type MessageImageDisplayOptions, MessageImagesContainer } from "./message-images.ts";

export interface UserMessageImageOptions extends MessageImageDisplayOptions {
	images?: readonly ImageContent[];
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	private attachedImages: readonly ImageContent[];
	private markdownChild?: Markdown;
	private imagesContainer: MessageImagesContainer;
	private zoneLines?: { source: readonly string[]; lines: string[] };

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		imageOptions?: UserMessageImageOptions,
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.attachedImages = imageOptions?.images ?? [];
		this.imagesContainer = new MessageImagesContainer((s) => theme.fg("toolOutput", s), imageOptions);
		this.rebuild();
		this.imagesContainer.sync(this.text, this.attachedImages, true);
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setShowImages(show: boolean): void {
		this.imagesContainer.setShowImages(show);
	}

	setImageWidthCells(widthCells: number): void {
		this.imagesContainer.setImageWidthCells(widthCells);
	}

	private rebuild(): void {
		this.clear();
		this.markdownChild = undefined;
		if (this.text.length > 0 || this.attachedImages.length === 0) {
			// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
			// line, with identical output.
			this.markdownChild = new Markdown(
				this.text,
				this.outputPad,
				1,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
					bgColor: (content: string) => theme.bg("userMessageBg", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform(
						"user",
						() => false,
						this.markdownTransformers,
						this.messageId,
						this.timestamp,
					),
				},
			);
			this.addChild(this.markdownChild);
		}
		this.addChild(this.imagesContainer);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		if (!this.markdownChild) {
			return lines;
		}
		const textLineCount = this.imagesContainer.hasImages() ? this.markdownChild.render(width).length : lines.length;
		if (textLineCount === 0) {
			return lines;
		}

		// Container output is shared across frames; copy it once per change instead of mutating it.
		if (this.zoneLines?.source !== lines) {
			const zoned = [...lines];
			zoned[0] = OSC133_ZONE_START + zoned[0];
			// Attach OSC 133 end markers to the last text line so trailing image/reservation rows stay clean.
			const lastTextRow = Math.min(textLineCount, zoned.length) - 1;
			zoned[lastTextRow] = OSC133_ZONE_END + OSC133_ZONE_FINAL + zoned[lastTextRow];
			this.zoneLines = { source: lines, lines: zoned };
		}
		return this.zoneLines.lines;
	}
}
