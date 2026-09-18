import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionRunner, InputEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointActivity } from "../../src/core/checkpoint.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

async function createWaitingHarness(
	options: {
		tools?: AgentTool[];
		extensionFactories?: Harness["session"]["extensionRunner"] extends never
			? never
			: Array<(pi: ExtensionAPI) => void>;
	} = {},
): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

function expectRetainedNotice(harness: Harness): void {
	const notices = harness.session.messages.filter((message) => message.role === "custom");
	expect(notices).toHaveLength(1);
	expect(notices[0]).toMatchObject({
		customType: "retained-notice",
		content: "finished",
		display: true,
		details: { value: 1 },
	});
	const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		customType: "retained-notice",
		content: "finished",
		display: true,
		details: { value: 1 },
	});
	for (const type of ["message_start", "message_end"] as const) {
		const events = harness.eventsOfType(type).filter((event) => event.message.role === "custom");
		expect(events).toHaveLength(1);
		expect(harness.events.indexOf(events[0])).toBeLessThan(
			harness.events.findIndex((event) => event.type === "agent_settled"),
		);
	}
}

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each(["event", "shortcut"] as const)("reports only native steering through the %s context", async (source) => {
		let shortcutContext: ExtensionContext | undefined;
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					pi.registerShortcut("ctrl+shift+y", {
						handler: (ctx) => {
							shortcutContext = ctx;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		try {
			const view = Object.assign(Object.create(InteractiveMode.prototype), {
				runtimeHost: { session: harness.session },
				checkpointUIActivity: new CheckpointActivity(),
				keybindings: new KeybindingsManager(),
				defaultEditor: {},
			}) as {
				setupExtensionShortcuts(runner: ExtensionRunner): void;
				defaultEditor: { onExtensionShortcut(data: string): boolean };
			};
			if (source === "shortcut") {
				view.setupExtensionShortcuts(harness.session.extensionRunner);
				expect(view.defaultEditor.onExtensionShortcut("\u001b[121;6u")).toBe(true);
			}
			const ctx = source === "shortcut" ? shortcutContext! : harness.session.extensionRunner.createContext();
			expect(ctx.hasPendingSteeringMessages()).toBe(false);
			for (const custom of [false, true]) {
				for (const deliverAs of ["followUp", "steer"] as const) {
					if (custom)
						await harness.session.sendCustomMessage(
							{ customType: "queue-test", content: deliverAs, display: true },
							{ deliverAs },
						);
					else await harness.session[deliverAs](deliverAs);
					expect(ctx.hasPendingMessages()).toBe(true);
					expect(ctx.hasPendingSteeringMessages()).toBe(deliverAs === "steer");
				}
				harness.session.clearQueue();
				expect(ctx.hasPendingMessages()).toBe(false);
				expect(ctx.hasPendingSteeringMessages()).toBe(false);
			}
			await harness.session.steer("delivered");
			expect(ctx.hasPendingSteeringMessages()).toBe(true);
			releaseToolExecution();
			await promptPromise;
			expect(getUserTexts(harness)).toEqual(["start", "delivered"]);
			expect(ctx.hasPendingSteeringMessages()).toBe(false);
		} finally {
			releaseToolExecution();
			await promptPromise;
		}
	});

	it("dispatches extension commands immediately when prompted while idle", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
	});

	it("delivers extension-origin steering messages before the next LLM call", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "steer now",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("steer now", { deliverAs: "steer" });
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer now"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});

	it("delivers follow-up messages only after the current run finishes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const assistantSeenBeforeFollowUp: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				assistantSeenBeforeFollowUp.push(
					...context.messages
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						),
				);
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("after current run");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "after current run"]);
		expect(assistantSeenBeforeFollowUp).toContain("");
		expect(getAssistantTexts(harness)).toContain("follow-up response");
	});

	// Regression test for #8718.
	it("runs direct and prompted queues through input handlers exactly once with pending ownership and images", async () => {
		const inputEvents: Array<Pick<InputEvent, "text" | "source" | "streamingBehavior" | "images">> = [];
		const pendingCounts: number[] = [];
		const images: ImageContent[] = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
		const transformedImages: ImageContent[] = [{ type: "image", data: "bmV3", mimeType: "image/png" }];
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event, ctx) => {
						inputEvents.push({
							text: event.text,
							source: event.source,
							streamingBehavior: event.streamingBehavior,
							images: event.images,
						});
						pendingCounts.push(ctx.getPendingInputCount());
						if (event.text.startsWith("handle")) return { action: "handled" };
						return {
							action: "transform",
							text: `transformed: ${event.text}`,
							images: event.text === "follow me" ? transformedImages : undefined,
						};
					});
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("steered"),
			fauxAssistantMessage("prompted steer"),
			fauxAssistantMessage("followed up"),
		]);

		await waitForToolStart;
		inputEvents.length = 0;
		pendingCounts.length = 0;
		try {
			await harness.session.steer("steer me", images, { source: "rpc" });
			await harness.session.steer("handle steer", undefined, { source: "rpc" });
			await harness.session.followUp("follow me", images, { source: "rpc" });
			await harness.session.followUp("handle follow", undefined, { source: "rpc" });
			await harness.session.prompt("prompt me", { source: "rpc", streamingBehavior: "steer", images });

			expect(inputEvents).toEqual([
				{ text: "steer me", source: "rpc", streamingBehavior: "steer", images },
				{ text: "handle steer", source: "rpc", streamingBehavior: "steer", images: undefined },
				{ text: "follow me", source: "rpc", streamingBehavior: "followUp", images },
				{ text: "handle follow", source: "rpc", streamingBehavior: "followUp", images: undefined },
				{ text: "prompt me", source: "rpc", streamingBehavior: "steer", images },
			]);
			expect(pendingCounts).toEqual([1, 1, 1, 1, 1]);
			expect(harness.session.pendingInputCount).toBe(0);
			expect(harness.session.getSteeringMessages()).toEqual(["transformed: steer me", "transformed: prompt me"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["transformed: follow me"]);
		} finally {
			releaseToolExecution();
		}
		await promptPromise;
		for (const [text, expectedImages] of [
			["transformed: steer me", images],
			["transformed: follow me", transformedImages],
			["transformed: prompt me", images],
		] as const) {
			expect(harness.session.messages.find((message) => getMessageText(message) === text)).toMatchObject({
				role: "user",
				content: [{ type: "text", text }, ...expectedImages],
			});
		}
	});

	it("delivers multiple steering messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "handled steer 1", "handled steer 2"]);
	});

	it("delivers multiple follow-up messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("handled follow-up 1"),
			fauxAssistantMessage("handled follow-up 2"),
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"original turn complete",
			"handled follow-up 1",
			"handled follow-up 2",
		]);
	});

	it("delivers all steering messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched steer response");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "batched steer response"]);
	});

	it("delivers all follow-up messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "original turn complete", "batched follow-up response"]);
	});

	it.each([undefined, true])(
		"queues custom steer messages normally with persistOnCancel=%s",
		async (persistOnCancel) => {
			const waiting = await createWaitingHarness();
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			let sawCustomMessage = false;

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				(context) => {
					sawCustomMessage = context.messages.some(
						(message) =>
							message.role === "user" &&
							typeof message.content !== "string" &&
							message.content.some((part) => part.type === "text" && part.text === "steer custom"),
					);
					return fauxAssistantMessage("done");
				},
			]);

			await waitForToolStart;
			await harness.session.sendCustomMessage(
				{ customType: "queue-test", content: "steer custom", display: true, details: { value: 1 } },
				{ deliverAs: "steer", persistOnCancel },
			);
			releaseToolExecution();
			await promptPromise;

			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
			expect(harness.eventsOfType("message_end").filter((event) => event.message.role === "custom")).toHaveLength(1);
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(sawCustomMessage).toBe(true);
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "queue-test",
				),
			).toBe(true);
		},
	);

	it.each([undefined, true])(
		"queues custom followUp messages normally with persistOnCancel=%s",
		async (persistOnCancel) => {
			const waiting = await createWaitingHarness();
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			let sawCustomMessage = false;

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("original turn complete"),
				(context) => {
					sawCustomMessage = context.messages.some(
						(message) =>
							message.role === "user" &&
							typeof message.content !== "string" &&
							message.content.some((part) => part.type === "text" && part.text === "follow-up custom"),
					);
					return fauxAssistantMessage("done");
				},
			]);

			await waitForToolStart;
			await harness.session.sendCustomMessage(
				{ customType: "queue-test", content: "follow-up custom", display: true, details: { value: 1 } },
				{ deliverAs: "followUp", persistOnCancel },
			);
			releaseToolExecution();
			await promptPromise;

			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
			expect(harness.eventsOfType("message_end").filter((event) => event.message.role === "custom")).toHaveLength(1);
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(sawCustomMessage).toBe(true);
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "queue-test",
				),
			).toBe(true);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"reports custom %s messages retained by abort until clearQueue drains them",
		async (deliverAs) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const ctx = harness.session.extensionRunner.createContext();
			let queued = false;
			harness.setResponses([
				async () => {
					await harness.session.sendCustomMessage(
						{ customType: "queue-test", content: "retained", display: true },
						{ deliverAs },
					);
					queued = ctx.hasPendingMessages();
					ctx.abort();
					return fauxAssistantMessage("cancelled");
				},
			]);
			await harness.session.prompt("start");

			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(queued).toBe(true);
			expect(ctx.hasPendingMessages()).toBe(true);
			expect(ctx.hasPendingSteeringMessages()).toBe(deliverAs === "steer");
			expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
			expect(ctx.hasPendingMessages()).toBe(false);
			expect(ctx.hasPendingSteeringMessages()).toBe(false);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"persists opted-in %s notices before settlement when cancelled before queue drain",
		async (deliverAs) => {
			let queued = false;
			const settledNotices: number[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", (_event, ctx) => {
							if (queued) return;
							queued = true;
							pi.sendMessage(
								{ customType: "retained-notice", content: "finished", display: true, details: { value: 1 } },
								{ deliverAs, triggerTurn: true, persistOnCancel: true },
							);
							ctx.abort();
						});
						pi.on("agent_settled", (_event, ctx) => {
							settledNotices.push(
								ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length,
							);
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("resumed")]);
			// Queue unrelated user inputs behind the first request, not before its initial steering poll.
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
					void harness.session.steer("user steer");
					void harness.session.followUp("user follow-up");
				}
			});
			await harness.session.prompt("start");

			expect(harness.session.isIdle).toBe(true);
			expect(settledNotices).toEqual([1]);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.getSteeringMessages()).toEqual(["user steer"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["user follow-up"]);
			expect(harness.session.clearQueue()).toEqual({ steering: ["user steer"], followUp: ["user follow-up"] });
			expect(harness.session.hasPendingMessages).toBe(false);
			expectRetainedNotice(harness);
			await harness.session.prompt("resume");
			expectRetainedNotice(harness);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"recovers opted-in %s notices drained before cancellation in next-turn preparation",
		async (deliverAs) => {
			let sent = false;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", () => {
							if (sent) return;
							sent = true;
							pi.sendMessage(
								{ customType: "retained-notice", content: "finished", display: true, details: { value: 1 } },
								{ deliverAs, persistOnCancel: true },
							);
						});
					},
				],
			});
			harnesses.push(harness);
			const prepare = harness.session.agent.prepareNextTurnWithContext;
			let prepared = false;
			harness.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
				prepared = true;
				expect(harness.session.hasPendingMessages).toBe(false);
				expect(harness.eventsOfType("message_end").filter((event) => event.message.role === "custom")).toHaveLength(
					0,
				);
				harness.session.agent.abort();
				await prepare?.(turn, signal);
				// Real abort-aware preparation fails before the loop can emit message_end.
				signal?.throwIfAborted();
				return undefined;
			};
			harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
			await harness.session.prompt("start");

			expect(prepared).toBe(true);
			expectRetainedNotice(harness);
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
			expectRetainedNotice(harness);
		},
	);

	it("clearQueue preserves only queued opted-in notices after all tool results, without waking", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		await waitForToolStart;
		try {
			await harness.session.steer("user steer");
			await harness.session.followUp("user follow-up");
			await harness.session.sendCustomMessage(
				{ customType: "retained-notice", content: "finished", display: true, details: { value: 1 } },
				{ deliverAs: "followUp", persistOnCancel: true },
			);
			await harness.session.sendCustomMessage({ customType: "discarded", content: "ordinary", display: true });
			await harness.session.sendCustomMessage(
				{ customType: "deferred", content: "next prompt", display: true },
				{ deliverAs: "nextTurn", persistOnCancel: true },
			);
			expect(harness.session.clearQueue()).toEqual({ steering: ["user steer"], followUp: ["user follow-up"] });
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
			harness.session.agent.abort();
		} finally {
			releaseToolExecution();
		}
		await promptPromise;
		expectRetainedNotice(harness);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"custom",
		]);
		expect(harness.session.pendingNextTurnCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.session.clearQueue();
		expectRetainedNotice(harness);
	});

	it("preserves opted-in notices at final shutdown stop without a cancelled agent signal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.subscribe(async (event, signal) => {
			if (event.type !== "turn_end") return;
			await harness.session.sendCustomMessage(
				{ customType: "retained-notice", content: "finished", display: true, details: { value: 1 } },
				{ persistOnCancel: true },
			);
			harness.session.beginShutdown();
			expect(signal.aborted).toBe(false);
		});
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("start");
		expectRetainedNotice(harness);
		expect(harness.session.hasPendingMessages).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("flushes delivered provider messages before undelivered opted-in notices at final cleanup", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						if (sent) return;
						sent = true;
						for (const content of ["delivered", "undelivered"]) {
							pi.sendMessage({ customType: "notice", content, display: true }, { persistOnCancel: true });
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const prepare = harness.session.agent.prepareProviderRequest;
		let cancelled = false;
		harness.session.agent.prepareProviderRequest = async (context, signal) => {
			if (context.messages.some((message) => getMessageText(message) === "delivered")) {
				cancelled = true;
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(
					0,
				);
				harness.session.agent.abort();
				signal?.throwIfAborted();
			}
			return prepare?.(context, signal);
		};
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("start");
		expect(cancelled).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message")
				.map((entry) => entry.content),
		).toEqual(["delivered", "undelivered"]);
		expect(harness.session.messages.filter((message) => message.role === "custom").map(getMessageText)).toEqual([
			"delivered",
			"undelivered",
		]);
		expect(
			harness
				.eventsOfType("message_end")
				.filter((event) => event.message.role === "custom")
				.map((event) => getMessageText(event.message)),
		).toEqual(["delivered", "undelivered"]);
		expect(harness.session.hasPendingMessages).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.session.clearQueue();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(2);
	});

	it("clearQueue does not take a drained opted-in notice that can still deliver normally", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						if (sent) return;
						sent = true;
						pi.sendMessage(
							{ customType: "retained-notice", content: "finished", display: true, details: { value: 1 } },
							{ persistOnCancel: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		const prepare = harness.session.agent.prepareNextTurnWithContext;
		let prepared = false;
		harness.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
			prepared = true;
			expect(harness.session.hasPendingMessages).toBe(false);
			expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
			return prepare?.(turn, signal);
		};
		harness.setResponses([
			fauxAssistantMessage("done"),
			(context) => {
				expect(context.messages.filter((message) => getMessageText(message) === "finished")).toHaveLength(1);
				return fauxAssistantMessage("saw notice");
			},
		]);
		await harness.session.prompt("start");
		expect(prepared).toBe(true);
		expectRetainedNotice(harness);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		harness.session.clearQueue();
		expectRetainedNotice(harness);
	});

	it("does not count context-only custom messages as pending steering/follow-up work", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const ctx = harness.session.extensionRunner.createContext();

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "context-only", content: "aside", display: true },
			{ triggerTurn: false },
		);
		const queued = ctx.hasPendingMessages();
		expect(ctx.hasPendingSteeringMessages()).toBe(false);
		releaseToolExecution();
		await promptPromise;

		expect(queued).toBe(false);
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(true);
	});

	it.each([undefined, true])("keeps nextTurn deferred with persistOnCancel=%s", async (persistOnCancel) => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;
		const ctx = harness.session.extensionRunner.createContext();
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(ctx.getPendingNextTurnCount()).toBe(0);

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn", persistOnCancel },
		);
		expect(ctx.getPendingNextTurnCount()).toBe(1);
		expect(ctx.isIdle()).toBe(true);
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(ctx.hasPendingSteeringMessages()).toBe(false);
		expect(harness.session.pendingMessageCount).toBe(0);
		harness.session.clearQueue();
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(ctx.getPendingNextTurnCount()).toBe(1);

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(ctx.getPendingNextTurnCount()).toBe(0);
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"custom",
			"assistant",
		]);
	});

	it("updates pendingMessageCount and removes queued text before message_start is emitted", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const countsAtQueuedMessageStart: number[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued"
			) {
				countsAtQueuedMessageStart.push(harness.session.pendingMessageCount);
			}
		});

		await waitForToolStart;
		await harness.session.steer("queued");
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution();
		await promptPromise;

		expect(countsAtQueuedMessageStart).toEqual([0]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("throws when queueing an extension command with steer", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.steer("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("throws when queueing an extension command with followUp", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.followUp("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("delivers follow-ups queued during agent_end", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						pi.sendUserMessage("conflict report", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", "conflict report"]);
	});
});
