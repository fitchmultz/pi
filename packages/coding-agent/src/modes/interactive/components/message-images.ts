import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Container, getCapabilities, Image, Spacer } from "@earendil-works/pi-tui";
import { resolveReadPathAsync } from "../../../core/tools/path-utils.ts";
import { ensureImageEncoders } from "../../../utils/image-convert.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../../utils/mime.ts";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const REMOTE_SCHEME_RE = /^(?:https?|ftp|data|mailto):/i;

export interface LoadedLocalImage {
	data: string;
	mimeType: string;
	filename: string;
}

export interface MessageImageDisplayOptions {
	cwd?: string;
	showImages?: boolean;
	imageWidthCells?: number;
	onImageLoaded?: () => void;
}

function hasSupportedImageExtension(candidate: string): boolean {
	const ext = extname(candidate).toLowerCase();
	return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

function normalizeCandidatePath(raw: string): string | null {
	let candidate = raw.trim();
	if (!candidate || candidate.includes("\n") || candidate.includes("\r")) return null;
	if (candidate.startsWith("<") && candidate.endsWith(">")) {
		candidate = candidate.slice(1, -1).trim();
	}
	if (!candidate || REMOTE_SCHEME_RE.test(candidate)) return null;
	if (/^file:\/\//i.test(candidate)) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}
	// Strip query/fragment suffixes (e.g. Markdown links like `shot.png?v=1`)
	const cleanForExt = candidate.replace(/[?#].*$/, "");
	if (!hasSupportedImageExtension(cleanForExt)) return null;
	return cleanForExt;
}

// Single-pass tokenizer in priority order:
// 1. Fenced code blocks (skipped)
// 2. Markdown image syntax ![alt](<path>) or ![alt](path "title")
// 3. Inline code spans `path`
// 4. Remote URLs http(s)/ftp/data (skipped so host/path segments are not matched as local files)
// 5. file:// URLs
// 6. Quoted paths "..." or '...'
// 7. Bare or backslash-escaped local paths (with optional leading @)
const IMAGE_TOKEN_RE =
	/(```[\s\S]*?```|~~~[\s\S]*?~~~)|!\[[^\]]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\)|`([^`\n]+)`|\b(?:https?|ftp):\/\/[^\s"'<>()[\]]+|\bdata:[^\s"'<>()[\]]+|(file:\/\/[^\s"'<>()[\]]+)|(?<=^|[\s([{:;,=])(["'])((?:\\.|(?!\6)[^\n])+?\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^\s"']*)?)\6|(?<=^|[\s([{:;,=])(@?(?:~\/|\.\.?\/|\/)?(?:\\ |[^\s"'<>()[\]`,;:])+?\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s)\]}.,;:!?])/gi;

const BARE_IMAGE_PATH_RE =
	/(?<=^|[\s([{:;,=])(@?(?:~\/|\.\.?\/|\/)?(?:\\ |[^\s"'<>()[\]`,;:])+?\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s)\]}.,;:!?])/gi;

// Matches unquoted rooted paths containing literal spaces (e.g. Finder clipboard paste of macOS screenshots).
const ROOTED_SPACED_IMAGE_PATH_RE =
	/(?<=^|[\s([{:;,=])(@?(?:~\/|\.\.?\/|\/)(?:(?!\s+(?:~\/|\.\.?\/|\/))[^\n"'<>()[\]`,;:])*?\s(?:(?!\s+(?:~\/|\.\.?\/|\/))[^\n"'<>()[\]`,;:])*?\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s)\]}.,;:!?])/gi;

/**
 * Extract deduplicated local image file paths referenced in user or assistant message text.
 * Ignores fenced code blocks and remote URLs (`http://`, `https://`, `data:`).
 */
export function extractLocalImagePaths(text: string): string[] {
	if (!text) return [];
	const paths: string[] = [];
	const seen = new Set<string>();
	const add = (raw: string | undefined): void => {
		if (!raw) return;
		const normalized = normalizeCandidatePath(raw);
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		paths.push(normalized);
	};

	IMAGE_TOKEN_RE.lastIndex = 0;
	let match = IMAGE_TOKEN_RE.exec(text);
	while (match !== null) {
		if (match[1]) {
			// Fenced code block — skip
		} else if (match[2] || match[3]) {
			add(match[2] ?? match[3]);
		} else if (match[4]) {
			add(match[4]);
		} else if (match[5]) {
			add(match[5]);
		} else if (match[7]) {
			const quoted = match[7].replace(/\\ /g, " ");
			add(quoted);
			// If a quoted phrase contains an embedded bare path (e.g. "see /tmp/shot.png"), extract it too.
			BARE_IMAGE_PATH_RE.lastIndex = 0;
			let inner = BARE_IMAGE_PATH_RE.exec(quoted);
			while (inner !== null) {
				add(inner[1]?.replace(/\\ /g, " "));
				inner = BARE_IMAGE_PATH_RE.exec(quoted);
			}
		} else if (match[8]) {
			add(match[8].replace(/\\ /g, " "));
		}
		match = IMAGE_TOKEN_RE.exec(text);
	}

	const withoutFences = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "\n");
	ROOTED_SPACED_IMAGE_PATH_RE.lastIndex = 0;
	let spacedMatch = ROOTED_SPACED_IMAGE_PATH_RE.exec(withoutFences);
	while (spacedMatch !== null) {
		add(spacedMatch[1]?.replace(/\\ /g, " "));
		spacedMatch = ROOTED_SPACED_IMAGE_PATH_RE.exec(withoutFences);
	}
	return paths;
}

/**
 * Resolve and load a local image path for inline TUI display after verifying its file magic bytes.
 * Returns `null` for missing, unreadable, empty, or non-image files.
 */
export async function loadLocalImage(rawPath: string, cwd: string): Promise<LoadedLocalImage | null> {
	const candidates = [rawPath];
	if (rawPath.includes("%")) {
		try {
			const decoded = decodeURIComponent(rawPath);
			if (decoded !== rawPath) candidates.push(decoded);
		} catch {
			// Ignore malformed percent sequences and try literal path only.
		}
	}
	for (const candidate of candidates) {
		try {
			const resolved = await resolveReadPathAsync(candidate, cwd);
			const fileStat = await stat(resolved);
			if (!fileStat.isFile() || fileStat.size <= 0) {
				continue;
			}

			const mimeType = await detectSupportedImageMimeTypeFromFile(resolved);
			if (!mimeType) continue;

			const bytes = await readFile(resolved);
			return {
				data: bytes.toString("base64"),
				mimeType,
				filename: resolved,
			};
		} catch {
			// Try next candidate
		}
	}
	return null;
}

/**
 * Renders attached and local-path images inline inside user and assistant message components.
 */
export class MessageImagesContainer extends Container {
	private cwd?: string;
	private showImages: boolean;
	private imageWidthCells: number;
	private onImageLoaded?: () => void;
	private fallbackColor: (text: string) => string;

	private lastText = "";
	private lastAttached: readonly ImageContent[] = [];
	private lastExtractSource?: { text: string; hasAttached: boolean };
	private cachedCandidatePaths: string[] = [];
	private lastLoadedPathsKey?: string;
	private loadedFileImages: LoadedLocalImage[] = [];
	private imageSources: Array<{ data: string; mimeType: string; widthCells: number; filename?: string }> = [];
	private imageComponents: Image[] = [];
	private loadGeneration = 0;

	constructor(fallbackColor: (text: string) => string, options: MessageImageDisplayOptions = {}) {
		super();
		this.fallbackColor = fallbackColor;
		this.cwd = options.cwd;
		this.showImages = options.showImages ?? false;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.onImageLoaded = options.onImageLoaded;
	}

	hasImages(): boolean {
		return this.children.length > 0;
	}

	setShowImages(show: boolean): void {
		if (this.showImages === show) return;
		this.showImages = show;
		if (!show) {
			this.loadGeneration += 1;
			this.lastLoadedPathsKey = undefined;
			this.loadedFileImages = [];
			this.clearImages();
			this.invalidate();
			return;
		}
		this.sync(this.lastText, this.lastAttached, true);
	}

	setImageWidthCells(widthCells: number): void {
		if (this.imageWidthCells === widthCells) return;
		this.imageWidthCells = widthCells;
		this.rebuildChildren();
	}

	sync(text: string, attachedImages: readonly ImageContent[], allowFileLoad: boolean): void {
		this.lastText = text;
		this.lastAttached = attachedImages;

		if (!this.showImages) {
			this.loadGeneration += 1;
			this.lastLoadedPathsKey = undefined;
			this.loadedFileImages = [];
			this.clearImages();
			return;
		}

		const hasImageProtocol = getCapabilities().images !== null;
		if (!hasImageProtocol) {
			this.loadGeneration += 1;
			this.lastLoadedPathsKey = undefined;
			this.loadedFileImages = [];
			// Keep plain text messages clean when the terminal has no inline image protocol;
			// still show fallbacks for attached image blocks when there is no text.
			if (attachedImages.length > 0 && !text.trim()) {
				this.rebuildChildren();
			} else {
				this.clearImages();
			}
			return;
		}

		this.rebuildChildren();

		if (!allowFileLoad || !this.cwd) return;
		const hasAttached = attachedImages.length > 0;
		let candidatePaths = this.cachedCandidatePaths;
		if (
			!this.lastExtractSource ||
			this.lastExtractSource.text !== text ||
			this.lastExtractSource.hasAttached !== hasAttached
		) {
			// `@file` image attachments emit `<file name="/abs/path">...</file>` alongside an ImageContent block
			// that may have been resized. Skip those attachment tags when attached images are already present
			// so resized `@file` images do not reload from disk and render twice.
			const extractableText = hasAttached ? text.replace(/<file\s+name="[^"]*">[\s\S]*?<\/file>/g, " ") : text;
			candidatePaths = extractLocalImagePaths(extractableText);
			this.lastExtractSource = { text, hasAttached };
			this.cachedCandidatePaths = candidatePaths;
		}
		const pathsKey = `${this.cwd}\0${candidatePaths.join("\0")}`;
		if (pathsKey === this.lastLoadedPathsKey) return;
		this.lastLoadedPathsKey = pathsKey;

		if (candidatePaths.length === 0) {
			if (this.loadedFileImages.length > 0) {
				this.loadedFileImages = [];
				this.rebuildChildren();
			}
			return;
		}

		const generation = ++this.loadGeneration;
		const cwd = this.cwd;
		void Promise.all(candidatePaths.map((candidate) => loadLocalImage(candidate, cwd))).then((results) => {
			if (generation !== this.loadGeneration || !this.showImages || getCapabilities().images === null) {
				return;
			}
			const resolvedImages: LoadedLocalImage[] = [];
			const seenFilenames = new Set<string>();
			for (const loaded of results) {
				if (!loaded || seenFilenames.has(loaded.filename)) continue;
				seenFilenames.add(loaded.filename);
				resolvedImages.push(loaded);
			}
			this.loadedFileImages = resolvedImages;
			this.rebuildChildren();
			this.invalidate();
			this.onImageLoaded?.();
		});
	}

	private clearImages(): void {
		if (this.children.length === 0 && this.imageComponents.length === 0) return;
		this.clear();
		this.imageSources = [];
		this.imageComponents = [];
	}

	private rebuildChildren(): void {
		if (!this.showImages) {
			this.clearImages();
			return;
		}

		const seenData = new Set<string>();
		const nextSources: Array<{ data: string; mimeType: string; widthCells: number; filename?: string }> = [];

		for (const img of this.lastAttached) {
			if (!img.data || !img.mimeType || seenData.has(img.data)) continue;
			seenData.add(img.data);
			nextSources.push({ data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells });
		}
		for (const img of this.loadedFileImages) {
			if (!img.data || !img.mimeType || seenData.has(img.data)) continue;
			seenData.add(img.data);
			nextSources.push({
				data: img.data,
				mimeType: img.mimeType,
				widthCells: this.imageWidthCells,
				filename: img.filename,
			});
		}

		// Reuse existing Image instances when inputs are unchanged so Kitty image IDs and cached PNG/Sixel data stay stable.
		if (
			nextSources.length === this.imageSources.length &&
			this.children.length === nextSources.length * 2 &&
			nextSources.every((src, idx) => {
				const prev = this.imageSources[idx];
				return (
					prev !== undefined &&
					prev.data === src.data &&
					prev.mimeType === src.mimeType &&
					prev.widthCells === src.widthCells &&
					prev.filename === src.filename
				);
			})
		) {
			return;
		}

		const reusableByKey = new Map<string, Image>();
		for (let i = 0; i < this.imageSources.length; i++) {
			const prev = this.imageSources[i];
			const comp = this.imageComponents[i];
			if (!prev || !comp) continue;
			reusableByKey.set(`${prev.data}\0${prev.mimeType}\0${prev.widthCells}\0${prev.filename ?? ""}`, comp);
		}

		this.clear();
		const nextComponents: Image[] = [];
		for (const item of nextSources) {
			const key = `${item.data}\0${item.mimeType}\0${item.widthCells}\0${item.filename ?? ""}`;
			const component =
				reusableByKey.get(key) ??
				new Image(
					item.data,
					item.mimeType,
					{ fallbackColor: this.fallbackColor },
					{ maxWidthCells: item.widthCells, filename: item.filename },
				);
			this.addChild(new Spacer(1));
			this.addChild(component);
			nextComponents.push(component);
			ensureImageEncoders(() => {
				this.invalidate();
				this.onImageLoaded?.();
			}, item.mimeType);
		}
		this.imageSources = nextSources;
		this.imageComponents = nextComponents;
	}
}
