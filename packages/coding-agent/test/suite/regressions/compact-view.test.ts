import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type AutocompleteProvider, type Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { type CustomMessage, convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import backgroundCommand, { BACKGROUND_COMMAND_NOTICE } from "../../../src/extensions/background-command/index.ts";
import {
	backgroundCommandDirectory,
	backgroundCommandFinished,
	cancelBackgroundCommand,
	listBackgroundCommands,
} from "../../../src/extensions/background-command/jobs.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import type { SettingsSelectorComponent } from "../../../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

type View = {
	isInitialized: boolean;
	defaultEditor: CustomEditor;
	autocompleteProvider: AutocompleteProvider | undefined;
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
			["/compact-view", "hybrid"],
			["/compact-view", false],
			["/cv", true],
			["/cv", "hybrid"],
			["/cv", false],
			["/compact-view on", true],
			["/compact-view off", false],
			["/compact-view toggle", true],
			["/compact-view toggle", false],
			["/compact-view hybrid", "hybrid"],
			["/compact-view invalid", "hybrid"],
			["/compact-view toggle", false],
			["/cv on", true],
			["/cv off", false],
			["/cv toggle", true],
			["/cv toggle", false],
			["/cv hybrid", "hybrid"],
			["/cv invalid", "hybrid"],
			["/cv toggle", false],
			["/cv on", true],
		] as const) {
			view.defaultEditor.setText(command);
			await submit(command);
			expect(harness.settingsManager.getCompactView()).toBe(enabled);
			expect(text().includes("Activity")).toBe(!!enabled);
			expect(view.chatContainer.children[0]).toBe(child);
			expect(view.defaultEditor.getText()).toBe("");
		}
		expect(text().match(/Usage: \/compact-view \[on\|off\|hybrid\|toggle\]/g)).toHaveLength(2);
		const suggestions = await view.autocompleteProvider?.getSuggestions(["/cv"], 0, 3, {
			signal: new AbortController().signal,
		});
		expect(suggestions?.items).toContainEqual(expect.objectContaining({ value: "cv" }));
		harness.settingsManager.setCompactView(false);
		await rebind();
		expect(text()).toContain("Activity");
		await submit("/cv");
		expect(harness.settingsManager.getCompactView()).toBe("hybrid");
		expect(text()).toContain("▾ Activity");
		await submit("/compact-view");
		expect(harness.settingsManager.getCompactView()).toBe(false);
		expect(text()).not.toContain("Activity");
		await submit("/cv");
		expect(harness.settingsManager.getCompactView()).toBe(true);
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

	test("background completion notices use one compact row and keep the full notice on expansion", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-compact-background-")));
		const release = join(root, "release");
		const quotedRelease = `'${release.split(sep).join("/").replaceAll("'", "'\\''")}'`;
		const harness = await createHarness({
			sessionManager: SessionManager.create(root, join(root, "sessions")),
			settings: { compactView: "hybrid", compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [backgroundCommand],
		});
		const jobs = backgroundCommandDirectory(harness.sessionManager);
		onTestFinished(async () => {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			for (const job of listBackgroundCommands(jobs)) {
				if (!backgroundCommandFinished(job)) await cancelBackgroundCommand(jobs, job.id);
			}
			harness.cleanup();
			rmSync(root, { recursive: true, force: true });
		});
		const { view, text, submit, rebind } = await createView(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background_command", {
					action: "start",
					command: `while [ ! -f ${quotedRelease} ]; do sleep 0.01; done; printf 'compact-view-boundary-sentinel\\n'`,
				}),
				{ stopReason: "toolUse" },
			),
			async () => {
				// Finish after the first tool boundary: an inline completion legitimately takes only two turns.
				writeFileSync(release, "");
				const statuses = () => listBackgroundCommands(jobs).map((job) => job.status);
				await vi.waitFor(() => expect(statuses()).toEqual(["succeeded"]), { timeout: 6000, interval: 25 });
				return fauxAssistantMessage("Launched");
			},
			fauxAssistantMessage("Completion received"),
		]);
		await harness.session.prompt("Run background reproduction");
		expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			details: { status: "running" },
		});
		expect(harness.faux.state.callCount).toBe(3);
		expect(text()).toContain("▾ Activity");
		expect(text()).not.toContain('"commandPreview"');
		const [job] = listBackgroundCommands(jobs);
		const notice = harness.session.messages.find(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === BACKGROUND_COMMAND_NOTICE,
		);
		expect(notice?.details).toEqual({ jobIds: [job.id], jobs: [{ id: job.id, status: "succeeded" }] });
		expect(notice?.content).toMatch(/^Background commands finished:\n/);
		expect(notice?.content).toContain(job.logFile);
		const saved = structuredClone(harness.session.messages);
		const llm = convertToLlm(harness.session.messages);

		const renderer = harness.session.extensionRunner.getMessageRenderer(BACKGROUND_COMMAND_NOTICE);
		expect(renderer, "background notices have a compact renderer").toBeTypeOf("function");
		const compactRow = (message: CustomMessage, width: number) => {
			const lines = renderer!(message, { compactView: true, expanded: false, outputPad: 1 }, theme)!.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
			return stripAnsi(lines[0]).trim();
		};
		const row = compactRow(notice!, 80);
		expect(row).toContain("1");
		await rebind();
		expect(text()).toContain("▾ Activity");
		expect(text()).toContain(row);
		expect(text()).not.toContain('"commandPreview"');
		view.setToolsExpanded(true);
		expect(text()).toContain("Background commands finished:");
		expect(text()).toContain('"commandPreview"');
		view.setToolsExpanded(false);
		expect(text()).not.toContain('"commandPreview"');
		await submit("/cv off");
		expect(text()).not.toContain("Activity");
		expect(text()).toContain('"commandPreview"');
		await submit("/cv hybrid");
		expect(text()).toContain(row);
		expect(text()).not.toContain('"commandPreview"');
		expect(harness.session.messages).toEqual(saved);
		expect(convertToLlm(harness.session.messages)).toEqual(llm);

		const recorded = (details: unknown): CustomMessage => ({
			role: "custom",
			customType: BACKGROUND_COMMAND_NOTICE,
			content: 'Background commands finished:\n{"id":"a","status":"succeeded"}\n\n{"id":"b","status":"failed"}',
			display: true,
			details,
			timestamp: 1,
		});
		const legacy = compactRow(recorded({ jobIds: ["a", "b"] }), 24);
		expect(legacy).toContain("2");
		expect(legacy).not.toMatch(/succeeded|failed/);
		const mixed = compactRow(
			recorded({
				jobIds: ["a", "b"],
				jobs: [
					{ id: "a", status: "succeeded" },
					{ id: "b", status: "failed" },
				],
			}),
			80,
		);
		expect(mixed).toContain("2");
		expect(mixed).toContain("failed");
	});
});
