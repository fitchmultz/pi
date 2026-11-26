import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { TerminalColorMode } from "./colors.ts";
import { visibleWidth } from "./utils.ts";

export type ImageProtocol = "kitty" | "iterm2" | "sixel" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	imageId?: number;
	/** Whether Kitty should apply its default cursor movement after placement. */
	moveCursor?: boolean;
	/** Source MIME type for protocols that transcode/encode from source bytes (e.g. Sixel). */
	mimeType?: string;
}

export interface SixelEncodeRequest {
	base64Data: string;
	mimeType: string;
	widthPx: number;
	heightPx: number;
}

/**
 * Encodes source base64 image data into a DEC Sixel DCS sequence (`\x1bP...q...\x1b\\`)
 * sized to the requested pixel box, or returns null if it cannot.
 * Called synchronously during rendering.
 */
export type SixelImageEncoder = (request: SixelEncodeRequest) => string | null;

export interface TmuxCapabilities {
	hyperlinks: boolean;
	sixel: boolean;
	cellDimensions?: CellDimensions;
}

export type TmuxCapabilityProbe = () => boolean | TmuxCapabilities;

let cachedCapabilities: TerminalCapabilities | null = null;
let capabilityOverrides: Partial<TerminalCapabilities> = {};
let sixelEncoder: SixelImageEncoder | undefined;

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/**
 * Register the encoder used for DEC Sixel terminals (including tmux 3.4+ with Sixel support).
 * Without one, Sixel-capable terminals render text fallbacks.
 */
export function setSixelEncoder(encoder: SixelImageEncoder | undefined): void {
	sixelEncoder = encoder;
}

/**
 * Queries the attached tmux client in a single call for OSC 8 hyperlink forwarding,
 * native Sixel image support, and current cell pixel dimensions.
 */
function probeTmuxCapabilities(): TmuxCapabilities {
	try {
		const output = execSync(
			"tmux display-message -p '#{sixel_support}\t#{client_termfeatures}\t#{window_cell_width}x#{window_cell_height}'",
			{
				encoding: "utf8",
				timeout: 250,
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trimEnd();
		const [sixelSupportRaw = "", termfeaturesRaw = "", cellSizeRaw = ""] = output.split("\t");
		const features = termfeaturesRaw.split(",").map((feature) => feature.trim());
		const hyperlinks = features.includes("hyperlinks");
		const sixel = sixelSupportRaw.trim() !== "0" && features.includes("sixel");
		const cellMatch = /^(\d+)x(\d+)$/.exec(cellSizeRaw.trim());
		const widthPx = cellMatch ? Number.parseInt(cellMatch[1]!, 10) : 0;
		const heightPx = cellMatch ? Number.parseInt(cellMatch[2]!, 10) : 0;
		const dims = widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : undefined;
		return { hyperlinks, sixel, ...(dims ? { cellDimensions: dims } : {}) };
	} catch {
		return { hyperlinks: false, sixel: false };
	}
}

function normalizeTmuxCapabilities(result: boolean | TmuxCapabilities): TmuxCapabilities {
	if (typeof result === "boolean") {
		return { hyperlinks: result, sixel: false };
	}
	return result;
}

function detectCapabilitiesFromEnvironment(tmuxProbe: TmuxCapabilityProbe): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit" || term.endsWith("-direct");
	const isWindowsConsole = process.platform === "win32";

	// Query tmux for hyperlink forwarding, native Sixel graphics, and cell pixel size.
	if (process.env.TMUX || term.startsWith("tmux")) {
		const tmux = normalizeTmuxCapabilities(tmuxProbe());
		if (tmux.cellDimensions) {
			setCellDimensions(tmux.cellDimensions);
		}
		return {
			images: tmux.sixel ? "sixel" : null,
			trueColor: hasTrueColorHint,
			hyperlinks: tmux.hyperlinks,
		};
	}

	// screen does not forward OSC 8 hyperlinks, so keep them off there.
	if (term.startsWith("screen")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
	}

	// Herdr forwards OSC 8 hyperlinks and supports the Kitty graphics protocol. Check it before
	// outer-terminal detection because variables like KITTY_WINDOW_ID can leak into its panes.
	if (termProgram === "herdr") {
		return { images: "kitty", trueColor: hasTrueColorHint, hyperlinks: true };
	}

	if (termProgram === "rex") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Orca supports Kitty graphics but only advertises it through ORCA_IMAGE_PROTOCOL. Require
	// both signals so Orca releases predating that advertisement keep the text fallback instead
	// of reserving image rows that nothing renders.
	if (termProgram === "orca" && process.env.ORCA_IMAGE_PROTOCOL === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Warp supports the Kitty graphics protocol and OSC 8 hyperlinks.
	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (
		termProgram === "foot" ||
		term.startsWith("foot") ||
		termProgram === "contour" ||
		term.startsWith("contour") ||
		termProgram === "rio" ||
		term.startsWith("rio") ||
		termProgram === "mintty" ||
		term.startsWith("mlterm")
	) {
		return { images: "sixel", trueColor: true, hyperlinks: true };
	}

	if (process.env.WT_SESSION) {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	// Alacritty does not set TERM_PROGRAM. It sets TERM=alacritty when its terminfo entry is
	// installed (otherwise xterm-256color) and ALACRITTY_WINDOW_ID on Unix and macOS.
	const isAlacritty = termProgram === "alacritty" || term.startsWith("alacritty") || process.env.ALACRITTY_WINDOW_ID;
	if (isAlacritty || termProgram === "vscode" || termProgram === "zed") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (terminalEmulator === "jetbrains-jediterm") {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Windows Terminal does not always set WT_SESSION, for example when it hosts
	// a cmd.exe launched directly from Win+R. Modern Windows consoles support
	// truecolor; keep hyperlinks off unless we positively detected support above.
	if (isWindowsConsole) {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	return value === "1" ? true : value === "0" ? false : undefined;
}

export function detectCapabilities(tmuxProbe: TmuxCapabilityProbe = probeTmuxCapabilities): TerminalCapabilities {
	const hyperlinks = parseBooleanCapabilityOverride(process.env.PI_HYPERLINKS);
	const imageProtocol = process.env.PI_IMAGE_PROTOCOL?.toLowerCase();
	const images =
		imageProtocol === "kitty" || imageProtocol === "iterm2" || imageProtocol === "sixel"
			? imageProtocol
			: imageProtocol === "none" || imageProtocol === "0"
				? null
				: undefined;
	const skipTmuxProbe = hyperlinks !== undefined && images !== undefined;
	const detected = detectCapabilitiesFromEnvironment(
		skipTmuxProbe ? () => ({ hyperlinks, sixel: images === "sixel" }) : tmuxProbe,
	);
	const trueColor = parseBooleanCapabilityOverride(process.env.PI_TRUE_COLOR);
	return {
		...detected,
		...(images !== undefined ? { images } : {}),
		...(trueColor !== undefined ? { trueColor } : {}),
		...(hyperlinks !== undefined ? { hyperlinks } : {}),
	};
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const hyperlinks = capabilityOverrides.hyperlinks;
		const images = capabilityOverrides.images;
		const probe =
			hyperlinks !== undefined && images !== undefined
				? () => ({ hyperlinks, sixel: images === "sixel" })
				: undefined;
		cachedCapabilities = {
			...detectCapabilities(probe),
			...capabilityOverrides,
		};
	}
	return cachedCapabilities;
}

export function getTerminalColorMode(capabilities: TerminalCapabilities = getCapabilities()): TerminalColorMode {
	return capabilities.trueColor ? "truecolor" : "256color";
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

/** Override selected auto-detected capabilities. */
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void {
	if (
		capabilityOverrides.images === overrides.images &&
		capabilityOverrides.trueColor === overrides.trueColor &&
		capabilityOverrides.hyperlinks === overrides.hyperlinks
	) {
		return;
	}
	capabilityOverrides = { ...overrides };
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
const SIXEL_PREFIX = "\x1bP";

interface SixelSequenceSpan {
	start: number;
	bodyStart: number;
	bodyEnd: number;
	end: number;
}

function findSixelHeader(line: string, fromIndex = 0): { start: number; bodyStart: number } | undefined {
	let index = fromIndex;
	while (index < line.length) {
		const start = line.indexOf(SIXEL_PREFIX, index);
		if (start === -1) return undefined;
		let cursor = start + SIXEL_PREFIX.length;
		while (cursor < line.length) {
			const code = line.charCodeAt(cursor);
			if ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
				cursor++;
				continue;
			}
			break;
		}
		if (cursor < line.length && line.charCodeAt(cursor) === 0x71 /* 'q' */) {
			return { start, bodyStart: cursor + 1 };
		}
		index = start + SIXEL_PREFIX.length;
	}
	return undefined;
}

function findSixelSequence(line: string, fromIndex = 0): SixelSequenceSpan | undefined {
	const header = findSixelHeader(line, fromIndex);
	if (!header) return undefined;
	const bodyEnd = line.indexOf("\x1b\\", header.bodyStart);
	if (bodyEnd === -1) return undefined;
	return {
		start: header.start,
		bodyStart: header.bodyStart,
		bodyEnd,
		end: bodyEnd + 2,
	};
}

export function isSixelImageLine(line: string): boolean {
	return line.includes(SIXEL_PREFIX) && findSixelHeader(line) !== undefined;
}

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	if (line.startsWith(SIXEL_PREFIX) && findSixelHeader(line, 0)?.start === 0) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX) || isSixelImageLine(line);
}

/**
 * Cells covered by the image placement on an image line. Rows are relative to the line; columns are
 * absolute, with `endCol` exclusive and `Infinity` when the image width cannot be read.
 */
export interface ImageLineExtent {
	firstRow: number;
	lastRow: number;
	startCol: number;
	endCol: number;
}

/**
 * Return the cells an image line draws over. Kitty places the image at the line and extends it
 * downward; iTerm2 lines move the cursor up before drawing, so the image ends at the line.
 */
export function getImageLineExtent(line: string): ImageLineExtent | undefined {
	const kittyStart = line.indexOf(KITTY_PREFIX);
	if (kittyStart !== -1) {
		const controls = /\x1b_G([^;]*);/.exec(line)?.[1] ?? "";
		const columnValue = /(?:^|,)c=(\d+)(?:,|$)/.exec(controls)?.[1];
		const columns =
			columnValue === undefined
				? getRegisteredKittyImageMetadataFromControls(controls)?.columns
				: Number.parseInt(columnValue, 10);
		const startCol = visibleWidth(line.slice(0, kittyStart));
		const rows = getKittyImagePlacementRows(line) ?? 1;
		return { firstRow: 0, lastRow: rows - 1, startCol, endCol: startCol + (columns ?? Infinity) };
	}
	const iterm2Start = line.indexOf(ITERM2_PREFIX);
	if (iterm2Start !== -1) {
		const before = line.slice(0, iterm2Start);
		const moveUp = /\x1b\[(\d+)A$/.exec(before);
		// Only a plain cell count is a known width; `auto`, pixel and percent widths depend on the image.
		const columnValue = /[;=]width=(\d+)[;:]/.exec(line.slice(iterm2Start))?.[1];
		// visibleWidth counts the cursor-up sequence as text, so measure only what precedes it.
		const startCol = visibleWidth(moveUp ? before.slice(0, moveUp.index) : before);
		return {
			firstRow: moveUp ? -Number.parseInt(moveUp[1]!, 10) : 0,
			lastRow: 0,
			startCol,
			endCol: startCol + (columnValue === undefined ? Infinity : Number.parseInt(columnValue, 10)),
		};
	}
	const sixelHeader = findSixelHeader(line);
	if (!sixelHeader) return undefined;
	const metadata = getSixelImageMetadata(line);
	const startCol = visibleWidth(line.slice(0, sixelHeader.start));
	const rows = metadata?.rows ?? 1;
	return {
		firstRow: 0,
		lastRow: rows - 1,
		startCol,
		endCol: startCol + (metadata?.columns ?? Infinity),
	};
}

/** Remove Kitty, iTerm2, and Sixel image sequences, including iTerm2's cursor-up prefix, keeping the text. */
export function stripImageSequences(line: string): string {
	let stripped = line.replace(/\x1b_G[^\x1b]*\x1b\\/g, "").replace(/(?:\x1b\[\d+A)?\x1b\]1337;File=[^\x07]*\x07/g, "");
	if (!stripped.includes(SIXEL_PREFIX)) return stripped;
	let result = "";
	let cursor = 0;
	while (cursor < stripped.length) {
		const span = findSixelSequence(stripped, cursor);
		if (!span) {
			result += stripped.slice(cursor);
			break;
		}
		result += stripped.slice(cursor, span.start);
		cursor = span.end;
	}
	stripped = result;
	return stripped;
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 */
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		/** Whether Kitty should apply its default cursor movement after placement. Default: true. */
		moveCursor?: boolean;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

/** Delete all visible Kitty placements while retaining their uploaded image data. */
export function deleteAllKittyPlacements(): string {
	return "\x1b_Ga=d,d=a,q=2\x1b\\";
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [
		`inline=${options.inline !== false ? 1 : 0}`,
		`size=${Buffer.byteLength(base64Data, "base64")}`,
	];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export interface ImageCellSize {
	columns: number;
	rows: number;
}

export interface KittyImageMetadata extends ImageCellSize {
	imageId: number;
	widthPx: number;
	heightPx: number;
}

export interface SixelImageMetadata extends ImageCellSize {
	widthPx: number;
	heightPx: number;
}

interface ParsedSixelBands {
	prefix: string;
	rasterPrefix: string;
	paletteHeader: string;
	bands: string[];
	bandStartColors: Array<number | undefined>;
}

interface RegisteredKittyImageMetadata extends KittyImageMetadata {
	transmissionGeneration: number;
}

export interface KittyImagePlacement {
	imageId: number;
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
	rows: number;
	sequence: string;
	replacementLine: string;
}

const kittyImageMetadata = new Map<number, RegisteredKittyImageMetadata>();
let kittyTransmissionGeneration = 0;
// Tallest registered image. Bounds backward searches for image lines above a
// viewport: no image line further up than this can reach into it.
let maxKittyImageRows = 0;
let maxSixelImageRows = 0;

export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	kittyTransmissionGeneration += 1;
	maxKittyImageRows = Math.max(maxKittyImageRows, metadata.rows);
	kittyImageMetadata.delete(metadata.imageId);
	kittyImageMetadata.set(metadata.imageId, { ...metadata, transmissionGeneration: kittyTransmissionGeneration });
	if (kittyImageMetadata.size > 1000) {
		const oldestImageId = kittyImageMetadata.keys().next().value;
		if (oldestImageId !== undefined) kittyImageMetadata.delete(oldestImageId);
	}
}

/** Return the row height of the tallest Kitty image registered so far. */
export function getMaxKittyImageRows(): number {
	return maxKittyImageRows;
}

/** Return the row height of the tallest top-anchored image (Kitty or Sixel) registered so far. */
export function getMaxImageRows(): number {
	return Math.max(maxKittyImageRows, maxSixelImageRows);
}

function parseSixelRasterDimensions(sequence: string): ImageDimensions | undefined {
	const span = findSixelSequence(sequence);
	if (!span) return undefined;
	const bodyHead = sequence.slice(span.bodyStart, Math.min(span.bodyEnd, span.bodyStart + 64));
	const match = /^"\d+;\d+;(\d+);(\d+)/.exec(bodyHead);
	if (!match) return undefined;
	const widthPx = Number.parseInt(match[1]!, 10);
	const heightPx = Number.parseInt(match[2]!, 10);
	return widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : undefined;
}

function ensureSixelRasterAttributes(sequence: string, widthPx: number, heightPx: number): string {
	if (parseSixelRasterDimensions(sequence)) return sequence;
	const span = findSixelSequence(sequence);
	if (!span) return sequence;
	return `${sequence.slice(0, span.bodyStart)}"1;1;${widthPx};${heightPx}${sequence.slice(span.bodyStart)}`;
}

function measureSixelBandDimensions(sequence: string): { widthPx: number; heightPx: number } | undefined {
	const parsed = parseSixelBands(sequence, 1);
	if (!parsed || parsed.bands.length === 0) return undefined;
	let maxCols = 0;
	for (const band of parsed.bands) {
		for (const pass of band.split("$")) {
			let cols = 0;
			let i = 0;
			while (i < pass.length) {
				const ch = pass.charCodeAt(i);
				if (ch === 0x23) {
					// Color selector (#n or #n;...)
					i++;
					while (
						i < pass.length &&
						((pass.charCodeAt(i) >= 0x30 && pass.charCodeAt(i) <= 0x39) || pass.charCodeAt(i) === 0x3b)
					) {
						i++;
					}
					continue;
				}
				if (ch === 0x21) {
					// Repeat introducer (!<count><sixel>)
					i++;
					let count = 0;
					while (i < pass.length && pass.charCodeAt(i) >= 0x30 && pass.charCodeAt(i) <= 0x39) {
						count = count * 10 + (pass.charCodeAt(i) - 0x30);
						i++;
					}
					if (i < pass.length && pass.charCodeAt(i) >= 0x3f && pass.charCodeAt(i) <= 0x7e) {
						cols += Math.max(1, count);
						i++;
					}
					continue;
				}
				if (ch >= 0x3f && ch <= 0x7e) {
					cols++;
				}
				i++;
			}
			if (cols > maxCols) maxCols = cols;
		}
	}
	return { widthPx: Math.max(1, maxCols), heightPx: parsed.bands.length * 6 };
}

export function getSixelImageMetadata(line: string): SixelImageMetadata | undefined {
	const span = findSixelSequence(line);
	if (!span) return undefined;
	const sequence = line.slice(span.start, span.end);
	const raster = parseSixelRasterDimensions(sequence) ?? measureSixelBandDimensions(sequence);
	if (!raster) return undefined;
	const dims = getCellDimensions();
	const rows = Math.max(1, Math.ceil(raster.heightPx / dims.heightPx));
	maxSixelImageRows = Math.max(maxSixelImageRows, rows);
	return {
		columns: Math.max(1, Math.ceil(raster.widthPx / dims.widthPx)),
		rows,
		widthPx: raster.widthPx,
		heightPx: raster.heightPx,
	};
}

function parseSixelBands(sequence: string, fallbackWidthPx: number): ParsedSixelBands | undefined {
	const span = findSixelSequence(sequence);
	if (!span) return undefined;
	const prefix = sequence.slice(span.start, span.bodyStart);
	const body = sequence.slice(span.bodyStart, span.bodyEnd);
	let offset = 0;
	let rasterPrefix = `"1;1;${fallbackWidthPx};`;
	const rasterMatch = /^"(\d+);(\d+);(\d+);(\d+)/.exec(body);
	if (rasterMatch) {
		rasterPrefix = `"${rasterMatch[1]};${rasterMatch[2]};${rasterMatch[3]};`;
		offset = rasterMatch[0].length;
	}
	// Leading palette definitions (#n;1;... or #n;2;...) stay intact across cropped bands.
	const palettePattern = /#\d+;[12];\d+;\d+;\d+/gy;
	palettePattern.lastIndex = offset;
	let paletteEnd = offset;
	while (palettePattern.exec(body) !== null) {
		paletteEnd = palettePattern.lastIndex;
	}
	const paletteHeader = body.slice(offset, paletteEnd);
	const bandBody = body.slice(paletteEnd);
	const bands = bandBody.split("-");
	const bandStartColors: Array<number | undefined> = new Array(bands.length);
	let activeColor: number | undefined;
	const colorSelector = /#(\d+)/g;
	for (let i = 0; i < bands.length; i++) {
		bandStartColors[i] = activeColor;
		colorSelector.lastIndex = 0;
		let match = colorSelector.exec(bands[i]!);
		while (match !== null) {
			activeColor = Number.parseInt(match[1]!, 10);
			match = colorSelector.exec(bands[i]!);
		}
	}
	return { prefix, rasterPrefix, paletteHeader, bands, bandStartColors };
}

/** Crop a Sixel image line vertically by slicing its 6-pixel bands in O(bands) time. */
export function cropSixelImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getSixelImageMetadata(line);
	const span = findSixelSequence(line);
	if (!metadata || !span || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	if (hiddenRows === 0 && croppedRows === metadata.rows) return line;
	const sequence = line.slice(span.start, span.end);
	const parsed = parseSixelBands(sequence, metadata.widthPx);
	if (!parsed || parsed.bands.length === 0) return line;

	const totalBands = parsed.bands.length;
	const startBand = Math.min(totalBands - 1, Math.floor((hiddenRows * totalBands) / metadata.rows));
	const endBand = Math.max(
		startBand + 1,
		Math.min(totalBands, Math.ceil(((hiddenRows + croppedRows) * totalBands) / metadata.rows)),
	);
	const croppedHeightPx = Math.max(1, (endBand - startBand) * 6);
	const firstBand = parsed.bands[startBand] ?? "";
	const inheritedColor = startBand > 0 ? parsed.bandStartColors[startBand] : undefined;
	const colorPrefix = inheritedColor !== undefined && !firstBand.startsWith("#") ? `#${inheritedColor}` : "";
	const croppedSequence = `${parsed.prefix}${parsed.rasterPrefix}${croppedHeightPx}${parsed.paletteHeader}${colorPrefix}${parsed.bands.slice(startBand, endBand).join("-")}\x1b\\`;
	return `${line.slice(0, span.start)}${croppedSequence}${line.slice(span.end)}`;
}

/** Return metadata for any top-anchored croppable image (Kitty or Sixel). */
export function getCroppableImageMetadata(line: string): (ImageCellSize & ImageDimensions) | undefined {
	return getKittyImageMetadata(line) ?? getSixelImageMetadata(line);
}

/** Crop any top-anchored image line (Kitty or Sixel) to a vertical slice of rows. */
export function cropImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	if (line.includes(KITTY_PREFIX)) return cropKittyImageLine(line, hiddenRows, visibleRows);
	if (line.includes(SIXEL_PREFIX)) return cropSixelImageLine(line, hiddenRows, visibleRows);
	return line;
}

/** Return the number of rows covered by a top-anchored image placement (Kitty or Sixel). */
export function getImagePlacementRows(line: string): number | undefined {
	return getKittyImagePlacementRows(line) ?? getSixelImageMetadata(line)?.rows;
}

function getRegisteredKittyImageMetadataFromControls(controls: string): RegisteredKittyImageMetadata | undefined {
	const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	return imageId === undefined ? undefined : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}

function getRegisteredKittyImageMetadata(line: string): RegisteredKittyImageMetadata | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	return controls === undefined ? undefined : getRegisteredKittyImageMetadataFromControls(controls);
}

function getExplicitKittyImageRows(controls: string): number | undefined {
	const value = /(?:^|,)r=(\d+)(?:,|$)/.exec(controls)?.[1];
	if (value === undefined) return undefined;
	const rows = Number.parseInt(value, 10);
	return rows > 0 ? rows : undefined;
}

function getKittyImageRowsFromControls(controls: string, fallbackRows: number): number {
	return getExplicitKittyImageRows(controls) ?? fallbackRows;
}

export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	const metadata = getRegisteredKittyImageMetadata(line);
	if (!metadata) return undefined;
	return {
		imageId: metadata.imageId,
		columns: metadata.columns,
		rows: metadata.rows,
		widthPx: metadata.widthPx,
		heightPx: metadata.heightPx,
	};
}

const KITTY_PLACEMENT_CONTROL_KEYS = new Set([
	"i",
	"p",
	"x",
	"y",
	"w",
	"h",
	"X",
	"Y",
	"c",
	"r",
	"C",
	"U",
	"z",
	"P",
	"Q",
	"H",
	"V",
]);

/** Read the number of rows covered by an image placement without scanning its payload. */
export function getKittyImagePlacementRows(line: string): number | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	if (controls === undefined) return undefined;
	const explicitRows = getExplicitKittyImageRows(controls);
	if (explicitRows !== undefined) return explicitRows;
	return getRegisteredKittyImageMetadataFromControls(controls)?.rows;
}

/** Build a placement-only command for an image line emitted by {@link renderImage}. */
export function getKittyImagePlacement(line: string): KittyImagePlacement | undefined {
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!match) return undefined;
	const metadata = getRegisteredKittyImageMetadataFromControls(match[1]);
	if (!metadata) return undefined;

	let commandStart = match.index;
	let commandControls = match[1];
	let transmissionEnd: number;
	while (true) {
		const terminator = line.indexOf("\x1b\\", commandStart + KITTY_PREFIX.length);
		if (terminator === -1) return undefined;
		transmissionEnd = terminator + 2;
		if (!/(?:^|,)m=1(?:,|$)/.test(commandControls)) break;
		commandStart = transmissionEnd;
		if (!line.startsWith(KITTY_PREFIX, commandStart)) return undefined;
		const controlsEnd = line.indexOf(";", commandStart + KITTY_PREFIX.length);
		if (controlsEnd === -1) return undefined;
		commandControls = line.slice(commandStart + KITTY_PREFIX.length, controlsEnd);
	}

	const controls = match[1]
		.split(",")
		.filter((control) => KITTY_PLACEMENT_CONTROL_KEYS.has(control.split("=", 1)[0] ?? ""));
	const sequence = `\x1b_Ga=p,q=2,${controls.join(",")}\x1b\\`;
	return {
		imageId: metadata.imageId,
		transmissionGeneration: metadata.transmissionGeneration,
		transmissionBytes: transmissionEnd - match.index,
		estimatedDecodedBytes: metadata.widthPx * metadata.heightPx * 4,
		rows: getKittyImageRowsFromControls(match[1], metadata.rows),
		sequence,
		replacementLine: `${line.slice(0, match.index)}${sequence}${line.slice(transmissionEnd)}`,
	};
}

export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getKittyImageMetadata(line);
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!metadata || !match || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	if (hiddenRows === 0 && croppedRows === metadata.rows) return line;
	const sourceY = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows);
	const sourceEnd = Math.ceil((metadata.heightPx * (hiddenRows + croppedRows)) / metadata.rows);
	const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
	const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
	controls.push(`y=${sourceY}`, `h=${sourceHeight}`, `r=${croppedRows}`);
	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

function chooseLessDistortedCellCount(upperCount: number, idealCount: number): number {
	if (upperCount <= 1) return upperCount;

	const lowerCount = upperCount - 1;
	const upperDistortion = Math.max(upperCount / idealCount, idealCount / upperCount);
	const lowerDistortion = Math.max(lowerCount / idealCount, idealCount / lowerCount);
	return lowerDistortion < upperDistortion ? lowerCount : upperCount;
}

export function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
	optimizeAspectRatio = false,
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);

	const scaledWidthPx = imageWidth * scale;
	const scaledHeightPx = imageHeight * scale;
	let columns = Math.max(1, Math.min(maxWidth, Math.ceil(scaledWidthPx / cellDimensions.widthPx)));
	const heightRows = scaledHeightPx / cellDimensions.heightPx;
	let rows = Math.max(1, Math.ceil(heightRows));
	if (maxHeight !== undefined) {
		rows = Math.min(maxHeight, rows);
	}

	if (!optimizeAspectRatio) {
		return { columns, rows };
	}

	if (widthScale <= heightScale) {
		const idealRows = (columns * cellDimensions.widthPx * imageHeight) / (imageWidth * cellDimensions.heightPx);
		rows = chooseLessDistortedCellCount(rows, idealRows);
	} else {
		const idealColumns = (rows * cellDimensions.heightPx * imageWidth) / (imageHeight * cellDimensions.widthPx);
		columns = chooseLessDistortedCellCount(columns, idealColumns);
	}

	return { columns, rows };
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	return calculateImageCellSize(imageDimensions, targetWidthCells, undefined, cellDimensions).rows;
}

function sliceBase64Prefix(base64Data: string, maxDecodedBytes: number): { buffer: Buffer; complete: boolean } {
	const neededChars = Math.ceil(maxDecodedBytes / 3) * 4;
	let nonWhitespaceChars = 0;
	let end = 0;
	while (end < base64Data.length && nonWhitespaceChars < neededChars) {
		if (base64Data.charCodeAt(end) > 0x20) {
			nonWhitespaceChars++;
		}
		end++;
	}
	return {
		buffer: Buffer.from(end === base64Data.length ? base64Data : base64Data.slice(0, end), "base64"),
		complete: end === base64Data.length,
	};
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const { buffer } = sliceBase64Prefix(base64Data, 24);

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

function parseTiffOrientation(buffer: Buffer, tiffStart: number, end: number): number | undefined {
	if (end - tiffStart < 8) return undefined;
	const littleEndian = buffer[tiffStart] === 0x49 && buffer[tiffStart + 1] === 0x49;
	const bigEndian = buffer[tiffStart] === 0x4d && buffer[tiffStart + 1] === 0x4d;
	if (!littleEndian && !bigEndian) return undefined;
	const readU16 = (pos: number) => (littleEndian ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos));
	const readU32 = (pos: number) => (littleEndian ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos));
	if (readU16(tiffStart + 2) !== 42) return undefined;
	const ifdOffset = readU32(tiffStart + 4);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdStart < tiffStart || ifdStart + 2 > end) return undefined;
	const entryCount = readU16(ifdStart);
	for (let i = 0; i < entryCount; i++) {
		const entryStart = ifdStart + 2 + i * 12;
		if (entryStart + 12 > end) break;
		if (readU16(entryStart) === 0x0112) {
			return readU16(entryStart + 8);
		}
	}
	return undefined;
}

function hasExifHeader(buffer: Buffer, start: number, end: number): boolean {
	return (
		end - start >= 6 &&
		buffer[start] === 0x45 &&
		buffer[start + 1] === 0x78 &&
		buffer[start + 2] === 0x69 &&
		buffer[start + 3] === 0x66 &&
		buffer[start + 4] === 0x00 &&
		buffer[start + 5] === 0x00
	);
}

function parseExifOrientation(buffer: Buffer, start: number, end: number): number | undefined {
	if (!hasExifHeader(buffer, start, end)) return undefined;
	return parseTiffOrientation(buffer, start + 6, end);
}

function parseWebpExifOrientation(buffer: Buffer): number | undefined {
	let offset = 12;
	while (offset + 8 <= buffer.length) {
		const chunkId = buffer.slice(offset, offset + 4).toString("ascii");
		const chunkSize = buffer.readUInt32LE(offset + 4);
		const dataStart = offset + 8;
		const dataEnd = dataStart + chunkSize;
		if (dataEnd > buffer.length) return undefined;
		if (chunkId === "EXIF") {
			const tiffStart = hasExifHeader(buffer, dataStart, dataEnd) ? dataStart + 6 : dataStart;
			return parseTiffOrientation(buffer, tiffStart, dataEnd);
		}
		// RIFF chunks are padded to an even byte boundary.
		offset = dataEnd + (chunkSize % 2);
	}
	return undefined;
}

function parseJpegDimensions(
	buffer: Buffer,
	complete: boolean,
): { kind: "done"; dimensions: ImageDimensions | null } | { kind: "truncated" } {
	if (buffer.length < 2) {
		return complete ? { kind: "done", dimensions: null } : { kind: "truncated" };
	}

	if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
		return { kind: "done", dimensions: null };
	}

	let exifOrientation: number | undefined;
	let offset = 2;
	while (offset < buffer.length - 9) {
		if (buffer[offset] !== 0xff) {
			offset++;
			continue;
		}

		const marker = buffer[offset + 1];

		if (marker >= 0xc0 && marker <= 0xc2) {
			const height = buffer.readUInt16BE(offset + 5);
			const width = buffer.readUInt16BE(offset + 7);
			const rotated = exifOrientation !== undefined && exifOrientation >= 5 && exifOrientation <= 8;
			return {
				kind: "done",
				dimensions: rotated ? { widthPx: height, heightPx: width } : { widthPx: width, heightPx: height },
			};
		}

		if (offset + 3 >= buffer.length) {
			return complete ? { kind: "done", dimensions: null } : { kind: "truncated" };
		}
		const length = buffer.readUInt16BE(offset + 2);
		if (length < 2) {
			return { kind: "done", dimensions: null };
		}
		const segmentEnd = offset + 2 + length;
		if (marker === 0xe1) {
			if (segmentEnd > buffer.length) {
				if (!complete) return { kind: "truncated" };
			} else if (exifOrientation === undefined) {
				exifOrientation = parseExifOrientation(buffer, offset + 4, segmentEnd);
			}
		}
		offset = segmentEnd;
	}

	return complete ? { kind: "done", dimensions: null } : { kind: "truncated" };
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		// Most JPEG SOF0-SOF2 headers precede image scan data within the first 48 KiB.
		const prefix = sliceBase64Prefix(base64Data, 48 * 1024);
		const parsed = parseJpegDimensions(prefix.buffer, prefix.complete);
		if (parsed.kind === "done") {
			return parsed.dimensions;
		}
		const full = parseJpegDimensions(Buffer.from(base64Data, "base64"), true);
		return full.kind === "done" ? full.dimensions : null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const { buffer } = sliceBase64Prefix(base64Data, 10);

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const { buffer } = sliceBase64Prefix(base64Data, 30);

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			const fullBuffer = Buffer.from(base64Data, "base64");
			const orientation = parseWebpExifOrientation(fullBuffer);
			if (orientation !== undefined && orientation >= 5 && orientation <= 8) {
				return { widthPx: height, heightPx: width };
			}
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; columns: number; rows: number; imageId?: number } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const cellDims = getCellDimensions();
	// Reduce Kitty's cell-aligned distortion without shrinking iTerm2 reservations.
	const size = calculateImageCellSize(
		imageDimensions,
		maxWidth,
		options.maxHeightCells,
		cellDims,
		caps.images === "kitty" || caps.images === "sixel",
	);

	if (caps.images === "kitty") {
		if (options.imageId !== undefined) {
			registerKittyImageMetadata({
				imageId: options.imageId,
				columns: size.columns,
				rows: size.rows,
				widthPx: imageDimensions.widthPx,
				heightPx: imageDimensions.heightPx,
			});
		}
		const sequence = encodeKitty(base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, columns: size.columns, rows: size.rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: size.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, columns: size.columns, rows: size.rows };
	}

	if (caps.images === "sixel") {
		if (!sixelEncoder) return null;
		const boxWidthPx = size.columns * cellDims.widthPx;
		const boxHeightPx = size.rows * cellDims.heightPx;
		const srcW = Math.max(1, imageDimensions.widthPx);
		const srcH = Math.max(1, imageDimensions.heightPx);
		const scale = Math.min(boxWidthPx / srcW, boxHeightPx / srcH);
		const targetWidthPx = Math.max(1, Math.min(boxWidthPx, Math.round(srcW * scale)));
		const targetHeightPx = Math.max(1, Math.min(boxHeightPx, Math.round(srcH * scale)));
		const rawSequence = sixelEncoder({
			base64Data,
			mimeType: options.mimeType ?? "image/png",
			widthPx: targetWidthPx,
			heightPx: targetHeightPx,
		});
		if (!rawSequence) return null;
		const sequence = ensureSixelRasterAttributes(rawSequence, targetWidthPx, targetHeightPx);
		maxSixelImageRows = Math.max(maxSixelImageRows, size.rows);
		return { sequence, columns: size.columns, rows: size.rows };
	}

	return null;
}

/** Longest URL that {@link hyperlink} wraps in an OSC 8 sequence. Real links are far shorter. */
const MAX_HYPERLINK_URL_LENGTH = 8192;

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * URLs longer than {@link MAX_HYPERLINK_URL_LENGTH} are not linked: wrapping re-opens the link on
 * every line with the full URL, so a multi-megabyte URL would grow memory quadratically.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	if (url.length > MAX_HYPERLINK_URL_LENGTH) {
		return text;
	}
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Shorten home-prefixed absolute paths to ~/... for compact display. */
function shortenImagePath(filename: string): string {
	const home = homedir();
	if (home && (filename === home || filename.startsWith(`${home}/`) || filename.startsWith(`${home}\\`))) {
		return `~${filename.slice(home.length)}`;
	}
	return filename;
}

/**
 * Text fallback when the terminal cannot render inline images.
 * Absolute paths are shown shortened (~/...) and, when OSC 8 hyperlinks are
 * available, linked to file:// so the full path remains openable.
 */
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const display = shortenImagePath(filename);
		if (getCapabilities().hyperlinks && isAbsolute(filename)) {
			parts.push(hyperlink(display, pathToFileURL(filename).href));
		} else {
			parts.push(display);
		}
	}
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
