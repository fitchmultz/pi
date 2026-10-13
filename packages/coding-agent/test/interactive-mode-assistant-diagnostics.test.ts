import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { CacheMiss, ModelPriceSource } from "../src/core/cache-stats.ts";
import { SessionManager } from "../src/core/session-manager.ts";
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
	chatContainer: Container;
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
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice.call(enabled, message);
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Anthropic dropped 3 thinking blocks (details in session)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice.call(disabled, message);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("does not repeat unchanged Anthropic thinking drops", () => {
		initTheme("dark");
		const context = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getBranch: () => [{ type: "message" as const, message }] },
		};

		maybeShowThinkingDropNotice.call(context, { ...message, timestamp: 2 });

		expect(context.chatContainer.children).toHaveLength(0);
	});
});

describe("InteractiveMode cache estimates", () => {
	test("uses the active leaf for live notices and never diagnoses expiry from a start-time gap", () => {
		initTheme("dark");
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 0 });
		const previous: AssistantMessage = {
			...fauxAssistantMessage("previous", { timestamp: 0 }),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 100_000,
				cacheWrite: 0,
				totalTokens: 100_000,
				cost: { input: 0, output: 0, cacheRead: 0.04, cacheWrite: 0, total: 0.04 },
			},
		};
		const previousId = manager.appendMessage(previous);
		const current: AssistantMessage = {
			...previous,
			timestamp: 600_000,
			usage: {
				...previous.usage,
				cacheRead: 0,
				cacheWrite: 100_000,
				cacheWrite1h: 100_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1.5, total: 1.5 },
			},
		};
		type CacheContext = {
			chatContainer: Container;
			settingsManager: { getShowCacheMissNotices(): boolean };
			sessionManager: SessionManager;
			session: { modelRuntime: ModelPriceSource };
			addCacheMissNotice(miss: CacheMiss): void;
		};
		const show = Reflect.get(InteractiveMode.prototype, "maybeShowCacheMissNotice") as (
			this: CacheContext,
			message: AssistantMessage,
		) => void;
		const add = Reflect.get(InteractiveMode.prototype, "addCacheMissNotice") as (
			this: CacheContext,
			miss: CacheMiss,
		) => void;
		let enabled = true;
		const context: CacheContext = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => enabled },
			sessionManager: manager,
			session: { modelRuntime: { getModel: () => ({ cost: { cacheRead: 0.2 } }) } },
			addCacheMissNotice(miss) {
				add.call(this, miss);
			},
		};
		show.call(context, current);
		const output = stripAnsi(context.chatContainer.render(160).join("\n"));
		expect(output).toContain("100k estimated uncached overlap tokens (~$1.46 extra, prior observed read price)");
		expect(output).not.toMatch(/re-billed|idle|expiry/i);

		context.chatContainer.clear();
		enabled = false;
		show.call(context, current);
		expect(context.chatContainer.children).toHaveLength(0);

		enabled = true;
		manager.branch(root); // No new journal entries: getEntries() still ends at the abandoned response.
		show.call(context, current);
		expect(context.chatContainer.children).toHaveLength(0);

		manager.branch(previousId);
		show.call(context, { ...current, provider: "other-route" });
		const transition = stripAnsi(context.chatContainer.render(160).join("\n"));
		expect(transition).toContain("Expected model/provider cache transition");
		expect(transition).toContain("catalog read price");
		expect(transition).not.toContain("Cache miss estimate:");
	});
});
