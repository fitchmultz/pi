import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import * as fs from "fs";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, appendFileSync: vi.fn(original.appendFileSync) };
});

describe("completed parallel tool receipts", () => {
	it.each(["message_start", "message_end", "persistence"] as const)(
		"retains both successful results when the first receipt fails at %s",
		async (failureAt) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-tool-receipts-"));
			let session: AgentSession | undefined;
			try {
				const effects: string[] = [];
				const tool: AgentTool = {
					name: "work",
					label: "Work",
					description: "Record a synthetic operation",
					parameters: Type.Object({}),
					async execute(id) {
						effects.push(id);
						return {
							content: [{ type: "text", text: `Committed ${id}` }],
							details: { receipt: id },
							terminate: true,
						};
					},
				};
				const model = getModel("anthropic", "claude-sonnet-4-5");
				let requests = 0;
				const agent = new Agent({
					initialState: { model, tools: [tool] },
					streamFn: () => {
						requests++;
						const stream = new AssistantMessageEventStream();
						stream.push({
							type: "done",
							reason: "toolUse",
							message: {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								content: ["first", "second"].map((id) => ({
									type: "toolCall",
									id,
									name: "work",
									arguments: {},
								})),
								stopReason: "toolUse",
								timestamp: 1,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							},
						});
						return stream;
					},
				});
				const manager = SessionManager.create(directory, directory);
				session = new AgentSession({
					agent,
					sessionManager: manager,
					settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
					cwd: directory,
					modelRuntime: getModelRuntime(
						await createInMemoryModelRegistry(
							AuthStorage.inMemory({ anthropic: { type: "api_key", key: "unused" } }),
						),
					),
					resourceLoader: createTestResourceLoader(),
					baseToolsOverride: { work: tool },
				});
				const failure = Object.assign(new Error(`receipt ${failureAt} failed`), { code: "EACCES" });
				session.subscribe((event) => {
					if (
						event.type === "message_start" &&
						event.message.role === "assistant" &&
						event.message.stopReason === "error"
					) {
						vi.mocked(fs.appendFileSync).mockRestore();
					}
					if (
						(event.type === "message_start" || event.type === "message_end") &&
						event.message.role === "toolResult" &&
						event.message.toolCallId === "first"
					) {
						if (event.type === failureAt) throw failure;
						if (event.type === "message_end" && failureAt === "persistence") {
							vi.mocked(fs.appendFileSync).mockImplementation(() => {
								throw failure;
							});
						}
					}
				});

				await session.prompt("Run both operations", { expandPromptTemplates: false });
				manager.flush();

				const receipts = (source: SessionManager): ToolResultMessage[] =>
					source
						.getEntries()
						.flatMap((entry) =>
							entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
						);
				const expected = ["first", "second"].map((id) => ({
					toolCallId: id,
					content: [{ type: "text", text: `Committed ${id}` }],
					details: { receipt: id },
					isError: false,
				}));
				expect(receipts(manager)).toMatchObject(expected);
				expect(receipts(SessionManager.open(manager.getSessionFile()!))).toEqual(receipts(manager));
				expect(agent.state.messages.filter((message) => message.role === "toolResult")).toMatchObject(expected);
				expect(effects).toEqual(["first", "second"]);
				expect(requests).toBe(1);
				expect(agent.state.errorMessage).toBe(failure.message);
				expect(session.isIdle).toBe(true);
			} finally {
				vi.mocked(fs.appendFileSync).mockRestore();
				session?.dispose();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
