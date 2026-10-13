import { getEventListeners } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "queue-test",
	name: "queue-test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const token = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "queue-test" } }),
).toString("base64")}.bbb`;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Codex WebSocket backlog", () => {
	test.each(["complete", "close", "abort"] as const)(
		"preserves ordered observer delivery and cleanup after %s",
		async (ending) => {
			const sockets: QueueSocket[] = [];
			class QueueSocket extends EventTarget {
				readyState = 1;
				constructor() {
					super();
					sockets.push(this);
					queueMicrotask(() => this.dispatchEvent(new Event("open")));
				}
				send(): void {
					queueMicrotask(() => this.emitBurst(0));
				}
				emitBurst(start: number): void {
					for (let sequence = start; sequence < start + 4096; sequence++) {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({ type: "heartbeat", sequence }),
							}),
						);
					}
				}
				finish(): void {
					this.dispatchEvent(
						new MessageEvent("message", {
							data: JSON.stringify({
								type: "response.completed",
								response: { id: "queue-response", status: "completed", output: [] },
							}),
						}),
					);
				}
				close(): void {
					this.readyState = 3;
				}
			}
			vi.stubGlobal("WebSocket", QueueSocket);
			const fetch = vi.fn(async () => {
				throw new Error("unexpected SSE fallback");
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const controller = new AbortController();
			const seen: unknown[] = [];
			let activeObservers = 0;
			const response = stream(model, normalizeContext({ messages: [] }), {
				apiKey: token,
				transport: "websocket",
				signal: controller.signal,
				fetch,
				onProviderStreamEvent: async (data) => {
					if (!data || typeof data !== "object" || !("sequence" in data)) return;
					expect(++activeObservers).toBe(1);
					if (data.sequence === 0) {
						entered.resolve();
						await release.promise;
					}
					await Promise.resolve();
					seen.push(data.sequence);
					if (data.sequence === 4095 && ending === "complete") {
						sockets[0].emitBurst(4096);
						sockets[0].finish();
					}
					activeObservers--;
				},
			});
			await entered.promise;
			expect(seen).toEqual([]);
			if (ending === "close") {
				sockets[0].dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
			} else if (ending === "abort") {
				controller.abort();
			}
			release.resolve();
			const result = await response.result();
			expect(result.stopReason).toBe(ending === "complete" ? "stop" : ending === "abort" ? "aborted" : "error");
			const count = ending === "complete" ? 8192 : ending === "abort" ? 1 : 4096;
			expect(seen).toEqual(Array.from({ length: count }, (_, sequence) => sequence));
			expect(activeObservers).toBe(0);
			expect(fetch).not.toHaveBeenCalled();
			expect(["open", "message", "error", "close"].flatMap((type) => getEventListeners(sockets[0], type))).toEqual(
				[],
			);
			expect(getEventListeners(controller.signal, "abort")).toEqual([]);
		},
	);
});
