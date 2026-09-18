import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { RESTART_SOCKET_ENV, requestRestart } from "../../src/cli/restart-protocol.ts";
import { createRestartControl } from "../../src/cli/restart-worker.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { prepareCheckpointExit, readSessionCheckpoint, writeSessionCheckpoint } from "../../src/core/checkpoint.ts";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
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
			actual.createInteractiveTui({ ...options, terminal: options.terminal ?? new VirtualTerminal(120, 40) }),
	};
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type ExitView = {
	runtimeHost: AgentSessionRuntime;
	renderer: ReturnType<typeof TuiRenderer.createInteractiveTui>;
	shutdown(options?: { fromSignal?: boolean; fromExtension?: boolean }): Promise<void>;
	emergencyTerminalExit(): never;
	uncaughtCrash(error: Error): never;
};
const modes: InteractiveMode[] = [];
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const mode of modes.splice(0)) mode.stop("resume-hint");
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function setup(
	options: {
		extensions?: InlineExtension[];
		enabled?: boolean;
		onShutdownRequested?: (source: "user" | "extension" | "signal") => void;
	} = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "pi-exit-"));
	directories.push(directory);
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_CHECKPOINT_SOCKET", "");
	vi.stubEnv("PI_CHECKPOINT_EXIT_PATH", "");
	vi.stubEnv("PI_MANAGED_CLI", "");
	vi.stubEnv("PI_EXPERIMENTAL", "");
	vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	const exits: number[] = [];
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exits.push(Number(code ?? 0));
		return undefined as never;
	});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const settingsManager = SettingsManager.create(directory, directory, { projectTrusted: false });
	settingsManager.setQuietStartup(true);
	settingsManager.setCompactionEnabled(false);
	settingsManager.setRetryEnabled(false);
	const h = await createHarness({
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		settingsManager,
		models: [{ id: "first" }, { id: "second" }],
		extensionFactories: options.extensions,
	});
	harnesses.push(h);
	const runtime = new AgentSessionRuntime(
		h.session,
		{
			cwd: h.tempDir,
			agentDir: directory,
			modelRuntime: h.session.modelRuntime,
			settingsManager,
			resourceLoader: h.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("No session replacement during exit");
		},
	);
	const path = join(directory, "exit.json");
	const terminal = new VirtualTerminal(120, 40);
	const mode = new InteractiveMode(runtime, {
		terminal,
		onShutdownRequested: options.onShutdownRequested,
		writeExitCheckpoint: options.enabled === false ? undefined : prepareCheckpointExit(path),
	});
	modes.push(mode);
	await mode.init();
	return { h, directory, path, mode, view: mode as unknown as ExitView, terminal, exits, errors };
}

async function quit(f: Awaited<ReturnType<typeof setup>>, key: "quit" | "ctrl-d" = "quit") {
	if (key === "quit") {
		f.terminal.sendInput("/quit");
		f.terminal.sendInput("\r");
	} else f.terminal.sendInput("\x04");
	await vi.waitFor(() => expect(f.exits.length).toBeGreaterThan(0));
}

describe("native deliberate clean-exit checkpoint", () => {
	it.each(["quit", "ctrl-d"] as const)(
		"%s preserves exact non-tail branch, accepted queues, settings and persisted extension files",
		async (key) => {
			let extensionFile = "";
			const f = await setup({
				extensions: [
					(pi) => {
						pi.on("session_start", () => pi.appendEntry("supported-state", { restored: true }));
						pi.on("session_shutdown", async () => {
							await Promise.resolve();
							writeFileSync(extensionFile, "complete shutdown state");
						});
					},
				],
			});
			extensionFile = join(f.directory, "extension.json");
			f.h.setResponses([fauxAssistantMessage("Which approach should I use?")]);
			await f.h.session.prompt("Finish naturally");
			const selected = f.h.sessionManager.getLeafId();
			f.h.sessionManager.appendMessage(fauxAssistantMessage("unselected branch"));
			f.h.sessionManager.branch(selected!);
			f.h.session.setScopedModels([{ model: f.h.getModel("second")!, thinkingLevel: "off" }]);
			await f.h.session.steer("accepted steering");
			await f.h.session.followUp("accepted follow-up");
			await f.h.session.sendCustomMessage(
				{ customType: "next", content: "accepted context", display: true },
				{ deliverAs: "nextTurn" },
			);
			f.h.settingsManager.setTheme("light");
			const queues = f.h.session.getCheckpointQueues();
			await quit(f, key);
			expect(f.exits).toEqual([0]);
			expect(f.errors).not.toHaveBeenCalled();
			const saved = readSessionCheckpoint(f.path);
			expect(saved).toMatchObject({
				completedExit: { pid: process.pid },
				version: 1,
				boundary: "settled",
				settled: true,
			});
			expect(saved.selection.leafId).toBe(selected);
			expect(saved.selection.leafId).not.toBe(saved.entries.at(-1)?.id);
			expect(saved.queues).toEqual(queues);
			expect(saved.scopedModels?.map((scope) => scope.id)).toEqual(["second"]);
			expect(JSON.stringify(saved.entries)).toContain("supported-state");
			expect(readFileSync(extensionFile, "utf8")).toBe("complete shutdown state");
			expect(JSON.parse(readFileSync(join(f.directory, "settings.json"), "utf8"))).toMatchObject({ theme: "light" });
			expect(statSync(f.path).mode & 0o777).toBe(0o600);

			// The actual CLI loads the same final path BEFORE clearing old proof, into a fresh runtime/TUI.
			vi.stubEnv("PI_CHECKPOINT_EXIT_PATH", f.path);
			const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
			const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			let restored = false;
			vi.spyOn(InteractiveMode.prototype, "run").mockImplementation(async function (this: InteractiveMode) {
				await this.init();
				const view = this as unknown as ExitView;
				const session = view.runtimeHost.session;
				try {
					expect(readSessionCheckpoint(f.path).completedExit).toBeUndefined();
					expect(session).not.toBe(f.h.session);
					expect(session.sessionId).toBe(saved.selection.sessionId);
					expect(session.sessionManager.getLeafId()).toBe(selected);
					expect(session.getCheckpointQueues()).toEqual(queues);
					expect(session.scopedModels.map((scope) => scope.model.id)).toEqual(["second"]);
					expect(session.settingsManager.getTheme()).toBe("light");
					const terminal = view.renderer.terminal as VirtualTerminal;
					await terminal.waitForRender();
					const screen = terminal.getViewport().join("\n");
					expect(screen).toContain("Which approach should I use?");
					expect(screen).not.toContain("unselected branch");
					expect(screen).toContain("Steering: accepted steering");
					expect(screen).toContain("Follow-up: accepted follow-up");
					expect(f.h.faux.state.callCount).toBe(1);
					restored = true;
				} finally {
					this.stop("resume-hint");
					await view.runtimeHost.dispose();
				}
			});
			try {
				await main(["--checkpoint", f.path, "--offline", "-ne", "-ns", "-np", "--no-themes", "--no-approve"], {
					extensionFactories: [
						(pi) =>
							pi.registerProvider(f.h.getModel().provider, {
								baseUrl: f.h.getModel().baseUrl,
								apiKey: "faux-only",
								api: f.h.faux.api,
								models: f.h.models.map((model) => ({ ...model })),
							}),
					],
				});
				expect(restored).toBe(true);
				expect(readSessionCheckpoint(f.path).completedExit).toBeUndefined(); // Loop return is not clean-exit proof.
			} finally {
				if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
				else Reflect.deleteProperty(process.stdin, "isTTY");
				if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
				else Reflect.deleteProperty(process.stdout, "isTTY");
			}
		},
	);

	it("waits for a delayed session_shutdown entry/file before publishing", async () => {
		const entered = deferred();
		const finish = deferred();
		let file = "";
		const f = await setup({
			extensions: [
				(pi) => {
					pi.on("session_shutdown", async () => {
						entered.resolve();
						await finish.promise;
						writeFileSync(file, "shutdown complete");
						pi.appendEntry("shutdown-tail", { complete: true });
					});
				},
			],
		});
		file = join(f.directory, "late.json");
		const closing = f.view.shutdown();
		await entered.promise;
		expect(existsSync(f.path)).toBe(false);
		expect(f.exits).toEqual([]);
		finish.resolve();
		await closing;
		expect(f.exits).toEqual([0]);
		expect(readFileSync(file, "utf8")).toBe("shutdown complete");
		expect(JSON.stringify(readSessionCheckpoint(f.path).entries)).toContain("shutdown-tail");
	});

	it("cancels active native work, joins its final recording, and preserves remaining accepted queues", async () => {
		const entered = deferred();
		const f = await setup();
		f.h.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("Cancelled by deliberate exit")),
						{ once: true },
					);
					entered.resolve();
				}),
		]);
		const running = f.h.session.prompt("Work");
		await entered.promise;
		await f.h.session.followUp("still accepted");
		await f.view.shutdown();
		await running;
		expect(f.exits).toEqual([0]);
		const saved = readSessionCheckpoint(f.path);
		expect(saved.queues.followUp).toHaveLength(1);
		expect(saved.entries).toEqual(f.h.sessionManager.getEntries());
		expect(f.h.faux.state.callCount).toBe(1);
	});

	it("joins a native command continuation released by session_shutdown cleanup", async () => {
		const entered = deferred();
		const finish = deferred();
		const f = await setup({
			extensions: [
				(pi) => {
					pi.registerCommand("held", {
						handler: async () => {
							entered.resolve();
							await finish.promise;
							pi.appendEntry("command-final", { complete: true });
						},
					});
					pi.on("session_shutdown", () => {
						finish.resolve();
					});
				},
			],
		});
		const running = f.h.session.prompt("/held");
		await entered.promise;
		await f.view.shutdown();
		await running;
		expect(f.exits).toEqual([0]);
		expect(JSON.stringify(readSessionCheckpoint(f.path).entries)).toContain("command-final");
	});

	it("waits for independent Bash cancellation and its native result recording", async () => {
		const entered = deferred();
		const finish = deferred();
		const f = await setup({
			extensions: [
				(pi) => {
					pi.on("user_bash", async () => {
						entered.resolve();
						await finish.promise;
						return { result: { output: "intercepted", exitCode: 0, cancelled: false, truncated: false } };
					});
				},
			],
		});
		const running = f.h.session.executeBash("intercepted command");
		await entered.promise;
		const closing = f.view.shutdown();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.exits).toEqual([]);
		expect(existsSync(f.path)).toBe(false);
		finish.resolve();
		await running;
		await closing;
		expect(f.exits).toEqual([0]);
		expect(readSessionCheckpoint(f.path).entries).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ role: "bashExecution", cancelled: true }),
			}),
		);
	});

	it("does not publish completed proof when the atomic artifact write fails", async () => {
		const f = await setup();
		mkdirSync(f.path);
		await f.view.shutdown();
		expect(f.exits).toEqual([1]);
		expect(() => readSessionCheckpoint(f.path)).toThrow();
		expect(f.errors).toHaveBeenCalledWith(expect.stringContaining("Clean-exit checkpoint failed"));
	});

	it.each(["extension", "settings", "credentials"])("fails closed on %s persistence errors", async (failure) => {
		const f = await setup({
			extensions:
				failure === "extension"
					? [
							(pi) => {
								pi.on("session_shutdown", () => {
									throw new Error("shutdown disk full");
								});
							},
						]
					: [],
		});
		if (failure === "settings")
			vi.spyOn(f.h.settingsManager, "drainErrors").mockReturnValue([
				{ scope: "global", error: new Error("settings disk full") },
			]);
		if (failure === "credentials") {
			vi.spyOn(f.h.authStorage, "delete").mockRejectedValue(new Error("credentials disk full"));
			await expect(f.h.session.modelRuntime.logout(f.h.getModel().provider)).rejects.toThrow();
		}
		await f.view.shutdown();
		expect(f.exits).toEqual([1]);
		expect(existsSync(f.path)).toBe(false);
		expect(f.errors).toHaveBeenCalledWith(expect.stringContaining("Clean-exit checkpoint failed"));
	});

	it.each(["command", "question"])(
		"does not publish when a %s callback cannot finish within the exit cleanup budget",
		async (kind) => {
			const entered = deferred();
			const finish = deferred();
			const f = await setup({
				extensions: [
					(pi) =>
						pi.registerCommand("held", {
							handler: async () => {
								entered.resolve();
								await finish.promise;
							},
						}),
				],
			});
			const dialogController = new AbortController();
			const running =
				kind === "command"
					? f.h.session.prompt("/held")
					: f.mode.getExtensionUIContext().input("Live question", undefined, { signal: dialogController.signal });
			if (kind === "command") await entered.promise;
			vi.useFakeTimers();
			const closing = f.view.shutdown();
			await vi.advanceTimersByTimeAsync(0);
			expect(f.exits).toEqual([]);
			expect(existsSync(f.path)).toBe(false);
			await vi.advanceTimersByTimeAsync(30_000);
			await closing;
			expect(f.exits).toEqual([1]);
			expect(existsSync(f.path)).toBe(false);
			finish.resolve();
			dialogController.abort();
			await running;
			expect(existsSync(f.path)).toBe(false);
		},
	);

	it.each(["signal", "extension", "crash", "terminal"])(
		"never mints a normal-exit artifact for %s exit",
		async (kind) => {
			const f = await setup();
			if (kind === "crash") f.view.uncaughtCrash(new Error("crash"));
			else if (kind === "terminal") f.view.emergencyTerminalExit();
			else await f.view.shutdown(kind === "signal" ? { fromSignal: true } : { fromExtension: true });
			expect(existsSync(f.path)).toBe(false);
		},
	);

	it("keeps ordinary unset-option shutdown behavior, including reported extension errors", async () => {
		const f = await setup({
			enabled: false,
			extensions: [
				(pi) => {
					pi.on("session_shutdown", () => {
						throw new Error("ordinary extension error");
					});
				},
			],
		});
		await quit(f);
		expect(f.exits).toEqual([0]);
		expect(existsSync(f.path)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"does not publish clean proof for the actual managed-restart shutdown route",
		async () => {
			const sent: string[] = [];
			const control = createRestartControl({
				args: [],
				send: async (message) => {
					sent.push(message.type);
				},
			});
			const f = await setup({ extensions: [control.extension], onShutdownRequested: control.shutdownRequested });
			f.h.sessionManager.appendMessage(fauxAssistantMessage("saved"));
			await control.ready();
			await requestRestart(process.env[RESTART_SOCKET_ENV]!, {});
			await vi.waitFor(() => expect(f.exits).toEqual([0]));
			expect(sent).toContain("pi:restart");
			expect(existsSync(f.path)).toBe(false);
		},
	);

	it.each(["UI", "catalog"])(
		"late native %s activity during final flush cannot mint completed proof",
		async (kind) => {
			const f = await setup();
			const entered = deferred();
			const finish = deferred();
			const flush = f.h.settingsManager.flush.bind(f.h.settingsManager);
			vi.spyOn(f.h.settingsManager, "flush").mockImplementation(async () => {
				entered.resolve();
				await finish.promise;
				await flush();
			});
			const ui = f.mode.getExtensionUIContext();
			const closing = f.view.shutdown();
			await entered.promise;
			if (kind === "UI") ui.setEditorText("late draft");
			else await f.h.session.modelRuntime.refresh({ allowNetwork: false });
			finish.resolve();
			await closing;
			expect(f.exits).toEqual([1]);
			expect(existsSync(f.path)).toBe(false);
		},
	);

	it("clears stale proof even if a different cold restore input fails", async () => {
		const f = await setup();
		const hold = await f.h.session.acquireCheckpoint();
		writeSessionCheckpoint(f.path, { ...hold.checkpoint, completedExit: { pid: 1234 } });
		hold.release();
		vi.stubEnv("PI_CHECKPOINT_EXIT_PATH", f.path);
		await expect(main(["--checkpoint", join(f.directory, "missing.json")])).rejects.toThrow();
		expect(readSessionCheckpoint(f.path).completedExit).toBeUndefined();
	});

	it("a signal racing with deliberate shutdown suppresses completed proof", async () => {
		const entered = deferred();
		const finish = deferred();
		const f = await setup({
			extensions: [
				(pi) => {
					pi.on("session_shutdown", async () => {
						entered.resolve();
						await finish.promise;
					});
				},
			],
		});
		const closing = f.view.shutdown();
		await entered.promise;
		await f.view.shutdown({ fromSignal: true });
		finish.resolve();
		await closing;
		expect(f.exits).toEqual([1]);
		expect(existsSync(f.path)).toBe(false);
	});

	it("validates the exit path without removing unrelated data", async () => {
		const f = await setup();
		expect(() => prepareCheckpointExit("relative.json")).toThrow("absolute");
		const file = join(f.directory, "unrelated.json");
		writeFileSync(file, '{"important":true}');
		expect(() => prepareCheckpointExit(file)).toThrow();
		expect(readFileSync(file, "utf8")).toBe('{"important":true}');
	});
});
