import { Container, CURSOR_MARKER, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { type LayoutBox, renderLayoutFrame } from "../../tui/src/layout.ts";
import { getLayoutNode } from "../../tui/src/layout-node.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";

function multilineViewport() {
	const components = {
		document: new Text("message 1\nmessage 2", 0, 0),
		pendingMessages: new Text("pending 1\npending 2", 0, 0),
		status: new Text("status 1\nstatus 2", 0, 0),
		widgetsAbove: new Text("above 1\nabove 2", 0, 0),
		editor: new Text("editor 1\neditor 2\neditor 3", 0, 0),
		widgetsBelow: new Text("below 1\nbelow 2", 0, 0),
		footer: new Text("footer 1\nfooter 2", 0, 0),
	};
	return { ...createChatViewport({ ...components, scrollbar: "hidden" }), components };
}

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("mirrors component order without reversing their lines or replacing native layout instances", () => {
		const viewport = multilineViewport();
		const { root, transcript, components } = viewport;
		const normal = renderLayoutFrame(root, 20, 15, () => {});
		const dock = normal.root.children[1]!.component;
		const normalRootNode = getLayoutNode(root);
		const normalDockNode = getLayoutNode(dock);
		const normalRootEntries = normalRootNode?.type === "vstack" ? [...normalRootNode.entries] : undefined;
		const normalDockEntries = normalDockNode?.type === "vstack" ? [...normalDockNode.entries] : undefined;
		expect(normalRootEntries).toBeDefined();
		expect(normalDockEntries).toBeDefined();
		expect(normal.lines.map((line) => line.trimEnd())).toEqual([
			"message 1",
			"message 2",
			"pending 1",
			"pending 2",
			"status 1",
			"status 2",
			"above 1",
			"above 2",
			"editor 1",
			"editor 2",
			"editor 3",
			"below 1",
			"below 2",
			"footer 1",
			"footer 2",
		]);

		for (const inverted of [true, true, false]) {
			viewport.setInverted(inverted);
			const frame = renderLayoutFrame(viewport.root, 20, 15, () => {});
			const dockBox = frame.root.children[inverted ? 0 : 1]!;
			const transcriptBox = frame.root.children[inverted ? 1 : 0]!;
			expect(viewport.root).toBe(root);
			expect(viewport.transcript).toBe(transcript);
			expect(dockBox.component).toBe(dock);
			expect(transcriptBox.component).toBe(transcript);
			expect(transcriptBox.children[0]!.component).toBe(components.document);
			const orderedComponents = [
				components.pendingMessages,
				components.status,
				components.widgetsAbove,
				components.editor,
				components.widgetsBelow,
				components.footer,
			];
			if (inverted) orderedComponents.reverse();
			expect(dockBox.children).toHaveLength(orderedComponents.length);
			dockBox.children.forEach((box, index) => {
				expect(box.component).toBe(orderedComponents[index]);
			});
			expect(getLayoutNode(root)).toEqual({
				...normalRootNode,
				entries: inverted ? [...normalRootEntries!].reverse() : normalRootEntries,
			});
			expect(getLayoutNode(dock)).toEqual({
				...normalDockNode,
				entries: inverted ? [...normalDockEntries!].reverse() : normalDockEntries,
			});
			expect(transcript.followEnd).toBe(true);
			expect(frame.lines.map((line) => line.trimEnd())).toEqual(
				inverted
					? [
							"footer 1",
							"footer 2",
							"below 1",
							"below 2",
							"editor 1",
							"editor 2",
							"editor 3",
							"above 1",
							"above 2",
							"status 1",
							"status 2",
							"pending 1",
							"pending 2",
							"message 1",
							"message 2",
						]
					: normal.lines.map((line) => line.trimEnd()),
			);
		}
	});

	test("keeps native allocation and clipping through narrow and one-row resizes", () => {
		const viewport = multilineViewport();
		for (const inverted of [false, true, false]) {
			viewport.setInverted(inverted);
			for (const [width, height] of [
				[20, 18],
				[5, 6],
				[1, 1],
				[20, 18],
			] as const) {
				const frame = renderLayoutFrame(viewport.root, width, height, () => {});
				const transcriptBox = frame.root.children[inverted ? 1 : 0]!;
				const dockBox = frame.root.children[inverted ? 0 : 1]!;
				expect(frame.lines).toHaveLength(height);
				expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(transcriptBox.rect.height).toBe(Math.max(1, height - dockBox.rect.height));
				expect(transcriptBox.rect.y).toBe(inverted ? dockBox.rect.height : 0);
				expect(dockBox.rect.y).toBe(inverted ? 0 : transcriptBox.rect.height);
				const editorBox = dockBox.children.find((box) => box.component === viewport.components.editor)!;
				expect(editorBox.rect.height).toBeGreaterThanOrEqual(3);
				const checkClip = (box: LayoutBox): void => {
					expect(box.clip.width).toBeGreaterThanOrEqual(0);
					expect(box.clip.height).toBeGreaterThanOrEqual(0);
					if (box.clip.width > 0 && box.clip.height > 0) {
						expect(box.clip.x).toBeGreaterThanOrEqual(0);
						expect(box.clip.y).toBeGreaterThanOrEqual(0);
						expect(box.clip.x + box.clip.width).toBeLessThanOrEqual(width);
						expect(box.clip.y + box.clip.height).toBeLessThanOrEqual(height);
					}
					box.children.forEach(checkClip);
				};
				checkClip(frame.root);
			}
		}
	});

	test("keeps editor focus and cursor placement while wheel input scrolls the relocated transcript", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		const inputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor 1", `> ${CURSOR_MARKER}draft`, "editor 3"],
			invalidate: () => {},
			handleInput: (data: string) => inputs.push(data),
		};
		const viewport = createChatViewport({
			document: new Text(Array.from({ length: 20 }, (_, index) => `message ${index + 1}`).join("\n"), 0, 0),
			pendingMessages: new Container(),
			status: new Container(),
			editor,
			footer: new Text("footer 1\nfooter 2", 0, 0),
			scrollbar: "hidden",
		});
		tui.setLayoutRoot(viewport.root);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getCursorPosition()).toEqual({ x: 2, y: 6 });
			viewport.setInverted(true);
			viewport.transcript.setFollow("start");
			tui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().map((line) => line.trimEnd())).toEqual([
				"footer 1",
				"footer 2",
				"editor 1",
				"> draft",
				"editor 3",
				"message 1",
				"message 2",
				"message 3",
				"message 4",
				"message 5",
			]);
			expect(terminal.getCursorPosition()).toEqual({ x: 2, y: 3 });
			expect(editor.focused).toBe(true);
			terminal.sendInput("x");
			terminal.sendInput("\x1b[<65;1;6M");
			await terminal.waitForRender();
			expect(inputs).toEqual(["x"]);
			expect(viewport.transcript.scrollTop).toBe(1);
			expect(
				terminal
					.getViewport()
					.slice(5)
					.map((line) => line.trimEnd()),
			).toEqual(["message 2", "message 3", "message 4", "message 5", "message 6"]);
			expect(terminal.getCursorPosition()).toEqual({ x: 2, y: 3 });

			viewport.setInverted(false);
			viewport.transcript.setFollow("end");
			tui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().map((line) => line.trimEnd())).toEqual([
				"message 16",
				"message 17",
				"message 18",
				"message 19",
				"message 20",
				"editor 1",
				"> draft",
				"editor 3",
				"footer 1",
				"footer 2",
			]);
			expect(terminal.getCursorPosition()).toEqual({ x: 2, y: 6 });
			expect(editor.focused).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
