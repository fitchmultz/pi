import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function normalizeEventOrder(events: Harness["events"]): string[] {
	const normalized: string[] = [];
	for (const event of events) {
		const label =
			event.type === "message_start" || event.type === "message_end"
				? `${event.type}:${event.message.role}`
				: event.type === "tool_execution_start" ||
						event.type === "tool_execution_prepared" ||
						event.type === "tool_execution_end"
					? `${event.type}:${event.toolName}`
					: event.type;
		if (label === "message_update" && normalized[normalized.length - 1] === "message_update") {
			continue;
		}
		normalized.push(label);
	}
	return normalized;
}

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries after a transient error and succeeds", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "end:true"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("retries multiple transient failures and succeeds on the final attempt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("success"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:true"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it.each(["thinking", "text", "synchronous call"] as const)(
		"omits a failed ordinary response with completed %s before retrying, keeping the raw journal",
		async (completed) => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
			});
			harnesses.push(harness);
			const failed = fauxAssistantMessage(
				[
					completed === "thinking"
						? { type: "thinking", thinking: "plan", thinkingSignature: "signed-thinking" }
						: completed === "text"
							? { type: "text", text: "completed block", textSignature: "signed-text" }
							: {
									type: "toolCall",
									id: "call|fc_call",
									name: "work",
									arguments: {},
									responsesItem: {
										type: "function_call",
										id: "fc_call",
										call_id: "call",
										name: "work",
										arguments: "{}",
										status: "completed",
									},
								},
					{ type: "text", text: "unfinished answer" },
				],
				{ stopReason: "error", errorMessage: "terminated" },
			);
			let retryMessages: unknown;
			harness.setResponses([
				failed,
				(context) => {
					retryMessages = structuredClone(context.messages);
					return fauxAssistantMessage("recovered");
				},
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(2);
			expect(retryMessages).toEqual([
				expect.objectContaining({ role: "system" }),
				expect.objectContaining({ role: "user" }),
			]);
			expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1 }]);
			expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
			expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
			expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
			const entries = harness.sessionManager.getEntries();
			const attempt = entries.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
			expect(attempt).toMatchObject({ message: { content: failed.content } });
			expect(entries.filter((entry) => entry.type === "context_edit")).toMatchObject([
				{ targetId: attempt?.id, replacement: null },
			]);
			expect(harness.sessionManager.buildSessionProjection().messages).toEqual(harness.session.messages);
			expect(harness.session.getLastAssistantText()).toBe("recovered");
			expect(harness.session.retryAttempt).toBe(0);
		},
	);

	// Regression test for #9340.
	it("finalizes retry state when abort is requested after a retry attempt fails", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		let errorCount = 0;
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (event.message.stopReason === "error" && ++errorCount === 2) void harness.session.abort();
		});

		await harness.session.prompt("test");

		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.eventsOfType("agent_end").at(-1)?.willRetry).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			attempt: 1,
			finalError: "Retry cancelled",
		});
	});

	it("exhausts max retries and emits a failure event", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:false"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it.each([false, true])(
		"awaits retry extension handlers and resets before the next prompt (exhausted=%s)",
		async (exhausted) => {
			const order: string[] = [];
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
				extensionFactories: [
					(pi) => {
						pi.on("auto_retry_start", async (event) => {
							await new Promise((resolve) => setTimeout(resolve, 5));
							order.push(`start:${event.attempt}/${event.maxAttempts}`);
						});
						pi.on("auto_retry_end", async (event) => {
							await new Promise((resolve) => setTimeout(resolve, 5));
							order.push(`end:${event.attempt}:${event.success}`);
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start" || event.type === "auto_retry_end")
					order.push(`public:${event.type}`);
			});
			harness.setResponses(
				[1, 2, 3, 4].map((request) => () => {
					order.push(`request:${request}`);
					return request < 3 || (exhausted && request === 3)
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })
						: fauxAssistantMessage("recovered");
				}),
			);

			await harness.session.prompt("test");
			expect(harness.session.retryAttempt).toBe(0);
			await harness.session.prompt("next prompt");

			expect(order).toEqual([
				"request:1",
				"start:1/2",
				"public:auto_retry_start",
				"request:2",
				"start:2/2",
				"public:auto_retry_start",
				"request:3",
				`end:2:${!exhausted}`,
				"public:auto_retry_end",
				"request:4",
			]);
		},
	);

	it("cancels while an async retry extension handler is pending", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false;
		const ended: boolean[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("auto_retry_start", async () => {
						entered = true;
						await gate;
					});
					pi.on("auto_retry_end", async (event) => {
						await new Promise((resolve) => setTimeout(resolve, 5));
						ended.push(event.success);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not run"),
		]);
		const prompt = harness.session.prompt("test");
		try {
			await vi.waitFor(() => expect(entered).toBe(true));
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.isRetrying).toBe(true);
			const aborted = harness.session.abort();
			release();
			await aborted;
			await prompt;
			expect(harness.faux.state.callCount).toBe(1);
			expect(ended).toEqual([false]);
			expect(harness.session.retryAttempt).toBe(0);
		} finally {
			release();
			await prompt;
		}
	});

	it("does not retry when retry is disabled", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not retry non-retryable errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("cancels retry sleep when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("test");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("waits for the full loop and retry reset when recovery produces tool calls", async () => {
		const toolRuns: string[] = [];
		const attemptsAtRequest: number[] = [];
		let retryAttempt = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("auto_retry_start", (event) => {
						retryAttempt = event.attempt;
					});
					pi.on("auto_retry_end", async () => {
						await new Promise((resolve) => setTimeout(resolve, 5));
						retryAttempt = 0;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			() => {
				attemptsAtRequest.push(retryAttempt);
				return fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" });
			},
			() => {
				attemptsAtRequest.push(retryAttempt);
				return fauxAssistantMessage("final answer");
			},
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toEqual(["hello"]);
		expect(attemptsAtRequest).toEqual([1, 0]);
		expect(harness.session.isStreaming).toBe(false);
		await harness.session.prompt("follow-up");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("emits extension events before public event subscribers", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
					pi.on("message_end", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end") {
				order.push(`public:${event.type}:${event.message.role}`);
			}
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(order).toEqual([
			"extension:message_start:system",
			"public:message_start:system",
			"extension:message_end:system",
			"public:message_end:system",
			"extension:message_start:user",
			"public:message_start:user",
			"extension:message_end:user",
			"public:message_end:user",
			"extension:message_start:assistant",
			"public:message_start:assistant",
			"extension:message_end:assistant",
			"public:message_end:assistant",
		]);
	});

	it("emits the expected event order for a single prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:system",
			"message_end:system",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits the expected event order for a tool call turn", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(toolRuns).toEqual(["hello"]);
		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:system",
			"message_end:system",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"tool_execution_start:echo",
			"tool_execution_prepared:echo",
			"tool_execution_end:echo",
			"message_start:toolResult",
			"message_end:toolResult",
			"turn_end",
			"turn_start",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits streaming deltas for text, thinking, and tool calls in message_update events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("plan"), { type: "text", text: "answer" }, fauxToolCall("echo", { text: "hello" })],
				{
					stopReason: "toolUse",
				},
			),
		]);

		await harness.session.prompt("hi").catch(() => {});

		const updateTypes = harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type);
		expect(updateTypes).toContain("thinking_delta");
		expect(updateTypes).toContain("text_delta");
		expect(updateTypes).toContain("toolcall_delta");
	});

	it("emits agent_end for error responses", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken" })]);

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
	});

	it("emits agent_end for aborted runs and persists the aborted assistant message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
