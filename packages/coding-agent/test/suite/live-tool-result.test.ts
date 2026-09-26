import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const workTool: AgentTool = {
	name: "work",
	label: "Work",
	description: "Return saved output",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "saved output" }], details: {} }),
};

it("offers live_tool_result content for live continuations without changing the saved result", async () => {
	let harness: Harness | undefined;
	let savedBeforeHook: boolean | undefined;
	let liveContent: ToolResultMessage["content"] | undefined;
	harness = await createHarness({
		tools: [workTool],
		extensionFactories: [
			(pi) => {
				pi.on("live_tool_result", ({ message }, ctx) => {
					savedBeforeHook = ctx.sessionManager
						.getEntries()
						.some((entry) => entry.type === "message" && entry.message === message);
					return { content: [...message.content, { type: "text", text: "live note" }] };
				});
				pi.on("live_tool_result", ({ message }) => ({
					content: [...message.content, { type: "text", text: "second note" }],
				}));
				pi.on("turn_end", ({ toolResults }) => {
					if (toolResults[0]) liveContent = harness?.session.agent.toolResultModelContent?.(toolResults[0]);
				});
			},
		],
	});
	onTestFinished(() => harness?.cleanup());
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("work", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("work");

	expect(savedBeforeHook).toBe(true);
	expect(liveContent).toEqual([
		{ type: "text", text: "saved output" },
		{ type: "text", text: "live note" },
		{ type: "text", text: "second note" },
	]);
	const saved = harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
	expect(saved.map((message) => message.content)).toEqual([[{ type: "text", text: "saved output" }]]);
	expect(harness.session.agent.toolResultModelContent?.(saved[0]!)).toBeUndefined();
});
