import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
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
	runtime.registerProvider("openai", {
		api: "openai-responses",
		baseUrl: server.baseUrl,
		apiKey: "local-key",
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
