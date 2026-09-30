import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fchownSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AgentState } from "@earendil-works/pi-agent-core";
import { resolveLocalFileTarget } from "@earendil-works/pi-agent-core/node";
import type { ToolCall } from "@earendil-works/pi-ai";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { SessionManager } from "../session-manager.ts";

/**
 * Interface for rendering custom tools to HTML.
 * Used by agent-session to pre-render extension tool output.
 */
export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to HTML. Returns collapsed/expanded or undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/** Presentation variants for a call's snapshots and branch-specific results. */
interface RenderedToolHtml {
	/** Call previews keyed by serialized display arguments, including branch-specific arguments. */
	calls?: Record<string, string>;
	/** Results keyed by their raw journal entry ID. */
	results?: Record<string, { collapsed?: string; expanded?: string }>;
}

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	/** Optional tool renderer for custom tools */
	toolRenderer?: ToolHtmlRenderer;
	signal?: AbortSignal;
}

/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color (e.g., userMessageBg). */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom property declarations from theme colors.
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	leafId: string | null;
	systemPrompt?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "namespace" | "description" | "parameters">>;
}

/** Template assets are small; history is written independently below. */
function htmlTemplate(themeName?: string): string {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf8");
	const colors = getResolvedThemeColors(themeName);
	const exported = getThemeExportColors(themeName);
	const derived = deriveExportColors(colors.userMessageBg || "#343541");
	const css = readFileSync(join(templateDir, "template.css"), "utf8")
		.replace("{{THEME_VARS}}", generateThemeVars(themeName))
		.replace("{{BODY_BG}}", exported.pageBg ?? derived.pageBg)
		.replace("{{CONTAINER_BG}}", exported.cardBg ?? derived.cardBg)
		.replace("{{INFO_BG}}", exported.infoBg ?? derived.infoBg);
	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", readFileSync(join(templateDir, "template.js"), "utf8"))
		.replace("{{MARKED_JS}}", readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf8"))
		.replace("{{HIGHLIGHT_JS}}", readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf8"));
}

/** Tools rendered directly by the HTML template (not pre-rendered via TUI→ANSI→HTML pipeline) */
const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

/**
 * Pre-render custom tools to HTML using their TUI renderers.
 */
function preRenderCustomTools(
	entry: SessionEntry,
	toolRenderer: ToolHtmlRenderer,
	manager: SessionManager,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = Object.create(null);

	const findCall = (entry: SessionEntry, toolCallId: string): ToolCall | undefined => {
		let current: SessionEntry | undefined = entry;
		while (current) {
			if (current.type === "message" && current.message.role === "assistant") {
				const block = current.message.content.find((block) => block.type === "toolCall" && block.id === toolCallId);
				if (block?.type === "toolCall") {
					return block;
				}
			}
			current = current.parentId && current.parentId !== current.id ? manager.getEntry(current.parentId) : undefined;
		}
		return undefined;
	};

	const renderCall = (call: ToolCall) => {
		const args = call.arguments;
		const callHtml = toolRenderer.renderCall(call.id, call.name, args);
		if (callHtml) {
			renderedTools[call.id] ??= {};
			const rendered = renderedTools[call.id];
			rendered.calls ??= Object.create(null) as NonNullable<RenderedToolHtml["calls"]>;
			rendered.calls[JSON.stringify(args)] = callHtml;
		}
	};

	if (entry.type !== "message") return renderedTools;
	const msg = entry.message;
	if (msg.role === "assistant") {
		for (const block of msg.content) {
			if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
				renderCall(findCall(entry, block.id) ?? block);
			}
		}
	}
	if (msg.role === "toolResult" && !TEMPLATE_RENDERED_TOOLS.has(msg.toolName)) {
		// Restore this branch's arguments for the result renderer's context.
		const call = findCall(entry, msg.toolCallId);
		if (call) renderCall(call);
		const rendered = toolRenderer.renderResult(msg.toolCallId, msg.toolName, msg.content, msg.details, msg.isError);
		if (rendered) {
			renderedTools[msg.toolCallId] ??= {};
			renderedTools[msg.toolCallId].results = { [entry.id]: rendered };
		}
	}
	return renderedTools;
}

function assertDistinctExportTarget(sourceFile: string, outputPath: string): void {
	const source = statSync(sourceFile);
	const output = statSync(outputPath, { throwIfNoEntry: false });
	if (output && output.dev === source.dev && output.ino === source.ino) {
		throw new Error(`Cannot export HTML over the source session file: ${outputPath}`);
	}
}

/** Structural browsing facts; arbitrary bodies remain in the individual encoded records. */
function entryIndex(entry: SessionEntry, record: number): object {
	const index: Record<string, unknown> = {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		type: entry.type,
		record,
	};
	if (entry.type === "message") {
		const message = entry.message;
		index.message = {
			role: message.role,
			...(message.role === "assistant"
				? {
						model: message.model,
						provider: message.provider,
						usage: message.usage,
						stopReason: message.stopReason,
						toolCalls: message.content.filter((part) => part.type === "toolCall").length,
						hasText: message.content.some((part) => part.type === "text" && part.text.trim().length > 0),
					}
				: {}),
			...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName } : {}),
		};
	} else if (entry.type === "label") {
		index.targetId = entry.targetId;
		index.label = entry.label;
	} else if (entry.type === "custom" || entry.type === "custom_message") {
		index.customType = entry.customType;
		if (entry.type === "custom_message") {
			index.display = entry.display;
		}
	} else if (entry.type === "model_change") {
		index.provider = entry.provider;
		index.modelId = entry.modelId;
	} else if (entry.type === "thinking_level_change") index.thinkingLevel = entry.thinkingLevel;
	else if (entry.type === "compaction") index.tokensBefore = entry.tokensBefore;
	else if (entry.type === "context_edit") {
		index.targetId = entry.targetId;
		index.replacement = entry.replacement === null ? null : {};
	}
	return index;
}

async function writeHtml(
	manager: SessionManager,
	data: SessionData,
	outputPath: string,
	options: ExportOptions,
): Promise<void> {
	options.signal?.throwIfAborted();
	const target = await resolveLocalFileTarget(resolve(outputPath));
	assertDistinctExportTarget(manager.getSessionFile()!, target);
	const previous = statSync(target, { throwIfNoEntry: false });
	if (previous && !previous.isFile()) throw new Error("HTML export requires a regular file");
	const stage = join(dirname(target), `.pi-write-${randomUUID()}`);
	const fd = openSync(stage, "wx", previous ? 0o600 : 0o666);
	let closed = false;
	try {
		const [before, after] = htmlTemplate(options.themeName).split("{{SESSION_DATA}}");
		writeFileSync(fd, before);
		// ponytail: a requested record/rendered value must fit its consumer; never encode the whole history.
		writeFileSync(fd, Buffer.from(JSON.stringify(data)).toString("base64"));
		writeFileSync(fd, "</script>\n");
		let record = 0;
		for (const entry of manager.getEntries()) {
			options.signal?.throwIfAborted();
			const renderedTools = options.toolRenderer
				? preRenderCustomTools(entry, options.toolRenderer, manager)
				: undefined;
			for (const [kind, value] of [
				["index", entryIndex(entry, record)],
				["entry", { entry, renderedTools }],
			] as const) {
				writeFileSync(
					fd,
					`<script id="session-${kind}-${record}" type="application/json"${kind === "index" ? ' class="session-index"' : ""}>`,
				);
				writeFileSync(fd, Buffer.from(JSON.stringify(value)).toString("base64"));
				writeFileSync(fd, "</script>\n");
			}
			record++;
			await setImmediate();
		}
		writeFileSync(fd, after.replace(/^\s*<\/script>/, ""));
		if (previous) {
			fchownSync(fd, previous.uid, previous.gid);
			fchmodSync(fd, previous.mode & 0o777);
		}
		closeSync(fd);
		closed = true;
		options.signal?.throwIfAborted();
		assertDistinctExportTarget(manager.getSessionFile()!, target);
		renameSync(stage, target);
	} finally {
		if (!closed) closeSync(fd);
		rmSync(stage, { force: true });
	}
}

/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const sessionData: SessionData = {
		header: sm.getHeader(),
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	};

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	assertDistinctExportTarget(sessionFile, outputPath);
	await writeHtml(sm, sessionData, outputPath, opts);
	return outputPath;
}

/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const resolvedInputPath = resolvePath(inputPath);

	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const inputBasename = basename(resolvedInputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}
	assertDistinctExportTarget(resolvedInputPath, outputPath);

	const sm = SessionManager.open(resolvedInputPath);

	const sessionData: SessionData = {
		header: sm.getHeader(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	await writeHtml(sm, sessionData, outputPath, opts);
	return outputPath;
}
