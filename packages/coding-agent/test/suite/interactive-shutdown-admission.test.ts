import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createInteractiveTui, InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type ShutdownView = {
	renderer: ReturnType<typeof createInteractiveTui>;
	isInitialized: boolean;
	bindCurrentSessionExtensions(): Promise<void>;
	shutdown(options?: { fromSignal?: boolean; fromExtension?: boolean }): Promise<void>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class ProcessExitError extends Error {}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});

async function createShutdownView(harness: Harness) {
	initTheme("dark");
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("Shutdown must not replace the session");
		},
	);
	const mode = new InteractiveMode(runtime);
	const view = mode as unknown as ShutdownView;
	// Keep native shutdown, extension bindings and runtime disposal; replace only terminal I/O and process exit.
	view.renderer = createInteractiveTui({
		tuiMode: "regular",
		terminal: new VirtualTerminal(120, 40),
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
	});
	view.isInitialized = true;
	await view.bindCurrentSessionExtensions();
	view.renderer.start();
	cleanups.push(() => mode.stop("resume-hint"));
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw new ProcessExitError();
	});
	return view;
}

async function shutdown(view: ShutdownView, fromExtension: boolean): Promise<void> {
	try {
		await view.shutdown({ fromExtension });
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("native shutdown prompt admission", () => {
	it("saves shutdown state before aborting an active response", async () => {
		const requestEntered = deferred();
		const drainReleased = deferred();
		const order: string[] = [];
		let status = "active";
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (event.message.role === "assistant" && event.message.stopReason === "aborted") status = "paused";
					});
					pi.on("session_shutdown", () => {
						order.push("shutdown hook");
						pi.appendEntry("shutdown-state", { status });
					});
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		const view = await createShutdownView(harness);
		vi.spyOn(view.renderer.terminal, "drainInput").mockReturnValue(drainReleased.promise);
		harness.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							order.push("active response aborted");
							resolve(fauxAssistantMessage("Interrupted response"));
						},
						{ once: true },
					);
					requestEntered.resolve();
				}),
		]);
		const run = harness.session.prompt("Keep working");
		await requestEntered.promise;
		const closing = shutdown(view, false);
		let duringDrain: string[];
		try {
			await new Promise((resolve) => setImmediate(resolve));
			await expect(harness.session.compact()).rejects.toMatchObject({ name: "AbortError" });
			duringDrain = order.slice();
		} finally {
			drainReleased.resolve();
			await closing;
			await run;
		}
		expect(duringDrain).toEqual([]);
		expect(order).toEqual(["shutdown hook", "active response aborted"]);
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "shutdown-state", data: { status: "active" } }),
		);
	});

	// PR #30: request preparation can still be awaiting work after prompt admission has completed.
	it.each(["context", "message conversion", "request auth"] as const)(
		"stops pending %s without an assistant failure during shutdown",
		async (stage) => {
			const entered = deferred();
			const released = deferred();
			const drainReleased = deferred();
			const hold = async () => {
				entered.resolve();
				await released.promise;
			};
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						if (stage === "context") pi.on("context", hold);
					},
				],
			});
			cleanups.push(() => harness.cleanup());
			const view = await createShutdownView(harness);
			vi.spyOn(view.renderer.terminal, "drainInput").mockReturnValue(drainReleased.promise);
			if (stage === "message conversion") {
				const convert = harness.session.agent.convertToLlm;
				harness.session.agent.convertToLlm = async (messages) => {
					await hold();
					return convert(messages);
				};
			} else if (stage === "request auth") {
				harness.session.agent.getApiKey = async () => {
					await hold();
					return "faux-key";
				};
			}
			// Public stream replacements must not bypass the session's shutdown boundary.
			const stream = vi.fn(harness.session.agent.streamFunction);
			harness.session.agent.streamFunction = stream;
			harness.setResponses([fauxAssistantMessage("Must not reach provider")]);
			const run = harness.session.prompt("Pending request");
			await entered.promise;
			const closing = shutdown(view, false);
			try {
				released.resolve();
				await run;
				await harness.session.waitForIdle();
				expect(stream).not.toHaveBeenCalled();
				expect(harness.session.messages.filter((message) => message.role === "assistant")).toEqual([]);
				expect(harness.eventsOfType("turn_end")).toEqual([]);
				expect(harness.eventsOfType("agent_end")).toHaveLength(1);
				expect(harness.session.isIdle).toBe(true);
			} finally {
				released.resolve();
				await run;
				drainReleased.resolve();
				await closing;
			}
		},
	);

	// PR #30: summary preparation and retry hooks run after the initial auth/admission check.
	it.each(["compaction hook", "compaction retry", "branch retry"] as const)(
		"stops a pending %s during shutdown",
		async (stage) => {
			const entered = deferred();
			const released = deferred();
			const drainReleased = deferred();
			const retry = stage !== "compaction hook";
			const harness = await createHarness({
				tools: [],
				settings: {
					compaction: { enabled: false, keepRecentTokens: 1 },
					retry: { enabled: retry, maxRetries: 1, baseDelayMs: 0 },
				},
				extensionFactories: [
					(pi) => {
						const hold = async () => {
							entered.resolve();
							await released.promise;
						};
						if (retry) pi.on("summarization_retry_attempt_start", hold);
						else pi.on("session_before_compact", hold);
					},
				],
			});
			cleanups.push(() => harness.cleanup());
			const view = await createShutdownView(harness);
			vi.spyOn(view.renderer.terminal, "drainInput").mockReturnValue(drainReleased.promise);
			harness.setResponses([
				fauxAssistantMessage("Saved response"),
				...(retry ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })] : []),
				fauxAssistantMessage("Must not generate a summary"),
			]);
			await harness.session.prompt("Saved input");
			const leaf = harness.sessionManager.getLeafId();
			const run = Promise.allSettled([
				stage === "branch retry"
					? harness.session.navigateTree(harness.session.getUserMessagesForForking()[0]!.entryId, {
							summarize: true,
						})
					: harness.session.compact(),
			]);
			await entered.promise;
			const calls = retry ? 2 : 1;
			expect(harness.faux.state.callCount).toBe(calls);
			const closing = shutdown(view, false);
			try {
				released.resolve();
				const result = await run;
				expect(harness.faux.state.callCount).toBe(calls);
				expect(result).toEqual([{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]);
				expect(harness.sessionManager.getLeafId()).toBe(leaf);
				expect(harness.session.getLastAssistantText()).toBe("Saved response");
				if (retry) expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(1);
			} finally {
				released.resolve();
				await run;
				drainReleased.resolve();
				await closing;
			}
		},
	);

	it.each(["input", "custom startup"] as const)("rejects pending %s after shutdown starts", async (stage) => {
		const entered = deferred();
		const released = deferred();
		const drainReleased = deferred();
		const preflight: boolean[] = [];
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (stage !== "input" || event.text !== "Pending input") return;
						entered.resolve();
						await released.promise;
					});
					pi.on("before_agent_start", async () => {
						if (stage !== "custom startup") return;
						entered.resolve();
						await released.promise;
					});
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		const view = await createShutdownView(harness);
		const drain = vi.spyOn(view.renderer.terminal, "drainInput").mockReturnValue(drainReleased.promise);
		harness.setResponses([fauxAssistantMessage("Must not reach provider")]);
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "Retain aside", display: false },
			{ deliverAs: "nextTurn" },
		);
		await harness.session.followUp("Retain queued work");
		const run = Promise.allSettled([
			stage === "input"
				? harness.session.prompt("Pending input", { preflightResult: (success) => preflight.push(success) })
				: harness.session.sendCustomMessage(
						{ customType: "pending", content: "Pending custom input", display: false },
						{ triggerTurn: true },
					),
		]);
		await entered.promise;
		const closing = shutdown(view, false);
		const idle = harness.session.waitForIdle();
		try {
			expect(drain).toHaveBeenCalledTimes(1);
			released.resolve();
			expect(await run).toEqual([{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]);
			await idle;
			expect(harness.faux.state.callCount).toBe(0);
			expect(preflight).toEqual(stage === "input" ? [false] : []);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.session.pendingNextTurnCount).toBe(1);
			expect(harness.session.getFollowUpMessages()).toEqual(["Retain queued work"]);
			expect(getUserTexts(harness)).toEqual([]);
		} finally {
			released.resolve();
			await run;
			drainReleased.resolve();
			await closing;
		}
	});

	it.each(["compaction", "branch summary"] as const)("does not start %s during shutdown", async (operation) => {
		const drainReleased = deferred();
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		cleanups.push(() => harness.cleanup());
		const view = await createShutdownView(harness);
		const drain = vi.spyOn(view.renderer.terminal, "drainInput").mockReturnValue(drainReleased.promise);
		harness.setResponses([fauxAssistantMessage("Saved response"), fauxAssistantMessage("Unwanted summary")]);
		await harness.session.prompt("Saved input");
		const closing = shutdown(view, false);
		try {
			expect(drain).toHaveBeenCalledTimes(1);
			const result = await Promise.allSettled([
				operation === "compaction"
					? harness.session.compact()
					: harness.session.navigateTree(harness.session.getUserMessagesForForking()[0]!.entryId, {
							summarize: true,
						}),
			]);
			expect(harness.faux.state.callCount).toBe(1);
			expect(result).toEqual([{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]);
			await harness.session.waitForIdle();
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.getLastAssistantText()).toBe("Saved response");
		} finally {
			drainReleased.resolve();
			await closing;
		}
	});

	it("finishes a tool and records without starting a queued provider request during shutdown", async () => {
		const toolEntered = deferred();
		const toolReleased = deferred();
		const drainReleased = deferred();
		let draining = false;
		const providerStarts: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			tools: [
				{
					name: "held_tool",
					label: "Held tool",
					description: "Wait for cancellation",
					parameters: Type.Object({}),
					async execute(_id, _args, signal) {
						toolEntered.resolve();
						await toolReleased.promise;
						return {
							content: [{ type: "text", text: signal?.aborted ? "Cancelled" : "Completed" }],
							details: {},
						};
					},
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		const view = await createShutdownView(harness);
		vi.spyOn(view.renderer.terminal, "drainInput").mockImplementation(() => {
			draining = true;
			return drainReleased.promise;
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("held_tool", {}), { stopReason: "toolUse" }),
			() => {
				providerStarts.push(draining ? "during terminal drain" : "before shutdown");
				return fauxAssistantMessage("Must not request another response");
			},
		]);
		const run = harness.session.prompt("Start held work");
		await toolEntered.promise;
		await harness.session.followUp("Retain queued work");
		await harness.session.sendCustomMessage(
			{ customType: "receipt", content: "Retain receipt", display: false },
			{ triggerTurn: false },
		);
		harness.session.recordBashResult("recorded command", {
			output: "Retain Bash output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		const closing = shutdown(view, false);
		try {
			expect(draining).toBe(true);
			toolReleased.resolve();
			await run;
			await harness.session.waitForIdle();
			expect(providerStarts).toEqual([]);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.getFollowUpMessages()).toEqual(["Retain queued work"]);
			expect(getUserTexts(harness)).toEqual(["Start held work"]);
			expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
			expect(harness.sessionManager.getEntries()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "custom_message", customType: "receipt", content: "Retain receipt" }),
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({ role: "toolResult", toolName: "held_tool" }),
					}),
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({ role: "bashExecution", output: "Retain Bash output" }),
					}),
				]),
			);
		} finally {
			toolReleased.resolve();
			await run;
			drainReleased.resolve();
			await closing;
		}
	});

	it.each([false, true])(
		"blocks idle-timer requests during terminal draining (extension: %s)",
		async (fromExtension) => {
			const timerFired = deferred();
			const drainReleased = deferred();
			let draining = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const providerStarts: string[] = [];
			const timerStates: boolean[] = [];
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("agent_settled", (_event, ctx) => {
							if (timer) return;
							timer = setTimeout(() => {
								timerStates.push(draining);
								if (ctx.isIdle()) {
									pi.sendMessage(
										{ customType: "continuation", content: "Timer continuation", display: false },
										{ triggerTurn: true },
									);
								}
								timerFired.resolve();
							}, 0);
						});
						pi.on("session_shutdown", () => {
							clearTimeout(timer);
							pi.appendEntry("shutdown-state", { saved: true });
						});
					},
				],
			});
			cleanups.push(() => harness.cleanup());
			harness.setResponses([
				() => {
					providerStarts.push(draining ? "during terminal drain" : "before shutdown");
					return fauxAssistantMessage("Final response");
				},
				() => {
					providerStarts.push(draining ? "during terminal drain" : "before shutdown");
					return fauxAssistantMessage("Unwanted shutdown response");
				},
			]);
			const view = await createShutdownView(harness);
			vi.spyOn(view.renderer.terminal, "drainInput").mockImplementation(() => {
				draining = true;
				return drainReleased.promise;
			});
			await harness.session.prompt("Finish the task");
			const closing = shutdown(view, fromExtension);
			try {
				await timerFired.promise;
				await harness.session.waitForIdle();
				expect(timerStates).toEqual([true]);
				expect(providerStarts).toEqual(["before shutdown"]);
				expect(harness.faux.state.callCount).toBe(1);
				expect(harness.session.isIdle).toBe(true);
				expect(harness.session.extensionRunner.createContext().isIdle()).toBe(false);
				await expect(harness.session.sendUserMessage("Late user input")).rejects.toMatchObject({
					name: "AbortError",
				});
				await expect(
					harness.session.sendCustomMessage(
						{ customType: "late", content: "Late custom input", display: false },
						{ triggerTurn: true },
					),
				).rejects.toMatchObject({ name: "AbortError" });
				expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
			} finally {
				drainReleased.resolve();
				await closing;
			}
			expect(harness.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ type: "custom", customType: "shutdown-state", data: { saved: true } }),
			);
		},
	);
});
