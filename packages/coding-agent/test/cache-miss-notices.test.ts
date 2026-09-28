import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { type CacheMiss, collectCacheMisses } from "../src/core/cache-stats.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ChatContainer } from "../src/modes/interactive/components/activity.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fixture(provider: "openai" | "anthropic" | "unavailable" | "model" = "openai") {
	const manager = SessionManager.inMemory();
	const previous = fauxAssistantMessage("previous");
	previous.timestamp = 0;
	previous.usage = {
		input: 30_000,
		output: 0,
		cacheRead: 70_000,
		cacheWrite: 0,
		totalTokens: 100_000,
		cost: { input: 0.09, output: 0, cacheRead: 0.021, cacheWrite: 0, total: 0.111 },
	};
	previous.diagnostics = [{ type: "provider_request", timestamp: 0, details: { websocketRequestMode: "delta" } }];
	const current = structuredClone(previous);
	if (provider === "model") current.model = "different-model";
	current.diagnostics = [
		{
			type: "provider_request",
			timestamp: 1,
			details: {
				websocketRequestMode: "full",
				socketReused: false,
				prompt_cache_diagnostics:
					provider === "openai"
						? { type: "cache_miss", reason: "input_changed", cache_missed_tokens: 30_000 }
						: { type: "unavailable" },
			},
		},
	];
	if (provider === "anthropic")
		current.diagnostics.push({
			type: "anthropic_input_transformations",
			timestamp: 1,
			details: {
				transformations: Array.from({ length: 49 }, (_, index) => ({
					type: "thinking_dropped",
					reason: "prefix_binding_mismatch",
					path: `messages.${index}.content.0`,
				})),
			},
		});
	manager.appendMessage(previous);
	manager.appendMessage(current);
	const models = { getModel: () => ({ cost: { cacheRead: 0.3 } }) };
	const miss = collectCacheMisses(manager.getBranch(), models).get(current)!;
	return { manager, models, miss };
}

describe("cache miss notice rendering", () => {
	it.each([
		["openai", 0, "; provider: input changed"],
		["openai", 20_000, "; provider: input changed"],
		["anthropic", 0, "; provider: dropped 49 thinking blocks (prefix binding mismatch)"],
		["unavailable", 0, ""],
		["model", 0, ""],
	] as const)("renders %s diagnostics with a cached-read decline of %s", (provider, decline, suffix) => {
		initTheme("dark", false);
		const { miss } = fixture(provider);
		const target = { chatContainer: new ChatContainer() };
		const render = Reflect.get(InteractiveMode.prototype, "addCacheMissNotice") as (
			this: typeof target,
			miss: CacheMiss,
		) => void;
		render.call(target, { ...miss, cacheReadDecline: decline });
		const output = stripAnsi(target.chatContainer.render(400).join("\n")).trim();
		expect(output).toBe(
			`Cache miss: 30k tokens not read from cache (estimated extra $0.08)${decline ? "; cached reads fell by 20k tokens" : ""}. Observed: ${provider === "model" ? "model changed, " : ""}new connection, full resend${suffix}`,
		);
		const narrow = stripAnsi(target.chatContainer.render(60).join("\n"));
		expect(narrow.replace(/\s+/g, " ").trim()).toBe(output);
	});

	it.each([
		["openai", "Provider: input changed (1)"],
		["anthropic", "Provider: dropped 49 thinking blocks (prefix binding mismatch) (1)"],
		["unavailable", ""],
		["model", ""],
	] as const)("shows %s provider reasons beside the session estimate", (provider, expected) => {
		initTheme("dark", false);
		const { manager, models } = fixture(provider);
		const target = {
			chatContainer: new ChatContainer(),
			sessionManager: manager,
			session: {
				modelRuntime: models,
				cacheWarmingStatus: undefined,
				getSessionStats: () => ({
					sessionFile: null,
					sessionId: "test",
					totalMessages: 2,
					userMessages: 0,
					assistantMessages: 2,
					toolCalls: 0,
					toolResults: 0,
					tokens: { input: 60_000, cacheRead: 140_000, cacheWrite: 0, output: 0, total: 200_000 },
					cost: 0.222,
				}),
			},
			settingsManager: { getCacheWarmingMode: () => "off" },
			ui: { requestRender: vi.fn() },
		};
		const render = Reflect.get(InteractiveMode.prototype, "handleSessionCommand") as (this: typeof target) => void;
		render.call(target);
		const output = stripAnsi(target.chatContainer.render(400).join("\n"));
		expect(output).toContain("Cache misses: estimated extra $0.081 (30,000 tokens not read from cache, 1 miss)");
		expect(output).toContain(
			`Observed (counts may overlap): ${provider === "model" ? "model changed (1), " : ""}new connection (1), full resend (1)`,
		);
		if (expected) expect(output).toContain(expected);
		else expect(output).not.toContain("Provider:");
	});
});
