import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { stream as responsesStream } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url")}.test`;

afterEach(() => vi.unstubAllGlobals());

// #155: the terminal response, not the request or an earlier event, confirms Ultrafast.
describe.each(["responses", "codex-sse", "codex-websocket"] as const)("Ultrafast pricing (%s)", (transport) => {
	it.each([
		["gpt-6-astra", "ultrafast", 6, "ultrafast"],
		["gpt-6-astra", undefined, 1, "ultrafast"],
		["gpt-6-astra", "default", 1, "ultrafast"],
		["gpt-6-astra", "unknown", 1, "ultrafast"],
		["gpt-6-sol-preview", "ultrafast", 1, "ultrafast"],
		["gpt-6-astra", "fast", 2, "ultrafast"],
		["gpt-5.5", "fast", 2.5, "ultrafast"],
		...(transport === "responses"
			? []
			: ([
					["gpt-6-astra", "default", 2, "fast"],
					["gpt-6-astra", undefined, 2, "fast"],
				] as const)),
	] as const)("prices %s with returned tier %s at %sx (requested %s)", async (id, tier, multiplier, requestTier) => {
		const events = [
			{ type: "response.created", response: { id: "offline", service_tier: "ultrafast" } },
			{
				type: "response.completed",
				response: {
					id: "offline",
					status: "completed",
					service_tier: tier,
					usage: {
						input_tokens: 20,
						output_tokens: 7,
						total_tokens: 27,
						input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
					},
				},
			},
		];
		const fetch: typeof globalThis.fetch = async () =>
			new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		class OfflineWebSocket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send() {
				setTimeout(() => {
					for (const event of events)
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
				}, 0);
			}
			close() {}
		}
		if (transport === "codex-websocket") vi.stubGlobal("WebSocket", OfflineWebSocket);
		const base = {
			id,
			name: id,
			baseUrl: "https://offline.test/v1",
			reasoning: false,
			input: ["text"] as ["text"],
			cost: {
				input: 2,
				output: 3,
				cacheRead: 1,
				cacheWrite: 4,
				tiers: [{ inputTokensAbove: 10, input: 4, output: 6, cacheRead: 2, cacheWrite: 8 }],
			},
			contextWindow: 1000,
			maxTokens: 100,
		};
		const stream =
			transport === "responses"
				? responsesStream(
						{ ...base, api: "openai-responses", provider: "openai" } satisfies Model<"openai-responses">,
						normalizeContext({ messages: [] }),
						{ apiKey: "sk-test", fetch, serviceTier: requestTier },
					)
				: codexStream(
						{
							...base,
							api: "openai-codex-responses",
							provider: "openai-codex",
						} satisfies Model<"openai-codex-responses">,
						normalizeContext({ messages: [] }),
						{
							apiKey: token,
							fetch,
							serviceTier: requestTier,
							transport: transport === "codex-sse" ? "sse" : "websocket",
							env: {},
						},
					);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.cost.input).toBeCloseTo(0.00006 * multiplier, 10);
		expect(result.usage.cost.output).toBeCloseTo(0.000042 * multiplier, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo(0.000004 * multiplier, 10);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(0.000024 * multiplier, 10);
		expect(result.usage.cost.total).toBeCloseTo(0.00013 * multiplier, 10);
	});
});
