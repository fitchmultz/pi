import { resetCapabilitiesCache, setCapabilities, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => {
	resetCapabilitiesCache();
	initTheme("dark", false);
});

class RecordingTerminal extends VirtualTerminal {
	output = "";
	override write(data: string): void {
		this.output += data;
		super.write(data);
	}
}

// #243: native iTerm 3.7.6 extends colored edge cells into margins and Minimal chrome.
// Parse actual renderer writes: reset bytes alone cannot establish cell backgrounds.
describe.each(["regular", "fullscreen"] as const)("%s chat background boundary", (tuiMode) => {
	test.each([false, true, "hybrid"] as const)(
		"cards retain colors inside default-background gutters (compact=%s)",
		async (compactView) => {
			const terminal = new VirtualTerminal(100, 60);
			const renderer = createInteractiveTui({ tuiMode, terminal, showHardwareCursor: false, logDirectory: "/tmp" });
			const chat = new ChatContainer();
			chat.setCompactView(compactView);
			chat.setExpanded(true);
			const tools = Array.from({ length: 36 }, (_, n) => {
				const tool = new ToolExecutionComponent(
					"fixture",
					`fixture-${n}`,
					{},
					{ compactView: !!compactView },
					{
						renderCall: () => new Text(`Card ${n}: ${"wide 界 call ".repeat(12)}`, 0, 0),
						renderResult: (result) =>
							new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 0, 0),
					},
					renderer,
					process.cwd(),
				);
				tool.markExecutionStarted();
				tool.updateResult(
					{ content: [{ type: "text", text: `Card ${n}: streaming\nSecond detail` }], isError: false },
					n === 35,
				);
				chat.addChild(tool);
				return tool;
			});
			chat.addChild(new Text("AFTER CARDS", 0, 0));
			renderer.addChild(chat);
			const assertFrame = () => {
				const xterm = (terminal as unknown as { xterm: XtermTerminal }).xterm;
				const buffer = xterm.buffer.active;
				let coloredInterior = 0;
				for (let row = 0; row < terminal.rows; row++) {
					const line = buffer.getLine(buffer.viewportY + row);
					expect(line?.getCell(0)?.isBgDefault(), `left edge row ${row}`).toBe(true);
					expect(line?.getCell(terminal.columns - 1)?.isBgDefault(), `right edge row ${row}`).toBe(true);
					for (let column = 1; column < terminal.columns - 1; column++) {
						if (line?.getCell(column)?.isBgDefault() === false) coloredInterior++;
					}
				}
				expect(coloredInterior).toBeGreaterThan(terminal.columns);
			};
			renderer.start();
			try {
				await terminal.waitForRender();
				assertFrame();
				tools[35].updateResult({
					content: [{ type: "text", text: "Final output\nSecond detail" }],
					isError: false,
				});
				renderer.requestRender();
				await terminal.waitForRender();
				assertFrame();
				expect(terminal.getViewport().join("\n")).toContain("AFTER CARDS");
				if (renderer instanceof TuiAltScreen) {
					renderer.scrollToTop();
					await terminal.waitForRender();
					assertFrame();
					renderer.scrollToBottom();
					await terminal.waitForRender();
					assertFrame();
				}
				terminal.resize(52, 24);
				await terminal.waitForRender();
				assertFrame();
				terminal.resize(100, 60);
				await terminal.waitForRender();
				assertFrame();
			} finally {
				renderer.stop();
			}
		},
	);
});

// Gutters must not hide semantic prefixes or replace image continuation rows.
describe.each([false, "hybrid"] as const)("chat gutter protocol compatibility (compact=%s)", (compactView) => {
	test("keeps native prompt navigation and fullscreen OSC 133 suppression", async () => {
		const terminal = new RecordingTerminal(40, 3);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			terminal,
			showHardwareCursor: false,
			logDirectory: "/tmp",
		});
		const chat = new ChatContainer();
		chat.setCompactView(compactView);
		for (let n = 0; n < 4; n++) chat.addChild(new UserMessageComponent(`Prompt ${n}`));
		expect(chat.render(40).filter((line) => line.startsWith("\x1b]133;A\x07"))).toHaveLength(4);
		renderer.addChild(chat);
		renderer.start();
		try {
			await terminal.waitForRender();
			const top = renderer.viewportTop;
			terminal.sendInput("\x1b[1;6A");
			await terminal.waitForRender();
			expect(renderer.viewportTop).toBeLessThan(top);
			expect(terminal.output).not.toContain("\x1b]133;");
		} finally {
			renderer.stop();
		}
	});

	test("keeps a native Kitty image visible when its anchor scrolls offscreen", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		// Valid 100×100 PNG, shared with image-processing.test.ts.
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAAAAABVicqIAAAAAmJLR0QA/4ePzL8AAAAHdElNRQfqAQ4AMzkN2iH/AAAAP0lEQVRo3u3NQQEAAAQEMASXXYrz2gqst/Lm4ZBIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiSTsAP1cAUZeKtreAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAw6crMeAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMJiXdMQAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDDPglUbAAAAAElFTkSuQmCC";
		const terminal = new RecordingTerminal(100, 5);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			terminal,
			showHardwareCursor: false,
			logDirectory: "/tmp",
		});
		const chat = new ChatContainer();
		chat.setCompactView(compactView);
		chat.setExpanded(true);
		const tool = new ToolExecutionComponent(
			"read",
			"image",
			{},
			{ compactView: !!compactView, imageWidthCells: 12 },
			undefined,
			renderer,
			process.cwd(),
		);
		tool.updateResult({ content: [{ type: "image", data: png, mimeType: "image/png" }], isError: false });
		tool.setExpanded(true);
		chat.addChild(tool);
		chat.addChild(new Text("AFTER IMAGE", 0, 0));
		const lines = chat.render(100);
		const anchor = lines.findIndex((line) => line.includes("\x1b_G"));
		expect(anchor).toBeGreaterThanOrEqual(0);
		const nativeAnchor = tool.render(98).find((line) => line.includes("\x1b_G"));
		expect(nativeAnchor).toBeDefined();
		expect(lines[anchor].endsWith(nativeAnchor!)).toBe(true);
		expect(lines.slice(anchor + 1, anchor + 4)).toEqual(["", "", ""]);
		renderer.addChild(chat);
		renderer.start();
		try {
			await terminal.waitForRender();
			expect(renderer.viewportTop).toBeGreaterThan(anchor + 1);
			expect(terminal.output).toContain(png);
		} finally {
			renderer.stop();
		}
	});
});
