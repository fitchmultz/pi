import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import { describe, expect, onTestFinished, test } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type HarnessOptions } from "../harness.ts";

const PAGE_UP = "\x1b[5~";
const PREVIOUS_PROMPT = "\x1b[1;5A";
const OPEN_SEARCH = "\x1b[70;6u";
const SCROLL_TO_TOP = "\x1b[1;5H";

async function harnessWith(options: HarnessOptions = {}) {
	const harness = await createHarness({
		...options,
		settings: {
			compaction: { enabled: false },
			retry: { enabled: false },
			quietStartup: true,
			...options.settings,
		},
	});
	onTestFinished(() => harness.cleanup());
	return harness;
}

function buildLongCompactedSession(cwd: string, totalTurns = 310): string {
	const sm = SessionManager.create(cwd);
	let keptId = "";
	for (let turn = 1; turn <= totalTurns; turn++) {
		const tag = String(turn).padStart(3, "0");
		const userId = sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Prompt marker ${tag}` }],
			timestamp: 1_700_000_000_000 + turn * 2,
		});
		if (turn === 140) {
			keptId = userId;
		}
		sm.appendMessage({
			...fauxAssistantMessage(`Reply marker ${tag}`),
			timestamp: 1_700_000_000_000 + turn * 2 + 1,
		});
		if (turn === 150) {
			sm.appendCompaction("Early history compacted summary", keptId, 42_000);
		}
	}
	return sm.getSessionFile()!;
}

async function openInteractiveSession(
	sessionFile: string,
	tuiMode: "fullscreen" | "regular",
	dimensions = { width: 90, height: 20 },
) {
	const harness = await harnessWith({
		sessionManager: SessionManager.open(sessionFile),
		settings: { quietStartup: true, tuiMode },
	});
	const terminal = new VirtualTerminal(dimensions.width, dimensions.height);
	const mode = new InteractiveMode(
		{
			session: harness.session,
			services: { agentDir: harness.tempDir },
			setBeforeSessionInvalidate() {},
			setRebindSession() {},
		} as unknown as AgentSessionRuntime,
		{ terminal, tuiMode },
	);
	await mode.init();
	onTestFinished(() => mode.stop("resume-hint"));
	await terminal.waitForRender();
	const internals = mode as unknown as {
		chatContainer: Container;
		defaultEditor: { handleInput(data: string): void; getText(): string };
		switchTuiMode(mode: "regular" | "fullscreen"): boolean;
	};
	return {
		mode,
		terminal,
		internals,
		chatText: () => stripAnsi(internals.chatContainer.render(dimensions.width).join("\n")),
		viewportText: () => stripAnsi(terminal.getViewport().join("\n")),
	};
}

describe("fullscreen progressive transcript hydration", () => {
	test("mounts only the recent window initially, keeps full editor history, and hydrates identically to full render", async () => {
		const seed = await harnessWith();
		const sessionFile = buildLongCompactedSession(seed.tempDir, 310);

		const regular = await openInteractiveSession(sessionFile, "regular");
		const fullRegularText = regular.chatText();
		expect(fullRegularText).toContain("Prompt marker 001");
		expect(fullRegularText).toContain("[compaction]");
		expect(fullRegularText).toContain("Prompt marker 150");
		expect(fullRegularText).toContain("Prompt marker 310");

		const fullscreen = await openInteractiveSession(sessionFile, "fullscreen");
		expect(fullscreen.internals.chatContainer.children.length).toBeLessThan(
			regular.internals.chatContainer.children.length / 2,
		);
		const initialMountedText = fullscreen.chatText();
		expect(initialMountedText).not.toContain("Prompt marker 001");
		expect(initialMountedText).not.toContain("[compaction]");
		expect(initialMountedText).not.toContain("Prompt marker 150");
		expect(initialMountedText).toContain("Prompt marker 310");
		expect(fullscreen.viewportText()).toContain("Reply marker 310");

		// Editor Up-arrow history still includes prompts from the entire branch, oldest to newest.
		fullscreen.internals.defaultEditor.handleInput("\x1b[A");
		expect(fullscreen.internals.defaultEditor.getText()).toBe("Prompt marker 310");

		// Progressive PageUp scrolling hydrates the middle chunk before the earliest chunk.
		for (let i = 0; i < 85; i++) {
			fullscreen.terminal.sendInput(PAGE_UP);
		}
		await fullscreen.terminal.waitForRender();
		const midHydratedText = fullscreen.chatText();
		expect(midHydratedText).toContain("[compaction]");
		expect(midHydratedText).toContain("Prompt marker 150");
		expect(midHydratedText).not.toContain("Prompt marker 001");

		// Jump-to-top hydrates the remainder and matches the non-windowed transcript byte-for-byte.
		fullscreen.terminal.sendInput(SCROLL_TO_TOP);
		await fullscreen.terminal.waitForRender();
		expect(fullscreen.viewportText()).toContain("Prompt marker 001");
		expect(fullscreen.chatText()).toBe(fullRegularText);
	});

	test("hydrates one older chunk on backward prompt jump and full history on search or regular mode switch", async () => {
		const seed = await harnessWith();
		const sessionFile = buildLongCompactedSession(seed.tempDir, 310);

		const promptNav = await openInteractiveSession(sessionFile, "fullscreen");
		// Walk backward across all user/assistant zones in the initial window into the preceding chunk.
		for (let i = 0; i < 260; i++) {
			promptNav.terminal.sendInput(PREVIOUS_PROMPT);
		}
		await promptNav.terminal.waitForRender();
		expect(promptNav.chatText()).toContain("Prompt marker 180");
		expect(promptNav.chatText()).not.toContain("Prompt marker 001");

		// Opening fullscreen transcript search materializes the full branch so earliest turns are searchable.
		const searchable = await openInteractiveSession(sessionFile, "fullscreen");
		expect(searchable.chatText()).not.toContain("Prompt marker 001");
		searchable.terminal.sendInput(OPEN_SEARCH);
		await searchable.terminal.waitForRender();
		searchable.terminal.sendInput("Prompt marker 001");
		await searchable.terminal.waitForRender();
		expect(searchable.viewportText()).toContain("Prompt marker 001");

		// Switching from fullscreen to regular mode also materializes the full branch.
		const switched = await openInteractiveSession(sessionFile, "fullscreen");
		expect(switched.chatText()).not.toContain("Prompt marker 001");
		expect(switched.internals.switchTuiMode("regular")).toBe(true);
		expect(switched.chatText()).toContain("Prompt marker 001");
	});

	test("never splits an assistant tool call from its toolResult when custom entries sit between them", async () => {
		const seed = await harnessWith();
		const sm = SessionManager.create(seed.tempDir);
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Long single-turn tool loop" }],
			timestamp: 1_700_000_000_000,
		});
		// Create 120 tool rounds in a single user turn (> 250 entries, > 64-entry lookback),
		// with a custom entry recorded between each assistant toolCall and its toolResult.
		for (let round = 1; round <= 120; round++) {
			const callId = `call_${round}`;
			sm.appendMessage({
				...fauxAssistantMessage([fauxToolCall("bash", { command: `echo round-${round}` }, { id: callId })], {
					stopReason: "toolUse",
				}),
				timestamp: 1_700_000_000_000 + round * 3,
			});
			sm.appendCustomEntry("mid-tool-audit", { round });
			sm.appendMessage({
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: `output-${round}` }],
				isError: false,
				timestamp: 1_700_000_000_000 + round * 3 + 1,
			});
		}

		const fullscreen = await openInteractiveSession(sm.getSessionFile()!, "fullscreen");
		expect(fullscreen.chatText()).not.toContain("No result provided");
		fullscreen.terminal.sendInput(SCROLL_TO_TOP);
		await fullscreen.terminal.waitForRender();
		expect(fullscreen.chatText()).not.toContain("No result provided");
		expect(fullscreen.chatText()).toContain("Long single-turn tool loop");
	});
});
