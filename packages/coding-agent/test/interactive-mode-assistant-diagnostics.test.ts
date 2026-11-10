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
	sessionManager: Pick<SessionManager, "getBranch">;
};

const maybeShowThinkingDropNotice = Reflect.get(InteractiveMode.prototype, "maybeShowThinkingDropNotice") as (
	this: NoticeContext,
	message: AssistantMessage,
) => void;

/**
 * An assistant message with `thinking` thinking blocks whose request had thinking blocks dropped:
 * `drops` of them because the earlier prompt changed, or one for each listed reason.
 */
function reply(drops: number | Array<string | undefined>, thinking = 0): AssistantMessage {
	const reasons = typeof drops === "number" ? Array.from({ length: drops }, () => "prefix_binding_mismatch") : drops;
	return {
		...message,
		content: [
			...Array.from({ length: thinking }, () => ({ type: "thinking" as const, thinking: "reasoning" })),
			{ type: "text", text: "reply" },
		],
		diagnostics:
			reasons.length === 0
				? undefined
				: [
						{
							type: "anthropic_input_transformations",
							timestamp: 1,
							details: {
								transformations: reasons.map((reason, index) => ({
									type: "thinking_dropped",
									path: `messages.${index}.content.0`,
									...(reason === undefined ? {} : { reason }),
								})),
							},
						},
					],
	};
}

/** The notice text shown for `current`, the response after the session's branch; empty when none is shown. */
function thinkingDropNotice(sessionManager: SessionManager, current: AssistantMessage): string {
	initTheme("dark");
	const context = {
		chatContainer: new Container(),
		settingsManager: { getShowCacheMissNotices: () => true },
		sessionManager,
	};
	maybeShowThinkingDropNotice.call(context, current);
	return stripAnsi(context.chatContainer.render(120).join("\n")).trim();
}

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
		expect(output).toContain(
			"Anthropic dropped 3 thinking blocks after the earlier prompt changed (details in session)",
		);

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice.call(disabled, message);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("does not repeat unchanged Anthropic thinking drops", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(message);

		expect(thinkingDropNotice(manager, { ...message, timestamp: 2 })).toBe("");
	});

	test.each([
		[
			"names the earlier prompt when every dropped block reports a prefix mismatch",
			["prefix_binding_mismatch", "prefix_binding_mismatch"],
			" after the earlier prompt changed",
		],
		[
			"names another model when every dropped block reports a model mismatch",
			["model_binding_mismatch", "model_binding_mismatch"],
			" written by another model",
		],
		["names no cause for another reason", ["organization_binding_mismatch", "organization_binding_mismatch"], ""],
		["names no cause for mixed reasons", ["prefix_binding_mismatch", "model_binding_mismatch"], ""],
		["names no cause when a reason is missing", ["prefix_binding_mismatch", undefined], ""],
	])("%s", (_name, reasons, cause) => {
		expect(thinkingDropNotice(SessionManager.inMemory(), reply(reasons))).toBe(
			`Anthropic dropped 2 thinking blocks${cause} (details in session)`,
		);
	});

	test("does not repeat a drop count whatever reason the reports give", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(reply(["model_binding_mismatch", "prefix_binding_mismatch"]));
		manager.appendMessage(reply(0, 1));

		expect(thinkingDropNotice(manager, reply(["model_binding_mismatch", "prefix_binding_mismatch"]))).toBe("");
	});

	test("does not repeat a drop count reported before responses without a report", () => {
		// With message threads only a full request gets a report; a restarted thread repeats the last one.
		const manager = SessionManager.inMemory();
		manager.appendMessage(reply(3));
		manager.appendMessage(reply(0, 1));
		manager.appendMessage(reply(0, 1));

		expect(thinkingDropNotice(manager, reply(3))).toBe("");
		expect(thinkingDropNotice(manager, reply(5))).toBe(
			"Anthropic dropped 5 thinking blocks after the earlier prompt changed (details in session)",
		);
	});

	test("does not announce the drop of the thinking blocks a compaction kept", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "summarized", timestamp: 0 });
		manager.appendMessage(reply(5, 4));
		const firstKept = manager.appendMessage({ role: "user", content: "kept", timestamp: 0 });
		manager.appendMessage(reply(0, 2));
		manager.appendMessage(reply(0, 1));
		manager.appendCompaction("summary", firstKept, 1000);
		manager.appendMessage({ role: "user", content: "next", timestamp: 0 });

		expect(thinkingDropNotice(manager, reply(3))).toBe("");
		// Neither the summarized thinking blocks nor the report before the compaction raise the baseline.
		expect(thinkingDropNotice(manager, reply(4))).toBe(
			"Anthropic dropped 4 thinking blocks after the earlier prompt changed (details in session)",
		);

		// One kept block was not sent as thinking: the window's first report is lower and replaces the expectation.
		manager.appendMessage(reply(2));
		expect(thinkingDropNotice(manager, reply(3))).toBe(
			"Anthropic dropped 3 thinking blocks after the earlier prompt changed (details in session)",
		);
	});

	test("counts kept thinking blocks on both sides of an older compaction", () => {
		const manager = SessionManager.inMemory();
		const firstKept = manager.appendMessage(reply(0, 1));
		manager.appendCompaction("older summary", firstKept, 1000);
		manager.appendMessage(reply(0, 2));
		manager.appendCompaction("summary", firstKept, 1000);

		expect(thinkingDropNotice(manager, reply(3))).toBe("");
		expect(thinkingDropNotice(manager, reply(4))).toContain("Anthropic dropped 4 thinking blocks");
	});

	test("announces a drop after a compaction that kept nothing", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(reply(0, 2));
		manager.appendCompaction("summary", null, 1000);

		expect(thinkingDropNotice(manager, reply(1))).toBe(
			"Anthropic dropped 1 thinking block after the earlier prompt changed (details in session)",
		);
	});
});

describe("InteractiveMode cache estimates", () => {
	test("uses the active leaf for live notices and never diagnoses expiry from a start-time gap", () => {
		initTheme("dark");
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 0 });
		const previous: AssistantMessage = {
			...fauxAssistantMessage("previous", { timestamp: 0 }),
			cacheIdentity: "account-a",
			thinkingLevel: "high",
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
		expect(transition).toContain("Expected cache transition (model/provider)");
		expect(transition).toContain("catalog read price");
		expect(transition).not.toContain("Cache miss estimate:");

		context.chatContainer.clear();
		const switched: AssistantMessage = { ...current, cacheIdentity: "account-b", thinkingLevel: "low" };
		show.call(context, switched);
		const accountTransition = stripAnsi(context.chatContainer.render(160).join("\n"));
		expect(accountTransition).toContain("Expected cache transition (thinking level, account)");
		expect(accountTransition).toContain("catalog read price");

		manager.appendMessage(switched);
		context.chatContainer.clear();
		show.call(context, { ...switched, timestamp: 700_000 });
		const continuation = stripAnsi(context.chatContainer.render(160).join("\n"));
		expect(continuation).toContain("Cache miss estimate:");
		expect(continuation).not.toContain("Expected cache transition");
	});
});
