import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import type { SettingsSelectorComponent } from "../../../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

type View = {
	isInitialized: boolean;
	defaultEditor: CustomEditor;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	editorContainer: Container;
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	subscribeToAgent(): void;
	setToolsExpanded(expanded: boolean): void;
	showSettingsSelector(): void;
};

async function createView(harness: Harness) {
	initTheme("dark");
	let rebind = async () => {};
	const terminal = new VirtualTerminal(80, 40);
	const mode = new InteractiveMode(
		{
			session: harness.session,
			setBeforeSessionInvalidate() {},
			setRebindSession(callback: () => Promise<void>) {
				rebind = callback;
			},
		} as unknown as AgentSessionRuntime,
		{ terminal },
	);
	const view = mode as unknown as View;
	view.isInitialized = true;
	view.setupKeyHandlers();
	view.setupEditorSubmitHandler();
	await view.bindCurrentSessionExtensions();
	view.subscribeToAgent();
	onTestFinished(() => mode.stop("resume-hint"));
	return {
		view,
		terminal,
		rebind: () => rebind(),
		submit: async (text: string) => {
			await view.defaultEditor.onSubmit?.(text);
		},
		text: () => stripAnsi(view.chatContainer.render(80).join("\n")),
	};
}

describe("compact view settings and native event lifecycle", () => {
	test("defaults off, ignores project overrides and preserves concurrent unrelated writes", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-compact-settings-"));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ untouched: "keep" }));
		const projectJson = JSON.stringify({ compactView: true });
		writeFileSync(join(project, ".pi/settings.json"), projectJson);
		const first = SettingsManager.create(project, agentDir);
		const second = SettingsManager.create(project, agentDir);
		expect(first.getCompactView()).toBe(false);
		second.setOutputPad(0);
		await second.flush();
		first.setCompactView(true);
		await first.flush();
		expect(second.getCompactView()).toBe(false);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			compactView: true,
			outputPad: 0,
			untouched: "keep",
		});
		expect(readFileSync(join(project, ".pi/settings.json"), "utf8")).toBe(projectJson);
		writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ compactView: false }));
		expect(SettingsManager.create(project, agentDir).getCompactView()).toBe(true);
		expect(first.drainErrors()).toEqual([]);
	});

	test("commands and selector change the current view in place; rebind keeps the session snapshot", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { hideThinkingBlock: true },
			extensionFactories: [
				(pi) => {
					pi.registerMessageRenderer(
						"status",
						(_message, options) =>
							new Text(options.compactView && !options.expanded ? "status" : "status\nfull detail", 0, 0),
					);
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		const message = { role: "custom" as const, customType: "status", content: "saved", display: true, timestamp: 1 };
		harness.sessionManager.appendMessage(message);
		harness.session.agent.state.messages.push(message);
		const { view, submit, text, rebind } = await createView(harness);
		await rebind();
		expect(text()).toContain("full detail");
		const child = view.chatContainer.children[0];
		const saved = structuredClone(harness.session.messages);
		for (const [command, enabled] of [
			["/compact-view", true],
			["/compact-view off", false],
			["/compact-view toggle", true],
			["/compact-view hybrid", "hybrid"],
			["/compact-view on", true],
			["/compact-view invalid", true],
		] as const) {
			await submit(command);
			expect(harness.settingsManager.getCompactView()).toBe(enabled);
			expect(text().includes("Activity")).toBe(!!enabled);
			expect(view.chatContainer.children[0]).toBe(child);
		}
		expect(text()).toContain("Usage: /compact-view [on|off|hybrid|toggle]");
		harness.settingsManager.setCompactView(false);
		await rebind();
		expect(text()).toContain("Activity");
		view.showSettingsSelector();
		const selector = view.editorContainer.children[0] as SettingsSelectorComponent;
		selector.getSettingsList().selectItem("compact-view");
		selector.getSettingsList().handleInput("\r");
		expect(harness.settingsManager.getCompactView()).toBe("hybrid");
		expect(text()).toContain("▾ Activity");
		expect(text()).not.toContain("full detail");
		selector.getSettingsList().handleInput("\r");
		expect(harness.settingsManager.getCompactView()).toBe(false);
		expect(text()).not.toContain("Activity");
		expect(text()).toContain("full detail");
		expect(harness.session.messages).toEqual(saved);
		expect(harness.faux.state.callCount).toBe(0);
	});

	test("live tools, custom entries, hidden thinking and pending shells keep content and expansion", async () => {
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let update: ((text: string) => void) | undefined;
		const harness = await createHarness({
			tools: [],
			settings: { compactView: true, hideThinkingBlock: true, compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.registerMessageRenderer(
						"notice",
						(_message, options) =>
							new Text(options.expanded ? "Agent update\nagent detail" : "Agent update", 0, 0),
					);
					pi.registerEntryRenderer(
						"progress",
						(_entry, options) => new Text(options.expanded ? "Entry update\nentry detail" : "Entry update", 0, 0),
					);
					pi.on("user_bash", () => ({
						result: { output: "shell first\nshell last", exitCode: 2, cancelled: false, truncated: false },
					}));
					pi.registerTool({
						name: "step",
						label: "Step",
						description: "Offline fixture",
						parameters: Type.Object({ n: Type.Number() }),
						async execute(_id, { n }, _signal, onUpdate, ctx) {
							if (n === 1) {
								ctx.ui.notify("routine notice", "info");
								pi.appendEntry("progress", {});
								pi.sendMessage({ customType: "notice", content: "notice content", display: true });
							} else {
								await ctx.ui.input("Your choice");
								update = (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
								update("partial output\nhidden detail");
								await gate;
							}
							return { content: [{ type: "text", text: "final output\nfull tool detail" }], details: undefined };
						},
						renderCall: ({ n }) => new Text(`step ${n}`, 0, 0),
						renderResult: (result) =>
							new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 0, 0),
					});
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		const { view, text, submit, rebind } = await createView(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[{ type: "text", text: "First assistant" }, fauxToolCall("step", { n: 1 }, { id: "first" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[{ type: "thinking", thinking: "hidden reasoning" }, fauxToolCall("step", { n: 2 }, { id: "second" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Final assistant"),
		]);
		const run = harness.session.prompt("Visible user input");
		try {
			await vi.waitFor(() => expect(stripAnsi(view.editorContainer.render(80).join("\n"))).toContain("Your choice"));
			expect(text()).toContain("Visible user input");
			expect(text()).toContain("First assistant");
			expect(text().match(/Activity/g)).toHaveLength(1);
			expect(text()).not.toMatch(/Agent update|Entry update|routine notice|hidden reasoning/);
			view.editorContainer.children[0].handleInput?.("answer");
			view.editorContainer.children[0].handleInput?.("\r");
			await vi.waitFor(() => expect(update).toBeTypeOf("function"));
			await submit("!!intercepted");
			expect(stripAnsi(view.pendingMessagesContainer.render(80).join("\n"))).toContain("(exit 2)");
			await submit("queued input");
			expect(stripAnsi(view.pendingMessagesContainer.render(80).join("\n"))).toContain("shell last");
			harness.session.clearQueue();
			const saved = structuredClone(harness.session.messages);
			const llm = convertToLlm(harness.session.messages);
			view.setToolsExpanded(true);
			expect(text()).toContain("agent detail");
			expect(text()).toContain("entry detail");
			update!("live output\nlive full detail");
			await vi.waitFor(() => expect(text()).toContain("live full detail"));
			await submit("/compact-view off");
			expect(text()).not.toContain("Activity");
			await submit("/compact-view on");
			expect(text()).not.toContain("live output");
			expect(harness.session.messages).toEqual(saved);
			expect(convertToLlm(harness.session.messages)).toEqual(llm);
		} finally {
			finish();
			if (stripAnsi(view.editorContainer.render(80).join("\n")).includes("Your choice"))
				view.editorContainer.children[0].handleInput?.("\x1b");
			await run;
		}
		expect(text()).toContain("Final assistant");
		expect(text()).not.toContain("running");
		view.setToolsExpanded(true);
		view.chatContainer.invalidate();
		expect(text()).toContain("routine notice");
		await rebind();
		view.setToolsExpanded(true);
		expect(text()).toContain("full tool detail");
		expect(text()).toContain("agent detail");
		expect(text()).toContain("entry detail");
		expect(harness.faux.state.callCount).toBe(3);
	});
});
