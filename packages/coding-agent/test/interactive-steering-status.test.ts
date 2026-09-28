import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function view() {
	initTheme("dark");
	const chat = new ChatContainer();
	const pending = new Container();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, {
		isInitialized: true,
		liveSteeringMessages: new Set(),
		chatContainer: chat,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		pendingTools: new Map(),
		completedToolCalls: new Set(),
		workingVisible: false,
		clearStatusIndicator: vi.fn(),
		pendingMessagesContainer: pending,
		loadedResourcesContainer: new Container(),
		renderInitialMessages: vi.fn(),
		compactionQueuedMessages: [],
		maybeSuggestBugReport: vi.fn(),
		runtimeHost: {
			session: {
				state: { pendingToolCalls: new Map() },
				getSteeringMessages: () => [],
				getFollowUpMessages: () => [],
				settingsManager: { getShowTerminalProgress: () => false },
			},
		},
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
	});
	const handle = Reflect.get(mode, "handleEvent") as (event: AgentSessionEvent) => Promise<void>;
	return {
		send: (event: AgentSessionEvent) => handle.call(mode, event),
		reset: () => {
			const reset = Reflect.get(mode, "renderCurrentSessionState") as () => void;
			reset.call(mode);
		},
		pending: (width = 80) => {
			const lines = pending.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			return stripAnsi(lines.join("\n"));
		},
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
		expect(ui.pending()).toContain("Steering: change direction");
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
		expect(ui.pending()).toBe("");
		await ui.send({ type: "turn_start" });
		await ui.send({ type: "message_start", message: assistant });
		expect(ui.text()).toBe(received);
		expect(ui.text(40)).toContain("change direction");
		await ui.send({ type: "agent_end", messages: [], willRetry: false });
		expect(ui.text()).toBe(received);
	},
);

it("keeps identical live submissions distinct until each is applied, and clears on run end", async () => {
	const ui = view();
	const duplicate = { ...input };
	for (const message of [input, duplicate]) {
		await ui.send({ type: "steering", message, status: "queued" });
		await ui.send({ type: "steering", message, status: "accepted" });
		await ui.send({ type: "steering", message, status: "pending" });
	}
	expect(ui.pending().match(/Steering: change direction/g)).toHaveLength(2);
	expect(ui.pending(32)).toContain("sent; cannot edit");
	expect(ui.pending()).not.toContain("to edit all queued");
	await ui.send({ type: "steering", message: input, status: "applied" });
	expect(ui.pending().match(/Steering: change direction/g)).toHaveLength(1);
	await ui.send({ type: "agent_end", messages: [], willRetry: false });
	expect(ui.pending()).toBe("");
	expect(ui.text()).toBe("");
});

it("does not carry live steering feedback into a replacement session", async () => {
	const ui = view();
	await ui.send({ type: "steering", message: input, status: "queued" });
	expect(ui.pending()).toContain("Steering: change direction");
	ui.reset();
	await ui.send({ type: "queue_update", steering: [], followUp: [] });
	expect(ui.pending()).toBe("");
});

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
