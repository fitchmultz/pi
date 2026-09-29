import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type Model, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamOpenAIResponses } from "../../../ai/src/api/openai-responses.ts";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

const OVERFLOW = "prompt is too long: 300000 tokens > 128000 maximum";
const overflowResponse = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// Same public interception used by the official-host Posthorse path: the sentinel
// retains no conversation and an empty summary performs no summarization request.
function claimRollover(seen: SessionBeforeCompactEvent[] = []) {
	return (pi: ExtensionAPI) => {
		pi.on("session_before_compact", (event, ctx) => {
			if (event.reason === "manual") return;
			seen.push(event);
			pi.appendEntry("posthorse-boundary", {});
			return {
				compaction: {
					summary: "",
					firstKeptEntryId: ctx.sessionManager.getLeafId()!,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	};
}

function compactions(harness: Harness) {
	return harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
}

describe("summary-free automatic compaction through session_before_compact", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each([false, true])(
		"recovers a provider overflow on the first request (after reset: %s) without a summary request",
		async (reset) => {
			const seen: SessionBeforeCompactEvent[] = [];
			const harness = await createHarness({ tools: [], extensionFactories: [claimRollover(seen)] });
			harnesses.push(harness);
			if (reset) {
				harness.sessionManager.appendMessage({ role: "user", content: "old input", timestamp: 1 });
				harness.sessionManager.appendMessage(fauxAssistantMessage("old answer"));
				harness.sessionManager.appendCompaction("", null, 100);
				harness.session.refreshContext();
			}
			const requests: string[][] = [];
			harness.setResponses([
				overflowResponse(),
				(context) => {
					requests.push(context.messages.map(getMessageText));
					return fauxAssistantMessage("recovered");
				},
			]);
			await harness.session.prompt("new input");
			expect(seen.map(({ reason, willRetry }) => ({ reason, willRetry }))).toEqual([
				{ reason: "overflow", willRetry: true },
			]);
			expect(compactions(harness)).toHaveLength(reset ? 2 : 1);
			expect(compactions(harness).at(-1)?.summary).toBe("");
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(requests).toHaveLength(1);
			expect(requests[0]).not.toContain("new input");
			expect(requests[0]).not.toContain("old input");
			expect(harness.session.getLastAssistantText()).toBe("recovered");
		},
	);

	it("allows a physically fitting first request and delivers late preparation steering at the next boundary", async () => {
		const seen: SessionBeforeCompactEvent[] = [];
		const harness = await createHarness({
			tools: [],
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		const prepare = harness.session.agent.prepareRequest!;
		let queued = false;
		harness.session.agent.prepareRequest = async (request, signal) => {
			const prepared = await prepare(request, signal);
			if (!queued) {
				queued = true;
				await harness.session.steer("late steering");
			}
			return prepared ?? undefined;
		};
		let hooksAtRequest = -1;
		const requests: string[][] = [];
		harness.setResponses([
			(context) => {
				hooksAtRequest = seen.length;
				requests.push(context.messages.filter((message) => message.role !== "system").map(getMessageText));
				return fauxAssistantMessage("first");
			},
			(context) => {
				requests.push(context.messages.filter((message) => message.role !== "system").map(getMessageText));
				return fauxAssistantMessage("second");
			},
		]);
		await harness.session.prompt("p".repeat(60_000));
		expect(hooksAtRequest).toBe(0);
		expect(requests[0]).toEqual(["p".repeat(60_000)]);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("late steering");
		expect(harness.session.hasPendingMessages).toBe(false);
	});

	it("uses a full estimate when historical usage has no known prefix", async () => {
		const seen: SessionBeforeCompactEvent[] = [];
		const huge: AgentTool = {
			name: "huge",
			label: "Huge",
			description: "x".repeat(24_000),
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		const harness = await createHarness({
			tools: [huge],
			initialActiveToolNames: [],
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "o".repeat(36_000), timestamp: 1 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old", { timestamp: 2 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(10_000),
		});
		harness.session.refreshContext();
		harness.session.setActiveToolsByName(["huge"]);
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(15_000);
		let hooksAtRequest = 0;
		harness.setResponses([
			() => {
				hooksAtRequest = seen.length;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("new");
		expect(hooksAtRequest).toBe(1);
	});

	it("recovers a locally refused first request without sending the oversized input", async () => {
		const seen: SessionBeforeCompactEvent[] = [];
		const harness = await createHarness({ tools: [], extensionFactories: [claimRollover(seen)] });
		harnesses.push(harness);
		let sent = "";
		harness.setResponses([
			(context) => {
				sent = JSON.stringify(context.messages);
				return fauxAssistantMessage("recovered");
			},
		]);
		await harness.session.prompt("x".repeat(600_000));
		expect(seen.map(({ reason, willRetry }) => ({ reason, willRetry }))).toEqual([
			{ reason: "overflow", willRetry: true },
		]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(sent).not.toContain("x".repeat(100));
		expect(harness.session.getLastAssistantText()).toBe("recovered");
	});

	it.each(["preflight", "threshold", "overflow"] as const)(
		"preserves decorated opaque usage for %s rollover",
		async (boundary) => {
			const seen: SessionBeforeCompactEvent[] = [];
			const measured = boundary === "preflight" ? 430_000 : boundary === "threshold" ? 447_778 : 510_000;
			let responses = 0;
			const harness = await createHarness({
				tools: [],
				models: [{ id: "faux-1", contextWindow: 500_000, maxTokens: 1000 }],
				settings: { compaction: { reserveTokens: 64_000 } },
				extensionFactories: [
					claimRollover(seen),
					(pi) => {
						pi.on("context", (event) => ({
							messages: [{ role: "user", content: "Recovered todo", timestamp: 0 }, ...event.messages],
						}));
						pi.on("message_end", (event) => {
							if (event.message.role === "assistant" && responses++ === 0) event.message.usage = usage(measured);
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage([
					{ type: "thinking", thinking: "", thinkingSignature: "opaque" },
					{ type: "text", text: "completed" },
				]),
			]);
			await harness.session.prompt("original request");
			if (boundary === "preflight") {
				expect(seen).toEqual([]);
				expect(harness.session.getContextUsage()).toMatchObject({ tokens: measured, source: "reported" });
				const next = "n".repeat(28_000);
				let texts: string[] = [];
				let hooksAtRequest = 0;
				harness.setResponses([
					(context) => {
						hooksAtRequest = seen.length;
						texts = context.messages.map(getMessageText);
						return fauxAssistantMessage("next answer");
					},
				]);
				await harness.session.prompt(next);
				expect(hooksAtRequest).toBe(1);
				expect(texts).toContain(next);
				expect(texts).not.toContain("original request");
			}
			expect(seen.map(({ reason, willRetry }) => ({ reason, willRetry }))).toEqual([
				{ reason: boundary === "overflow" ? "overflow" : "threshold", willRetry: false },
			]);
			expect(compactions(harness)).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(boundary === "preflight" ? 2 : 1);
		},
	);

	it("does not duplicate an input when persistence fails after updating the journal", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const append = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message) => {
			const id = append(message);
			if (message.role === "user") throw new Error("disk full");
			return id;
		});
		await harness.session.prompt("keep this input once");
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", errorMessage: "disk full" });
	});

	it("retries overflow exactly once and reports a second failure", async () => {
		const seen: SessionBeforeCompactEvent[] = [];
		const failures: Array<string | undefined> = [];
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				claimRollover(seen),
				(pi) => {
					pi.on("session_compact_failed", (event) => {
						failures.push(event.errorMessage);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([overflowResponse(), overflowResponse(), fauxAssistantMessage("must remain unused")]);
		await harness.session.prompt("small input");
		expect(seen).toHaveLength(1);
		expect(compactions(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(failures).toEqual([expect.stringContaining("after one compact-and-retry attempt")]);
	});

	it("preserves a completed answer and rolls over without requesting another response", async () => {
		const seen: SessionBeforeCompactEvent[] = [];
		const harness = await createHarness({
			tools: [],
			models: [{ id: "small", contextWindow: 4000 }],
			settings: { compaction: { reserveTokens: 1000 } },
			extensionFactories: [
				claimRollover(seen),
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") event.message.usage = usage(3500);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed"), fauxAssistantMessage("unused")]);
		await harness.session.prompt("finish");
		expect(seen.map(({ reason, willRetry }) => ({ reason, willRetry }))).toEqual([
			{ reason: "threshold", willRetry: false },
		]);
		expect(compactions(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("completed");
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "message" && getMessageText(entry.message) === "completed"),
		).toBe(true);
	});

	it("rolls over an oversized tool result before the next provider request", async () => {
		const seen: SessionBeforeCompactEvent[] = [];
		const dump: AgentTool = {
			name: "dump",
			label: "Dump",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "r".repeat(600_000) }], details: {} }),
		};
		const harness = await createHarness({ tools: [dump], extensionFactories: [claimRollover(seen)] });
		harnesses.push(harness);
		let secondTexts: string[] = [];
		let hooksAtSecondRequest = 0;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
			(context) => {
				hooksAtSecondRequest = seen.length;
				secondTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("dump it");
		expect(hooksAtSecondRequest).toBe(1);
		expect(secondTexts.join("\n")).not.toContain("r".repeat(100));
		expect(compactions(harness)).toHaveLength(1);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each(["prompt", "steering", "custom"] as const)(
		"preserves newly admitted %s input across preflight compaction",
		async (kind) => {
			const seen: SessionBeforeCompactEvent[] = [];
			const harness = await createHarness({
				tools: [],
				models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
				settings: { compaction: { reserveTokens: 5000 } },
				extensionFactories: [claimRollover(seen)],
			});
			harnesses.push(harness);
			const pending = `NEW_REQUEST ${"q".repeat(28_000)}`;
			let hooksAtRequest = 0;
			let texts: string[] = [];
			harness.setResponses([
				() => {
					if (kind === "steering") void harness.session.steer(pending);
					return fauxAssistantMessage("first");
				},
				(context) => {
					hooksAtRequest = seen.length;
					texts = context.messages.map(getMessageText);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("p".repeat(36_000));
			if (kind === "prompt") await harness.session.prompt(pending);
			if (kind === "custom")
				await harness.session.sendCustomMessage(
					{ customType: "test", content: pending, display: true },
					{ triggerTurn: true },
				);
			expect(hooksAtRequest).toBe(1);
			expect(texts.filter((text) => text === pending)).toHaveLength(1);
			expect(texts).not.toContain("p".repeat(36_000));
			expect(compactions(harness)).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it.each(["idle", "tool result", "message_start"] as const)(
		"counts a changed tool schema at the next request (%s)",
		async (boundary) => {
			const seen: SessionBeforeCompactEvent[] = [];
			let changed = false;
			const harness = await createHarness({
				tools: [],
				models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
				settings: { compaction: { reserveTokens: 5000 } },
				extensionFactories: [
					claimRollover(seen),
					(pi) => {
						pi.registerTool({
							name: "loader",
							label: "Loader",
							description: "Load larger tool",
							parameters: Type.Object({}),
							execute: async () => {
								pi.setActiveTools(["huge"]);
								return { content: [{ type: "text", text: "loaded" }], details: {} };
							},
						});
						pi.registerTool({
							name: "huge",
							label: "Huge",
							description: "x".repeat(24_000),
							parameters: Type.Object({}),
							execute: async () => ({ content: [], details: {} }),
						});
						if (boundary === "message_start")
							pi.on("message_start", (event) => {
								if (!changed && event.message.role === "assistant") {
									changed = true;
									pi.setActiveTools(["huge"]);
								}
							});
					},
				],
			});
			harnesses.push(harness);
			harness.session.setActiveToolsByName(["loader"]);
			let hooksAtRequest = 0;
			let tools: string[] = [];
			harness.setResponses([
				boundary === "tool result"
					? fauxAssistantMessage(fauxToolCall("loader", {}), { stopReason: "toolUse" })
					: fauxAssistantMessage("first"),
				(context) => {
					hooksAtRequest = seen.length;
					tools = getCurrentTools(context.messages).map((tool) => tool.name);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("p".repeat(boundary === "tool result" ? 36_000 : 12_000));
			if (boundary === "idle") harness.session.setActiveToolsByName(["huge"]);
			if (boundary !== "tool result") await harness.session.prompt("q".repeat(28_000));
			expect(hooksAtRequest).toBe(1);
			expect(tools).toEqual(["huge"]);
			expect(compactions(harness)).toHaveLength(1);
		},
	);

	it.each([false, true])("honors cancellation while the automatic hook awaits (abort: %s)", async (abort) => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let hookSignal: AbortSignal | undefined;
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event, ctx) => {
						hookSignal = event.signal;
						entered();
						await held;
						pi.appendEntry("posthorse-boundary", {});
						return {
							compaction: {
								summary: "",
								firstKeptEntryId: ctx.sessionManager.getLeafId()!,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([overflowResponse(), fauxAssistantMessage("continued")]);
		const run = harness.session.prompt("start");
		let cancellation: Promise<void> | undefined;
		try {
			await started;
			await harness.session.steer("DO NOT LOSE");
			if (abort) cancellation = harness.session.abort();
		} finally {
			release();
			await Promise.all([run, cancellation]);
		}
		expect(hookSignal?.aborted).toBe(abort);
		expect(compactions(harness)).toHaveLength(abort ? 0 : 1);
		expect(harness.faux.state.callCount).toBe(abort ? 1 : 2);
		expect(harness.session.getSteeringMessages()).toEqual(abort ? ["DO NOT LOSE"] : []);
		expect(getUserTexts(harness).includes("DO NOT LOSE")).toBe(!abort);
		expect(harness.session.isIdle).toBe(true);
		if (abort) {
			await harness.session.prompt("continue");
			expect(getUserTexts(harness)).toContain("DO NOT LOSE");
		}
	});

	it("allows an extension compaction without summarization credentials", async () => {
		const harness = await createHarness({
			tools: [],
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event, ctx) => {
						pi.appendEntry("posthorse-boundary", {});
						return {
							compaction: {
								summary: "",
								firstKeptEntryId: ctx.sessionManager.getLeafId()!,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old input ".repeat(100), timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old response ".repeat(100)));
		harness.session.refreshContext();
		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "" });
		expect(harness.faux.state.callCount).toBe(0);
		expect(compactions(harness)).toHaveLength(1);
	});

	it("does not commit a compaction cancelled through abortCompaction in its hook", async () => {
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						await Promise.resolve();
						harness.session.abortCompaction();
						return {
							compaction: {
								summary: "must not commit",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([overflowResponse(), fauxAssistantMessage("unused")]);
		await harness.session.prompt("start");
		expect(compactions(harness)).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toMatchObject([{ aborted: true, willRetry: false }]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("reports a rollover persistence failure without dispatching the retry", async () => {
		const failures: Array<string | undefined> = [];
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				claimRollover(),
				(pi) => {
					pi.on("session_compact_failed", (event) => {
						failures.push(event.errorMessage);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start")
				vi.spyOn(harness.sessionManager, "appendCompaction").mockImplementation(() => {
					throw new Error("disk full");
				});
		});
		harness.setResponses([overflowResponse(), fauxAssistantMessage("must not dispatch")]);
		await harness.session.prompt("start");
		expect(harness.faux.state.callCount).toBe(1);
		expect(failures).toEqual([expect.stringContaining("disk full")]);
	});

	it("ignores kept pre-compaction usage after resume", async () => {
		const seen: SessionBeforeCompactEvent[] = [];
		const harness = await createHarness({
			tools: [],
			models: [{ id: "small", contextWindow: 200_000 }],
			extensionFactories: [claimRollover(seen)],
		});
		harnesses.push(harness);
		const kept = harness.sessionManager.appendMessage({
			role: "user",
			content: "retained",
			timestamp: Date.now() - 3000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old", { timestamp: Date.now() - 2000 }),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
			usage: usage(190_000),
		});
		harness.sessionManager.appendCompaction("summary", kept, 190_000);
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("next");
		expect(seen).toEqual([]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["forced prompt", "context", "tools", "conversion"] as const)(
		"refuses physical overflow after final %s transformation when compaction is disabled",
		async (source) => {
			const oversized = "x".repeat(200_000);
			const harness = await createHarness({
				tools: [],
				models: [{ id: "small", contextWindow: 40_000, maxTokens: 1000 }],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						if (source === "forced prompt") pi.on("before_agent_start", () => ({ systemPrompt: oversized }));
						if (source === "context")
							pi.on("context", (event) => ({
								messages: [{ role: "user", content: oversized, timestamp: 1 }, ...event.messages],
							}));
						if (source === "tools")
							pi.on("context_with_system", (event) => ({
								messages: [
									{
										role: "system",
										content: "",
										toolsAdded: [{ name: "large", description: oversized, parameters: Type.Object({}) }],
										timestamp: 1,
									},
									...event.messages.filter((message) => message.role !== "system"),
								],
							}));
					},
				],
			});
			harnesses.push(harness);
			if (source === "conversion") {
				const convert = harness.session.agent.convertToLlm;
				harness.session.agent.convertToLlm = async (messages) => [
					{ role: "user", content: oversized, timestamp: 1 },
					...(await convert(messages)),
				];
			}
			harness.setResponses([fauxAssistantMessage("must not dispatch")]);
			await harness.session.prompt("fitting input");
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.state.errorMessage).toMatch(/Estimated provider input .* exceeds .*context window/);
		},
	);

	it.each([false, true])(
		"budgets section and tool replacement using provider positional capabilities (%s)",
		async (supportsMidConvoSystemMessages) => {
			const harness = await createHarness({
				tools: [],
				models: [{ id: "small", contextWindow: 40_000, maxTokens: 1000 }],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("context_with_system", (event) => ({
							messages: [
								{
									role: "system",
									content: "",
									sections: { policy: `OLD_LARGE_SECTION ${"x".repeat(200_000)}` },
									toolsAdded: [{ name: "old", description: "OLD_LARGE_TOOL", parameters: Type.Object({}) }],
									timestamp: 1,
								},
								...event.messages.filter((message) => message.role !== "system"),
								{
									role: "system",
									content: "",
									sections: { policy: "CURRENT_SMALL_SECTION" },
									toolsRemoved: [{ name: "old" }],
									timestamp: 2,
								},
							],
						}));
					},
				],
			});
			harnesses.push(harness);
			const model: Model<"openai-responses"> = {
				...harness.getModel(),
				api: "openai-responses",
				baseUrl: "https://offline.invalid/v1",
				compat: { supportsMidConvoSystemMessages },
			};
			harness.session.agent.state.model = model;
			const payloads: string[] = [];
			harness.session.agent.streamFunction = (_model, context, options) =>
				streamOpenAIResponses(model, context, {
					...options,
					apiKey: "offline-placeholder",
					transport: "sse",
					maxRetries: 0,
					fetch: async (_url, init) => {
						payloads.push(String(init?.body));
						return new Response(
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				});
			await harness.session.prompt("Fitting current instructions");
			expect(payloads).toHaveLength(supportsMidConvoSystemMessages ? 0 : 1);
			if (supportsMidConvoSystemMessages)
				expect(harness.session.state.errorMessage).toMatch(/Estimated provider input .* exceeds .*context window/);
			else {
				expect(payloads[0]).toContain("CURRENT_SMALL_SECTION");
				expect(payloads[0]).not.toContain("OLD_LARGE");
				expect(harness.session.state.errorMessage).toBeUndefined();
			}
		},
	);

	it("falls through to default summarization when an automatic hook declines", async () => {
		const reasons: string[] = [];
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						reasons.push(event.reason);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("old answer"),
			overflowResponse(),
			fauxAssistantMessage("generated summary"),
			fauxAssistantMessage("continued"),
		]);
		await harness.session.prompt("old request");
		await harness.session.prompt("new request");
		expect(reasons).toEqual(["overflow"]);
		expect(compactions(harness).at(-1)?.summary).toContain("generated summary");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
