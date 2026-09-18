import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { createAgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("../../src/utils/tools-manager.ts", () => ({ ensureTool: async () => undefined }));
const modes: InteractiveMode[] = [];
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const mode of modes.splice(0)) mode.stop("resume-hint");
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function setup() {
	vi.stubEnv("PI_OFFLINE", "1");
	vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
	const pause = vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	const resume = vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	initTheme("dark");
	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-ui-"));
	directories.push(directory);
	const h = await createHarness({
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		settings: { quietStartup: true },
	});
	harnesses.push(h);
	const runtime = await createAgentSessionRuntime(
		async () => ({
			session: h.session,
			extensionsResult: h.session.resourceLoader.getExtensions(),
			services: {
				cwd: h.tempDir,
				agentDir: directory,
				modelRuntime: h.session.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		}),
		{ cwd: h.tempDir, agentDir: directory, sessionManager: h.sessionManager },
	);
	const terminal = new VirtualTerminal(100, 30);
	const mode = new InteractiveMode(runtime, { terminal });
	modes.push(mode);
	await mode.init();
	return { h, mode, terminal, pause, resume };
}

describe("native checkpoint TUI boundary", () => {
	it("holds native input and retains restored pending display without replacing the TUI", async () => {
		const f = await setup();
		await f.h.session.steer("visible accepted steering");
		await f.h.session.sendCustomMessage(
			{ customType: "next", content: "retained", display: true },
			{ deliverAs: "nextTurn" },
		);
		f.mode.renderInitialMessages();
		await f.terminal.waitForRender();
		const screen = f.terminal.getViewport().join("\n");
		expect(screen).toContain("Steering: visible accepted steering");
		expect(screen).toContain("Next-turn context: 1");
		const hold = await f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() });
		expect(f.pause).toHaveBeenCalled();
		expect(hold.checkpoint.queues.steering).toHaveLength(1);
		hold.release();
		expect(f.resume).toHaveBeenCalled();
		expect(f.h.session.getSteeringMessages()).toEqual(["visible accepted steering"]);
	});

	it("invalidates a cut before a previously decoded key reaches extension input listeners", async () => {
		const f = await setup();
		const observations: boolean[] = [];
		f.mode.getExtensionUIContext().onTerminalInput(() => {
			observations.push(f.h.session.isCheckpointHeld);
			return undefined;
		});
		const hold = await f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() });
		f.terminal.sendInput("x");
		expect(hold.signal.aborted).toBe(true);
		expect(observations).toEqual([false]);
		expect(f.mode.getExtensionUIContext().getEditorText()).toBe("x");
	});

	it("rejects real extension dialogs and draft image paths rather than losing their callbacks/files", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const controller = new AbortController();
		const dialog = ui.input("Live question", undefined, { signal: controller.signal });
		await expect(f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() })).rejects.toThrow(
			"live UI",
		);
		expect(f.h.session.isCheckpointHeld).toBe(false);
		controller.abort();
		await dialog;
		ui.setEditorText("/tmp/pi-clipboard-unsubmitted.png");
		await expect(f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() })).rejects.toThrow(
			"unsent draft",
		);
		expect(ui.getEditorText()).toBe("/tmp/pi-clipboard-unsubmitted.png");
	});
});
