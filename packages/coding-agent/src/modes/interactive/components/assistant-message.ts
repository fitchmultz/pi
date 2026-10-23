import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface ContentRun {
	type: "text" | "thinking";
	text: string;
	hidden: boolean;
	runIndex: number;
	content: Markdown | Text;
	child: Component;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private compactView: boolean;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private contentRuns: ContentRun[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		compactView = false,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.compactView = compactView;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.contentRuns = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		this.contentRuns = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.contentRuns = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.contentRuns = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setCompactView(compactView: boolean): void {
		if (this.compactView === compactView) return;
		this.compactView = compactView;
		this.contentRuns = [];
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	isEmpty(): boolean {
		// Every displayed run or notice has a spacer, even when Markdown transforms to empty text.
		return this.contentContainer.children.length === 0;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		if (this.isStreaming !== isStreaming) this.contentRuns = [];
		this.isStreaming = isStreaming;

		const previousRuns = this.contentRuns;
		const runs: ContentRun[] = [];
		this.contentContainer.clear();

		const addRun = (type: ContentRun["type"], text: string, hidden = false, runIndex = 0): void => {
			let run = previousRuns[runs.length];
			if (!run || run.type !== type || run.hidden !== hidden || run.runIndex !== runIndex) {
				const content = hidden
					? new Text(text, this.outputPad, 0)
					: new Markdown(
							text,
							this.outputPad,
							0,
							this.markdownTheme,
							type === "thinking"
								? { color: (text: string) => theme.fg("thinkingText", text), italic: true }
								: undefined,
							{
								transform: createMarkdownTransform(
									type === "thinking" ? "assistant-thinking" : "assistant",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						);
				const child =
					type === "thinking"
						? new MouseRegion(content, (event) => {
								if (event.type !== "click" || event.button !== "left") return undefined;
								this.thinkingVisibilityOverrides.set(runIndex, !hidden);
								if (this.lastMessage) this.updateContent(this.lastMessage);
								return { handled: true };
							})
						: content;
				run = { type, text, hidden, runIndex, content, child };
			} else if (run.text !== text) {
				// Compare source snapshots: providers can mutate the same message and blocks in place.
				run.content.setText(text);
				run.text = text;
			}
			runs.push(run);
			this.contentContainer.addChild(run.child);
		};

		let needsSpacer = true;

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				if (needsSpacer) this.contentContainer.addChild(new Spacer(1));
				needsSpacer = false;
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				addRun("text", content.text.trim());
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				if (hidden && this.compactView) continue;
				if (needsSpacer) this.contentContainer.addChild(new Spacer(1));
				needsSpacer = true;
				addRun(
					"thinking",
					hidden ? theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)) : thinkingBlocks.join("\n\n"),
					hidden,
					runIndex,
				);
			}
		}
		this.contentRuns = runs;

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
