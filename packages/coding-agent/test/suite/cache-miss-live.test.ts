import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { collectCacheMisses, detectCacheMiss } from "../../src/core/cache-stats.ts";
import { createHarness } from "./harness.ts";

it("exposes only admitted result IDs before persistence and reproduces the live cache observation on replay", async () => {
	const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
	try {
		const manager = harness.sessionManager;
		const issued = fauxAssistantMessage([{ type: "toolCall", id: "old", name: "work", arguments: {}, async: true }]);
		issued.usage.cacheRead = 100_000;
		manager.appendMessage(issued);
		const previous = fauxAssistantMessage("intervening request");
		previous.usage.cacheRead = 100_000;
		manager.appendMessage(previous);
		const resultId = manager.appendMessage({
			role: "toolResult",
			toolCallId: "old",
			toolName: "work",
			content: [],
			isError: false,
			timestamp: 1,
		});
		harness.session.refreshContext();
		let completed: AssistantMessage | undefined;
		let observed: string[] | undefined;
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			expect(event.consumedToolResultIds).toEqual([resultId]);
			expect(manager.getBranch().some((entry) => entry.type === "message" && entry.message === event.message)).toBe(
				false,
			);
			completed = event.message;
			observed = detectCacheMiss(
				manager,
				event.message,
				harness.session.modelRuntime,
				event.consumedToolResultIds,
			)?.observedChanges;
		});
		harness.setResponses([
			() => {
				// Arrival during streaming is not proof that this request included the result.
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "late",
					toolName: "work",
					content: [],
					isError: false,
					timestamp: 2,
				});
				const response = fauxAssistantMessage("done");
				response.usage.input = 110_000;
				return response;
			},
		]);
		await harness.session.prompt("continue");
		expect(observed).toContain("older async result admitted");
		expect(
			collectCacheMisses(manager.getBranch(), harness.session.modelRuntime).get(completed!)?.observedChanges,
		).toEqual(observed);
	} finally {
		harness.cleanup();
	}
});
