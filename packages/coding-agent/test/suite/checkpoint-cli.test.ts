import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { writeSessionCheckpoint } from "../../src/core/checkpoint.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { main } from "../../src/main.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import type * as TuiRenderer from "../../src/modes/interactive/tui-renderer.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("../../src/utils/tools-manager.ts", () => ({ ensureTool: async () => undefined }));
vi.mock("../../src/modes/interactive/tui-renderer.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof TuiRenderer>();
	return {
		...actual,
		createInteractiveTui: (options: Parameters<typeof actual.createInteractiveTui>[0]) =>
			actual.createInteractiveTui({ ...options, terminal: new VirtualTerminal(120, 40) }),
	};
});

const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("cold --checkpoint builds a fresh native TUI on the exact branch with accepted queues and no replay", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-cold-checkpoint-"));
	directories.push(directory);
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("PI_CHECKPOINT_SOCKET", "");
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_EXPERIMENTAL", "");
	vi.stubEnv("PI_MANAGED_CLI", "");
	const h = await createHarness({ sessionManager: SessionManager.create(directory, join(directory, "sessions")) });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("Which implementation should I use?")]);
	await h.session.prompt("Complete a task and ask a textual question");
	const selected = h.sessionManager.getLeafId();
	h.sessionManager.appendMessage(fauxAssistantMessage("unselected branch"));
	h.sessionManager.branch(selected!);
	await h.session.steer("accepted steering");
	await h.session.followUp("accepted follow-up");
	await h.session.sendCustomMessage(
		{ customType: "next", content: "persisted next-turn", display: true },
		{ deliverAs: "nextTurn" },
	);
	const hold = await h.session.acquireCheckpoint();
	const checkpoint = hold.checkpoint;
	const artifact = join(directory, "checkpoint.json");
	writeSessionCheckpoint(artifact, checkpoint);
	hold.release();
	h.session.dispose();
	const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	let reopened = false;
	vi.spyOn(InteractiveMode.prototype, "run").mockImplementation(async function (this: InteractiveMode) {
		await this.init();
		const view = this as unknown as {
			runtimeHost: AgentSessionRuntime;
			renderer: ReturnType<typeof TuiRenderer.createInteractiveTui>;
		};
		const session = view.runtimeHost.session;
		try {
			expect(session).not.toBe(h.session);
			expect(session.sessionId).toBe(checkpoint.selection.sessionId);
			expect(session.sessionManager.getLeafId()).toBe(selected);
			expect(session.getCheckpointQueues()).toEqual(checkpoint.queues);
			const terminal = view.renderer.terminal as VirtualTerminal;
			await terminal.waitForRender();
			const screen = terminal.getViewport().join("\n");
			expect(screen).toContain("Which implementation should I use?");
			expect(screen).not.toContain("unselected branch");
			expect(screen).toContain("Steering: accepted steering");
			expect(screen).toContain("Follow-up: accepted follow-up");
			expect(screen).toContain("Next-turn context: 1");
			expect(h.faux.state.callCount).toBe(1);
			const restoredHold = await session.acquireCheckpoint({
				boundary: "turn",
				quiesce: () => this.quiesceForCheckpoint(),
			});
			expect(restoredHold.sleepReady).toBe(true);
			expect(restoredHold.checkpoint.boundary).toBe("settled");
			restoredHold.release();
			reopened = true;
		} finally {
			this.stop("resume-hint");
			await view.runtimeHost.dispose();
		}
	});
	try {
		await main(["--checkpoint", artifact, "--offline", "-ne", "-ns", "-np", "--no-themes", "--no-approve"], {
			extensionFactories: [
				(pi) =>
					pi.registerProvider(h.getModel().provider, {
						baseUrl: h.getModel().baseUrl,
						apiKey: "faux-only",
						api: h.faux.api,
						models: h.models.map((model) => ({ ...model })),
					}),
			],
		});
		expect(reopened).toBe(true);
	} finally {
		if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	}
});
