import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function view() {
	initTheme("dark");
	const chat = new ChatContainer();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, {
		isInitialized: true,
		chatContainer: chat,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		pendingTools: new Map(),
		completedToolCalls: new Set(),
		workingVisible: false,
		clearStatusIndicator: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		maybeSuggestBugReport: vi.fn(),
		runtimeHost: {
			session: {
				state: { pendingToolCalls: new Map() },
				settingsManager: { getShowTerminalProgress: () => false },
			},
		},
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
	});
	const handle = Reflect.get(mode, "handleEvent") as (event: AgentSessionEvent) => Promise<void>;
	return {
		send: (event: AgentSessionEvent) => handle.call(mode, event),
		text: (width = 80) => {
			const lines = chat.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			return stripAnsi(lines.join("\n"));
		},
	};
}
const input = { role: "user" as const, content: "change direction", timestamp: 1 };
const assistant: AssistantMessage = {
	role: "assistant",
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-6-astra",
	content: [],
	stopReason: "pending",
	timestamp: 2,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

it.each(["failed", "unknown"] as const)(
	"keeps retained input visible without native %s or fallback notices",
	async (status) => {
		const ui = view();
		await ui.send({ type: "steering", message: input, status: "queued" });
		await ui.send({ type: "steering", message: input, status: "accepted" });
		// Protocol acceptance alone is not model application or user-message admission.
		expect(ui.text()).toBe("");
		await ui.send({ type: "message_start", message: input });
		const received = ui.text();
		expect(received).toContain("change direction");
		await ui.send({
			type: "steering",
			message: input,
			status,
			errorMessage:
				status === "failed"
					? "prompt_cache_options is not supported on this model"
					: "Connection ended before steering application was observed",
		});
		expect(ui.text()).toBe(received);
		await ui.send({ type: "turn_start" });
		await ui.send({ type: "message_start", message: assistant });
		expect(ui.text()).toBe(received);
		expect(ui.text(40)).toContain("change direction");
		await ui.send({ type: "agent_end", messages: [], willRetry: false });
		expect(ui.text()).toBe(received);
	},
);

it("leaves terminal provider errors visible through the normal assistant lifecycle", async () => {
	const ui = view();
	await ui.send({ type: "steering", message: input, status: "pending" });
	await ui.send({ type: "steering", message: input, status: "applied" });
	expect(ui.text()).toBe("");
	await ui.send({ type: "message_start", message: assistant });
	await ui.send({
		type: "message_end",
		message: { ...assistant, stopReason: "error", errorMessage: "Provider request could not be delivered" },
	});
	expect(ui.text()).toContain("Provider request could not be delivered");
});
