import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionConfig } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
};

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: {
		failCount?: number;
		maxRetries?: number;
		maxAgentDelayMs?: number;
		delayAssistantMessageEndMs?: number;
		errors?: Partial<AssistantMessage>[];
		extensions?: ExtensionFactory[];
		cacheWarmer?: AgentSessionConfig["cacheWarmer"];
	}) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const maxAgentDelayMs = options?.maxAgentDelayMs ?? 60000;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
							...options?.errors?.[callCount - 1],
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries, baseDelayMs: 1, maxAgentDelayMs } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({
				extensionsResult: await createTestExtensionsResult(options?.extensions ?? [], tempDir),
			}),
			cacheWarmer: options?.cacheWarmer,
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	it.each([false, true])(
		"stops monitoring-blocked continuation and preserves queued input (pending new context: %s)",
		async (requestNewContext) => {
			const beforeSettle = vi.fn(() => ({ continue: true }));
			const cancelWarming = vi.fn();
			const providerError = {
				code: "misalignment_policy_violation",
				type: "invalid_request_error",
				status: 403,
				requestId: "req_blocked",
				responseId: "resp_blocked",
			};
			const created = await createSession({
				errors: [{ providerError, errorMessage: "overloaded_error: context length exceeded" }],
				cacheWarmer: {
					cancel: cancelWarming,
					status: { state: "scheduled" },
					onAgentSettled: vi.fn(),
					onModeChanged: vi.fn(),
				},
				extensions: [
					(pi) => {
						pi.on("agent_end", async () => {
							if (requestNewContext) session.newContext({ handoff: "Pending handoff" });
							await session.steer("Keep this steering input");
							await session.followUp("Keep this follow-up input");
							session.settingsManager.applyOverrides({
								compaction: { enabled: true, reserveTokens: session.model!.contextWindow },
							});
						});
						pi.on("agent_before_settle", beforeSettle);
					},
				],
			});
			// Fail immediately instead of allowing a queued-message continuation loop to hang the test.
			const continuation = vi
				.spyOn(session.agent, "continue")
				.mockRejectedValue(new Error("A blocked conversation must not continue"));
			const events: string[] = [];
			session.subscribe((event) => events.push(event.type));

			await expect(session.prompt("Test")).resolves.toBeUndefined();

			expect(created.getCallCount()).toBe(1);
			expect(continuation).not.toHaveBeenCalled();
			expect(beforeSettle).not.toHaveBeenCalled();
			expect(cancelWarming).toHaveBeenCalledOnce();
			expect(events).not.toContain("auto_retry_start");
			expect(events).not.toContain("compaction_start");
			expect(events).not.toContain("context_window_started");
			expect(session.isIdle).toBe(true);
			expect(session.getSteeringMessages()).toEqual(["Keep this steering input"]);
			expect(session.getFollowUpMessages()).toEqual(["Keep this follow-up input"]);
			expect(session.agent.getQueuedMessages().steering).toHaveLength(1);
			expect(session.agent.getQueuedMessages().followUp).toHaveLength(1);
			expect(session.messages.find((message) => message.role === "assistant")?.providerError).toEqual(providerError);
			expect(session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit")).toHaveLength(0);
		},
	);

	it("ends an active retry with the monitoring error", async () => {
		const created = await createSession({
			failCount: 2,
			errors: [{}, { providerError: { code: "misalignment_policy_violation" }, errorMessage: "Review required" }],
		});
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:${event.success}:${event.finalError}`);
		});

		await session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:false:Review required"]);
		expect(session.retryAttempt).toBe(0);
		expect(session.isRetrying).toBe(false);
	});

	it("keeps a monitoring stop effective after context projection hides its evidence", async () => {
		const created = await createSession({ failCount: 0 });
		const blocked = createAssistantMessage("Partial response", {
			stopReason: "error",
			errorMessage: "Review required",
			providerError: { code: "misalignment_policy_violation", requestId: "req_persisted" },
		});
		const id = session.sessionManager.appendMessage(blocked);
		session.sessionManager.appendContextEdit(id, null);
		session.refreshContext();
		await session.followUp("Queued input");
		const entries = session.sessionManager.getBranch();

		session.newContext({ handoff: "Must not roll over the stopped conversation" });
		await expect(session.prompt("Try again")).rejects.toThrow(/Review required/);
		await expect(session.compact()).rejects.toThrow(/Review required/);

		expect(created.getCallCount()).toBe(0);
		expect(session.sessionManager.getBranch()).toEqual(entries);
		expect(session.getFollowUpMessages()).toEqual(["Queued input"]);
		expect(session.agent.getQueuedMessages().followUp).toHaveLength(1);
	});

	it.each(["automatic compaction", "manual compaction", "branch summary"])(
		"preserves a monitoring stop from %s and prevents subsequent requests",
		async (operation) => {
			const providerError = { code: "misalignment_policy_violation", requestId: "req_summary" };
			const created = await createSession({
				errors: [{ providerError, errorMessage: "Summary review required" }],
			});
			const targetId = session.sessionManager.appendMessage({
				role: "user",
				content: "Earlier input",
				timestamp: Date.now(),
			});
			session.sessionManager.appendMessage(createAssistantMessage("Earlier response"));
			session.sessionManager.appendMessage({
				role: "user",
				content: "Current input",
				timestamp: Date.now(),
			});
			session.refreshContext();
			session.settingsManager.applyOverrides({
				compaction: { enabled: true, reserveTokens: session.model!.contextWindow, keepRecentTokens: 1 },
			});
			await session.followUp("Keep queued input");
			const messageEnds: AssistantMessage[] = [];
			session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					messageEnds.push(event.message);
				}
			});

			if (operation === "automatic compaction") {
				await session.prompt("Next input");
			} else if (operation === "manual compaction") {
				await expect(session.compact()).rejects.toThrow("Summary review required");
			} else {
				await expect(session.navigateTree(targetId, { summarize: true })).rejects.toThrow(
					"Summary review required",
				);
			}

			expect(created.getCallCount()).toBe(1);
			expect(messageEnds.some((message) => message.providerError?.requestId === "req_summary")).toBe(true);
			expect(
				session.sessionManager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.providerError?.requestId === "req_summary",
					),
			).toBe(true);
			expect(session.getFollowUpMessages()).toEqual(["Keep queued input"]);
			await expect(session.prompt("Continue")).rejects.toThrow("Summary review required");
			expect(created.getCallCount()).toBe(1);
		},
	);

	it("records cache-warming monitoring blocks and aborts the owning conversation", async () => {
		const cacheWarmer: NonNullable<AgentSessionConfig["cacheWarmer"]> = {
			cancel: vi.fn(),
			status: { state: "scheduled" },
			onAgentSettled: vi.fn(),
			onModeChanged: vi.fn(),
		};
		const created = await createSession({ failCount: 0, cacheWarmer });
		const abort = vi.spyOn(session.agent, "abort");
		await session.followUp("Keep queued input");
		const blocked = createAssistantMessage("Partial warm response", {
			stopReason: "error",
			errorMessage: "Warm request review required",
			providerError: { code: "misalignment_policy_violation", requestId: "req_warm" },
		});

		await cacheWarmer.onMonitoringBlocked!(blocked);

		expect(abort).toHaveBeenCalledOnce();
		expect(session.messages).toContainEqual(blocked);
		expect(session.sessionManager.getBranch().at(-1)).toMatchObject({ type: "message", message: blocked });
		expect(session.getFollowUpMessages()).toEqual(["Keep queued input"]);
		await expect(session.prompt("Continue")).rejects.toThrow("Warm request review required");
		expect(created.getCallCount()).toBe(0);
	});

	it("preserves queued input when a warming block aborts an active response", async () => {
		const cacheWarmer: NonNullable<AgentSessionConfig["cacheWarmer"]> = {
			cancel: vi.fn(),
			status: { state: "scheduled" },
			onAgentSettled: vi.fn(),
			onModeChanged: vi.fn(),
		};
		await createSession({ failCount: 0, cacheWarmer });
		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		let calls = 0;
		let requestSignal: AbortSignal | undefined;
		session.agent.streamFunction = (_model, _context, options) => {
			calls++;
			const stream = new MockAssistantStream();
			requestSignal = options?.signal;
			requestSignal?.addEventListener(
				"abort",
				() => {
					const message = createAssistantMessage("", { stopReason: "aborted" });
					stream.push({ type: "error", reason: "aborted", error: message });
				},
				{ once: true },
			);
			requestStarted();
			return stream;
		};
		const prompt = session.prompt("Active request");
		await started;
		await session.steer("Queued steering");
		await session.followUp("Queued follow-up");
		const blocked = createAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Warm request review required",
			providerError: { code: "misalignment_policy_violation", requestId: "req_active_warm" },
		});

		await cacheWarmer.onMonitoringBlocked!(blocked);
		await prompt;

		expect(requestSignal?.aborted).toBe(true);
		expect(session.isIdle).toBe(true);
		expect(session.getSteeringMessages()).toEqual(["Queued steering"]);
		expect(session.getFollowUpMessages()).toEqual(["Queued follow-up"]);
		expect(session.agent.getQueuedMessages().steering).toHaveLength(1);
		expect(session.agent.getQueuedMessages().followUp).toHaveLength(1);
		expect(session.sessionManager.getEntries()).toContainEqual(expect.objectContaining({ message: blocked }));
		await expect(session.prompt("Continue")).rejects.toThrow("Warm request review required");
		expect(calls).toBe(1);
	});

	it("keeps a session stopped after tree navigation while a new session remains usable", async () => {
		await createSession({ failCount: 0 });
		const ancestorId = session.sessionManager.appendMessage({
			role: "user",
			content: "Original request",
			timestamp: Date.now(),
		});
		const blocked = createAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Session review required",
			providerError: { code: "misalignment_policy_violation" },
		});
		session.sessionManager.appendMessage(blocked);
		session.refreshContext();

		await session.navigateTree(ancestorId);

		expect(session.messages).not.toContainEqual(blocked);
		await expect(session.prompt("Continue from ancestor")).rejects.toThrow("Session review required");
		await expect(session.compact()).rejects.toThrow("Session review required");
		session.dispose();
		const fresh = await createSession({ failCount: 0 });
		await session.prompt("Unrelated new task");
		expect(fresh.getCallCount()).toBe(1);
	});

	it("retries after a transient error and succeeds", async () => {
		const created = await createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = await createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("caps agent retry delay", async () => {
		// Regression for #8826.
		const created = await createSession({ failCount: 4, maxRetries: 5, maxAgentDelayMs: 5 });
		const delays: number[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") delays.push(event.delayMs);
		});

		await created.session.prompt("Test");

		expect(delays).toEqual([1, 2, 4, 5]);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = await createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = await createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		created.session.dispose();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});
});
