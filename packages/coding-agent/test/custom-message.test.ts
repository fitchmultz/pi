import { resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import type { MarkdownTransformContext, MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toMatchObject([{ expanded: false, outputPad: 1, compactView: false }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toMatchObject({ expanded: false, outputPad: 0, compactView: false });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});

	// Upstream's seven positional arguments keep upstream's positions: an extension written for upstream gets its
	// transformers, message ID and timestamp, and does not turn on compact view.
	test("runs Markdown transformers on default-rendered content when constructed the upstream way", () => {
		initTheme("dark");
		const contexts: MarkdownTransformContext[] = [];
		const optionsSeen: MessageRenderOptions[] = [];
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "original",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(
			message,
			(_message, options) => {
				optionsSeen.push(options);
				return undefined;
			},
			undefined,
			1,
			[
				(markdown, context) => {
					contexts.push(context);
					return markdown.replace("original", "transformed");
				},
			],
			"entry-1",
			"2025-01-15T10:30:00.000Z",
		);

		const rendered = component.render(40).map(stripAnsi).join("\n");
		expect(rendered).toContain("transformed");
		expect(rendered).not.toContain("original");
		expect(contexts[0]).toMatchObject({
			messageType: "custom",
			isStreaming: false,
			messageId: "entry-1",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
		expect(optionsSeen).toMatchObject([{ compactView: false }]);
	});
});

describe("CustomMessageComponent images", () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=";

	afterEach(() => {
		resetCapabilitiesCache();
	});

	test("draws the image blocks of a message below its custom renderer", () => {
		initTheme("dark");
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: [
				{ type: "text", text: "saved to /tmp/a.png" },
				{ type: "image", data: png, mimeType: "image/png" },
			],
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, () => new Text("rendered", 0, 0), undefined, 1);

		const lines = component.render(40).join("\n");
		expect(lines).toContain("rendered");
		expect(lines).toContain("\x1b_G");

		component.setShowImages(false);
		expect(component.render(40).join("\n")).not.toContain("\x1b_G");
		component.setShowImages(true);
		expect(component.render(40).join("\n")).toContain("\x1b_G");
	});

	test("draws them for the default rendering too, and only when expanded in compact view", () => {
		initTheme("dark");
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: [{ type: "image", data: png, mimeType: "image/png" }],
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, undefined, undefined, 1, [], undefined, undefined, true);

		expect(component.render(40).join("\n")).not.toContain("\x1b_G");
		component.setExpanded(true);
		expect(component.render(40).join("\n")).toContain("\x1b_G");
	});
});
