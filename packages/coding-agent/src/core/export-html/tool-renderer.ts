/**
 * Tool HTML renderer for custom tools in HTML export.
 *
 * Renders custom tool calls and results to HTML by invoking their TUI renderers
 * and converting the ANSI output to HTML.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Component, type Keybinding, Text } from "@earendil-works/pi-tui";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../extensions/types.ts";
import { formatToolCallWithArgs } from "../tools/render-utils.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Renderers of calls to a tool, as resolved by extensions and the registered tool */
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	/** Theme for styling */
	theme: Theme;
	/** Working directory for render context */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	width?: number;
}

export interface ToolHtmlRenderer {
	/**
	 * Render a tool call to HTML in its expanded form, because a page cannot expand a call. `result` is the call's
	 * saved result: with it the call is rendered as finished, without it as still running. Returns undefined if the
	 * tool has no renderer; the page then shows the arguments as JSON.
	 */
	renderCall(
		toolCallId: string,
		toolName: string,
		args: unknown,
		result?: { isError: boolean; durationMs?: number },
	): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
		durationMs?: number,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * Create a tool HTML renderer.
 *
 * The renderer looks up tool definitions and invokes their renderCall/renderResult
 * methods, converting the resulting TUI Component output (ANSI) to HTML.
 */
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolRenderers, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	// On the page a click switches a result between its two forms, and the expand key does nothing.
	const pageKeyText = (keybinding: Keybinding): string =>
		keybinding === "app.tools.expand" ? "click" : keyText(keybinding);

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
		durationMs: number | undefined,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
			durationMs,
			outputPad: 1,
			keyText: pageKeyText,
			keyHint: (keybinding, description) =>
				keybinding === "app.tools.expand"
					? theme.fg("dim", pageKeyText(keybinding)) + theme.fg("muted", ` ${description}`)
					: keyHint(keybinding, description),
		};
	};

	return {
		renderCall(
			toolCallId: string,
			toolName: string,
			args: unknown,
			result?: { isError: boolean; durationMs?: number },
		): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderCall && !toolDef?.renderResult) {
					return undefined;
				}

				// The page has no control that expands a call, so the call is rendered expanded. A renderer
				// that shortens an unexpanded call would otherwise lose that text in every export.
				// A tool with only a result renderer gets the terminal's fallback header: the page shows the
				// arguments itself only when nothing is rendered for the call.
				const context = createRenderContext(
					toolCallId,
					renderedCallComponents.get(toolCallId),
					true,
					result === undefined,
					result?.isError ?? false,
					result?.durationMs,
				);
				const component = toolDef.renderCall
					? toolDef.renderCall(args, theme, context)
					: new Text(formatToolCallWithArgs(toolName, args, theme, context), 0, 0);
				renderedCallComponents.set(toolCallId, component);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
			durationMs?: number,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// Render collapsed
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(
						toolCallId,
						renderedResultComponents.get(toolCallId),
						false,
						false,
						isError,
						durationMs,
					),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(collapsedComponent.render(width)));

				// Render expanded
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(
						toolCallId,
						renderedResultComponents.get(toolCallId),
						true,
						false,
						isError,
						durationMs,
					),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expanded = ansiLinesToHtml(trimRenderedResultLines(expandedComponent.render(width)));

				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},
	};
}
