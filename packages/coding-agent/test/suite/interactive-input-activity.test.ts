import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { createInteractiveTui, InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type InputView = {
	renderer: ReturnType<typeof createInteractiveTui>;
	isInitialized: boolean;
	defaultEditor: CustomEditor;
	chatContainer: Container;
	setupEditorSubmitHandler(): void;
	setupKeyHandlers(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	handleDequeue(): void;
	handleFollowUp(): Promise<void>;
	subscribeToAgent(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void;
	flushCompactionQueue(): Promise<void>;
	handleEvent(event: AgentSessionEvent): Promise<void>;
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function createInputView(harness: Harness) {
	initTheme("dark");
	const mode = new InteractiveMode({
		session: harness.session,
		setBeforeSessionInvalidate() {},
		setRebindSession() {},
	} as unknown as AgentSessionRuntime);
	const view = mode as unknown as InputView;
	// Keep native input/queue/context bindings; only replace the physical terminal.
	view.renderer = createInteractiveTui({
		tuiMode: "regular",
		terminal: new VirtualTerminal(120, 40),
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
	});
	view.isInitialized = true;
	view.setupKeyHandlers();
	view.setupEditorSubmitHandler();
	await view.bindCurrentSessionExtensions();
	view.renderer.start();
	onTestFinished(() => mode.stop("resume-hint"));
	return { mode, view, ctx: harness.session.extensionRunner.createContext() };
}

describe("native pending input visibility", () => {
	it("reports TUI input waiting for the native prompt loop", async () => {
		const harness = await createHarness({ tools: [] });
		onTestFinished(() => harness.cleanup());
		const { mode, view, ctx } = await createInputView(harness);
		await view.defaultEditor.onSubmit?.("submitted before the prompt loop waits");
		expect(ctx.isIdle()).toBe(true);
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(ctx.getPendingInputCount()).toBe(1);
		expect(await mode.getUserInput()).toBe("submitted before the prompt loop waits");
		expect(ctx.getPendingInputCount()).toBe(0);
	});

	it.each([false, true])("cancels TUI prompt preparation and recovers queued input (queued: %s)", async (queued) => {
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						markEntered();
						await released;
					});
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		const { view, ctx } = await createInputView(harness);
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "retained aside", display: false },
			{ deliverAs: "nextTurn" },
		);
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);
		const run = Promise.allSettled([
			queued
				? harness.session.prompt("cancelled prompt")
				: harness.session.sendCustomMessage(
						{ customType: "wakeup", content: "cancelled wakeup", display: false },
						{ triggerTurn: true },
					),
		]);
		try {
			await entered;
			expect(ctx.isIdle()).toBe(false);
			expect(ctx.signal).toBeUndefined();
			if (queued) {
				await harness.session.followUp("recover queued input");
				view.defaultEditor.onEscape?.();
			} else {
				ctx.abort();
			}
			release();
			const result = await run;
			await harness.session.waitForIdle();
			expect(harness.faux.state.callCount).toBe(0);
			expect(result).toEqual([{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]);
			expect(ctx.isIdle()).toBe(true);
			expect(ctx.hasPendingMessages()).toBe(false);
			expect(ctx.getPendingInputCount()).toBe(0);
			expect(ctx.getPendingNextTurnCount()).toBe(1);
			expect(ctx.ui.getEditorText()).toBe(queued ? "recover queued input" : "");
		} finally {
			release();
			await run;
		}
	});

	it.each(["first", "later", "retry"] as const)(
		"delivers compaction-queue input once when the %s handler waits",
		async (held) => {
			const entered = createDeferred();
			const released = createDeferred();
			const laterEntered = createDeferred();
			const providerReleased = createDeferred();
			const settled = createDeferred();
			const retryScheduled = createDeferred();
			const inputs: string[] = [];
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false }, retry: { enabled: held === "retry", baseDelayMs: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							inputs.push(event.text);
							if (event.text === "later") laterEntered.resolve();
							if (event.text === (held === "first" ? "first" : "later")) {
								entered.resolve();
								await released.promise;
							}
							return { action: "transform", text: `transformed ${event.text}` };
						});
					},
				],
			});
			onTestFinished(() => harness.cleanup());
			harness.session.subscribe((event) => {
				if (event.type === "agent_settled") settled.resolve();
				if (event.type === "auto_retry_start") retryScheduled.resolve();
			});
			harness.setResponses([
				...(held === "retry"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]
					: []),
				async () => {
					if (held === "first") await providerReleased.promise;
					return fauxAssistantMessage("first done");
				},
				fauxAssistantMessage("later done"),
			]);
			const { view, ctx } = await createInputView(harness);
			const retryRun = held === "retry" ? harness.session.prompt("first") : undefined;
			if (retryRun) await retryScheduled.promise;
			else view.queueCompactionMessage("first", "steer");
			view.queueCompactionMessage("later", "followUp");
			const flush = view.handleEvent({
				type: "compaction_end",
				reason: "threshold",
				result: undefined,
				aborted: true,
				willRetry: held === "retry",
			});
			try {
				await entered.promise;
				if (held === "first") {
					expect(inputs).toEqual(["first"]);
					released.resolve();
					await laterEntered.promise;
					providerReleased.resolve();
				} else {
					await settled.promise;
					expect(ctx.isIdle()).toBe(true);
					expect(ctx.getPendingInputCount()).toBe(1);
					released.resolve();
				}
				await flush;
				await expect.poll(() => getUserTexts(harness)).toEqual(["transformed first", "transformed later"]);
				await harness.session.waitForIdle();
				expect(harness.faux.state.callCount).toBe(held === "retry" ? 3 : 2);
				expect(inputs).toEqual(["first", "later"]);
				expect(ctx.getPendingInputCount()).toBe(0);
				expect(ctx.hasPendingMessages()).toBe(false);
			} finally {
				released.resolve();
				providerReleased.resolve();
				await flush;
				await retryRun;
				await harness.session.waitForIdle();
			}
		},
	);

	it.each(["steer", "followUp", "submit", "altEnter", "later"] as const)(
		"restores only unaccepted TUI input after auth failure (%s)",
		async (route) => {
			const authEntered = createDeferred();
			const authReleased = createDeferred();
			const laterEntered = createDeferred();
			const laterReleased = createDeferred();
			const firstSettled = createDeferred();
			let authState: "unconfigured" | "fail" | "ready" = "unconfigured";
			const inputs: string[] = [];
			const harness = await createHarness({
				tools: [],
				withConfiguredAuth: false,
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							inputs.push(event.text);
							if (route === "later" && event.text === "later input") {
								laterEntered.resolve();
								await laterReleased.promise;
							}
							return { action: "transform", text: `transformed ${event.text}` };
						});
					},
				],
			});
			onTestFinished(() => harness.cleanup());
			const faux = fauxProvider({ api: harness.faux.api });
			harness.session.modelRuntime.registerNativeProvider({
				...faux.provider,
				auth: {
					apiKey: {
						name: "Held faux auth",
						resolve: async () => {
							if (authState === "fail") {
								authEntered.resolve();
								await authReleased.promise;
								throw new Error("held auth unavailable");
							}
							return authState === "ready" ? { auth: {} } : undefined;
						},
					},
				},
			});
			await harness.session.modelRuntime.refresh({ allowNetwork: false });
			harness.session.subscribe((event) => {
				if (event.type === "agent_settled") firstSettled.resolve();
			});
			const { view, ctx } = await createInputView(harness);
			authState = route === "later" ? "ready" : "fail";
			harness.setResponses([fauxAssistantMessage("first done")]);
			view.queueCompactionMessage("first input", "steer");
			if (route === "later") view.queueCompactionMessage("later input", "followUp");
			const flush = view.flushCompactionQueue();
			try {
				if (route === "later") {
					await laterEntered.promise;
					await firstSettled.promise;
					expect(getUserTexts(harness)).toEqual(["transformed first input"]);
					authState = "fail";
					laterReleased.resolve();
				}
				await authEntered.promise;
				if (route === "steer" || route === "followUp") {
					await harness.session[route]("independent input");
				} else if (route === "submit") {
					await view.defaultEditor.onSubmit?.("independent input");
				} else if (route === "altEnter") {
					view.defaultEditor.setText("independent input");
					await view.handleFollowUp();
				}
				expect(ctx.hasPendingMessages()).toBe(route !== "later");
				authReleased.resolve();
				await flush;
				expect(ctx.getPendingInputCount()).toBe(1);
				expect(ctx.hasPendingMessages()).toBe(route !== "later");
				expect(view.chatContainer.render(120).join("\n")).toContain("held auth unavailable");
				authState = "ready";
				harness.setResponses([
					fauxAssistantMessage("recovered"),
					...(route === "followUp" || route === "altEnter" ? [fauxAssistantMessage("follow-up done")] : []),
				]);
				await view.flushCompactionQueue();
				await harness.session.waitForIdle();
				expect(getUserTexts(harness)).toEqual([
					"transformed first input",
					route === "later" ? "transformed later input" : "transformed independent input",
				]);
				expect(inputs).toEqual(
					route === "later"
						? ["first input", "later input", "later input"]
						: ["first input", "independent input", "first input"],
				);
				expect(ctx.getPendingInputCount()).toBe(0);
				expect(ctx.hasPendingMessages()).toBe(false);
				expect(harness.getPendingResponseCount()).toBe(0);
			} finally {
				authReleased.resolve();
				laterReleased.resolve();
				await flush;
				await harness.session.waitForIdle();
			}
		},
	);

	it("keeps undispatched TUI input counted and dequeuable while the first handler waits", async () => {
		const entered = createDeferred();
		const released = createDeferred();
		const inputs: string[] = [];
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						inputs.push(event.text);
						if (event.text === "first input") {
							entered.resolve();
							await released.promise;
						}
					});
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("first done")]);
		const { view, ctx } = await createInputView(harness);
		view.queueCompactionMessage("first input", "steer");
		view.queueCompactionMessage("dequeue this tail", "followUp");
		expect(ctx.getPendingInputCount()).toBe(2);
		const flush = view.flushCompactionQueue();
		try {
			await entered.promise;
			expect(ctx.getPendingInputCount()).toBe(2);
			view.handleDequeue();
			expect(ctx.ui.getEditorText()).toBe("dequeue this tail");
			expect(ctx.getPendingInputCount()).toBe(1);
			released.resolve();
			await flush;
			await harness.session.waitForIdle();
			expect(inputs).toEqual(["first input"]);
			expect(getUserTexts(harness)).toEqual(["first input"]);
			expect(harness.faux.state.callCount).toBe(1);
			expect(ctx.getPendingInputCount()).toBe(0);
			expect(ctx.ui.getEditorText()).toBe("dequeue this tail");
		} finally {
			released.resolve();
			await flush;
			await harness.session.waitForIdle();
		}
	});

	it("keeps TUI input order when pre-prompt compaction reenters the flush", async () => {
		const entered = createDeferred();
		const released = createDeferred();
		const inputs: string[] = [];
		const harness = await createHarness({
			tools: [],
			models: [{ id: "faux-1", contextWindow: 2000 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputs.push(event.text);
					});
					pi.on("session_before_auto_compact", () => ({ newContext: { handoff: "short handoff" } }));
					pi.on("before_agent_start", async (event) => {
						if (event.prompt === "first input") {
							entered.resolve();
							await released.promise;
						}
						return { systemPrompt: "short instructions" };
					});
				},
			],
		});
		onTestFinished(() => harness.cleanup());
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ ...userMsg("previous input ".repeat(800)), timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("previous response", { stopReason: "aborted", timestamp: Date.now() - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("tail done")]);
		const { view, ctx } = await createInputView(harness);
		view.subscribeToAgent();
		view.queueCompactionMessage("first input", "steer");
		view.queueCompactionMessage("tail input", "followUp");
		const flush = view.flushCompactionQueue();
		try {
			await entered.promise;
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(inputs).toEqual(["first input"]);
			expect(ctx.getPendingInputCount()).toBe(2);
			released.resolve();
			await flush;
			await harness.session.waitForIdle();
			expect(inputs).toEqual(["first input", "tail input"]);
			expect(getUserTexts(harness).slice(-2)).toEqual(["first input", "tail input"]);
			expect(harness.faux.state.callCount).toBe(2);
			expect(ctx.getPendingInputCount()).toBe(0);
		} finally {
			released.resolve();
			await flush;
			await harness.session.waitForIdle();
		}
	});

	it.each(["steer", "followUp", "settlement"] as const)(
		"reports %s observer failure without replaying accepted input",
		async (failure) => {
			const released = createDeferred();
			const entered = createDeferred();
			const providerReleased = createDeferred();
			const settled = createDeferred();
			const inputs: string[] = [];
			const harness = await createHarness({
				tools: [],
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							inputs.push(event.text);
							if (event.text !== "held input") return;
							entered.resolve();
							await released.promise;
							return { action: "transform", text: "transformed input" };
						});
					},
				],
			});
			onTestFinished(() => harness.cleanup());
			harness.setResponses([
				async () => {
					if (failure !== "settlement") await providerReleased.promise;
					return fauxAssistantMessage("first done");
				},
				fauxAssistantMessage("later done"),
				fauxAssistantMessage("newer done"),
			]);
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_settled") settled.resolve();
				if (
					(failure !== "settlement" &&
						event.type === "queue_update" &&
						[...event.steering, ...event.followUp].includes("transformed input")) ||
					(failure === "settlement" &&
						event.type === "agent_settled" &&
						getUserTexts(harness).includes("transformed input"))
				) {
					unsubscribe();
					throw new Error(`${failure} observer failed`);
				}
			});
			const { view, ctx } = await createInputView(harness);
			view.queueCompactionMessage("first prompt", "steer");
			view.queueCompactionMessage("held input", failure === "steer" ? "steer" : "followUp");
			const flush = view.flushCompactionQueue();
			try {
				await entered.promise;
				if (failure === "settlement") await settled.promise;
				expect(ctx.isIdle()).toBe(failure === "settlement");
				expect(ctx.hasPendingMessages()).toBe(false);
				expect(ctx.getPendingInputCount()).toBe(1);
				view.queueCompactionMessage("newer input", "followUp");
				expect(ctx.getPendingInputCount()).toBe(2);
				released.resolve();
				await flush;
				await expect.poll(() => view.chatContainer.render(120).join("\n")).toContain(`${failure} observer failed`);
				expect(harness.session.getSteeringMessages()).toEqual([]);
				expect(harness.session.getFollowUpMessages()).toEqual([]);
				expect(ctx.hasPendingMessages()).toBe(false);
				if (failure === "settlement") {
					expect(ctx.getPendingInputCount()).toBe(0);
					expect(inputs).toEqual(["first prompt", "held input", "newer input"]);
					expect(getUserTexts(harness)).toEqual(["first prompt", "transformed input", "newer input"]);
				} else {
					expect(ctx.getPendingInputCount()).toBe(2);
					expect(inputs).toEqual(["first prompt", "held input"]);
					view.handleDequeue();
					expect(ctx.ui.getEditorText()).toBe("held input\n\nnewer input");
					expect(ctx.getPendingInputCount()).toBe(0);
				}
			} finally {
				released.resolve();
				providerReleased.resolve();
				await flush;
				await harness.session.waitForIdle();
				unsubscribe();
			}
		},
	);

	it.each(["cancel", "error"] as const)("retains visible queued input after branch summary %s", async (outcome) => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({ tools: [], settings: { retry: { enabled: false } } });
		onTestFinished(() => harness.cleanup());
		const target = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.sessionManager.appendMessage(userMsg("second"));
		harness.setResponses([
			async () => {
				markStarted();
				await released;
				return fauxAssistantMessage("", {
					stopReason: outcome === "cancel" ? "aborted" : "error",
					errorMessage: "fixture summary failure",
				});
			},
		]);
		const { view, ctx } = await createInputView(harness);
		const navigation = harness.session.navigateTree(target, { summarize: true }).catch((error: unknown) => error);
		try {
			await started;
			await view.defaultEditor.onSubmit?.("retain this submitted input");
			if (outcome === "cancel") harness.session.abortBranchSummary();
			release();
			const result = await navigation;
			if (outcome === "cancel") expect(result).toMatchObject({ cancelled: true, aborted: true });
			else expect(result).toBeInstanceOf(Error);
			expect(ctx.isIdle()).toBe(true);
			expect(ctx.hasPendingMessages()).toBe(false);
			expect(ctx.getPendingInputCount()).toBe(1);
			view.handleDequeue();
			expect(ctx.ui.getEditorText()).toBe("retain this submitted input");
			expect(ctx.getPendingInputCount()).toBe(0);
		} finally {
			harness.session.abortBranchSummary();
			release();
			await navigation;
		}
	});
});
