import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function custom(content: string) {
	return { customType: "admission", content, display: true, details: { id: content } };
}

describe("AgentSession prompt admission", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["prompt", "steer", "followUp"] as const)(
		"counts concurrent %s input through handling and reload without counting commands",
		async (method) => {
			const firstReleased = createDeferred();
			const secondReleased = createDeferred();
			const entered: string[] = [];
			const commandCounts: number[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							entered.push(event.text);
							await (event.text === "first" ? firstReleased : secondReleased).promise;
							return { action: "handled" };
						});
						pi.registerCommand("restart-check", {
							handler: async (_args, ctx) => {
								commandCounts.push(ctx.getPendingInputCount());
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const first = harness.session[method]("first");
			const second = harness.session[method]("second");
			try {
				expect(entered).toEqual(["first", "second"]);
				expect(harness.session.isIdle).toBe(true);
				expect(harness.session.hasPendingMessages).toBe(false);
				const oldContext = harness.session.extensionRunner.createContext();
				expect(oldContext.getPendingInputCount()).toBe(2);
				await harness.session.prompt("/restart-check");
				expect(commandCounts).toEqual([2]);
				expect(entered).toHaveLength(2);
				await harness.session.reload();
				const current = harness.session.extensionRunner.createContext();
				expect(() => oldContext.getPendingInputCount()).toThrow("stale");
				expect(current.getPendingInputCount()).toBe(2);
				secondReleased.resolve();
				await second;
				expect(current.getPendingInputCount()).toBe(1);
				firstReleased.resolve();
				await first;
				expect(current.getPendingInputCount()).toBe(0);
				await harness.session.prompt("/restart-check");
				expect(commandCounts).toEqual([2, 0]);
				expect(harness.session.messages).toEqual([]);
				expect(harness.faux.state.callCount).toBe(0);
			} finally {
				firstReleased.resolve();
				secondReleased.resolve();
				await Promise.allSettled([first, second]);
			}
		},
	);

	it("releases direct input ownership if reporting a handler failure also throws", async () => {
		const released = createDeferred();
		const errorCounts: number[] = [];
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						await released.promise;
						throw new Error("input handler failed");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			onError: (error) => {
				errorCounts.push(harness.session.pendingInputCount);
				throw new Error(`observer: ${error.error}`);
			},
		});
		const result = Promise.allSettled([harness.session.followUp("failed input")]);
		try {
			expect(harness.session.pendingInputCount).toBe(1);
			released.resolve();
			expect(await result).toEqual([
				{
					status: "rejected",
					reason: expect.objectContaining({ message: "observer: input handler failed" }),
				},
			]);
			expect(errorCounts).toEqual([1]);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			released.resolve();
			await result;
		}
	});

	it.each([false, true])("owns user startup through settlement (abort: %s)", async (abort) => {
		const inputEntered = createDeferred();
		const inputReleased = createDeferred();
		const startupEntered = createDeferred();
		const startupReleased = createDeferred();
		const requestEntered = createDeferred();
		const responseReleased = createDeferred();
		const startupStates: Array<{ prompt: string; idle: boolean }> = [];
		const settledStates: Array<{ idle: boolean; signal: AbortSignal | undefined }> = [];
		const requests: Array<{ systemPrompt: string | undefined; texts: string[] }> = [];
		const preflight: boolean[] = [];
		const rejectedPreflight: boolean[] = [];
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "held-input") {
							inputEntered.resolve();
							await inputReleased.promise;
						}
					});
					pi.on("before_agent_start", async (event, ctx) => {
						startupStates.push({ prompt: event.prompt, idle: ctx.isIdle() });
						if (event.prompt === "original") {
							startupEntered.resolve();
							await startupReleased.promise;
							pi.sendMessage(custom("startup-aside"), { deliverAs: "nextTurn" });
						}
						return {
							systemPrompt: `${event.prompt} instructions`,
							message: { customType: "guidance", content: `guidance:${event.prompt}`, display: false },
						};
					});
					pi.on("agent_settled", (_event, ctx) => {
						settledStates.push({ idle: ctx.isIdle(), signal: ctx.signal });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async (context) => {
				requests.push({ systemPrompt: context.systemPrompt, texts: context.messages.map(getMessageText) });
				requestEntered.resolve();
				await responseReleased.promise;
				return fauxAssistantMessage("owner answer");
			},
			(context) => {
				requests.push({ systemPrompt: context.systemPrompt, texts: context.messages.map(getMessageText) });
				return fauxAssistantMessage("second answer");
			},
			(context) => {
				requests.push({ systemPrompt: context.systemPrompt, texts: context.messages.map(getMessageText) });
				return fauxAssistantMessage("third answer");
			},
		]);
		await harness.session.sendCustomMessage(custom("before-aside"), { deliverAs: "nextTurn" });
		const rejected = Promise.allSettled([
			harness.session.prompt("held-input", { preflightResult: (accepted) => rejectedPreflight.push(accepted) }),
		]);
		let owner: Promise<PromiseSettledResult<void>[]> | undefined;
		let wakeup: Promise<PromiseSettledResult<void>[]> | undefined;
		let abortWait: Promise<void> | undefined;
		const idleResults: string[] = [];
		const waits: Promise<void>[] = [];
		try {
			await inputEntered.promise;
			expect(harness.session.pendingInputCount).toBe(1);
			expect(harness.session.isIdle).toBe(true);
			owner = Promise.allSettled([
				harness.session.prompt("original", { preflightResult: (accepted) => preflight.push(accepted) }),
			]);
			await startupEntered.promise;
			expect(harness.session.pendingInputCount).toBe(2);
			expect(startupStates).toEqual([{ prompt: "original", idle: false }]);
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			expect(preflight).toEqual([]);
			waits.push(
				harness.session.waitForIdle().then(() => {
					idleResults.push("startup");
				}),
			);
			wakeup = Promise.allSettled([harness.session.sendCustomMessage(custom("wakeup"), { triggerTurn: true })]);
			await expect(harness.session.sendUserMessage("rejected-extension")).rejects.toThrow("already processing");
			expect(await wakeup).toEqual([{ status: "fulfilled", value: undefined }]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(startupStates).toHaveLength(1);
			expect(idleResults).toEqual([]);

			startupReleased.resolve();
			await requestEntered.promise;
			expect(harness.session.pendingInputCount).toBe(1);
			const signal = harness.session.agent.signal;
			expect(signal?.aborted).toBe(false);
			waits.push(
				harness.session.waitForIdle().then(() => {
					idleResults.push("active");
				}),
			);
			await harness.session.sendCustomMessage(custom("next-aside"), { deliverAs: "nextTurn" });
			await harness.session.sendCustomMessage(custom("passive"), { triggerTurn: false });
			harness.session.recordBashResult("recorded command", {
				output: "recorded output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
			harness.session.newContext({ handoff: "active handoff" });
			inputReleased.resolve();
			expect(await rejected).toEqual([
				{
					status: "rejected",
					reason: expect.objectContaining({ message: expect.stringContaining("already processing") }),
				},
			]);
			expect(rejectedPreflight).toEqual([false]);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(preflight).toEqual([true]);
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.isIdle).toBe(false);
			expect(harness.session.agent.state.isStreaming).toBe(true);
			expect(harness.session.agent.signal).toBe(signal);
			expect(harness.session.systemPrompt).toBe("original instructions");
			expect(harness.session.hasPendingBashMessages).toBe(true);
			expect(harness.session.messages.some((message) => getMessageText(message) === "passive")).toBe(false);
			expect(harness.eventsOfType("agent_settled")).toEqual([]);
			expect(settledStates).toEqual([]);
			waits.push(
				harness.session.waitForIdle().then(() => {
					idleResults.push("after-rejection");
				}),
			);
			await harness.session.sendCustomMessage(custom("retained"), { deliverAs: "followUp" });
			expect(idleResults).toEqual([]);
			if (abort) abortWait = harness.session.abort();
			expect(signal?.aborted).toBe(abort);
			expect(idleResults).toEqual([]);
			responseReleased.resolve();
			expect(await owner).toEqual([{ status: "fulfilled", value: undefined }]);
			await Promise.all([...waits, abortWait]);
			expect(idleResults).toEqual(["startup", "active", "after-rejection"]);
			expect(settledStates).toEqual([{ idle: true, signal: undefined }]);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			expect(harness.session.hasPendingMessages).toBe(abort);
			expect(harness.session.hasPendingBashMessages).toBe(false);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_window")).toHaveLength(
				abort ? 0 : 1,
			);
			expect(requests[0]).toEqual({
				systemPrompt: "original instructions",
				texts: ["original", "before-aside", "guidance:original", "wakeup"],
			});
			if (!abort) {
				expect(requests[1]).toEqual({
					systemPrompt: "original instructions",
					texts: [expect.stringContaining("active handoff"), "retained"],
				});
			}
			await harness.session.prompt("next");
			expect(requests).toHaveLength(3);
			expect(requests.at(-1)?.systemPrompt).toBe("next instructions");
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
			const entries = harness.sessionManager.getEntries();
			const receipts = entries.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === "admission" ? [entry.details] : [],
			);
			expect(receipts).toHaveLength(6);
			expect(receipts).toEqual(
				expect.arrayContaining(
					["before-aside", "startup-aside", "next-aside", "passive", "retained", "wakeup"].map((id) => ({ id })),
				),
			);
			expect(
				entries.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
				),
			).toEqual(["original", "next"]);
			expect(preflight).toEqual([true]);
			expect(rejectedPreflight).toEqual([false]);
		} finally {
			inputReleased.resolve();
			startupReleased.resolve();
			responseReleased.resolve();
			await Promise.allSettled([rejected, owner, wakeup, abortWait, ...waits]);
		}
	});

	it.each(["auth", "auth-error", "startup"] as const)(
		"cancels admitted %s preparation before any provider call",
		async (stage) => {
			const entered = createDeferred();
			const released = createDeferred();
			let holdAuth = false;
			let failAuth = stage === "auth-error";
			const harness = await createHarness({
				tools: [],
				withConfiguredAuth: stage === "startup",
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async () => {
							if (stage === "startup") {
								entered.resolve();
								await released.promise;
							}
						});
					},
				],
			});
			harnesses.push(harness);
			if (stage !== "startup") {
				const faux = fauxProvider({ api: harness.faux.api });
				harness.session.modelRuntime.registerNativeProvider({
					...faux.provider,
					auth: {
						apiKey: {
							name: "Faux preflight",
							resolve: async () => {
								if (!holdAuth) return undefined;
								entered.resolve();
								await released.promise;
								if (failAuth) throw new Error("auth failed after cancellation");
								return { auth: {} };
							},
						},
					},
				});
				await harness.session.modelRuntime.refresh({ allowNetwork: false });
				holdAuth = true;
			}
			harness.sessionManager.appendMessage(fauxAssistantMessage("previous answer"));
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			await harness.session.sendCustomMessage(custom("before-aside"), { deliverAs: "nextTurn" });
			harness.setResponses([fauxAssistantMessage("must not reach provider")]);
			const preflight: boolean[] = [];
			const run = Promise.allSettled([
				harness.session.prompt("cancelled prompt", {
					preflightResult: (accepted) => preflight.push(accepted),
				}),
			]);
			let abort: Promise<void> | undefined;
			try {
				await Promise.race([
					entered.promise,
					run.then(() => {
						throw new Error("Prompt did not reach preparation");
					}),
				]);
				expect(harness.session.isStreaming).toBe(true);
				expect(harness.session.agent.signal).toBeUndefined();
				expect(harness.session.pendingInputCount).toBe(1);
				await harness.session.sendCustomMessage(custom("late-aside"), { deliverAs: "nextTurn" });
				await harness.session.steer("retained steering");
				harness.session.newContext({ handoff: "cancelled handoff" });
				abort = harness.session.abort();
				expect(harness.session.isIdle).toBe(false);
				released.resolve();
				const [result] = await Promise.all([run, abort]);
				expect(harness.faux.state.callCount).toBe(0);
				expect(result).toEqual([{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]);
				expect(preflight).toEqual([false]);
				expect(harness.session.isIdle).toBe(true);
				expect(harness.session.pendingInputCount).toBe(0);
				expect(harness.session.pendingNextTurnCount).toBe(2);
				expect(harness.session.getSteeringMessages()).toEqual(["retained steering"]);
				expect(harness.eventsOfType("agent_start")).toEqual([]);
				expect(harness.eventsOfType("agent_settled")).toEqual([]);
				expect(harness.session.getLastAssistantText()).toBe("previous answer");
				failAuth = false;
				const requests: string[][] = [];
				harness.setResponses([
					(context) => {
						requests.push(context.messages.map(getMessageText));
						return fauxAssistantMessage("recovered");
					},
				]);
				await harness.session.prompt("retry");
				expect(requests).toHaveLength(1);
				expect(requests[0]).toEqual(
					expect.arrayContaining(["retry", "before-aside", "late-aside", "retained steering"]),
				);
				expect(requests[0]).not.toContain("cancelled prompt");
				expect(harness.session.pendingNextTurnCount).toBe(0);
				expect(harness.session.hasPendingMessages).toBe(false);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_window")).toEqual([]);
				expect(harness.session.getLastAssistantText()).toBe("recovered");
			} finally {
				released.resolve();
				await Promise.allSettled([run, abort]);
			}
		},
	);

	it.each(["callback", "awaited"] as const)(
		"preserves nextTurn ownership when cancelled at %s preflight acceptance",
		async (boundary) => {
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
			});
			harnesses.push(harness);
			await harness.session.sendCustomMessage(custom("retained aside"), { deliverAs: "nextTurn" });
			const accepted = createDeferred();
			const order: string[] = [];
			const preflight: boolean[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "agent_start") order.push("agent_start");
			});
			harness.setResponses([fauxAssistantMessage("must not reach provider")]);
			let abort: Promise<void> | undefined;
			const run = Promise.allSettled([
				harness.session.prompt("cancelled prompt", {
					preflightResult(success) {
						preflight.push(success);
						order.push("accepted");
						if (boundary === "callback") abort = harness.session.abort();
						accepted.resolve();
					},
				}),
			]);
			await accepted.promise;
			if (boundary === "awaited") abort = harness.session.abort();
			const [result] = await Promise.all([run, abort]);
			expect(preflight).toEqual([true]);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.session.isIdle).toBe(true);
			const asides = () =>
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "admission");
			expect(harness.session.pendingNextTurnCount + asides().length).toBe(1);
			if (boundary === "callback") {
				expect(harness.faux.state.callCount).toBe(0);
				expect(result).toEqual([{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]);
				expect(harness.session.pendingNextTurnCount).toBe(1);
				expect(harness.session.messages).toEqual([]);
				expect(order).toEqual(["accepted"]);
			} else {
				expect(result).toEqual([{ status: "fulfilled", value: undefined }]);
				expect(harness.session.pendingNextTurnCount).toBe(0);
				expect(order).toEqual(["accepted", "agent_start"]);
				expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
			}
			const requests: string[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages.map(getMessageText));
					return fauxAssistantMessage("recovered");
				},
			]);
			await harness.session.prompt("retry");
			expect(requests).toHaveLength(1);
			expect(requests[0].filter((text) => text === "retained aside")).toHaveLength(1);
			expect(asides()).toHaveLength(1);
			expect(harness.session.pendingNextTurnCount).toBe(0);
		},
	);

	it("releases failed preflight without settling or losing queued inputs", async () => {
		const authEntered = createDeferred();
		const authReleased = createDeferred();
		let authState: "unconfigured" | "fail" | "ready" = "unconfigured";
		const harness = await createHarness({
			tools: [],
			withConfiguredAuth: false,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		const faux = fauxProvider({ api: harness.faux.api });
		harness.session.modelRuntime.registerNativeProvider({
			...faux.provider,
			auth: {
				apiKey: {
					name: "Faux preflight",
					resolve: async () => {
						if (authState === "fail") {
							authEntered.resolve();
							await authReleased.promise;
							throw new Error("faux auth unavailable");
						}
						return authState === "ready" ? { auth: {} } : undefined;
					},
				},
			},
		});
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
		const systemPrompt = harness.session.systemPrompt;
		await harness.session.sendCustomMessage(custom("before-aside"), { deliverAs: "nextTurn" });
		const preflight: boolean[] = [];
		const queuedPreflight: boolean[] = [];
		const rejectedPreflight: boolean[] = [];
		const idleResults: string[] = [];
		const waits: Promise<void>[] = [];
		authState = "fail";
		const failed = Promise.allSettled([
			harness.session.prompt("failed", { preflightResult: (accepted) => preflight.push(accepted) }),
		]);
		try {
			await authEntered.promise;
			expect(harness.session.pendingInputCount).toBe(1);
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.isIdle).toBe(false);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			waits.push(
				harness.session.waitForIdle().then(() => {
					idleResults.push("auth");
				}),
			);
			await harness.session.sendCustomMessage(custom("held-custom"), { triggerTurn: true });
			await harness.session.sendCustomMessage(custom("passive"), { triggerTurn: false });
			await harness.session.prompt("held-user", {
				streamingBehavior: "followUp",
				preflightResult: (accepted) => queuedPreflight.push(accepted),
			});
			await expect(
				harness.session.prompt("rejected", {
					preflightResult: (accepted) => rejectedPreflight.push(accepted),
				}),
			).rejects.toThrow("already processing");
			waits.push(
				harness.session.waitForIdle().then(() => {
					idleResults.push("after-rejection");
				}),
			);
			await harness.session.sendCustomMessage(custom("late-aside"), { deliverAs: "nextTurn" });
			expect(preflight).toEqual([]);
			expect(queuedPreflight).toEqual([true]);
			expect(harness.session.pendingInputCount).toBe(1);
			expect(rejectedPreflight).toEqual([false]);
			expect(idleResults).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
			authReleased.resolve();
			expect(await failed).toEqual([
				{
					status: "rejected",
					reason: expect.objectContaining({ message: expect.stringContaining("faux auth unavailable") }),
				},
			]);
			await Promise.all(waits);
			expect(idleResults).toEqual(["auth", "after-rejection"]);
			expect(preflight).toEqual([false]);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.eventsOfType("agent_start")).toEqual([]);
			expect(harness.eventsOfType("agent_settled")).toEqual([]);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.agent.signal).toBeUndefined();
			expect(harness.session.systemPrompt).toBe(systemPrompt);
			expect(harness.session.hasPendingMessages).toBe(true);

			authState = "ready";
			const requests: string[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages.map(getMessageText));
					return fauxAssistantMessage("recovered");
				},
				fauxAssistantMessage("follow-up"),
			]);
			await harness.session.prompt("retry", { preflightResult: (accepted) => preflight.push(accepted) });
			expect(requests).toEqual([["passive", "retry", "before-aside", "late-aside", "held-custom"]]);
			expect(preflight).toEqual([false, true]);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			const entries = harness.sessionManager.getEntries();
			expect(entries.filter((entry) => entry.type === "custom_message").map((entry) => entry.details)).toEqual(
				["passive", "before-aside", "late-aside", "held-custom"].map((id) => ({ id })),
			);
			expect(
				entries.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
				),
			).toEqual(["retry", "held-user"]);
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_settled") throw new Error("settlement observer failed");
			});
			try {
				harness.setResponses([fauxAssistantMessage("accepted answer")]);
				await expect(
					harness.session.prompt("accepted", {
						preflightResult: (accepted) => preflight.push(accepted),
					}),
				).rejects.toThrow("settlement observer failed");
				expect(preflight).toEqual([false, true, true]);
				expect(harness.session.isIdle).toBe(true);
			} finally {
				unsubscribe();
			}
		} finally {
			authReleased.resolve();
			await Promise.allSettled([failed, ...waits]);
		}
	});

	it("keeps admission across pre-prompt compaction and its context boundary", async () => {
		const compactionEntered = createDeferred();
		const compactionReleased = createDeferred();
		const harness = await createHarness({
			tools: [],
			models: [{ id: "faux-1", contextWindow: 2000 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_auto_compact", async () => {
						compactionEntered.resolve();
						await compactionReleased.promise;
						return { newContext: { handoff: "preflight handoff" } };
					});
					pi.on("before_agent_start", () => ({ systemPrompt: "short instructions" }));
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: "previous input ".repeat(800),
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("previous response", { stopReason: "aborted", timestamp: Date.now() - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.sendCustomMessage(custom("compaction-aside"), { deliverAs: "nextTurn" });
		const requests: string[][] = [];
		harness.setResponses([
			(context) => {
				requests.push(context.messages.map(getMessageText));
				return fauxAssistantMessage("answer");
			},
		]);
		const preflight: boolean[] = [];
		const rejectedPreflight: boolean[] = [];
		const run = Promise.allSettled([
			harness.session.prompt("after-compaction", { preflightResult: (accepted) => preflight.push(accepted) }),
		]);
		let idle = false;
		let wait: Promise<void> | undefined;
		try {
			await Promise.race([
				compactionEntered.promise,
				run.then(() => {
					throw new Error("Prompt finished before pre-prompt compaction");
				}),
			]);
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.pendingInputCount).toBe(1);
			expect(harness.session.isCompacting).toBe(true);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			wait = harness.session.waitForIdle().then(() => {
				idle = true;
			});
			await harness.session.sendCustomMessage(custom("compaction-wakeup"), { triggerTurn: true });
			await expect(
				harness.session.prompt("rejected", {
					preflightResult: (accepted) => rejectedPreflight.push(accepted),
				}),
			).rejects.toThrow("already processing");
			expect(preflight).toEqual([]);
			expect(rejectedPreflight).toEqual([false]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.eventsOfType("agent_settled")).toEqual([]);
			expect(idle).toBe(false);
			compactionReleased.resolve();
			expect(await run).toEqual([{ status: "fulfilled", value: undefined }]);
			await wait;
			expect(idle).toBe(true);
			expect(preflight).toEqual([true]);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")).toMatchObject([
				{ reason: "threshold", contextWindowStarted: true },
			]);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(requests).toEqual([
				[expect.stringContaining("preflight handoff"), "after-compaction", "compaction-aside", "compaction-wakeup"],
			]);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.details),
			).toEqual(["compaction-aside", "compaction-wakeup"].map((id) => ({ id })));
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.session.pendingInputCount).toBe(0);
		} finally {
			compactionReleased.resolve();
			await Promise.allSettled([run, wait]);
		}
	});
});
