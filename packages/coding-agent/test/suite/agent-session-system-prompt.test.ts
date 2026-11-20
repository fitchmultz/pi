import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createHarness } from "./harness.ts";

describe("AgentSession system prompt host section", () => {
	test("records static <host> right after <cwd> and keeps it cache-stable across turns", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			await harness.session.prompt("one");
			await harness.session.prompt("two");

			const systemMessages = harness.session.messages.filter((message) => message.role === "system");
			expect(systemMessages).toHaveLength(1);

			const head = systemMessages[0];
			if (head?.role !== "system") throw new Error("expected leading system message");
			const keys = Object.keys(head.sections ?? {});
			expect(keys.indexOf("host")).toBe(keys.indexOf("cwd") + 1);
			expect(head.sections?.cwd).toBe(`<cwd>\n${harness.tempDir.replace(/\\/g, "/")}\n</cwd>`);
			expect(head.sections?.host).toContain(process.platform);
			expect(head.sections?.host).toContain(process.arch);
			expect(head.sections?.host).toContain(process.version);
		} finally {
			harness.cleanup();
		}
	});

	test("reports configured settings shellPath as basename only", async () => {
		const harness = await createHarness({
			settings: { shellPath: "/Users/private-user/custom-shells/zsh" },
		});
		try {
			expect(harness.session.systemPrompt).toContain("\nShell: zsh\n");
			expect(harness.session.systemPrompt).not.toContain("private-user");
			expect(harness.session.systemPrompt).not.toContain("custom-shells");
		} finally {
			harness.cleanup();
		}
	});
});
