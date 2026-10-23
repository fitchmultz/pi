// Native Node child fixture: fatal timer throws must not reach Vitest's process.
import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { ChatContainer } from "../../src/modes/interactive/components/activity.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../../src/modes/interactive/tui-renderer.ts";

const [columns, item, operation, tuiMode, logDirectory] = process.argv.slice(2);
initTheme("dark", false);
const terminal = new VirtualTerminal(Number(columns), 8);
const renderer = createInteractiveTui({ tuiMode, terminal, showHardwareCursor: false, logDirectory });
const chat = new ChatContainer();
chat.setCompactView(false);
const assistantMessage = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-responses",
	provider: "openai",
	model: "offline-fixture",
	usage: {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
});
chat.addChild(new UserMessageComponent("narrow msg"));
const tool = new ToolExecutionComponent(
	"fixture", "narrow-tool", {}, {},
	{ renderCall: () => new Text("tool", 0, 0), renderResult: () => new Text("done", 0, 0) },
	renderer, process.cwd(),
);
tool.markExecutionStarted();
tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
chat.addChild(tool);
// Preserve the real assistant's default outputPad=1, including semantic markers.
const assistant = new AssistantMessageComponent(assistantMessage("start"));
chat.addChild(assistant);
renderer.addChild(chat);
renderer.start();
try {
	await terminal.waitForRender();
	console.log("initial frame settled");
	const nextMessage = assistantMessage(`- ${item}\n  - ${item}\n    - ${item}`);
	if (operation === "update") assistant.updateContent(nextMessage, true);
	else if (operation === "append") chat.addChild(new AssistantMessageComponent(nextMessage));
	else throw new Error(`Unknown operation: ${operation}`);
	renderer.requestRender();
	await terminal.waitForRender();
	assert.ok(terminal.getScrollBuffer().join("\n").includes(item), "updated content reached the terminal");
	console.log("narrow renderer lifecycle completed");
} finally {
	renderer.stop();
}
