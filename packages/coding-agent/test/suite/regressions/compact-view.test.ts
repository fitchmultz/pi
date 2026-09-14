import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type Container, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { BashExecutionComponent } from "../../../src/modes/interactive/components/bash-execution.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import type { SettingsSelectorComponent } from "../../../src/modes/interactive/components/settings-selector.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTui, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

type CompactView = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	isInitialized: boolean;
	compactView: boolean;
	toolOutputExpanded: boolean;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	editorContainer: Container;
	defaultEditor: CustomEditor;
	pendingTools: Map<string, ToolExecutionComponent>;
	pendingUserInputs: string[];
	pendingBashComponents: BashExecutionComponent[];
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	subscribeToAgent(): void;
	renderInitialMessages(): void;
	renderSessionItems(messages: AgentMessage[]): void;
	setToolsExpanded(expanded: boolean): void;
	showSettingsSelector(): void;
	handleReloadCommand(): Promise<void>;
};

async function createView(harness: Harness) {
	initTheme("dark");
	let rebind = async () => {};
	const mode = new InteractiveMode(
		{
			session: harness.session,
			setBeforeSessionInvalidate() {},
			setRebindSession(callback: () => Promise<void>) {
				rebind = callback;
			},
		} as unknown as AgentSessionRuntime,
		{ tuiMode: "fullscreen" },
	);
	// Use the real constructor (including its preference snapshot), editor, components and event handlers.
	// Replace only the unstarted physical terminal with the existing headless terminal fixture.
	const view = mode as unknown as CompactView;
	const terminal = new VirtualTerminal(80, 40);
	view.renderer = createInteractiveTui({
		tuiMode: "fullscreen",
		terminal,
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
	});
	view.isInitialized = true;
	view.setupKeyHandlers();
	view.setupEditorSubmitHandler();
	await view.bindCurrentSessionExtensions();
	view.subscribeToAgent();
	view.renderer.addChild(view.chatContainer);
	view.renderer.addChild(view.pendingMessagesContainer);
	view.renderer.addChild(view.editorContainer);
	view.ui.setFocus(view.defaultEditor);
	view.renderer.start();
	onTestFinished(() => mode.stop("resume-hint"));
	return {
		view,
		terminal,
		rebind: () => rebind(),
		submit: async (text: string) => {
			await view.defaultEditor.onSubmit?.(text);
		},
	};
}

function history(): Array<AssistantMessage | ToolResultMessage> {
	return [
		fauxAssistantMessage(
			[
				{ type: "thinking", thinking: "private history" },
				{ type: "text", text: "human history" },
				fauxToolCall("read", { path: "file.txt" }, { id: "history-read" }),
			],
			{ stopReason: "toolUse" },
		),
		{
			role: "toolResult",
			toolName: "read",
			toolCallId: "history-read",
			content: [{ type: "text", text: "read detail" }],
			isError: false,
			timestamp: 1,
		},
	];
}

function tools(view: CompactView): ToolExecutionComponent[] {
	return view.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
}

function clickTool(component: ToolExecutionComponent): void {
	const lines = component.render(80);
	const y = lines.findIndex((line) => stripAnsi(line).trim());
	expect(
		component.handleMouse({
			type: "click",
			button: "left",
			x: 2,
			y,
			screenX: 2,
			screenY: y,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		})?.handled,
	).toBe(true);
}

describe("native compact-view settings and live rendering", () => {
	test("defaults off, ignores project overrides and remembers only future starts across reload/rebind", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-compact-settings-"));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ hideThinkingBlock: true, theme: "dark", untouched: "keep" }),
		);
		const projectJson = JSON.stringify({ compactView: true });
		writeFileSync(join(project, ".pi/settings.json"), projectJson);
		const firstSettings = SettingsManager.create(project, agentDir);
		const secondSettings = SettingsManager.create(project, agentDir);
		const firstHarness = await createHarness({ tools: [], settingsManager: firstSettings });
		const secondHarness = await createHarness({ tools: [], settingsManager: secondSettings });
		onTestFinished(() => firstHarness.cleanup());
		onTestFinished(() => secondHarness.cleanup());
		const first = await createView(firstHarness);
		const second = await createView(secondHarness);
		first.view.renderSessionItems(history());
		second.view.renderSessionItems(history());
		const secondCard = tools(second.view)[0];
		const normal = secondCard.render(80);
		expect(normal.length).toBeGreaterThan(2);

		// A different writer must keep its unrelated change when this instance saves compactView.
		secondSettings.setOutputPad(0);
		await secondSettings.flush();
		await first.submit("/compact-view on");
		await firstSettings.flush();
		expect(tools(first.view)[0].render(80).length).toBeLessThanOrEqual(2);
		expect(secondSettings.getCompactView()).toBe(false);
		expect(secondCard.render(80)).toEqual(normal);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			compactView: true,
			outputPad: 0,
			untouched: "keep",
			hideThinkingBlock: true,
		});
		expect(readFileSync(join(project, ".pi/settings.json"), "utf8")).toBe(projectJson);

		await secondSettings.reload();
		expect(secondSettings.getCompactView()).toBe(true);
		await second.rebind();
		expect(second.view.compactView).toBe(false);
		second.view.renderSessionItems(history());
		expect(tools(second.view)[0].render(80).length).toBeGreaterThan(2);

		writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ compactView: false }));
		const futureSettings = SettingsManager.create(project, agentDir);
		const futureHarness = await createHarness({ tools: [], settingsManager: futureSettings });
		onTestFinished(() => futureHarness.cleanup());
		const future = await createView(futureHarness);
		future.view.renderSessionItems(history());
		expect(tools(future.view)[0].render(80).length).toBeLessThanOrEqual(2);

		first.view.showSettingsSelector();
		const selector = first.view.editorContainer.children[0] as SettingsSelectorComponent;
		const list = selector.getSettingsList();
		list.selectItem("compact-view");
		list.handleInput("\r");
		await firstSettings.flush();
		expect(first.view.compactView).toBe(false);
		expect(tools(first.view)[0].render(80).length).toBeGreaterThan(2);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).compactView).toBe(false);

		await future.view.handleReloadCommand();
		expect(futureSettings.getCompactView()).toBe(false);
		expect(future.view.compactView).toBe(true);
		future.view.renderSessionItems(history());
		expect(tools(future.view)[0].render(80).length).toBeLessThanOrEqual(2);
		await future.rebind();
		expect(future.view.compactView).toBe(true);
		future.view.renderSessionItems(history());
		expect(tools(future.view)[0].render(80).length).toBeLessThanOrEqual(2);
		expect(firstSettings.drainErrors()).toEqual([]);
		expect(firstHarness.faux.state.callCount).toBe(0);
		expect(secondHarness.faux.state.callCount).toBe(0);
		expect(futureHarness.faux.state.callCount).toBe(0);
	});

	test("uses one command for toggle/on/off and rejects invalid arguments without submitting a prompt", async () => {
		const harness = await createHarness({ tools: [] });
		onTestFinished(() => harness.cleanup());
		const { view, submit } = await createView(harness);
		view.renderSessionItems(history());
		const card = tools(view)[0];
		for (const [command, expected] of [
			["/compact-view", true],
			["/compact-view off", false],
			["/compact-view toggle", true],
			["/compact-view on", true],
			["/compact-view invalid", true],
		] as const) {
			await submit(command);
			if (expected) expect(card.render(80).length).toBeLessThanOrEqual(2);
			else expect(card.render(80).length).toBeGreaterThan(2);
			expect(view.compactView).toBe(expected);
			expect(harness.settingsManager.getCompactView()).toBe(expected);
		}
		expect(stripAnsi(view.chatContainer.render(80).join("\n"))).toContain("Usage: /compact-view [on|off|toggle]");
		expect(view.pendingUserInputs).toEqual([]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	test.each([false, true])(
		"toggles history and streaming tools/shells in place (global expanded=%s)",
		async (globallyExpanded) => {
			let finishTool!: () => void;
			const toolGate = new Promise<void>((resolve) => {
				finishTool = resolve;
			});
			let finishBash!: () => void;
			const bashGate = new Promise<void>((resolve) => {
				finishBash = resolve;
			});
			let updateTool: ((text: string) => void) | undefined;
			let updateBash: ((text: string) => void) | undefined;
			const toolOutput = Array.from({ length: 30 }, (_, i) => `tool line ${i}`).join("\n");
			const harness = await createHarness({
				tools: [],
				settings: { hideThinkingBlock: true, compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "progress_tool",
							label: "Progress",
							description: "Offline progress fixture",
							parameters: Type.Object({}),
							async execute(_id, _args, _signal, onUpdate) {
								updateTool = (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
								updateTool(toolOutput);
								await toolGate;
								return { content: [{ type: "text", text: `FINAL\n${toolOutput}` }], details: undefined };
							},
							renderCall: () => new Text("progress tool", 0, 0),
							renderResult: (result, _options, _theme, context) => {
								const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
								text.setText(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
								return text;
							},
						});
						pi.on("user_bash", (event) =>
							event.command === "intercepted"
								? {
										result: { output: "intercepted output", exitCode: 2, cancelled: false, truncated: false },
									}
								: {
										operations: {
											exec: async (_command, _cwd, { onData }) => {
												updateBash = (text) => onData(Buffer.from(text));
												updateBash("FIRST BASH\n");
												await bashGate;
												updateBash("FINAL BASH\n");
												return { exitCode: 0 };
											},
										},
									},
						);
						pi.registerMessageRenderer("status", (_message, options) =>
							options.compactView && !options.expanded
								? {
										render: (width) => [truncateToWidth("custom status", width)],
										invalidate() {},
									}
								: new Text("custom status\nexpanded status detail", 0, 0),
						);
					},
				],
			});
			onTestFinished(() => harness.cleanup());
			const messages = [
				...history(),
				{ role: "custom" as const, customType: "status", content: "custom status", display: true, timestamp: 1 },
			];
			for (const message of messages) harness.sessionManager.appendMessage(message);
			harness.session.agent.state.messages.push(...messages);
			const { view, terminal, submit } = await createView(harness);
			view.renderInitialMessages();
			const historical = tools(view)[0];
			harness.setResponses([
				fauxAssistantMessage(
					[
						{ type: "thinking", thinking: "private live thought" },
						{ type: "text", text: "before tool" },
						fauxToolCall("progress_tool", {}, { id: "live-tool" }),
						{ type: "text", text: "after tool commentary" },
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("final human answer"),
			]);
			const run = harness.session.prompt("run fixture");
			let bashRun: Promise<void> | undefined;
			try {
				await vi.waitFor(() => expect(updateTool).toBeTypeOf("function"));
				const live = view.pendingTools.get("live-tool")!;
				expect(live).toBeInstanceOf(ToolExecutionComponent);
				bashRun = submit("!fixture");
				await vi.waitFor(() => expect(updateBash).toBeTypeOf("function"));
				const bash = view.pendingBashComponents[0];
				expect(bash.getOutput()).toBe("FIRST BASH\n");
				if (globallyExpanded) view.setToolsExpanded(true);
				else {
					clickTool(historical);
					clickTool(live);
					view.setToolsExpanded(false);
					expect(live.render(80).length).toBeGreaterThan(2);
				}
				const beforeMessages = structuredClone(harness.session.messages);
				const beforeEntries = structuredClone(harness.sessionManager.getEntries());
				const beforeContext = convertToLlm(harness.session.messages);
				await submit("/compact-view on");
				expect(view.toolOutputExpanded).toBe(false);
				expect(view.pendingTools.get("live-tool")).toBe(live);
				expect(tools(view)).toContain(historical);
				expect(view.pendingMessagesContainer.children).toContain(bash);
				for (const card of [historical, live, bash]) expect(card.render(80).length).toBeLessThanOrEqual(2);
				expect(harness.session.messages).toEqual(beforeMessages);
				expect(harness.sessionManager.getEntries()).toEqual(beforeEntries);
				expect(convertToLlm(harness.session.messages)).toEqual(beforeContext);
				expect(harness.settingsManager.getHideThinkingBlock()).toBe(true);
				const compactText = stripAnsi(view.chatContainer.render(80).join("\n"));
				expect(compactText).toContain("before tool");
				expect(compactText).toContain("after tool commentary");
				expect(compactText).toContain("human history");
				expect(compactText).not.toContain("Thinking...");
				expect(compactText).not.toContain("read detail");

				clickTool(live);
				await submit("/compact-view on");
				updateTool!(`SECOND\n${toolOutput}`);
				updateBash!("SECOND BASH\n");
				await vi.waitFor(() => expect(stripAnsi(live.render(80).join("\n"))).toContain("SECOND"));
				expect(live.render(80).length).toBeGreaterThan(2);
				expect(bash.render(80).length).toBeLessThanOrEqual(2);
				expect(bash.getOutput()).toBe("FIRST BASH\nSECOND BASH\n");
				expect(view.pendingTools.get("live-tool")).toBe(live);

				terminal.sendInput("\x0f");
				await terminal.waitForRender();
				expect(view.toolOutputExpanded).toBe(true);
				expect(bash.render(80).length).toBeGreaterThan(2);
				terminal.sendInput("\x0f");
				await terminal.waitForRender();
				expect(view.toolOutputExpanded).toBe(false);
				expect(bash.render(80).length).toBeLessThanOrEqual(2);
				await submit("/compact-view off");
				expect(stripAnsi(historical.render(80).join("\n"))).not.toContain("read detail");
				expect(stripAnsi(live.render(80).join("\n"))).toContain("SECOND");
				expect(stripAnsi(bash.render(80).join("\n"))).toContain("SECOND BASH");
				await submit("/compact-view on");
				expect(harness.faux.state.callCount).toBe(1);
				expect(harness.session.getSteeringMessages()).toEqual([]);

				// Queue refreshes must not discard an in-flight user shell's existing component.
				await submit("queued input");
				expect(view.pendingMessagesContainer.children).toContain(bash);
				harness.session.clearQueue();
				finishBash();
				await bashRun;
				await submit("!!intercepted");
				expect(view.pendingBashComponents).toHaveLength(2);
				for (const card of view.pendingBashComponents) expect(card.render(80).length).toBeLessThanOrEqual(2);
				expect(stripAnsi(view.pendingBashComponents[1].render(80).join("\n"))).toContain("(exit 2)");
			} finally {
				harness.session.clearQueue();
				finishTool();
				finishBash();
				await bashRun;
				await run;
			}
			expect(view.pendingTools.size).toBe(0);
			expect(tools(view).some((card) => stripAnsi(card.render(80).join("\n")).includes("progress tool"))).toBe(true);
			expect(stripAnsi(view.chatContainer.render(80).join("\n"))).toContain("final human answer");
			const result = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "live-tool",
			);
			expect(result).toMatchObject({ content: [{ type: "text", text: `FINAL\n${toolOutput}` }] });
			expect(harness.faux.state.callCount).toBe(2);
		},
	);
});
