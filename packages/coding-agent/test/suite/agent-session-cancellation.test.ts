import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("admitted session cancellation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each(["before_agent_start", "agent_before_settle"] as const)(
		"cancels cooperative %s work through ctx.signal",
		async (phase) => {
			const entered = deferred();
			const released = deferred();
			let signal: AbortSignal | undefined;
			let cancelled = false;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						const hold = async (_event: unknown, ctx: ExtensionContext) => {
							signal = ctx.signal;
							signal?.addEventListener(
								"abort",
								() => {
									cancelled = true;
									released.resolve();
								},
								{ once: true },
							);
							entered.resolve();
							await released.promise;
						};
						if (phase === "before_agent_start") pi.on("before_agent_start", hold);
						else pi.on("agent_before_settle", hold);
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done")]);
			const run = Promise.allSettled([harness.session.prompt("start")]);
			await entered.promise;
			let aborted = false;
			const abort = harness.session.abort().then(() => {
				aborted = true;
			});
			try {
				await setImmediate();
				expect(signal).toBeDefined();
				expect(cancelled).toBe(true);
				expect(aborted).toBe(true);
				expect(await run).toEqual(
					phase === "before_agent_start"
						? [{ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }]
						: [{ status: "fulfilled", value: undefined }],
				);
				expect(harness.faux.state.callCount).toBe(phase === "before_agent_start" ? 0 : 1);
			} finally {
				released.resolve();
				await Promise.all([run, abort]);
			}
		},
	);

	it.each(["before_agent_start", "provider", "turn_end", "agent_before_settle", "agent_settled"] as const)(
		"joins uncooperative %s work after abort, including a fresh idle waiter",
		async (phase) => {
			const entered = deferred();
			const released = deferred();
			let context: ExtensionContext | undefined;
			let signal: AbortSignal | undefined;
			const hold = async () => {
				signal = context?.signal;
				entered.resolve();
				await released.promise;
			};
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", (_event, ctx) => {
							context = ctx;
						});
						if (phase === "before_agent_start") pi.on("before_agent_start", hold);
						else if (phase === "turn_end") pi.on("turn_end", hold);
						else if (phase === "agent_before_settle") pi.on("agent_before_settle", hold);
						else if (phase === "agent_settled") pi.on("agent_settled", hold);
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					if (phase === "provider") await hold();
					return fauxAssistantMessage("done");
				},
			]);
			const run = Promise.allSettled([harness.session.prompt("start")]);
			await entered.promise;
			const completed: string[] = [];
			const abort = harness.session.abort().then(() => {
				completed.push("abort");
			});
			const idle = harness.session.waitForIdle().then(() => {
				completed.push("idle");
			});
			try {
				await setImmediate();
				expect(completed).toEqual([]);
				if (phase === "agent_settled") expect(signal).toBeUndefined();
				else expect(signal?.aborted).toBe(true);
			} finally {
				released.resolve();
				await Promise.all([run, abort, idle]);
			}
			expect(completed).toEqual(["idle", "abort"]);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it.each([false, true])(
		"lets a deferred command join child work without releasing external idle waits (child run: %s)",
		async (childRun) => {
			const commandEntered = deferred();
			const commandRelease = deferred();
			const childEntered = deferred();
			const childRelease = deferred();
			let queued = false;
			let commandIdle = false;
			let externalIdle = false;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.registerCommand("wait-command", {
							handler: async (_args, ctx) => {
								commandEntered.resolve();
								const child = childRun ? harness.session.prompt("child") : undefined;
								if (child) await childEntered.promise;
								await ctx.waitForIdle();
								commandIdle = true;
								await child;
								await commandRelease.promise;
							},
						});
						pi.on("agent_settled", () => {
							if (queued) return;
							queued = true;
							pi.sendUserMessage("/wait-command", { expandPromptTemplates: true });
							pi.sendMessage(
								{ customType: "later", content: "later run", display: false },
								{ triggerTurn: true },
							);
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.extensionRunner.bindCommandContext({
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			});
			harness.setResponses([fauxAssistantMessage("first")]);
			if (childRun) {
				harness.appendResponses([
					async () => {
						childEntered.resolve();
						await childRelease.promise;
						return fauxAssistantMessage("child done");
					},
				]);
			}
			harness.appendResponses([fauxAssistantMessage("later done")]);
			const run = harness.session.prompt("start");
			try {
				await commandEntered.promise;
				const idle = harness.session.waitForIdle().then(() => {
					externalIdle = true;
				});
				if (childRun) {
					await childEntered.promise;
					await setImmediate();
					expect(commandIdle).toBe(false);
					expect(externalIdle).toBe(false);
					childRelease.resolve();
				}
				await setImmediate();
				expect(commandIdle).toBe(true);
				expect(externalIdle).toBe(false);
				expect(harness.faux.state.callCount).toBe(childRun ? 2 : 1);
				commandRelease.resolve();
				await Promise.all([run, idle]);
				expect(externalIdle).toBe(true);
				expect(harness.faux.state.callCount).toBe(childRun ? 3 : 2);
			} finally {
				childRelease.resolve();
				commandRelease.resolve();
			}
		},
	);

	it("retains one signal across native continuations, then clears it for settlement", async () => {
		const signals: Array<AbortSignal | undefined> = [];
		let settledSignal: AbortSignal | undefined;
		let continued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						signals.push(ctx.signal);
					});
					pi.on("agent_start", (_event, ctx) => {
						signals.push(ctx.signal);
					});
					pi.on("agent_before_settle", (_event, ctx) => {
						signals.push(ctx.signal);
						if (continued) return;
						continued = true;
						return {
							entries: [{ type: "custom_message", customType: "next", content: "continue", display: false }],
							continue: true,
						};
					});
					pi.on("agent_settled", (_event, ctx) => {
						settledSignal = ctx.signal;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("start");
		expect(signals).toHaveLength(5);
		expect(signals[0]).toBeDefined();
		expect(signals.every((signal) => signal === signals[0])).toBe(true);
		expect(settledSignal).toBeUndefined();
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("keeps pre-admission input outside active-run cancellation", async () => {
		const entered = deferred();
		const released = deferred();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (_event, ctx) => {
						signal = ctx.signal;
						entered.resolve();
						await released.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("admitted later")]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			expect(signal).toBeUndefined();
			await harness.session.abort();
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			released.resolve();
			await run;
		}
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("propagates low-level abort to the extension signal", async () => {
		const entered = deferred();
		const released = deferred();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async (_event, ctx) => {
						signal = ctx.signal;
						entered.resolve();
						await released.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			harness.session.agent.abort();
			expect(signal?.aborted).toBe(true);
		} finally {
			released.resolve();
			await run;
		}
	});
});
