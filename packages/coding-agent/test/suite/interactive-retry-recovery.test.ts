import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createInteractiveTui, InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./harness.ts";

it.each([true, false])(
	"keeps completed tools and replaces only failed attempts (retry enabled: %s)",
	async (enabled) => {
		const runs: string[] = [];
		const parameters = Type.Object({ value: Type.String() });
		const echo: AgentTool<typeof parameters> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters,
			async execute(_id, args) {
				runs.push(args.value);
				return { content: [{ type: "text", text: `completed:${args.value}` }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [echo],
			settings: { compaction: { enabled: false }, retry: { enabled, maxRetries: 2, baseDelayMs: 0 } },
		});
		onTestFinished(() => harness.cleanup());
		initTheme("dark");
		const mode = new InteractiveMode({
			session: harness.session,
			setBeforeSessionInvalidate() {},
			setRebindSession() {},
		} as unknown as AgentSessionRuntime);
		const view = mode as unknown as {
			renderer: ReturnType<typeof createInteractiveTui>;
			isInitialized: boolean;
			chatContainer: Container;
			subscribeToAgent(): void;
			rebuildChatFromMessages(): void;
		};
		view.renderer = createInteractiveTui({
			tuiMode: "regular",
			terminal: new VirtualTerminal(120, 40),
			showHardwareCursor: false,
			logDirectory: harness.tempDir,
		});
		view.isInitialized = true;
		view.subscribeToAgent();
		onTestFinished(() => mode.stop("resume-hint"));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { value: "original" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[{ type: "text", text: "discarded partial answer" }, fauxToolCall("echo", { value: "unfinished" })],
				{ stopReason: "error", errorMessage: "WebSocket closed 1006" },
			),
			fauxAssistantMessage("recovered final answer"),
		]);
		await harness.session.prompt("test recovery");
		const rendered = stripAnsi(view.chatContainer.render(120).join("\n"));
		expect(runs).toEqual(["original"]);
		expect(rendered).toContain("completed:original");
		if (enabled) {
			expect(rendered).toContain("recovered final answer");
			expect(rendered).not.toContain("discarded partial answer");
			expect(rendered).not.toContain("unfinished");
			expect(rendered).not.toContain("WebSocket closed");
		} else {
			expect(rendered).toContain("discarded partial answer");
			expect(rendered).toContain("WebSocket closed 1006");
		}
		view.rebuildChatFromMessages();
		const rebuilt = stripAnsi(view.chatContainer.render(120).join("\n"));
		expect(rebuilt).toContain("completed:original");
		if (enabled) {
			expect(rebuilt).toContain("recovered final answer");
			expect(rebuilt).not.toContain("discarded partial answer");
			expect(rebuilt).not.toContain("unfinished");
			expect(rebuilt).not.toContain("WebSocket closed");
		} else {
			expect(rebuilt).toContain("WebSocket closed 1006");
		}
		// UI cleanup must not erase diagnostic evidence from session history.
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toBe(true);
	},
);
