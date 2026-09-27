import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { Agent as Dispatcher, WebSocket } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../../ai/src/session-resources.ts";
import { createResponsesServer, replyWithOutput, textOutput } from "../../ai/test/responses-websocket-server.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const sessions: AgentSession[] = [];
const servers: Awaited<ReturnType<typeof createResponsesServer>>[] = [];
const directories: string[] = [];
const dispatchers: Dispatcher[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.stubEnv("NO_PROXY", "*");
	vi.stubEnv("no_proxy", "*");
});

afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	cleanupSessionResources();
	for (const server of servers.splice(0)) {
		await server.close();
		expect(server.errors).toEqual([]);
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	for (const dispatcher of dispatchers.splice(0)) await dispatcher.close();
	vi.unstubAllGlobals();
});

async function createLocalSession(
	server: Awaited<ReturnType<typeof createResponsesServer>>,
	options: Pick<
		CreateAgentSessionOptions,
		"model" | "tools" | "customTools" | "settingsManager" | "resourceLoader"
	> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "pi-responses-window-"));
	directories.push(directory);
	const model = options.model ?? server.model;
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: server.baseUrl,
		apiKey:
			model.api === "openai-codex-responses"
				? `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url")}.test`
				: "local-key",
		models: [model],
	});
	const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		model,
		modelRuntime: runtime,
		thinkingLevel: "high",
		sessionManager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoader: createTestResourceLoader(),
		tools: [],
		...options,
	});
	sessions.push(session);
	return { session, sessionManager, directory };
}

describe("AgentSession native windows over actual Responses WebSockets", () => {
	it.each(
		(["openai-responses", "openai-codex-responses"] as const).flatMap((api) =>
			(
				[
					"unchanged",
					"insert",
					"remove",
					"unknown",
					"message end",
					"checkpoint",
					"compact dropped",
					"window dropped",
					"compact retained",
					"window retained",
				] as const
			).map((payload) => ({
				api,
				payload,
			})),
		),
	)("preserves causal receipts on $api with $payload payload membership", async ({ api, payload }) => {
		const dispatcher = new Dispatcher();
		dispatchers.push(dispatcher);
		class LocalWebSocket extends WebSocket {
			constructor(url: string, init: { headers: Record<string, string> }) {
				super(url, { ...init, dispatcher });
			}
		}
		vi.stubGlobal("WebSocket", LocalWebSocket);
		const gates = [0, 1, 2].map(() => deferred());
		const thinkingStarted = deferred();
		const runs: string[] = [];
		let manager: SessionManager;
		const receipt = async (index: number) => {
			gates[index].resolve();
			await vi.waitFor(() =>
				expect(
					manager
						.getBranch()
						.some(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === `call_${index}|fc_${index}`,
						),
				).toBe(true),
			);
		};
		const server = await createResponsesServer(async (request) => {
			const round = server.requests.length;
			if (round === 1) {
				replyWithOutput(
					request,
					"resp_1",
					gates.map((_, index) => ({
						type: "function_call",
						id: `fc_${index}`,
						call_id: `call_${index}`,
						name: "work",
						arguments: JSON.stringify({ index }),
						async: true,
						status: "completed",
					})),
				);
			} else if (round === 2) {
				if (payload !== "insert") await receipt(0); // After snapshot, before even response.created.
				const thinking = { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "opaque" };
				request.send({ type: "response.created", response: { id: "resp_2", status: "in_progress" } });
				request.send({ type: "response.output_item.added", output_index: 0, item: thinking });
				await thinkingStarted.promise;
				if (payload !== "message end") await receipt(1); // No tool-call checkpoint anchors this response.
				request.send({ type: "response.output_item.done", output_index: 0, item: thinking });
				const output: Record<string, unknown>[] = [thinking];
				if (payload === "checkpoint") {
					const call = {
						type: "function_call",
						id: "fc_3",
						call_id: "call_3",
						name: "work",
						arguments: '{"index":3}',
						async: true,
						status: "completed",
					};
					output.push(call);
					request.send({ type: "response.output_item.added", output_index: 1, item: call });
					request.send({ type: "response.output_item.done", output_index: 1, item: call });
					await vi.waitFor(() =>
						expect(
							manager
								.getBranch()
								.some(
									(entry) =>
										entry.type === "message" &&
										entry.message.role === "toolResult" &&
										entry.message.toolCallId === "call_3|fc_3",
								),
						).toBe(true),
					);
				}
				request.send({
					type: "response.completed",
					response: { id: "resp_2", status: "completed", output },
				});
			} else {
				if (round === 3) await receipt(2);
				replyWithOutput(request, `resp_${round}`, [textOutput(String(round))]);
			}
		});
		servers.push(server);
		const { session, sessionManager, directory } = await createLocalSession(server, {
			model: {
				...server.model,
				api,
				provider: api === "openai-responses" ? "openai" : "openai-codex",
				compat: { supportsAsyncTools: true },
			},
			resourceLoader: createTestResourceLoader({
				extensionsResult: await createTestExtensionsResult([
					(pi) => {
						pi.on("message_end", async (event) => {
							if (
								payload === "message end" &&
								event.message.role === "assistant" &&
								event.message.responseId === "resp_2"
							)
								await receipt(1);
						});
					},
				]),
			}),
			tools: ["work"],
			customTools: [
				{
					name: "work",
					label: "Work",
					description: "Independent work",
					parameters: Type.Object({ index: Type.Number() }),
					async: true,
					async execute(id, args) {
						const { index } = args as { index: number };
						runs.push(id);
						await gates[index]?.promise;
						return { content: [{ type: "text", text: `result_${index}` }], details: {} };
					},
				},
			],
		});
		manager = sessionManager;
		const boundary = payload.startsWith("compact") || payload.startsWith("window");
		const dropped = payload.endsWith("dropped");
		let receiptRetainedAfterResponse: boolean | undefined;
		const prepareRequest = session.agent.prepareRequest;
		session.agent.prepareRequest = async (request, signal) => {
			const prepared = await prepareRequest?.(request, signal);
			if (boundary && server.requests.length === 1) {
				await receipt(0);
				const receiptId = manager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "call_0|fc_0",
					)!.id;
				if (payload.startsWith("compact"))
					manager.appendCompaction("preparation cut", dropped ? null : receiptId, 100);
				else manager.appendContextWindow("preparation cut", 100, dropped ? [] : [receiptId]);
				expect(
					manager
						.buildSessionProjection()
						.messages.some((message) => message.role === "toolResult" && message.toolCallId === "call_0|fc_0"),
				).toBe(!dropped);
				return {
					...prepared,
					context: { ...request.context, messages: manager.buildSessionProjection().messages },
				};
			}
			return prepared ?? undefined;
		};
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start")
				thinkingStarted.resolve();
		});
		const onPayload = session.agent.onPayload;
		session.agent.onPayload = async (body, model) => {
			const params = ((await onPayload?.(body, model)) ?? body) as ResponseCreateParamsStreaming;
			if (server.requests.length === 1 && payload === "insert") {
				await receipt(0);
				if (!Array.isArray(params.input)) throw new Error("Expected native array input");
				params.input.push({ type: "function_call_output", call_id: "call_0", output: "result_0" });
			}
			// Agent preserves receipts arriving during prepareRequest; this real payload hook
			// excludes that receipt from B, rather than inferring input from the journal.
			if (boundary && server.requests.length === 1 && Array.isArray(params.input))
				params.input = params.input.filter(
					(item) => !(item.type === "function_call_output" && item.call_id === "call_0"),
				);
			if (server.requests.length === 2) {
				if (boundary)
					receiptRetainedAfterResponse = manager
						.buildSessionProjection()
						.messages.some((message) => message.role === "toolResult" && message.toolCallId === "call_0|fc_0");
				if (payload === "remove" && Array.isArray(params.input))
					params.input = params.input.filter(
						(item) => !(item.type === "function_call_output" && item.call_id === "call_0"),
					);
				if (payload === "unknown") params.previous_response_id = "caller-baseline";
			}
			return params;
		};
		const finishTurn = session.agent.finishTurn;
		session.agent.finishTurn = async (turn, signal) => {
			const decision = await finishTurn?.(turn, signal);
			if (turn.message.responseId === "resp_3" && (payload === "remove" || payload === "unknown"))
				return { action: "end" };
			return turn.message.responseId === "resp_1" ? { action: "continue" } : (decision ?? undefined);
		};
		try {
			await session.prompt("start independent work");
			if (boundary) expect(receiptRetainedAfterResponse).toBe(!dropped);
			expect(runs).toEqual([
				"call_0|fc_0",
				"call_1|fc_1",
				"call_2|fc_2",
				...(payload === "checkpoint" ? ["call_3|fc_3"] : []),
			]);
			const stopsEarly = payload === "remove" || payload === "unknown";
			expect(server.requests).toHaveLength(stopsEarly ? 3 : 4);
			if (!stopsEarly) {
				expect(server.requests[2].body).toMatchObject({
					previous_response_id: "resp_2",
					input: (payload === "insert" || dropped ? [1] : payload === "checkpoint" ? [0, 1, 3] : [0, 1]).map(
						(index) => ({
							type: "function_call_output",
							call_id: `call_${index}`,
							output: `result_${index}`,
						}),
					),
				});
				expect(server.requests[3].body).toMatchObject({
					previous_response_id: "resp_3",
					input: [{ type: "function_call_output", call_id: "call_2", output: "result_2" }],
				});
			}
			expect(server.requests.every((request) => request.transport === "websocket")).toBe(true);
			const raw = sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message")
				.filter((entry) => !entry.checkpoint);
			if (boundary) {
				const receiptId = raw.find(
					(entry) => entry.message.role === "toolResult" && entry.message.toolCallId === "call_0|fc_0",
				)!.id;
				const response = raw.find(
					(entry) => entry.message.role === "assistant" && entry.message.responseId === "resp_2",
				)!;
				expect(response.concurrentToolResultIds?.includes(receiptId) ?? false).toBe(!dropped);
			}
			const order = raw.map((entry) =>
				entry.message.role === "assistant"
					? entry.message.responseId
					: entry.message.role === "toolResult"
						? entry.message.toolCallId
						: entry.message.role,
			);
			expect(order.indexOf("call_0|fc_0")).toBeLessThan(order.indexOf("resp_2"));
			expect(order.indexOf("call_1|fc_1")).toBeLessThan(order.indexOf("resp_2"));
			expect(order.indexOf("call_2|fc_2")).toBeLessThan(order.indexOf("resp_3"));
			const reopened = SessionManager.open(sessionManager.getSessionFile()!, join(directory, "sessions"), directory);
			expect(reopened.buildSessionProjection()).toEqual(sessionManager.buildSessionProjection());
			expect(reopened.getBranch()).toEqual(sessionManager.getBranch());
			const exported = SessionManager.open(session.exportToJsonl(join(directory, "export.jsonl")));
			expect(exported.getBranch()).toEqual(sessionManager.getBranch());
			expect(exported.buildSessionProjection()).toEqual(reopened.buildSessionProjection());
			expect(session.getSessionStats().assistantMessages).toBe(stopsEarly ? 3 : 4);
			expect(
				raw
					.filter((entry) => entry.message.role === "toolResult")
					.map((entry) => entry.message.role === "toolResult" && entry.message.toolCallId),
			).toEqual(["call_0|fc_0", "call_1|fc_1", ...(payload === "checkpoint" ? ["call_3|fc_3"] : []), "call_2|fc_2"]);
			session.newContext();
			expect(
				session.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
			).toEqual(
				payload === "remove"
					? ["call_0|fc_0", "call_2|fc_2"]
					: payload === "unknown"
						? ["call_0|fc_0", "call_1|fc_1", "call_2|fc_2"]
						: [],
			);
		} finally {
			for (const gate of gates) gate.resolve();
		}
	});

	it("keeps saved history while a same-session window starts a new wire chain and subsequent delta", async () => {
		const server = await createResponsesServer((request) => {
			const round = server.requests.length;
			const item =
				round === 4
					? textOutput("finished")
					: {
							type: "function_call",
							id: `fc_${round}`,
							call_id: `call_${round}`,
							name: round === 2 ? "reset_window" : "echo",
							arguments: round === 2 ? "{}" : JSON.stringify({ text: round === 1 ? "old-tool" : "new-tool" }),
						};
			replyWithOutput(request, `resp_${round}`, [item]);
		});
		servers.push(server);
		const toolRuns: string[] = [];
		const { session, sessionManager, directory } = await createLocalSession(server, {
			tools: ["echo", "reset_window"],
			customTools: [
				{
					name: "echo",
					label: "Echo",
					description: "Echo text",
					parameters: Type.Object({ text: Type.String() }),
					async execute(_id, args) {
						const text = String((args as { text: string }).text);
						toolRuns.push(text);
						return { content: [{ type: "text", text }], details: {} };
					},
				},
				{
					name: "reset_window",
					label: "Reset window",
					description: "Start a new context window",
					parameters: Type.Object({}),
					async execute() {
						toolRuns.push("reset");
						await session.steer("pending-new-window");
						return {
							content: [{ type: "text", text: "old-window-tool-result" }],
							details: {},
							newContext: { handoff: "new-window-handoff" },
						};
					},
				},
			],
		});
		const sessionId = session.sessionId;
		await session.prompt("old-window-request");

		expect(toolRuns).toEqual(["old-tool", "reset", "new-tool"]);
		expect(server.requests).toHaveLength(4);
		expect(server.connections).toHaveLength(1);
		expect(server.requests.map((request) => request.transport)).toEqual([
			"websocket",
			"websocket",
			"websocket",
			"websocket",
		]);
		expect(server.requests.every((request) => request.headers.session_id === sessionId)).toBe(true);
		expect(
			server.requests.every(
				(request) =>
					request.body.model === "gpt-6-astra" &&
					request.body.reasoning?.effort === "high" &&
					request.body.store === false,
			),
		).toBe(true);
		expect(server.requests[1].body).toMatchObject({
			previous_response_id: "resp_1",
			input: [{ type: "function_call_output", call_id: "call_1", output: "old-tool" }],
		});
		const freshInput = JSON.stringify(server.requests[2].body.input);
		expect(server.requests[2].body.previous_response_id).toBeUndefined();
		expect(freshInput.match(/new-window-handoff/g)).toHaveLength(1);
		expect(freshInput.match(/pending-new-window/g)).toHaveLength(1);
		expect(freshInput).not.toMatch(/old-window-request|old-tool|old-window-tool-result|call_[12]|resp_[12]/);
		expect(server.requests[3].body).toMatchObject({
			previous_response_id: "resp_3",
			input: [{ type: "function_call_output", call_id: "call_3", output: "new-tool" }],
		});
		expect(session.sessionId).toBe(sessionId);
		const saved = readFileSync(sessionManager.getSessionFile()!, "utf8");
		expect(saved).toContain("old-window-request");
		expect(saved).toContain("old-window-tool-result");
		expect(saved.match(/"type":"context_window"/g)).toHaveLength(1);
		const reopened = SessionManager.open(sessionManager.getSessionFile()!, join(directory, "sessions"), directory);
		expect(reopened.getSessionId()).toBe(sessionId);
		expect(reopened.buildSessionContext().messages).toEqual(sessionManager.buildSessionContext().messages);
		expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain("old-window-request");
		session.dispose();
		await vi.waitFor(() => expect(server.webSockets.clients.size).toBe(0));
	});

	it.each(["idle", "automatic"])("isolates an %s native window and resumes incremental input", async (mode) => {
		const server = await createResponsesServer((request) => {
			const first = server.requests.length === 1;
			replyWithOutput(
				request,
				`resp_${server.requests.length}`,
				[textOutput(String(server.requests.length))],
				mode === "automatic" && first
					? {
							usage: {
								input_tokens: 49_000,
								output_tokens: 10,
								total_tokens: 49_010,
								input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 5 },
							},
						}
					: {},
			);
		});
		servers.push(server);
		let rollovers = 0;
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("session_before_auto_compact", () => {
					rollovers++;
					return { newContext: { handoff: "automatic-handoff" } };
				});
			},
		]);
		const { session, sessionManager } = await createLocalSession(server, {
			model: { ...server.model, contextWindow: 50_000 },
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: mode === "automatic", reserveTokens: 1000, keepRecentTokens: 1000 },
				retry: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		const sessionId = session.sessionId;
		await session.prompt("old-window-input");
		if (mode === "idle") session.newContext({ handoff: "idle-handoff" });
		await session.prompt("pending-window-input");
		await session.prompt("next delta");
		expect(server.requests).toHaveLength(3);
		expect(server.connections).toHaveLength(1);
		expect(session.sessionId).toBe(sessionId);
		expect(rollovers).toBe(mode === "automatic" ? 1 : 0);
		const input = JSON.stringify(server.requests[1].body.input);
		expect(input).not.toContain("old-window-input");
		expect(input.match(new RegExp(`${mode}-handoff`, "g"))).toHaveLength(1);
		expect(input.match(/pending-window-input/g)).toHaveLength(1);
		expect(server.requests[1].body.previous_response_id).toBeUndefined();
		expect(server.requests[2].body).toMatchObject({
			previous_response_id: "resp_2",
			input: [{ role: "user", content: [{ type: "input_text", text: "next delta" }] }],
		});
		expect(readFileSync(sessionManager.getSessionFile()!, "utf8")).toContain("old-window-input");
	});

	it("resets wire continuation after real branch navigation and manual compaction", async () => {
		const server = await createResponsesServer((request) =>
			replyWithOutput(request, `resp_${server.requests.length}`, [
				textOutput(String(server.requests.length), `reply ${server.requests.length}`),
			]),
		);
		servers.push(server);
		const { session, sessionManager } = await createLocalSession(server, {
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 },
				retry: { enabled: false },
			}),
		});
		await session.prompt("root input");
		const root = sessionManager.getLeafId()!;
		await session.prompt("abandoned branch");
		await session.navigateTree(root, { summarize: false });
		await session.prompt("sibling branch");
		expect(server.requests[2].body.previous_response_id).toBeUndefined();
		expect(JSON.stringify(server.requests[2].body.input)).not.toContain("abandoned branch");
		expect(JSON.stringify(server.requests[2].body.input)).toContain("sibling branch");
		await session.compact("retain current branch");
		const afterCompaction = server.requests.length;
		await session.prompt("after compaction");
		expect(server.requests[afterCompaction].transport).toBe("websocket");
		expect(server.requests[afterCompaction].body.previous_response_id).toBeUndefined();
		expect(JSON.stringify(server.requests[afterCompaction].body.input)).not.toContain("abandoned branch");
		expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(readFileSync(sessionManager.getSessionFile()!, "utf8")).toContain("abandoned branch");
	});
});
