import type { UserMessage } from "@earendil-works/pi-ai/compat";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

const skillText = '<skill name="review" location="/skills/review.md">\nSkill instructions\n</skill>';
const prompt = "Review this change\n\n1. Preserve **styling**\n2. Preserve ordering";

function createMode(compactView: boolean) {
	const chat = new ChatContainer();
	chat.setCompactView(compactView);
	const settings = SettingsManager.inMemory({ outputPad: 1 });
	const addToHistory = vi.fn();
	const editorContainer = new Container();
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		chatContainer: chat,
		loadedResourcesContainer: new Container(),
		pendingMessagesContainer: new Container(),
		editorContainer,
		editor: { addToHistory },
		outputPad: 1,
		toolOutputExpanded: false,
		compactView,
		runtimeHost: {
			session: {
				settingsManager: settings,
				isStreaming: true,
				modelRuntime: { getAvailableSnapshot: () => [] },
				extensionRunner: { getMarkdownTransformers: () => [] },
			},
		},
		mermaidMarkdownTransformer: (text: string) => text,
		themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => undefined },
		ui: { requestRender() {}, setFocus() {}, mode: "fullscreen" },
	}) as {
		addMessageToChat(message: UserMessage, options?: { populateHistory?: boolean }): void;
		setToolsExpanded(expanded: boolean): void;
		showSettingsSelector(): void;
	};
	return { mode, chat, settings, editorContainer, addToHistory };
}

function clickSkill(chat: ChatContainer): void {
	const lines = chat.render(80);
	const y = lines.findIndex((line) => stripAnsi(line).includes("[skill]"));
	expect(y).toBeGreaterThanOrEqual(0);
	expect(
		chat.handleMouse({
			type: "click",
			button: "left",
			x: 1,
			y,
			screenX: 1,
			screenY: y,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		})?.handled,
	).toBe(true);
}

describe.each([false, true])("native skill transcript (compact=%s)", (compact) => {
	// PR #108: reversing transcript children must not separate a skill card from its prompt.
	test.each([false, true])("preserves native rows and session data (trailing prompt=%s)", (hasPrompt) => {
		const { mode, chat, addToHistory } = createMode(compact);
		const content = skillText + (hasPrompt ? `\n\n${prompt}` : "");
		const message: UserMessage = { role: "user", content, timestamp: 1 };
		const saved = structuredClone(message);
		const older = new Text("OLDER MESSAGE", 0, 0);
		const newer = new Text("NEWER MESSAGE", 0, 0);
		chat.addChild(older);
		mode.addMessageToChat(message, { populateHistory: true });
		const nativeSkill = new SkillInvocationMessageComponent(parseSkillBlock(content)!);
		const nativeRows = [
			...new Spacer(1).render(80),
			...nativeSkill.render(80),
			...(hasPrompt ? [...new Spacer(1).render(80), ...new UserMessageComponent(prompt).render(80)] : []),
		];
		expect(chat.render(80)).toEqual([...older.render(80), ...nativeRows]);
		chat.addChild(newer);
		const backingChildren = [...chat.children];
		chat.setTranscriptOrder("newest-first");
		expect(chat.render(80)).toEqual([...newer.render(80), ...nativeRows, ...older.render(80)]);
		expect(chat.children).toEqual(backingChildren);
		chat.setTranscriptOrder("oldest-first");
		expect(chat.render(80)).toEqual([...older.render(80), ...nativeRows, ...newer.render(80)]);
		expect(message).toEqual(saved);
		expect(addToHistory).toHaveBeenCalledExactlyOnceWith(content);
	});

	test("keeps local and global expansion working in newest-first order", () => {
		const { mode, chat } = createMode(compact);
		mode.addMessageToChat({ role: "user", content: `${skillText}\n\n${prompt}`, timestamp: 1 });
		chat.addChild(new Text("NEWER MESSAGE", 0, 0));
		chat.setTranscriptOrder("newest-first");
		const visibleText = () => chat.render(80).map(stripAnsi).join("\n");
		expect(visibleText()).not.toContain("Skill instructions");
		clickSkill(chat);
		expect(visibleText()).toContain("Skill instructions");
		clickSkill(chat);
		expect(visibleText()).not.toContain("Skill instructions");
		mode.setToolsExpanded(true);
		expect(visibleText()).toContain("Skill instructions");
		expect(visibleText().indexOf("Skill instructions")).toBeLessThan(visibleText().indexOf("Review this change"));
		mode.setToolsExpanded(false);
		expect(visibleText()).not.toContain("Skill instructions");
		expect(visibleText()).toContain("Review this change");
	});

	test("updates the trailing prompt padding through settings during streaming", () => {
		const { mode, chat, settings, editorContainer } = createMode(compact);
		mode.addMessageToChat({ role: "user", content: `${skillText}\n\n${prompt}`, timestamp: 1 });
		chat.setTranscriptOrder("newest-first");
		clickSkill(chat);
		mode.showSettingsSelector();
		const selector = editorContainer.children[0] as SettingsSelectorComponent;
		const list = selector.getSettingsList();
		list.handleInput("Output padding");
		list.handleInput("\r");
		expect(settings.getOutputPad()).toBe(0);
		const skill = new SkillInvocationMessageComponent(parseSkillBlock(skillText)!);
		skill.setExpanded(true);
		// Exact native rows also preserve backgrounds, Markdown and OSC 133 copy/selection zones.
		expect(chat.render(80)).toEqual([
			...skill.render(80),
			...new Spacer(1).render(80),
			...new UserMessageComponent(prompt, undefined, 0).render(80),
		]);
	});
});
