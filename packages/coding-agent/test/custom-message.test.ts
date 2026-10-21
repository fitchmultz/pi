import { resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
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

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1, compactView: false }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0, compactView: false });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
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
		const component = new CustomMessageComponent(message, undefined, undefined, 1, true);

		expect(component.render(40).join("\n")).not.toContain("\x1b_G");
		component.setExpanded(true);
		expect(component.render(40).join("\n")).toContain("\x1b_G");
	});
});
