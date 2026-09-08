import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	Box,
	type Component,
	Container,
	Image,
	MouseRegion,
	resetCapabilitiesCache,
	setCapabilities,
	Text,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTui } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = { requestRender() {} } as TUI;
const output = Array.from({ length: 40 }, (_, index) => `output ${index}: ${"界 wide ".repeat(10)}`).join("\n");
const args = {
	path: `directory/${"long-".repeat(30)}file.txt`,
	command: `printf '${"line ".repeat(60)}'\necho done`,
	pattern: "needle",
	content: output,
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=";

function assertCompactRows(component: Component, width: number): string[] {
	const lines = component.render(width);
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.length).toBeLessThanOrEqual(2);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toContain("\x1b_G");
		expect(line).not.toContain("\x1b]1337;File=");
	}
	return lines;
}

function click(component: Component, y: number, width = 40, x = 2): void {
	const height = component.render(width).length;
	expect(
		component.handleMouse?.({
			type: "click",
			button: "left",
			x,
			y,
			screenX: 10 + x,
			screenY: 20 + y,
			width,
			height,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		})?.handled,
	).toBe(true);
}

beforeAll(() => initTheme("dark"));
afterEach(() => resetCapabilitiesCache());

describe("compact tool cards", () => {
	const custom: ToolRenderers = {
		renderCall: () => new Text(`custom call\n${output}`, 2, 3),
		renderResult: (result) =>
			new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 1, 2),
	};
	const renderers: Array<[string, ToolRenderers | undefined]> = [
		["generic", undefined],
		["fallback", {}],
		["custom", custom],
		["self", { ...custom, renderShell: "self" }],
		...Object.entries(createAllToolRenderers()),
	];

	test.each(renderers)("compact row budget: %s pending, partial, final and error", (_name, renderer) => {
		for (const width of [1, 2, 12, 40, 120]) {
			const component = new ToolExecutionComponent(
				"tool",
				"id",
				args,
				{ compactView: true },
				renderer,
				ui,
				process.cwd(),
			);
			assertCompactRows(component, width);
			component.markExecutionStarted();
			assertCompactRows(component, width);
			const result = { content: [{ type: "text", text: output }], details: { diff: output }, isError: false };
			const original = structuredClone(result);
			component.updateResult(result, true);
			assertCompactRows(component, width);
			component.updateResult(result);
			assertCompactRows(component, width);
			const error = {
				content: [{ type: "text", text: "Operation aborted: requested cancellation" }],
				isError: true,
			};
			component.updateResult(error);
			assertCompactRows(component, width);
			expect(result).toEqual(original);
			expect(error.content[0].text).toBe("Operation aborted: requested cancellation");
		}
	});

	test("reuses unchanged compact previews while refreshing args, results, width and theme", () => {
		const component = new ToolExecutionComponent(
			"read",
			"id",
			{ path: "directory/界-file.txt" },
			{ compactView: true },
			createAllToolRenderers().read,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "full detail" }], isError: false });
		const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
		const redraw = (width: number) => {
			const expected = component.render(width);
			segment.mockClear();
			expect(component.render(width)).toEqual(expected);
			expect(segment).not.toHaveBeenCalled();
			return expected;
		};
		try {
			redraw(40);
			component.updateArgs({ path: "changed-界.txt" });
			expect(stripAnsi(redraw(40).join("\n"))).toContain("changed-界.txt");
			component.updateResult({ content: [{ type: "text", text: "Partial error" }], isError: true }, true);
			expect(stripAnsi(redraw(40).join("\n"))).toContain("Partial error");
			component.updateResult({ content: [{ type: "text", text: "Final error\nfull detail" }], isError: true });
			const dark = redraw(40);
			expect(stripAnsi(dark.join("\n"))).toContain("Final error");
			for (const line of redraw(12)) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
			expect(redraw(40)).toEqual(dark);
			initTheme("light", false);
			component.invalidate();
			const light = redraw(40);
			expect(light).not.toEqual(dark);
			expect(light.map(stripAnsi)).toEqual(dark.map(stripAnsi));
			click(component, 1);
			expect(stripAnsi(component.render(40).join("\n"))).toContain("full detail");
			component.setExpanded(false);
			expect(redraw(40)).toEqual(light);
		} finally {
			segment.mockRestore();
			initTheme("dark", false);
		}
	});

	test.each(["default", "self"] as const)(
		"keeps mutable %s children and mouse layout live between redraws",
		(renderShell) => {
			let title = "call";
			let invalidate!: () => void;
			const call = new Text(title, 0, 0);
			const leading = new Text("", 0, 0);
			const detail = new Text("result\nfull detail", 0, 0);
			const events: TuiMouseEvent[] = [];
			const body = new Container();
			body.addChild(leading);
			body.addChild(
				new MouseRegion(detail, (event) => {
					events.push(event);
					return { handled: true };
				}),
			);
			const component = new ToolExecutionComponent(
				"custom",
				"id",
				{},
				{ compactView: true },
				{
					renderShell,
					renderCall: (_args, _theme, context) => {
						invalidate = context.invalidate;
						call.setText(title);
						return call;
					},
					renderResult: () => body,
				} satisfies ToolRenderers,
				ui,
				process.cwd(),
			);
			component.updateResult({ content: [], isError: false });
			const initial = component.render(40);
			expect(component.render(40)).toEqual(initial);

			// Same flattened lines, but the call now owns the old result row.
			call.setText("call\nresult");
			detail.setText("full detail");
			expect(component.render(40).map((line) => stripAnsi(line).trim())).toEqual(["call", "full detail"]);

			call.setText("call");
			detail.setText("result\nfull detail");
			expect(component.render(40)).toEqual(initial);
			click(component, 1);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ y: 0, height: 2 });

			// Identical output, but the visible result row is no longer inside the inner mouse region.
			leading.setText("result");
			detail.setText("full detail");
			expect(component.render(40)).toEqual(initial);
			click(component, 1);
			expect(events).toHaveLength(1);
			expect(component.render(40).length).toBeGreaterThan(2);
			component.setExpanded(false);
			title = "invalidated call";
			invalidate();
			expect(stripAnsi(component.render(40)[0])).toContain(title);
		},
	);

	test("keeps the result row visible below a wrapping custom call", () => {
		const component = new ToolExecutionComponent(
			"custom",
			"id",
			args,
			{ compactView: true },
			custom,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "Error: cancelled" }], isError: true });
		expect(stripAnsi(assertCompactRows(component, 40).join("\n"))).toContain("Error: cancelled");
	});

	test.each(["default", "self"] as const)("keeps both rows of a result-only %s card", (renderShell) => {
		const component = new ToolExecutionComponent(
			"custom",
			"id",
			{},
			{ compactView: true },
			{
				renderShell,
				renderCall: () => new Container(),
				renderResult: () => new Text("status\nneeds attention", 0, 0),
			},
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [], isError: false });
		expect(component.render(40).map((line) => stripAnsi(line).trim())).toEqual(["status", "needs attention"]);
	});

	test("removes empty renderer padding without inventing content", () => {
		for (const renderShell of ["default", "self"] as const) {
			const component = new ToolExecutionComponent(
				"hidden",
				"id",
				{},
				{ compactView: true },
				{
					renderShell,
					renderCall: () => new Container(),
					renderResult: () => new Text("", 1, 2),
				},
				ui,
				process.cwd(),
			);
			expect(component.render(40)).toEqual([]);
			component.updateResult({ content: [], isError: false });
			expect(component.render(40)).toEqual([]);
		}
	});

	test("preserves generic arguments/results and restores normal layout", () => {
		const originalArgs = structuredClone(args);
		const result = { content: [{ type: "text", text: output }], isError: false };
		const ordinary = new ToolExecutionComponent("generic", "id", args, {}, undefined, ui, process.cwd());
		ordinary.updateResult(result);
		const normal = ordinary.render(40);
		expect(normal.length).toBeGreaterThan(2);
		const component = new ToolExecutionComponent(
			"generic",
			"id",
			args,
			{ compactView: true },
			undefined,
			ui,
			process.cwd(),
		);
		component.updateResult(result);
		assertCompactRows(component, 40);
		component.setExpanded(true);
		expect(component.render(40)).toEqual(normal);
		component.setExpanded(false);
		component.setCompactView(false);
		expect(component.render(40)).toEqual(normal);
		expect(args).toEqual(originalArgs);
		expect(result.content[0].text).toBe(output);
	});

	test("passes independent mode/expansion hints while retaining renderer state and components", () => {
		const seen: Array<{
			slot: string;
			compactView?: boolean;
			expanded: boolean;
			state: unknown;
			lastComponent?: Component;
		}> = [];
		const call = new Text("call", 0, 0);
		const result = new Text(output, 0, 0);
		const component = new ToolExecutionComponent(
			"custom",
			"id",
			{},
			{},
			{
				renderCall: (_args, _theme, context) => {
					seen.push({ slot: "call", ...context });
					return call;
				},
				renderResult: (_result, _options, _theme, context) => {
					seen.push({ slot: "result", ...context });
					return result;
				},
			} satisfies ToolRenderers,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: output }], isError: false }, true);
		expect(seen.every((entry) => entry.compactView === false)).toBe(true);
		component.setCompactView(true);
		assertCompactRows(component, 40);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "final" }], isError: false });
		expect(component.render(40).length).toBeGreaterThan(2);
		expect(seen.at(-1)).toMatchObject({ compactView: true, expanded: true, lastComponent: result });
		expect(
			seen
				.filter((entry) => entry.slot === "call")
				.slice(1)
				.every((entry) => entry.lastComponent === call),
		).toBe(true);
		expect(
			seen
				.filter((entry) => entry.slot === "result")
				.slice(1)
				.every((entry) => entry.lastComponent === result),
		).toBe(true);
		expect(seen.every((entry) => entry.state === seen[0].state)).toBe(true);
		component.setCompactView(false);
		expect(seen.at(-1)).toMatchObject({ compactView: false, expanded: true });
	});

	test("caps the real edit renderCall preview without resetting its asynchronous cache", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-compact-edit-"));
		try {
			const before = Array.from({ length: 60 }, (_, index) => `before ${index}`).join("\n");
			const after = before.replaceAll("before", "after");
			writeFileSync(join(cwd, "file.txt"), before);
			const component = new ToolExecutionComponent(
				"edit",
				"id",
				{
					path: "file.txt",
					edits: [{ oldText: before, newText: after }],
				},
				{ compactView: true },
				createEditToolDefinition(cwd),
				ui,
				cwd,
			);
			component.setArgsComplete();
			component.setExpanded(true);
			await vi.waitFor(() => {
				expect(stripAnsi(component.render(100).join("\n"))).toContain("after 59");
			});
			component.setExpanded(false);
			assertCompactRows(component, 12);
			component.setExpanded(true);
			expect(stripAnsi(component.render(100).join("\n"))).toContain("after 59");
			component.updateResult({ content: [], details: { diff: "+1 after 0\n+60 after 59" }, isError: false });
			expect(stripAnsi(component.render(100).join("\n"))).toContain("after 59");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test.each(["kitty", "iterm2"] as const)("omits complete %s image protocols until expanded", (protocol) => {
		setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
		const result = { content: [{ type: "image", data: png, mimeType: "image/png" }], isError: false };
		const saved = structuredClone(result);
		for (const renderer of [
			undefined,
			createAllToolRenderers().read,
			{
				renderShell: "self" as const,
				renderCall: () => new Text("custom image", 0, 0),
				renderResult: () => new Image(png, "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 30 }),
			},
		]) {
			const component = new ToolExecutionComponent(
				"image",
				"id",
				args,
				{ compactView: true, showImages: true },
				renderer,
				ui,
				process.cwd(),
			);
			component.updateResult(result);
			assertCompactRows(component, 40);
			component.setExpanded(true);
			expect(component.render(40).join("\n")).toContain(protocol === "kitty" ? "\x1b_G" : "\x1b]1337;File=");
			component.setExpanded(false);
			assertCompactRows(component, 12);
		}
		expect(result).toEqual(saved);
	});

	test.each([
		["kitty", "default"],
		["kitty", "self"],
		["iterm2", "default"],
		["iterm2", "self"],
	] as const)("keeps padded %s image clicks inner-first in the %s shell", async (protocol, renderShell) => {
		setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
		const width = 40;
		const terminal = new VirtualTerminal(width, 24);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			terminal,
			showHardwareCursor: false,
			logDirectory: tmpdir(),
			fullscreenCopyOnSelect: false,
		});
		const events: TuiMouseEvent[] = [];
		let consumeClick = true;
		const body = new Box(4, 1);
		body.addChild(
			new MouseRegion(
				new Image(png, "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 20 }),
				(event) => {
					if (event.type !== "click" || event.button !== "left") return undefined;
					events.push(event);
					return consumeClick ? { handled: true } : undefined;
				},
			),
		);
		const component = new ToolExecutionComponent(
			"image",
			"id",
			{},
			{},
			{ renderShell, renderCall: () => new Text("image tool", 0, 0), renderResult: () => body },
			renderer,
			process.cwd(),
		);
		component.updateResult({ content: [], isError: false });
		const marker = protocol === "kitty" ? "\x1b_G" : "\x1b]1337;File=";
		const normal = component.render(width);
		const imageY = normal.findIndex((line) => line.includes(marker));
		expect(imageY).toBeGreaterThanOrEqual(0);
		const imageX = visibleWidth(stripAnsi(normal[imageY].slice(0, normal[imageY].indexOf(marker))));
		expect(imageX).toBe(renderShell === "default" ? 5 : 4);
		click(component, imageY, width, imageX + 1);
		expect(events).toHaveLength(1);
		const { x, y, width: innerWidth, height } = events[0];
		expect(x).toBe(1);

		component.setCompactView(true);
		for (const columns of [1, 2, 12, 40, 120]) assertCompactRows(component, columns);
		// Fullscreen natively disables iTerm2 graphics; test those image rows before mounting it.
		const fullscreen = protocol === "kitty";
		if (fullscreen) {
			const document = new Container();
			document.addChild(new Text("BEFORE", 0, 0));
			document.addChild(component);
			document.addChild(new Text("AFTER", 0, 0));
			renderer.setLayoutRoot(
				createChatViewport({
					document,
					pendingMessages: new Container(),
					status: new Container(),
					editor: new Text("EDITOR", 0, 0),
					footer: new Text("FOOTER", 0, 0),
					scrollbar: "hidden",
				}).root,
			);
			renderer.start();
		}
		try {
			for (const handled of [true, false]) {
				consumeClick = handled;
				events.length = 0;
				if (fullscreen) {
					await terminal.waitForRender();
					const viewport = terminal.getViewport();
					const before = viewport.findIndex((line) => line.includes("BEFORE"));
					expect(before).toBeGreaterThanOrEqual(0);
					expect(viewport.findIndex((line) => line.includes("AFTER")) - before).toBe(3);
					const placeholderY = viewport.findIndex((line) => line.includes("[image]"));
					expect(placeholderY).toBeGreaterThan(before);
					const placeholderX = viewport[placeholderY].indexOf("[image]") + 1;
					terminal.sendInput(`\x1b[<0;${placeholderX + 1};${placeholderY + 1}M`);
					terminal.sendInput(`\x1b[<0;${placeholderX + 1};${placeholderY + 1}m`);
					await terminal.waitForRender();
				} else {
					const compact = assertCompactRows(component, width).map(stripAnsi);
					const placeholderY = compact.findIndex((line) => line.includes("[image]"));
					expect(placeholderY).toBeGreaterThanOrEqual(0);
					click(component, placeholderY, width, compact[placeholderY].indexOf("[image]") + 1);
				}
				expect(events).toHaveLength(1);
				expect(events[0]).toMatchObject({ x, y, width: innerWidth, height });
				if (handled) assertCompactRows(component, width);
				else {
					expect(component.render(width).length).toBeGreaterThan(2);
					expect(component.render(width).join("\n")).toContain(marker);
				}
			}
			component.setExpanded(false);
			assertCompactRows(component, width);
			component.setCompactView(false);
			expect(component.render(width)).toEqual(normal);
		} finally {
			if (fullscreen) renderer.stop();
		}
	});

	test.each(["default", "self"] as const)(
		"maps clipped %s shell clicks to inner components before native expansion",
		(renderShell) => {
			const events: TuiMouseEvent[] = [];
			const inner = new Box(2, 2);
			inner.addChild(
				new MouseRegion(new Text(`inner header\n${output}`, 0, 0), (event) => {
					events.push(event);
					return { handled: true };
				}),
			);
			const component = new ToolExecutionComponent(
				"custom",
				"id",
				{},
				{ compactView: true },
				{
					renderShell,
					renderCall: () => inner,
					renderResult: () => new Text("result\nfull detail", 0, 2),
				},
				ui,
				process.cwd(),
			);
			component.updateResult({ content: [], isError: false });
			const outerPad = renderShell === "default" ? 1 : 0;
			click(component, 0, 40, outerPad + 3);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ x: 1, y: 0, width: 40 - outerPad * 2 - 4, screenY: 20 });
			assertCompactRows(component, 40);
			click(component, 1, 40, outerPad + 1);
			expect(component.render(40).length).toBeGreaterThan(2);
			expect(stripAnsi(component.render(40).join("\n"))).toContain("full detail");
		},
	);

	test.each([12, 80])(
		"uses at most two physical terminal rows at width %i and keeps fullscreen clicks",
		async (width) => {
			const terminal = new VirtualTerminal(width, 16);
			const renderer = createInteractiveTui({
				tuiMode: "fullscreen",
				terminal,
				showHardwareCursor: false,
				logDirectory: tmpdir(),
			});
			const component = new ToolExecutionComponent(
				"read",
				"id",
				{ path: "file" },
				{ compactView: true },
				createAllToolRenderers().read,
				renderer,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: "full detail" }], isError: false });
			renderer.addChild(new Text("BEFORE", 0, 0));
			renderer.addChild(component);
			renderer.addChild(new Text("AFTER", 0, 0));
			renderer.start();
			try {
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const before = viewport.findIndex((line) => line.includes("BEFORE"));
				const after = viewport.findIndex((line) => line.includes("AFTER"));
				expect(before).toBeGreaterThanOrEqual(0);
				expect(after - before).toBeLessThanOrEqual(3);
				expect(after - before).toBeGreaterThanOrEqual(2);
				terminal.sendInput(`\x1b[<0;3;${before + 2}M`);
				terminal.sendInput(`\x1b[<0;3;${before + 2}m`);
				await terminal.waitForRender();
				expect(component.render(width).length).toBeGreaterThan(2);
				expect(terminal.getViewport().join("\n")).toMatch(/full\s+detail/);
			} finally {
				renderer.stop();
			}
		},
	);
});

describe("compact user shell cards", () => {
	test.each([false, true])("reuses unchanged shell previews without losing updates (excluded=%s)", (excluded) => {
		const component = new BashExecutionComponent("echo 界", ui, excluded, true);
		const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
		try {
			component.appendOutput("first\nlast 界");
			const running = component.render(40);
			segment.mockClear();
			expect(component.render(40)).toEqual(running);
			expect(segment).not.toHaveBeenCalled();
			component.appendOutput("\nnext 界");
			expect(stripAnsi(component.render(40)[1])).toContain("Running... next 界");
			component.setComplete(2, false);
			const complete = component.render(40);
			expect(stripAnsi(complete[1])).toContain("(exit 2) next 界");
			segment.mockClear();
			expect(component.render(40)).toEqual(complete);
			expect(segment).not.toHaveBeenCalled();
			for (const line of component.render(12)) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
			expect(component.render(40)).toEqual(complete);
			initTheme("light", false);
			component.invalidate();
			const light = component.render(40);
			expect(light).not.toEqual(complete);
			expect(light.map(stripAnsi)).toEqual(complete.map(stripAnsi));
			component.setExpanded(true);
			expect(stripAnsi(component.render(40).join("\n"))).toContain("first");
			expect(component.getOutput()).toBe("first\nlast 界\nnext 界");
			component.setExpanded(false);
			expect(component.render(40)).toEqual(light);
		} finally {
			segment.mockRestore();
			component.setComplete(2, false);
			initTheme("dark", false);
		}
	});

	test.each([false, true])("caps !/!! pending output and all final states (excluded=%s)", (excluded) => {
		for (const width of [1, 12, 80]) {
			for (const [exitCode, cancelled, status] of [
				[0, false, ""],
				[2, false, "(exit 2)"],
				[undefined, true, "(cancelled)"],
			] as const) {
				const component = new BashExecutionComponent(args.command, ui, excluded, true);
				try {
					assertCompactRows(component, width);
					component.appendOutput(output);
					assertCompactRows(component, width);
					if (width === 80) expect(stripAnsi(component.render(width)[1])).toContain("Running...");
					component.setComplete(exitCode, cancelled);
					assertCompactRows(component, width);
					if (width === 80) expect(stripAnsi(component.render(width)[1])).toContain(status);
					component.setExpanded(true);
					expect(component.render(width).length).toBeGreaterThan(2);
					component.appendOutput("\nlast update");
					expect(component.render(width).length).toBeGreaterThan(2);
					expect(component.getOutput()).toBe(`${output}\nlast update`);
					expect(component.getCommand()).toBe(args.command);
					component.setExpanded(false);
					component.setCompactView(false);
					expect(component.render(width).length).toBeGreaterThan(2);
				} finally {
					component.setComplete(exitCode, cancelled);
				}
			}
		}
	});
});

describe("compact assistant and custom messages", () => {
	test("hidden-thinking-only messages occupy zero rows", () => {
		const message = fauxAssistantMessage([{ type: "thinking", thinking: "private" }]);
		const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, [], true);
		expect(component.render(40)).toEqual([]);
		component.setCompactView(false);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("Thinking...");
		expect(message.content).toEqual([{ type: "thinking", thinking: "private" }]);
	});

	test("removes only hidden runs and their spacing, retaining every human text block", () => {
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "first private" },
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "one", name: "read", arguments: {} },
			{ type: "thinking", thinking: "second private" },
			{ type: "text", text: "between" },
			{ type: "toolCall", id: "two", name: "read", arguments: {} },
			{ type: "text", text: "after" },
			{ type: "thinking", thinking: "last private" },
		]);
		const original = structuredClone(message);
		const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 0, [], true);
		expect(component.render(40).map((line) => stripAnsi(line).trim())).toEqual(["", "before", "between", "after"]);
		component.updateContent({ ...message, content: [...message.content, { type: "text", text: "streamed" }] }, true);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("streamed");
		expect(message).toEqual(original);
	});

	test("retains visible thinking and local visibility overrides through mode changes", () => {
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "visible reasoning" },
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "hidden reasoning" },
		]);
		const ordinary = new AssistantMessageComponent(message).render(40);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], true);
		expect(component.render(40)).toEqual(ordinary);
		const secondRun = component.render(40).findIndex((line) => stripAnsi(line).includes("hidden reasoning"));
		click(component, secondRun);
		expect(stripAnsi(component.render(40).join("\n"))).not.toContain("Thinking...");
		component.setCompactView(false);
		component.setHideThinkingBlock(true);
		click(component, 1);
		component.setCompactView(true);
		const rendered = stripAnsi(component.render(40).join("\n"));
		expect(rendered).toContain("visible reasoning");
		expect(rendered).toContain("answer");
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).not.toContain("hidden reasoning");
		component.setCompactView(false);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("Thinking...");
	});

	test.each(["length", "error", "aborted"] as const)(
		"keeps %s notices when hidden thinking disappears",
		(stopReason) => {
			const message = fauxAssistantMessage([{ type: "thinking", thinking: "private" }], { stopReason });
			const component = new AssistantMessageComponent(message, true, undefined, "Thinking...", 1, [], true);
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).not.toContain("Thinking...");
			expect(rendered).toContain(
				stopReason === "length"
					? "Response was truncated before completion."
					: stopReason === "error"
						? "Error: Unknown error"
						: "Operation aborted",
			);
			expect(component.render(80)).toHaveLength(2);
		},
	);

	test("supplies the custom-message hint and keeps exactly one native spacer without truncating human notices", () => {
		const seen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			seen.push(options);
			if (options.compactView && !options.expanded) {
				return { render: (width) => [truncateToWidth("ordinary status", width)], invalidate() {} };
			}
			return new Text("ordinary status\nfull detail\nstill here", 0, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "notice",
			content: "human content",
			display: true,
			timestamp: 1,
		};
		const saved = structuredClone(message);
		const component = new CustomMessageComponent(message, renderer, undefined, 0, true);
		expect(component.render(12)).toHaveLength(2);
		expect(component.render(12)[0]).toBe("");
		expect(seen.at(-1)).toMatchObject({ compactView: true, expanded: false, outputPad: 0 });
		component.setExpanded(true);
		expect(component.render(40)).toHaveLength(4);
		expect(seen.at(-1)).toMatchObject({ compactView: true, expanded: true });
		component.setCompactView(false);
		expect(seen.at(-1)).toMatchObject({ compactView: false, expanded: true });
		const important = new CustomMessageComponent(
			message,
			() => new Text("Needs attention\nquestion\nchoices", 0, 0),
			undefined,
			0,
			true,
		);
		expect(important.render(40)).toHaveLength(4);
		expect(message).toEqual(saved);
	});
});
