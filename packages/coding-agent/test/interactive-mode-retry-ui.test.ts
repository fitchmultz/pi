import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestInteractiveView } from "./suite/ui-harness.ts";

describe("InteractiveMode auto-retry error cleanup", () => {
	test("removes superseded retried error rows when a retry recovers, including across transcript rebuild and session resume", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-retry-ui-"));
		const sessionManager = SessionManager.create(sessionDir, sessionDir);
		const harness = await createHarness({
			sessionManager,
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

			expect(view.text()).not.toContain("MALFORMED_FUNCTION_CALL");
			expect(view.text()).toContain("Recovered response");

			// Rebuilding the transcript in-session (/settings -> rebuildChatFromMessages) keeps superseded error rows hidden.
			await view.submit("/settings");
			const selector = view.view.editorContainer.children[0] as SettingsSelectorComponent;
			selector.getSettingsList().selectItem("cache-miss-notices");
			selector.getSettingsList().handleInput("\r");
			selector.getSettingsList().handleInput("\x1b");
			expect(view.text()).not.toContain("MALFORMED_FUNCTION_CALL");
			expect(view.text()).toContain("Recovered response");

			// Resuming the saved session also hides the omitted error attempts while rendering the recovered reply.
			const sessionFile = sessionManager.getSessionFile()!;
			const resumedHarness = await createHarness({
				sessionManager: SessionManager.open(sessionFile, sessionDir),
			});
			try {
				const resumedView = await createTestInteractiveView(resumedHarness);
				(resumedView.view as unknown as { renderInitialMessages(): void }).renderInitialMessages();
				expect(resumedView.text()).not.toContain("MALFORMED_FUNCTION_CALL");
				expect(resumedView.text()).toContain("Recovered response");
			} finally {
				resumedHarness.cleanup();
			}
		} finally {
			harness.cleanup();
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	test("keeps a single final error row plus the retry-failed summary when retries exhaust, and one error row after rebuild", async () => {
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

			// Rebuilding the transcript keeps only the final non-omitted error attempt (not superseded attempts 1..3).
			await view.submit("/settings");
			const selector = view.view.editorContainer.children[0] as SettingsSelectorComponent;
			selector.getSettingsList().selectItem("cache-miss-notices");
			selector.getSettingsList().handleInput("\r");
			selector.getSettingsList().handleInput("\x1b");
			expect(view.text().match(/Error: Provider stopped with:/g) ?? []).toHaveLength(1);
			expect(view.text()).toContain("MALFORMED_FUNCTION_CALL");
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
