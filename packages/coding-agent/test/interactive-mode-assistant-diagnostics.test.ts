import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "survived" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-fable-5-1",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	diagnostics: [
		{
			type: "anthropic_input_transformations",
			timestamp: 1,
			details: {
				transformations: [
					{
						type: "thinking_dropped",
						path: "messages.2.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.5.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.8.content.0",
						reason: "prefix_binding_mismatch",
					},
				],
			},
		},
	],
};

type NoticeContext = {
	chatContainer: ChatContainer;
	settingsManager: { getShowCacheMissNotices(): boolean };
	sessionManager: { getBranch(): Array<{ type: "message"; message: AssistantMessage }> };
};

const maybeShowThinkingDropNotice = Reflect.get(InteractiveMode.prototype, "maybeShowThinkingDropNotice") as (
	this: NoticeContext,
	message: AssistantMessage,
) => void;

describe("InteractiveMode assistant diagnostics", () => {
	test("shows Anthropic thinking drops when cache miss notices are enabled", () => {
		initTheme("dark");
		const enabled = {
			chatContainer: new ChatContainer(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice.call(enabled, message);
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Anthropic dropped 3 thinking blocks (details in session)");

		const disabled = {
			chatContainer: new ChatContainer(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice.call(disabled, message);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("folds thinking-drop notices into Activity in compact view", () => {
		initTheme("dark");
		const chatContainer = new ChatContainer();
		chatContainer.setCompactView(true);
		maybeShowThinkingDropNotice.call(
			{
				chatContainer,
				settingsManager: { getShowCacheMissNotices: () => true },
				sessionManager: { getBranch: () => [] },
			},
			message,
		);
		const collapsed = stripAnsi(chatContainer.render(120).join("\n"));
		expect(collapsed).toContain("Activity");
		expect(collapsed).not.toContain("Anthropic dropped");
		chatContainer.setExpanded(true);
		expect(stripAnsi(chatContainer.render(120).join("\n"))).toContain("Anthropic dropped 3 thinking blocks");
	});

	test("does not repeat unchanged Anthropic thinking drops", () => {
		initTheme("dark");
		const context = {
			chatContainer: new ChatContainer(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getBranch: () => [{ type: "message" as const, message }] },
		};

		maybeShowThinkingDropNotice.call(context, { ...message, timestamp: 2 });

		expect(context.chatContainer.children).toHaveLength(0);
	});
});
