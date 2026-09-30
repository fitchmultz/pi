import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { MANAGED_CLI_ENV, RESTART_HANDOFF_ENV, type RestartHandoff } from "../../src/cli/restart-protocol.ts";
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

it.each(["standalone", "candidate", "fallback"] as const)(
	"cold %s builds a fresh native TUI on the exact branch with accepted queues and no replay",
	async (mode) => {
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
		const candidateJournal = join(directory, "converted.jsonl");
		const candidate = join(directory, "candidate.json");
		const rollback = join(directory, "rollback.mjs");
		const rollbackReceipt = join(directory, "rollback-receipt");
		copyFileSync(checkpoint.selection.sessionFile, candidateJournal);
		writeSessionCheckpoint(candidate, {
			...checkpoint,
			selection: { ...checkpoint.selection, sessionFile: candidateJournal },
		});
		writeFileSync(
			rollback,
			`import { writeFileSync } from "node:fs";
if (process.argv[2] !== "rollback") throw new Error("Conversion must never run on cold fallback");
writeFileSync(${JSON.stringify(rollbackReceipt)}, "prior artifacts restored");
`,
		);
		const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
		const handoff: RestartHandoff = {
			checkpoint: {
				...checkpoint.selection,
				files: {
					original: { path: artifact, sha256: hash(artifact) },
					candidate: { path: candidate, sha256: hash(candidate) },
					rollback,
				},
			},
			...(mode === "fallback" ? { failure: "candidate failed" } : {}),
		};
		const originalBytes = readFileSync(artifact);
		const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
		const connectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected");
		const disconnectListeners = process.listeners("disconnect");
		if (mode !== "standalone") {
			Object.defineProperty(process, "connected", { value: true, configurable: true });
			Object.defineProperty(process, "send", {
				value: (_message: unknown, callback: (error: Error | null) => void) => callback(null),
				configurable: true,
			});
			vi.stubEnv(MANAGED_CLI_ENV, "1");
			vi.stubEnv(RESTART_HANDOFF_ENV, JSON.stringify(handoff));
		}
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
				expect(session.sessionFile).toBe(
					mode === "candidate" ? candidateJournal : checkpoint.selection.sessionFile,
				);
				expect(session.getCheckpointQueues()).toEqual(checkpoint.queues);
				expect(session.getActiveToolNames()).toEqual(
					mode === "standalone"
						? checkpoint.selection.activeTools
						: [...checkpoint.selection.activeTools, "new_enabled"],
				);
				expect(readFileSync(artifact)).toEqual(originalBytes);
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
			await main(
				[
					...(mode === "standalone"
						? ["--checkpoint", artifact]
						: [
								"--session",
								checkpoint.selection.sessionFile,
								"--session-cwd",
								checkpoint.selection.cwd,
								"--provider",
								checkpoint.selection.model!.provider,
								"--model",
								`${checkpoint.selection.model!.provider}/${checkpoint.selection.model!.id}`,
								"--thinking",
								checkpoint.selection.thinkingLevel,
							]),
					"--offline",
					"-ne",
					"-ns",
					"-np",
					"--no-themes",
					"--no-approve",
				],
				{
					extensionFactories: [
						(pi) => {
							pi.registerProvider(h.getModel().provider, {
								baseUrl: h.getModel().baseUrl,
								apiKey: "faux-only",
								api: h.faux.api,
								models: h.models.map((model) => ({ ...model })),
							});
							pi.on("session_start", () => {
								if (mode === "fallback")
									expect(readFileSync(rollbackReceipt, "utf8")).toBe("prior artifacts restored");
								for (const name of ["new_enabled", "discovery_disabled", "new_inactive"])
									pi.registerTool({
										name,
										label: name,
										description: name,
										parameters: Type.Object({}),
										defaultActive: name !== "new_inactive",
										execute: async () => {
											throw new Error("No tool replay allowed");
										},
									});
							});
							pi.on("resources_discover", () => {
								pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "discovery_disabled"));
							});
						},
					],
				},
			);
			expect(reopened).toBe(true);
		} finally {
			if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
			else Reflect.deleteProperty(process, "send");
			if (connectedDescriptor) Object.defineProperty(process, "connected", connectedDescriptor);
			else Reflect.deleteProperty(process, "connected");
			for (const listener of process.listeners("disconnect"))
				if (!disconnectListeners.includes(listener)) process.off("disconnect", listener);
		}
	},
);

it.each(["journal", "checkpoint"] as const)(
	"later session replacement reports extension errors without exiting after %s startup",
	async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-replacement-"));
		directories.push(directory);
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		for (const name of ["PI_CHECKPOINT_SOCKET", "PI_CHECKPOINT_EXIT_PATH", "PI_MANAGED_CLI", "PI_EXPERIMENTAL"])
			vi.stubEnv(name, "");
		vi.stubEnv("PI_OFFLINE", "1");
		const h = await createHarness({ sessionManager: SessionManager.create(directory, join(directory, "sessions")) });
		harnesses.push(h);
		h.sessionManager.appendMessage(fauxAssistantMessage("existing history"));
		const hold = await h.session.acquireCheckpoint();
		const artifact = join(directory, "checkpoint.json");
		writeSessionCheckpoint(artifact, hold.checkpoint);
		hold.release();
		h.session.dispose();

		const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("Session replacement must not exit the application");
		});
		let extensionLoads = 0;
		let replaced = false;
		vi.spyOn(InteractiveMode.prototype, "run").mockImplementation(async function (this: InteractiveMode) {
			const runtime = (this as unknown as { runtimeHost: AgentSessionRuntime }).runtimeHost;
			runtime.setRebindSession(undefined);
			try {
				await runtime.newSession();
				expect(runtime.diagnostics).toContainEqual(
					expect.objectContaining({
						type: "error",
						message: expect.stringContaining("unrelated extension reload error"),
					}),
				);
				expect(exit).not.toHaveBeenCalled();
				replaced = true;
			} finally {
				this.stop("resume-hint");
				await runtime.dispose();
			}
		});
		try {
			await main(
				[
					...(mode === "checkpoint"
						? ["--checkpoint", artifact]
						: ["--session", h.sessionManager.getSessionFile()!]),
					"--offline",
					"-ne",
					"-ns",
					"-np",
					"--no-themes",
					"--no-approve",
				],
				{
					extensionFactories: [
						(pi) =>
							pi.registerProvider(h.getModel().provider, {
								baseUrl: h.getModel().baseUrl,
								apiKey: "faux-only",
								api: h.faux.api,
								models: h.models.map((model) => ({ ...model })),
							}),
						() => {
							if (++extensionLoads > 1) throw new Error("unrelated extension reload error");
						},
					],
				},
			);
			expect(replaced).toBe(true);
		} finally {
			if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	},
);
