import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("ScrollView start following", () => {
	it("follows prepends, suspends when scrolling away, and resumes at the start", () => {
		const content = new Text("3\n4\n5\n6\n7", 0, 0);
		const view = new ScrollView(content, { follow: "start" });
		const render = () => renderLayoutFrame(view, 10, 3, () => {});
		render();
		assert.strictEqual(view.followStart, true);
		assert.strictEqual(view.followEnd, false);
		assert.strictEqual(view.isFollowingStart, true);
		content.setText("2\n3\n4\n5\n6\n7");
		assert.strictEqual(render().lines[0]?.trimEnd(), "2");
		assert.strictEqual(view.scrollTop, 0);
		assert.strictEqual(view.scrollBy(2), 0);
		assert.strictEqual(view.isFollowingStart, false);
		content.setText("1\n2\n3\n4\n5\n6\n7");
		assert.strictEqual(render().lines[0]?.trimEnd(), "4");
		assert.strictEqual(view.scrollTop, 3);
		assert.strictEqual(view.scrollBy(-5), -2);
		assert.strictEqual(view.isFollowingStart, true);
		view.scrollToEnd();
		assert.strictEqual(view.isFollowingStart, false);
		view.scrollToStart();
		assert.strictEqual(view.isFollowingStart, true);
	});

	it("keeps search follow suppression through layout and growth at either edge", () => {
		for (const follow of ["start", "end"] as const) {
			const content = new Text("1\n2\n3\n4\n5", 0, 0);
			const view = new ScrollView(content, { follow });
			const render = () => renderLayoutFrame(view, 10, 3, () => {});
			render();
			const offset = view.scrollTop;
			view.scrollTo(offset, { disableFollow: true });
			render();
			assert.strictEqual(view.isFollowingStart || view.isFollowingEnd, false);
			content.setText("0\n1\n2\n3\n4\n5");
			render();
			assert.strictEqual(view.scrollTop, follow === "start" ? offset + 1 : offset);
			assert.strictEqual(view.isFollowingStart || view.isFollowingEnd, false);
			if (follow === "start") view.scrollToStart();
			else view.scrollToEnd();
			assert.strictEqual(view.isFollowingStart || view.isFollowingEnd, true);
		}
	});

	it("switches follow edges in place and preserves the offset when disabled", () => {
		const view = new ScrollView(new Text("1\n2\n3\n4\n5", 0, 0));
		renderLayoutFrame(view, 10, 3, () => {});
		assert.strictEqual(view.isFollowingStart || view.isFollowingEnd, false);
		view.setFollow("end");
		assert.strictEqual(view.scrollTop, 2);
		assert.strictEqual(view.isFollowingEnd, true);
		view.setFollow("none");
		assert.strictEqual(view.scrollTop, 2);
		assert.strictEqual(view.isFollowingEnd, false);
		view.setFollow("start");
		assert.strictEqual(view.scrollTop, 0);
		assert.strictEqual(view.isFollowingStart, true);
		view.setFollow("end");
		assert.strictEqual(view.scrollTop, 2);
		assert.strictEqual(view.isFollowingStart, false);
		assert.strictEqual(view.isFollowingEnd, true);
	});

	it("retains middle rows when separate tool updates above and below are coalesced", () => {
		const rows = [
			"running above",
			...Array.from({ length: 12 }, (_, n) => [`message ${12 - n}`, "detail", "detail"]).flat(),
			"running below",
		];
		const view = new ScrollView(new Text("", 0, 0), { follow: "start" });
		view.updateLayout(rows.length, 8, () => {}, rows);
		view.scrollTo(14);
		const next = ["new tool update", ...rows];
		next[next.length - 1] = "old tool finished";
		view.updateLayout(next.length, 8, () => {}, next);
		assert.strictEqual(view.scrollTop, 15);
		assert.strictEqual(view.rebaseContentRow(14), 15);
		assert.strictEqual(next[view.scrollTop - 1], rows[13]);
		assert.strictEqual(next[view.scrollTop], "detail");
		assert.strictEqual(view.rebaseContentRow(rows.length - 1), undefined);

		// A prepend and a deletion can leave the total height unchanged.
		const sameHeight = ["another update", ...next.slice(0, -1)];
		view.updateLayout(sameHeight.length, 8, () => {}, sameHeight);
		assert.strictEqual(view.scrollTop, 16);
		assert.strictEqual(view.rebaseContentRow(15), 16);
	});
});

describe("TuiAltScreen start following", () => {
	it("anchors detached reading, selection and search while rows above grow or shrink", async (t) => {
		const terminal = new VirtualTerminal(60, 8);
		let copied = "";
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied = text;
				return true;
			},
			searchCurrentMatchStyle: (text) => `[${text}]`,
		});
		t.mock.method(tui, "flash", () => {});
		const history = Array.from({ length: 16 }, (_, n) => `message ${15 - n} needle`).join("\n");
		const content = new Text(history, 0, 0);
		const view = new ScrollView(content, { follow: "start", primary: true });
		tui.setLayoutRoot(view);
		tui.start();
		try {
			await terminal.waitForRender();
			view.scrollBy(5);
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]?.startsWith("message 10"));
			terminal.sendInput("\x1b[<0;1;2M");
			terminal.sendInput("\x1b[<32;9;2M");
			terminal.sendInput("\x1b[<0;9;2m");
			await terminal.waitForRender();
			for (const [prefix, offset] of [
				["message 16 needle\n", 6],
				["message 16 needle\nstreamed line\nanother line\n", 8],
				["message 16 needle\n", 6],
			] as const) {
				content.setText(prefix + history);
				tui.requestRender();
				await terminal.waitForRender();
				assert.strictEqual(view.scrollTop, offset);
				assert.ok(terminal.getViewport()[0]?.startsWith("message 10"));
				await tui.copyActiveSelectionToClipboard();
				assert.strictEqual(copied, "message 9");
			}
			content.setText(`message 16 needle\n${history}\nnew row below the viewport`);
			tui.requestRender();
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 6);
			await tui.copyActiveSelectionToClipboard();
			assert.strictEqual(copied, "message 9");

			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("7/17")));
			assert.ok(terminal.getViewport()[0]?.startsWith("message 10 [needle]"));
			content.setText(
				`message 17 needle\nmessage 16 needle\n${history.replace("message 0 needle", "old tool finished needle")}`,
			);
			tui.requestRender();
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 7);
			assert.ok(terminal.getViewport().some((line) => line.includes("8/18")));
			assert.ok(terminal.getViewport()[0]?.startsWith("message 10 [needle]"));
			await tui.copyActiveSelectionToClipboard();
			assert.strictEqual(copied, "message 9");
			terminal.sendInput("\x07");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[1]?.startsWith("message 9 [needle]"));
		} finally {
			tui.stop();
		}
	});

	it("places the latest indicator on the transcript's first row and clicks back to the start", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToStartIndicator: () => "↑ Latest",
			scrollToEndIndicator: () => "↓ Latest",
		});
		const view = new ScrollView(new Text("1\n2\n3\n4\n5\n6\n7\n8", 0, 0), {
			follow: "start",
			primary: true,
		});
		tui.setLayoutRoot(
			new VStack([
				{ component: new Text("header", 0, 0), basis: 1 },
				{ component: view, basis: 0, grow: 1 },
				{ component: new Text("editor", 0, 0), basis: 1 },
			]),
		);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.strictEqual(tui.isFollowingOutput, true);
			assert.ok(!terminal.getViewport().some((line) => line.includes("Latest")));
			terminal.sendInput("\x1b[<65;1;2M");
			await terminal.waitForRender();
			assert.strictEqual(tui.isFollowingOutput, false);
			assert.ok(terminal.getViewport()[1]?.includes("↑ Latest"));
			assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "header");
			assert.strictEqual(terminal.getViewport()[5]?.trimEnd(), "editor");
			terminal.sendInput("\x1b[<0;15;2M");
			terminal.sendInput("\x1b[<0;15;2m");
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 0);
			assert.strictEqual(tui.isFollowingOutput, true);
			assert.ok(!terminal.getViewport().some((line) => line.includes("Latest")));
		} finally {
			tui.stop();
		}
	});

	it("keeps search and prompt navigation in visual order and resets search to the new follow edge", async () => {
		const terminal = new VirtualTerminal(60, 8);
		const tui = new TuiAltScreen(terminal);
		const view = new ScrollView(
			new Text(
				[4, 3, 2, 1].flatMap((n) => [`\x1b]133;A\x07message ${n} needle`, "detail", "detail", "detail"]).join("\n"),
				0,
				0,
			),
			{ follow: "start", primary: true },
		);
		tui.setLayoutRoot(view);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[1;6B");
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 4);
			assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3 needle");
			terminal.sendInput("\x1b[1;6A");
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 0);
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.strictEqual(view.isFollowingStart, false);
			assert.strictEqual(view.scrollTop, 0);
			assert.ok(terminal.getViewport().some((line) => line.includes("1/4")));
			terminal.sendInput("\x07");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("2/4")));
			terminal.sendInput("\x1b[103;6u");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("1/4")));
			view.setFollow("end");
			tui.resetTranscriptNavigation();
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 8);
			assert.strictEqual(tui.isFollowingOutput, true);
			assert.ok(!terminal.getViewport().some((line) => line.includes("Shift+Enter")));
			view.setFollow("start");
			view.scrollToEnd();
			tui.resetTranscriptNavigation();
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 0);
			assert.strictEqual(tui.isFollowingOutput, true);
		} finally {
			tui.stop();
		}
	});

	it("clears text selection, drag state, and old latest hit geometry when resetting", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			scrollToStartIndicator: () => "↑ Latest",
		});
		const view = new ScrollView(new Text(Array.from({ length: 16 }, (_, n) => `line ${n}`).join("\n"), 0, 0), {
			follow: "start",
			primary: true,
			scrollbar: "always",
		});
		tui.setLayoutRoot(view);
		tui.start();
		try {
			await terminal.waitForRender();
			tui.scrollBy(2);
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;3M");
			terminal.sendInput("\x1b[<32;5;3M");
			await terminal.waitForRender();
			assert.strictEqual(tui.hasActiveSelection(), true);
			tui.resetTranscriptNavigation();
			assert.strictEqual(tui.hasActiveSelection(), false);
			view.scrollTo(2);
			// The old top-row label must not catch a press before the next frame.
			terminal.sendInput("\x1b[<0;15;1M");
			assert.strictEqual(view.scrollTop, 2);
			terminal.sendInput("\x1b[<0;15;1m");
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;30;4M");
			tui.resetTranscriptNavigation();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<32;30;6M");
			terminal.sendInput("\x1b[<0;30;6m");
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 0);
			assert.strictEqual(view.isFollowingStart, true);
			assert.strictEqual(tui.hasActiveSelection(), false);
		} finally {
			tui.stop();
		}
	});
});
