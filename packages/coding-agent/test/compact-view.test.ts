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
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { MessageRenderOptions } from "../src/core/extensions/types.ts";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = { requestRender() {} } as TUI;
const output = Array.from({ length: 30 }, (_, i) => `output ${i}: ${"界 wide ".repeat(10)}`).join("\n");
const args = {
	path: `directory/${"long-".repeat(30)}file.txt`,
	command: `echo ${"line ".repeat(60)}`,
	pattern: "needle",
	content: output,
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=";

function compactRows(component: Component, width: number): string[] {
	const lines = component.render(width);
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.length).toBeLessThanOrEqual(2);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toMatch(/\x1b(?:_G|\]1337;File=)/);
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
afterEach(() => {
	resetCapabilitiesCache();
	initTheme("dark", false);
});

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
	test.each(renderers)("two physical rows for %s pending, partial, final and error", (_name, renderer) => {
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
			compactRows(component, width);
			component.markExecutionStarted();
			const result = { content: [{ type: "text", text: output }], details: { diff: output }, isError: false };
			const saved = structuredClone(result);
			component.updateResult(result, true);
			compactRows(component, width);
			component.updateResult(result);
			compactRows(component, width);
			component.updateResult({ content: [{ type: "text", text: "Error: cancelled" }], isError: true });
			compactRows(component, width);
			expect(result).toEqual(saved);
		}
	});

	test("expansion reveals nested codemode calls and script output", () => {
		const component = new ToolExecutionComponent(
			"codemode",
			"code",
			{ code: "await tools.read({ path: 'nested.txt' })" },
			{ compactView: true },
			codemodeRenderers,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({
			content: [{ type: "text", text: "script output" }],
			details: {
				calls: [{ id: "code/1", name: "read", args: '{"path":"nested.txt"}', status: "ok", durationMs: 5 }],
			},
			isError: false,
		});
		compactRows(component, 80);
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain('read {"path":"nested.txt"}');
		expect(stripAnsi(component.render(80).join("\n"))).toContain("script output");
	});

	test("wrapping calls cannot crowd out errors; result-only and hidden cards keep their content", () => {
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
		expect(stripAnsi(compactRows(component, 40).join("\n"))).toContain("Error: cancelled");
		for (const renderShell of ["default", "self"] as const) {
			const resultOnly = new ToolExecutionComponent(
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
			expect(resultOnly.render(40)).toEqual([]);
			resultOnly.updateResult({ content: [], isError: false });
			expect(resultOnly.render(40).map((line) => stripAnsi(line).trim())).toEqual(["status", "needs attention"]);
		}
	});

	test("preserves full generic data and restores normal rendering through expansion and mode changes", () => {
		const result = { content: [{ type: "text", text: output }], isError: false };
		const ordinary = new ToolExecutionComponent("generic", "id", args, {}, undefined, ui, process.cwd());
		ordinary.updateResult(result);
		const normal = ordinary.render(40);
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
		compactRows(component, 40);
		component.setExpanded(true);
		expect(component.render(40)).toEqual(normal);
		component.setExpanded(false);
		component.setCompactView(false);
		expect(component.render(40)).toEqual(normal);
	});

	test.each(["kitty", "iterm2"] as const)("%s image protocols are complete only when expanded", (protocol) => {
		setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
		for (const renderer of [
			undefined,
			createAllToolRenderers().read,
			{
				renderShell: "self" as const,
				renderCall: () => new Text("image tool", 0, 0),
				renderResult: () => new Image(png, "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 30 }),
			},
		]) {
			const component = new ToolExecutionComponent(
				"image",
				"id",
				args,
				{ compactView: true },
				renderer,
				ui,
				process.cwd(),
			);
			const result = { content: [{ type: "image", data: png, mimeType: "image/png" }], isError: false };
			const saved = structuredClone(result);
			component.updateResult(result);
			for (const width of [1, 12, 40]) compactRows(component, width);
			component.setExpanded(true);
			expect(component.render(40).join("\n")).toContain(protocol === "kitty" ? "\x1b_G" : "\x1b]1337;File=");
			expect(result).toEqual(saved);
		}
	});

	test.each(["default", "self"] as const)(
		"%s cards retain mutable child layouts and inner click priority",
		(renderShell) => {
			const events: TuiMouseEvent[] = [];
			const call = new Text("call", 0, 0);
			const inner = new Box(2, 2);
			inner.addChild(
				new MouseRegion(new Text("result\nfull detail", 0, 0), (event) => {
					events.push(event);
					return { handled: true };
				}),
			);
			const component = new ToolExecutionComponent(
				"custom",
				"id",
				{},
				{ compactView: true },
				{ renderShell, renderCall: () => call, renderResult: () => inner },
				ui,
				process.cwd(),
			);
			component.updateResult({ content: [], isError: false });
			const before = compactRows(component, 40);
			call.setText("call\nresult");
			expect(compactRows(component, 40)).toEqual(before);
			click(component, 1, 40, renderShell === "self" ? 3 : 4);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ x: 1, y: 0, height: 2 });
			compactRows(component, 40);
			click(component, 0, 40);
			expect(stripAnsi(component.render(40).join("\n"))).toContain("full detail");
		},
	);

	test("previews refresh after result, width and theme changes", () => {
		const component = new ToolExecutionComponent(
			"read",
			"id",
			{ path: "界.txt" },
			{ compactView: true },
			createAllToolRenderers().read,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "first error" }], isError: true });
		const dark = compactRows(component, 40);
		initTheme("light", false);
		component.invalidate();
		const light = compactRows(component, 40);
		expect(light).not.toEqual(dark);
		expect(light.map(stripAnsi)).toEqual(dark.map(stripAnsi));
		component.updateResult({ content: [{ type: "text", text: "new error" }], isError: true });
		expect(stripAnsi(compactRows(component, 40).join("\n"))).toContain("new error");
		compactRows(component, 12);
	});

	test.each([12, 80])("fullscreen uses physical rows and click expansion at width %i", async (width) => {
		const terminal = new VirtualTerminal(width, 16);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			terminal,
			showHardwareCursor: false,
			logDirectory: "/tmp",
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
			expect(before).toBeGreaterThanOrEqual(0);
			expect(viewport.findIndex((line) => line.includes("AFTER")) - before).toBeLessThanOrEqual(3);
			terminal.sendInput(`\x1b[<0;3;${before + 2}M`);
			terminal.sendInput(`\x1b[<0;3;${before + 2}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toMatch(/full\s+detail/);
		} finally {
			renderer.stop();
		}
	});
});

describe("compact Activity and messages", () => {
	test("hybrid opens groups with compact cards; heading clicks and global collapse retain mode defaults", () => {
		const chat = new ChatContainer();
		chat.setCompactView("hybrid");
		const tool = new ToolExecutionComponent(
			"read",
			"id",
			{ path: "file" },
			{ compactView: true },
			createAllToolRenderers().read,
			ui,
			process.cwd(),
		);
		tool.updateResult({ content: [{ type: "text", text: "first\nsecond\nfull detail" }], isError: false });
		chat.addChild(tool);
		expect(stripAnsi(chat.render(80).join("\n"))).toContain("▾ Activity");
		compactRows(tool, 80);
		expect(stripAnsi(chat.render(80).join("\n"))).not.toContain("full detail");
		click(chat, 0, 80);
		expect(chat.render(80)).toHaveLength(1);
		expect(stripAnsi(chat.render(80)[0])).toContain("▸ Activity");
		chat.setExpanded(true);
		tool.setExpanded(true);
		expect(stripAnsi(chat.render(80).join("\n"))).toContain("full detail");
		chat.setExpanded(false);
		tool.setExpanded(false);
		expect(stripAnsi(chat.render(80).join("\n"))).toContain("▾ Activity");
		compactRows(tool, 80);
		chat.setCompactView(true);
		expect(chat.render(80)).toHaveLength(1);
	});

	test("live counts, local expansion and invisible thinking preserve operations and transcript order", () => {
		const chat = new ChatContainer();
		chat.setCompactView(true);
		const tool = new ToolExecutionComponent(
			"pending",
			"id",
			{ detail: "arguments" },
			{ compactView: true },
			undefined,
			ui,
			process.cwd(),
		);
		const assistant = new AssistantMessageComponent(
			fauxAssistantMessage([{ type: "thinking", thinking: "private" }]),
			true,
			undefined,
			undefined,
			0,
			[],
			true,
		);
		const shell = new BashExecutionComponent("echo shell", ui, false, true);
		try {
			chat.children = [tool, assistant, shell];
			expect(chat.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual(["▸ Activity · 2 calls · 2 running"]);
			tool.updateResult({ content: [{ type: "text", text: "error detail" }], isError: true });
			shell.appendOutput("shell output\nlast line");
			shell.setComplete(undefined, true);
			expect(chat.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual([
				"▸ Activity · 2 calls · 1 failed · 1 cancelled",
			]);
			click(chat, 0, 80);
			expect(stripAnsi(chat.render(80).join("\n"))).toContain("error detail");
			assistant.updateContent(fauxAssistantMessage("visible text"), true);
			const text = stripAnsi(chat.render(80).join("\n"));
			expect(text.match(/Activity/g)).toHaveLength(2);
			expect(text.indexOf("visible text")).toBeGreaterThan(text.indexOf("Activity"));
			expect(text.indexOf("visible text")).toBeLessThan(text.lastIndexOf("Activity"));
			expect(chat.children).toEqual([tool, assistant, shell]);
			chat.setCompactView(false);
			const ordinary = new Container();
			ordinary.children = chat.children;
			expect(chat.render(80)).toEqual(ordinary.render(80));
		} finally {
			shell.setComplete(undefined, true);
		}
	});

	test.each([false, true])("!/!! preserves output and cancellation/error status (excluded=%s)", (excluded) => {
		for (const [code, cancelled, status] of [
			[0, false, ""],
			[2, false, "(exit 2)"],
			[undefined, true, "(cancelled)"],
		] as const) {
			const shell = new BashExecutionComponent(args.command, ui, excluded, true);
			try {
				shell.appendOutput(output);
				expect(stripAnsi(compactRows(shell, 80)[1])).toContain("Running...");
				shell.setComplete(code, cancelled);
				expect(stripAnsi(compactRows(shell, 80)[1])).toContain(status);
				compactRows(shell, 1);
				click(shell, 0);
				expect(shell.render(80).length).toBeGreaterThan(2);
				expect(shell.getOutput()).toBe(output);
			} finally {
				shell.setComplete(code, cancelled);
			}
		}
	});

	test.each(["length", "error", "aborted"] as const)(
		"hidden thinking takes no rows but retains %s notices",
		(stopReason) => {
			const component = new AssistantMessageComponent(
				fauxAssistantMessage([{ type: "thinking", thinking: "private" }]),
				true,
				undefined,
				undefined,
				0,
				[],
				true,
			);
			expect(component.render(40)).toEqual([]);
			component.updateContent(fauxAssistantMessage([{ type: "thinking", thinking: "private" }], { stopReason }));
			expect(component.render(80)).toHaveLength(2);
			expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Thinking...");
			component.setCompactView(false);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Thinking...");
		},
	);

	test("custom messages receive independent density/expansion hints without truncating human notices", () => {
		const seen: MessageRenderOptions[] = [];
		const message = {
			role: "custom" as const,
			customType: "notice",
			content: "content",
			display: true,
			timestamp: 1,
		};
		const component = new CustomMessageComponent(
			message,
			(_message, options) => {
				seen.push(options);
				return options.compactView && !options.expanded
					? { render: (width) => [truncateToWidth("ordinary status", width)], invalidate() {} }
					: new Text("ordinary status\nfull detail", 0, 0);
			},
			undefined,
			0,
			true,
		);
		expect(component.render(12)).toHaveLength(2);
		click(component, 1);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("full detail");
		expect(seen.at(-1)).toMatchObject({ compactView: true, expanded: true, outputPad: 0 });
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
	});
});
