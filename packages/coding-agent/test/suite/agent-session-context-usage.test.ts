import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession context usage estimate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("counts the system prompt and tool definitions before the model reports usage", async () => {
		const tool: AgentTool = {
			name: "lookup",
			label: "Lookup",
			description: "d".repeat(400),
			parameters: Type.Object({ query: Type.String({ description: "q".repeat(400) }) }),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		const systemPromptChars = harness.session.agent.state.systemPrompt.length;
		expect(systemPromptChars).toBeGreaterThan(1000);
		const before = harness.session.getContextUsage();
		// System prompt plus at least the 800 padded description characters of the tool schema.
		expect(before?.tokens).toBeGreaterThanOrEqual(Math.ceil(systemPromptChars / 4) + 200);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hi");

		const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		expect(reported).toBeGreaterThan(0);
		expect(harness.session.getContextUsage()?.tokens).toBe(reported);
	});

	it("does not reuse usage reported by a different model after a model switch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "big", contextWindow: 128_000 },
				{ id: "small", contextWindow: 8192 },
			],
		});
		harnesses.push(harness);
		const big = harness.getModel("big")!;
		harness.sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("ok"),
			provider: big.provider,
			model: big.id,
			usage: usage(7000),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		expect(harness.session.getContextUsage()).toMatchObject({ tokens: 7000, contextWindow: 128_000 });

		await harness.session.setModel(harness.getModel("small")!);

		const switched = harness.session.getContextUsage();
		expect(switched?.contextWindow).toBe(8192);
		expect(switched?.tokens).toBeGreaterThan(0);
		expect(switched?.tokens).toBeLessThan(7000);

		harness.setResponses([fauxAssistantMessage("small ok")]);
		await harness.session.prompt("again");

		const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		expect(harness.session.getContextUsage()?.tokens).toBe(reported);
	});
});
