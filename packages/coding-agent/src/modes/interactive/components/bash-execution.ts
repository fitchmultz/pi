/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Spacer, Text, type TUI, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { formatExpandKeyHint } from "../../../core/tools/render-utils.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { handledMouseTarget } from "./compact-preview.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { VisualLinePreview } from "./visual-truncate.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private compactView: boolean;
	// The collapsed compact card. `lines` follow the lines its Texts return, so they change with them: between a
	// fullscreen frame and other callers, as well as for a new width.
	private compactPreview?: { width: number; components: Text[]; sources: string[][]; lines: string[] };
	private contentContainer: Container;
	/** `dim` marks `!!` commands, whose output is excluded from the model context. */
	private readonly colorKey: "dim" | "bashMode";
	private outputPad: number;

	constructor(command: string, ui: TUI, excludeFromContext = false, outputPad = 1, compactView = false) {
		super();
		this.command = command;
		this.compactView = compactView;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		this.outputPad = outputPad;
		const borderColor = (str: string) => theme.fg(this.colorKey, str);

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(this.colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // Plain text for loader
		);

		// Bottom border
		this.addChild(new DynamicBorder(borderColor));

		this.updateDisplay();
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	getActivityStatus(): "running" | "complete" | "cancelled" | "error" {
		return this.status;
	}

	setCompactView(compactView: boolean): void {
		this.compactView = compactView;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.compactView) return super.handleMouse(event);
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.setExpanded(!this.expanded);
		return handledMouseTarget(this, event);
	}

	override render(width: number): string[] {
		if (!this.compactView || this.expanded) return super.render(width);
		const preview = this.compactPreview?.width === width ? this.compactPreview : this.createCompactPreview(width);
		this.compactPreview = preview;
		const sources = preview.components.map((component) => component.render(width));
		if (sources.some((lines, index) => lines !== preview.sources[index])) {
			preview.sources = sources;
			preview.lines = sources.flat();
		}
		return preview.lines;
	}

	private createCompactPreview(width: number): NonNullable<BashExecutionComponent["compactPreview"]> {
		const command = theme.fg(this.colorKey, theme.bold(`$ ${this.command.replace(/\s+/g, " ")}`));
		const status =
			this.status === "running"
				? theme.fg("muted", "Running...")
				: this.status === "cancelled"
					? theme.fg("warning", "(cancelled)")
					: this.status === "error"
						? theme.fg("error", `(exit ${this.exitCode})`)
						: "";
		const output = this.outputLines.findLast((line) => line.trim()) ?? "";
		const detail = [status, output ? theme.fg("muted", output) : ""].filter(Boolean).join(" ");
		const components = (detail ? [command, detail] : [command]).map(
			(line) => new Text(truncateToWidth(line, Math.max(1, width - this.outputPad * 2)), this.outputPad, 0),
		);
		return { width, components, sources: [], lines: [] };
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		this.loader.stop();

		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.compactPreview = undefined;
		// Apply truncation for LLM context limits (same limits as bash tool)
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// Get the lines to potentially display (after context truncation)
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Command header
		const header = new Text(theme.fg(this.colorKey, theme.bold(`$ ${this.command}`)), this.outputPad, 0);
		this.contentContainer.addChild(header);

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, this.outputPad, 0));
			} else {
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(
					new VisualLinePreview({
						text: `\n${styledOutput}`,
						maxVisualLines: PREVIEW_LINES,
						keep: "end",
						paddingX: this.outputPad,
					}),
				);
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(formatExpandKeyHint(theme, keyHint, "to collapse"));
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines `)}${formatExpandKeyHint(theme, keyHint)}`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, this.outputPad, 0));
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
