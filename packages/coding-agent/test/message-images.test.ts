import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	isImageLine,
	isSixelImageLine,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	setSixelEncoder,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { extractLocalImagePaths, loadLocalImage } from "../src/modes/interactive/components/message-images.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Valid 1x1 red PNG
const PNG_1X1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const PNG_1X1_BYTES = Buffer.from(PNG_1X1_BASE64, "base64");

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("extractLocalImagePaths", () => {
	it("extracts Markdown, backtick, quoted, file://, drag-dropped, and spaced macOS screenshot paths while ignoring fences and URLs", () => {
		const text = [
			"Look at ![home](<./shots/Home Page.png>) and ![dup](./shots/Home%20Page.png)",
			'Saved to `/tmp/pi-codemode-1.png` and "/Users/test/My Folder/chart.webp"',
			"Finder drop: /Users/test/Desktop/Screenshot\\ 2026-11-26\\ at\\ 1.23.45\\ PM.png",
			"Clipboard paste: /Users/test/Desktop/Screenshot 2026-11-26 at 2.00.00 PM.png",
			"Mention: @assets/logo.jpg and file:///tmp/from-url.gif",
			"Ignore https://example.com/remote.png and data:image/png;base64,AAAA",
			"```ts",
			'const ignored = "/tmp/inside-code-fence.png";',
			"```",
		].join("\n");

		const extracted = extractLocalImagePaths(text);
		expect(extracted).toContain("./shots/Home Page.png");
		expect(extracted).toContain("/tmp/pi-codemode-1.png");
		expect(extracted).toContain("/Users/test/My Folder/chart.webp");
		expect(extracted).toContain("/Users/test/Desktop/Screenshot 2026-11-26 at 1.23.45 PM.png");
		expect(extracted).toContain("/Users/test/Desktop/Screenshot 2026-11-26 at 2.00.00 PM.png");
		expect(extracted).toContain("@assets/logo.jpg");
		expect(extracted).toContain("/tmp/from-url.gif");
		expect(extracted.some((p) => p.includes("example.com"))).toBe(false);
		expect(extracted.some((p) => p.includes("inside-code-fence"))).toBe(false);
	});
});

describe("inline images in UserMessageComponent and AssistantMessageComponent", () => {
	let tempDir: string;

	beforeEach(() => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "pi-msg-images-"));
	});

	afterEach(() => {
		setSixelEncoder(undefined);
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		resetCapabilitiesCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loadLocalImage resolves macOS narrow-space screenshot paths and rejects fake non-image files", async () => {
		const realShot = join(tempDir, "Screenshot 2026-11-26 at 1.23.45\u202fPM.png");
		const fakePng = join(tempDir, "fake.png");
		writeFileSync(realShot, PNG_1X1_BYTES);
		writeFileSync(fakePng, "not actually a png");

		const loaded = await loadLocalImage(join(tempDir, "Screenshot 2026-11-26 at 1.23.45 PM.png"), tempDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.mimeType).toBe("image/png");
		expect(loaded!.data).toBe(PNG_1X1_BASE64);
		expect(await loadLocalImage(fakePng, tempDir)).toBeNull();
		expect(await loadLocalImage(join(tempDir, "missing.png"), tempDir)).toBeNull();
	});

	it("renders local path images inline in UserMessageComponent under Sixel, supports live toggle, and keeps OSC 133 off image rows", async () => {
		const shotPath = join(tempDir, "shot.png");
		writeFileSync(shotPath, PNG_1X1_BYTES);

		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 18 });
		setSixelEncoder(({ widthPx, heightPx }) => `\x1bP0;1q"1;1;${widthPx};${heightPx}#0;2;100;0;0#0~~~\x1b\\`);

		let resolveLoaded!: () => void;
		const loadedPromise = new Promise<void>((resolve) => {
			resolveLoaded = resolve;
		});

		const component = new UserMessageComponent(`Check ${shotPath}`, undefined, 1, [], undefined, undefined, {
			cwd: tempDir,
			showImages: true,
			imageWidthCells: 4,
			onImageLoaded: () => resolveLoaded(),
		});

		await loadedPromise;
		const withImages = component.render(80);
		const imageRowIndex = withImages.findIndex((line) => isSixelImageLine(line));
		expect(imageRowIndex).toBeGreaterThan(0);
		// OSC 133 end marker must remain on the last text row, never on trailing Sixel or reservation rows.
		expect(withImages[imageRowIndex - 2]).toContain("\x1b]133;B\x07\x1b]133;C\x07");
		expect(withImages.slice(imageRowIndex).some((line) => line.includes("\x1b]133;"))).toBe(false);

		// Turning showImages off restores exact plain text rendering.
		component.setShowImages(false);
		const plain = component.render(80);
		expect(plain.some((line) => isImageLine(line))).toBe(false);
		expect(plain).toEqual(new UserMessageComponent(`Check ${shotPath}`).render(80));
	});

	it("renders attached UserMessage ImageContent and deduplicates identical local file references", async () => {
		const shotPath = join(tempDir, "attached.png");
		writeFileSync(shotPath, PNG_1X1_BYTES);

		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let resolveLoaded!: () => void;
		const loadedPromise = new Promise<void>((resolve) => {
			resolveLoaded = resolve;
		});

		const component = new UserMessageComponent(`See ${shotPath}`, undefined, 1, [], undefined, undefined, {
			cwd: tempDir,
			showImages: true,
			imageWidthCells: 10,
			images: [{ type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" }],
			onImageLoaded: () => resolveLoaded(),
		});

		await loadedPromise;
		const lines = component.render(80);
		const imageLines = lines.filter((line) => isImageLine(line));
		expect(imageLines).toHaveLength(1);
	});

	it("does not render a resized @file image attachment twice from its <file name> tag while keeping extra paths", async () => {
		const attachedPath = join(tempDir, "large-shot.png");
		const extraPath = join(tempDir, "extra.png");
		// Different valid 1x1 PNG bytes on disk vs resized attached ImageContent payload
		const otherPngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		writeFileSync(attachedPath, PNG_1X1_BYTES);
		writeFileSync(extraPath, Buffer.from(otherPngBase64, "base64"));

		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		// Case 1: only `<file name="...">` tag + resized attachment -> must render exactly 1 image (no disk reload).
		const singleComponent = new UserMessageComponent(
			`<file name="${attachedPath}">[Image resized to 1000x1000]</file>\nDescribe this`,
			undefined,
			1,
			[],
			undefined,
			undefined,
			{
				cwd: tempDir,
				showImages: true,
				imageWidthCells: 10,
				images: [{ type: "image", data: otherPngBase64, mimeType: "image/png" }],
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(singleComponent.render(80).filter((line) => isImageLine(line))).toHaveLength(1);

		// Case 2: `<file name="...">` tag + separate referenced local path -> renders both without duplicating the @file image.
		let resolveExtra!: () => void;
		const extraLoaded = new Promise<void>((resolve) => {
			resolveExtra = resolve;
		});
		const combinedComponent = new UserMessageComponent(
			`<file name="${attachedPath}"></file>\nCompare with ${extraPath}`,
			undefined,
			1,
			[],
			undefined,
			undefined,
			{
				cwd: tempDir,
				showImages: true,
				imageWidthCells: 10,
				images: [{ type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" }],
				onImageLoaded: () => resolveExtra(),
			},
		);
		await extraLoaded;
		expect(combinedComponent.render(80).filter((line) => isImageLine(line))).toHaveLength(2);
	});

	it("renders Markdown and local-path images inline in AssistantMessageComponent once streaming finishes", async () => {
		const shotPath = join(tempDir, "capture.png");
		writeFileSync(shotPath, PNG_1X1_BYTES);

		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let loadCount = 0;
		let resolveLoaded!: () => void;
		const loadedPromise = new Promise<void>((resolve) => {
			resolveLoaded = resolve;
		});

		const message = createAssistantMessage(`Here is the screenshot:\n\n![Captured](${shotPath})`);
		const component = new AssistantMessageComponent(
			undefined,
			false,
			undefined,
			"Thinking...",
			1,
			[],
			undefined,
			undefined,
			false,
			{
				cwd: tempDir,
				showImages: true,
				imageWidthCells: 12,
				onImageLoaded: () => {
					loadCount++;
					resolveLoaded();
				},
			},
		);

		// While streaming, local paths are not loaded from disk yet.
		component.updateContent(message, true);
		expect(component.render(80).some((line) => isImageLine(line))).toBe(false);
		expect(loadCount).toBe(0);

		// Once streaming completes, the image loads and renders inline.
		component.updateContent(message, false);
		await loadedPromise;
		const rendered = component.render(80);
		const imageRow = rendered.findIndex((line) => isImageLine(line));
		expect(imageRow).toBeGreaterThan(0);
		expect(rendered.slice(imageRow).some((line) => line.includes("\x1b]133;"))).toBe(false);

		// Live toggle hides the inline image cleanly.
		component.setShowImages(false);
		expect(component.render(80).some((line) => isImageLine(line))).toBe(false);
	});
});
