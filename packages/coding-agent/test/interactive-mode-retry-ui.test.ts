import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createHarness } from "./suite/harness.ts";
import { createTestInteractiveView } from "./suite/ui-harness.ts";

describe("InteractiveMode auto-retry error cleanup", () => {
	test("removes superseded retried error rows when a retry recovers", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 5 } },
		});
		try {
			const view = await createTestInteractiveView(harness);
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stopped with: MALFORMED_FUNCTION_CALL",
				}),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stopped with: MALFORMED_FUNCTION_CALL",
				}),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stopped with: MALFORMED_FUNCTION_CALL",
				}),
				fauxAssistantMessage("Recovered response"),
			]);

			await harness.session.prompt("hello");
			await harness.session.waitForIdle();

			const rendered = view.text();
			expect(rendered).not.toContain("MALFORMED_FUNCTION_CALL");
			expect(rendered).toContain("Recovered response");
		} finally {
			harness.cleanup();
		}
	});

	test("keeps a single final error row plus the retry-failed summary when retries exhaust", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 5 } },
		});
		try {
			const view = await createTestInteractiveView(harness);
			harness.setResponses(
				Array.from({ length: 4 }, () =>
					fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider stopped with: MALFORMED_FUNCTION_CALL",
					}),
				),
			);

			await harness.session.prompt("hello");
			await harness.session.waitForIdle();

			const rendered = view.text();
			const normalized = rendered.replace(/\s+/g, " ");
			expect(rendered.match(/Error: Provider stopped with:/g) ?? []).toHaveLength(1);
			expect(normalized).toContain("Error: Provider stopped with: MALFORMED_FUNCTION_CALL");
			expect(normalized).toContain(
				"Error: Retry failed after 3 attempts: Provider stopped with: MALFORMED_FUNCTION_CALL",
			);
		} finally {
			harness.cleanup();
		}
	});

	test("keeps the error row above the cancellation notice when retry backoff is aborted via Escape", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 5000, maxAgentDelayMs: 5000 } },
		});
		try {
			const view = await createTestInteractiveView(harness);
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stopped with: MALFORMED_FUNCTION_CALL",
				}),
			]);
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start" && event.attempt === 1) {
					queueMicrotask(() => view.view.defaultEditor.onEscape?.());
				}
			});

			await harness.session.prompt("hello");
			await harness.session.waitForIdle();

			const rendered = view.text();
			expect(rendered.match(/MALFORMED_FUNCTION_CALL/g) ?? []).toHaveLength(1);
			expect(rendered).toContain("Retry failed after 1 attempts: Retry cancelled");
		} finally {
			harness.cleanup();
		}
	});

	test("removes superseded retried error rows in compact view", async () => {
		const harness = await createHarness({
			settings: {
				compactView: true,
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 5 },
			},
		});
		try {
			const view = await createTestInteractiveView(harness);
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stopped with: MALFORMED_FUNCTION_CALL",
				}),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stopped with: MALFORMED_FUNCTION_CALL",
				}),
				fauxAssistantMessage("Recovered compact response"),
			]);

			await harness.session.prompt("hello");
			await harness.session.waitForIdle();

			const rendered = view.text();
			expect(rendered).not.toContain("MALFORMED_FUNCTION_CALL");
			expect(rendered).toContain("Recovered compact response");
		} finally {
			harness.cleanup();
		}
	});
});
