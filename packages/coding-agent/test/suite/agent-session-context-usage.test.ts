import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	toToolDeclaration,
	type Usage,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestartControl } from "../../src/cli/restart-worker.ts";
import { estimateContextTokens, estimateTokens } from "../../src/core/compaction/index.ts";
import type { ToolDefinition } from "../../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildSystemPromptSections, diffSystemPromptSections } from "../../src/core/system-prompt.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

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

describe("AgentSession context usage estimate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["reported", "pending tools"] as const)(
		"reuses unchanged %s usage without rebuilding conversation or tool declarations",
		async (mode) => {
			const harness = await createHarness({
				tools: [
					{
						name: "lookup",
						label: "Lookup",
						description: "Lookup records",
						parameters: Type.Object({ query: Type.String({ description: "schema ".repeat(100) }) }),
						execute: async () => ({ content: [], details: {} }),
					},
				],
				settings: { compaction: { enabled: false } },
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("retained input ".repeat(100));
			const session = harness.session;
			if (mode === "pending tools")
				session.state.tools[0] = { ...session.state.tools[0], description: "Pending changed declaration" };
			const expected = session.getContextUsage();
			expect(expected?.source).toBe(mode === "reported" ? "reported" : "estimated");
			const user = session.messages.find((message) => message.role === "user")!;
			if (typeof user.content === "string") throw new Error("Expected normalized input blocks");
			const entries = vi.spyOn(Object, "entries");
			const serialize = vi.spyOn(JSON, "stringify");
			for (let i = 0; i < 10; i++) expect(session.getContextUsage()).toEqual(expected);
			expect(entries.mock.calls.filter(([value]) => value === user.content[0])).toHaveLength(0);
			// Native tuple keys are cheap; declarations and schemas must not be serialized again.
			expect(serialize.mock.calls.filter(([value]) => !Array.isArray(value))).toHaveLength(0);
		},
	);

	it("refreshes cached usage for in-place SDK message, usage and tool-schema edits", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("initial");
		const session = harness.session;
		const response = session.messages.at(-1) as AssistantMessage;
		const initial = session.getContextUsage()!;
		initial.tokens = -1;
		expect(session.getContextUsage()!.tokens).toBeGreaterThan(0);
		response.usage = usage(50_000);
		expect(session.getContextUsage()).toMatchObject({ tokens: 50_000, source: "reported" });
		response.usage.totalTokens = 60_000;
		expect(session.getContextUsage()).toMatchObject({ tokens: 60_000, source: "reported" });
		const user = session.messages.find((message) => message.role === "user")!;
		if (typeof user.content === "string" || user.content[0]?.type !== "text")
			throw new Error("Expected normalized text");
		user.content[0].text = "edited input";
		expect(session.getContextUsage()).toMatchObject({ source: "estimated" });
		expect(session.getContextUsage()!.tokens).toBeLessThan(60_000);
		user.content[0].text = "initial";
		expect(session.getContextUsage()).toMatchObject({ tokens: 60_000, source: "reported" });

		session.state.tools.push({
			name: "lookup",
			label: "Lookup",
			description: "Lookup",
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => ({ content: [], details: {} }),
		});
		const beforeSchema = session.getContextUsage()!.tokens!;
		session.state.tools[0].parameters.description = "new schema ".repeat(400);
		expect(session.getContextUsage()!.tokens).toBeGreaterThan(beforeSchema);
	});

	it.each(["root", "window", "compaction", "response"])(
		"avoids historical arrays when checking current usage after %s",
		async (boundary) => {
			const harness = await createHarness({ tools: [] });
			harnesses.push(harness);
			const sm = harness.sessionManager;
			for (let i = 0; i < 100; i++) sm.appendCustomEntry("old", i);
			const kept = sm.appendMessage({
				...fauxAssistantMessage("old"),
				api: harness.getModel().api,
				usage: usage(60_000),
			});
			if (boundary !== "root") sm.appendCompaction("summary", kept, 60_000);
			if (boundary === "window") sm.appendContextWindow("fresh", 60_000);
			if (boundary === "response")
				sm.appendMessage({ ...fauxAssistantMessage("new"), api: harness.getModel().api, usage: usage(1234) });
			sm.appendCustomEntry("metadata");
			harness.session.agent.state.messages = sm.buildSessionContext().messages;
			const scans = [vi.spyOn(sm, "getEntries"), vi.spyOn(sm, "getBranch"), vi.spyOn(sm, "buildContextEntries")];
			const parents = vi.spyOn(sm, "getEntry");
			const state = harness.session.agent.state;
			const options = { model: harness.getModel(), systemPrompt: harness.session.systemPrompt, tools: state.tools };
			const expected =
				boundary === "compaction"
					? null
					: Math.max(
							estimateContextTokens(state.messages, options).tokens,
							estimateContextTokens(state.messages, { ...options, useReportedUsage: false }).tokens,
						);
			for (let i = 0; i < 3; i++) expect(harness.session.getContextUsage()?.tokens).toBe(expected);
			for (const scan of scans) expect(scan).not.toHaveBeenCalled();
			expect(parents.mock.calls.length).toBeLessThanOrEqual(6);
		},
	);

	it("keeps retained usage unknown until a valid matching-model response follows the latest active compaction", async () => {
		const harness = await createHarness({ tools: [], models: [{ id: "faux-1" }, { id: "other" }] });
		harnesses.push(harness);
		const sm = harness.sessionManager;
		const old = { ...fauxAssistantMessage("retained"), api: harness.getModel().api, usage: usage(60_000) };
		const kept = sm.appendMessage(old);
		const compaction = sm.appendCompaction("summary", kept, 60_000);
		const sync = () => {
			harness.session.agent.state.messages = sm.buildSessionContext().messages;
		};
		sync();
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(harness.session.messages).toContain(old);
		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		for (const message of [
			{ ...fauxAssistantMessage("error", { stopReason: "error" }), usage: usage(1000) },
			{ ...fauxAssistantMessage("aborted", { stopReason: "aborted" }), usage: usage(1000) },
			{ ...fauxAssistantMessage("zero"), usage: usage(0) },
			{ ...fauxAssistantMessage("other model"), model: "other", usage: usage(1000) },
			{ ...fauxAssistantMessage("other provider"), provider: "other", usage: usage(1000) },
		]) {
			sm.appendMessage({ ...message, api: harness.getModel().api });
			sync();
			expect(harness.session.getContextUsage()).toMatchObject({ tokens: null, percent: null });
		}
		const valid = sm.appendMessage({
			...fauxAssistantMessage("valid"),
			api: harness.getModel().api,
			usage: usage(1234),
		});
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBe(1234);
		sm.appendMessage({ ...fauxAssistantMessage("zero"), api: harness.getModel().api, usage: usage(0) });
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThanOrEqual(1234);
		await harness.session.setModel(harness.getModel("other")!);
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThanOrEqual(1000);
		sm.branch(compaction);
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		sm.branch(valid);
		sm.appendCompaction("second summary", kept, 1234);
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		sm.appendContextWindow(undefined, 1234);
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(0);
		sm.resetLeaf();
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(0);
	});

	it("does not revive old measured usage from a late native checkpoint after reopening a fresh window", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-late-checkpoint-usage-"));
		const harness = await createHarness({
			tools: [],
			sessionManager: SessionManager.create(directory, directory),
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		try {
			const response: AssistantMessage = {
				...fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "call|fc_call",
							name: "work",
							arguments: {},
							async: true,
							responsesItem: {
								type: "function_call",
								id: "fc_call",
								call_id: "call",
								name: "work",
								arguments: "{}",
								async: true,
								status: "completed",
							},
						},
					],
					{ responseId: "old-response", stopReason: "toolUse" },
				),
				api: harness.getModel().api,
				usage: { ...usage(500_000), cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 } },
			};
			const manager = harness.sessionManager;
			manager.appendMessage(response);
			manager.appendContextWindow("continue the pending work", 500_000);
			manager.appendMessage({ ...structuredClone(response), stopReason: "pending" }, true);
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: directory,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: createTestResourceLoader(),
				sessionManager: SessionManager.open(manager.getSessionFile()!),
				tools: [],
			});
			try {
				expect(session.getPendingToolCalls()).toMatchObject([{ toolCallId: "call|fc_call" }]);
				expect(session.getContextUsage()).toMatchObject({ source: "estimated" });
				expect(session.getContextUsage()!.tokens!).toBeLessThan(10_000);
				expect(session.getSessionStats()).toMatchObject({
					assistantMessages: 1,
					tokens: { total: 500_000 },
					cost: 2,
				});
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("counts the system prompt and tool definitions before the model reports usage", async () => {
		const tool: AgentTool = {
			name: "lookup",
			label: "Lookup",
			description: "d".repeat(400),
			parameters: Type.Object({ query: Type.String({ description: "q".repeat(400) }) }),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		const systemPromptChars = harness.session.systemPrompt.length;
		expect(systemPromptChars).toBeGreaterThan(1000);
		const before = harness.session.getContextUsage();
		// System prompt plus at least the 800 padded description characters of the tool schema.
		expect(before?.tokens).toBeGreaterThanOrEqual(Math.ceil(systemPromptChars / 4) + 200);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hi");

		const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		expect(reported).toBeGreaterThan(0);
		expect(harness.session.getContextUsage()?.tokens).toBe(reported);
	});

	it.each(["base", "restart", "sections"])(
		"keeps reported idle usage and avoids premature next-prompt compaction with %s guidance",
		async (kind) => {
			const restart = createRestartControl({ args: [], send: async () => {} });
			const harness = await createHarness({
				tools: [],
				models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 1300, keepRecentTokens: 100 } },
				extensionFactories:
					kind === "restart"
						? [restart.extension]
						: kind === "sections"
							? [
									(pi) => {
										pi.on("before_agent_start", (event) => {
											event.systemPromptOptions.sections.policy = "Per-run policy.";
										});
									},
								]
							: [],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("o".repeat(1000)),
				fauxAssistantMessage("second"),
				fauxAssistantMessage("unexpected extra request"),
			]);
			await harness.session.prompt("h".repeat(1000));
			const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
			expect(reported).toBeLessThan(1300);
			expect.soft(harness.session.getContextUsage()?.tokens).toBe(reported);
			await harness.session.prompt("again");
			expect(harness.eventsOfType("compaction_start")).toEqual([]);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
			const lastReported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
			expect(harness.session.getContextUsage()?.tokens).toBe(lastReported);
			harness.session.newContext();
			expect(harness.sessionManager.getLeafEntry()).toMatchObject({
				type: "context_window",
				tokensBefore: lastReported,
			});
		},
	);

	it.each(["resume", "navigation"])(
		"keeps the persisted restart prompt effective after %s and does not compact the next prompt",
		async (boundary) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-accounting-resume-"));
			const restart = createRestartControl({ args: [], send: async () => {} });
			const harness = await createHarness({
				tools: [],
				models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 1300, keepRecentTokens: 100 } },
				extensionFactories: [restart.extension],
				sessionManager: SessionManager.create(directory, directory),
			});
			harnesses.push(harness);
			let session = harness.session;
			try {
				harness.setResponses([fauxAssistantMessage("o".repeat(1000)), fauxAssistantMessage("middle")]);
				await session.prompt("h".repeat(1000));
				const reported = (session.messages.at(-1) as AssistantMessage).usage.totalTokens;
				const firstAnswer = harness.sessionManager.getLeafId()!;
				expect(session.getContextUsage()?.tokens).toBe(reported);
				if (boundary === "resume") {
					const extensionsResult = await createTestExtensionsResult(
						[createRestartControl({ args: [], send: async () => {} }).extension],
						harness.tempDir,
					);
					({ session } = await createAgentSession({
						cwd: harness.tempDir,
						agentDir: directory,
						model: harness.getModel(),
						modelRuntime: harness.session.modelRuntime,
						settingsManager: harness.settingsManager,
						resourceLoader: createTestResourceLoader({ extensionsResult }),
						sessionManager: SessionManager.open(harness.session.sessionFile!),
					}));
				} else {
					await session.prompt("middle");
					await session.navigateTree(firstAnswer);
				}
				const compactions: string[] = [];
				session.subscribe((event) => {
					if (event.type === "compaction_start") compactions.push(event.reason);
				});
				expect.soft(session.getContextUsage()?.tokens).toBe(reported);
				expect.soft(session.systemPrompt).toBe(getCurrentSystemPrompt(session.messages));
				expect(reported).toBeLessThan(1300);
				// Keep faux cache-write accounting from doubling the resumed response's reported usage.
				// The saved session and SDK resume are real; only provider cache simulation is disabled.
				session.agent.sessionId = undefined;
				harness.setResponses([fauxAssistantMessage("continued"), fauxAssistantMessage("unexpected summary")]);
				await session.prompt("again");
				expect(compactions).toEqual([]);
				expect(session.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
				expect(harness.getPendingResponseCount()).toBe(1);

				// A restored baseline must still notice mutable prompt edits made after restoration.
				session.setAutoCompactionEnabled(false);
				session.extensionRunner.createCommandContext().getSystemPromptOptions().customPrompt =
					"Changed prompt ".repeat(2000);
				const lastReported = (session.messages.at(-1) as AssistantMessage).usage.totalTokens;
				expect(session.getContextUsage()!.tokens).toBeGreaterThan(lastReported);
				harness.setResponses([fauxAssistantMessage("edited")]);
				await session.prompt("apply edit");
				expect(getCurrentSystemPrompt(session.messages)).toContain("Changed prompt ");
			} finally {
				if (session !== harness.session) session.dispose();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it.each(["unchanged", "tools", "prompt"])(
		"adopts discovered startup skills on file-backed restart resume with %s inputs",
		async (change) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-accounting-resources-"));
			const skillDir = join(directory, "review-skill");
			mkdirSync(skillDir);
			const skillFile = join(skillDir, "SKILL.md");
			const writeSkill = (description: string) =>
				writeFileSync(
					skillFile,
					`---\nname: review-skill\ndescription: ${description}\n---\nReview instructions.\n`,
				);
			writeSkill("d".repeat(400));
			const makeLoader = async () => {
				const loader = new DefaultResourceLoader({
					cwd: directory,
					agentDir: join(directory, "agent"),
					settingsManager: SettingsManager.inMemory(),
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [
						createRestartControl({ args: [], send: async () => {} }).extension,
						(pi) => {
							pi.on("resources_discover", () => ({ skillPaths: [skillDir] }));
						},
					],
				});
				await loader.reload();
				return loader;
			};
			const harness = await createHarness({
				// Fix the starting tool budget; resume must still restore it from the transcript.
				initialActiveToolNames: ["read", "bash", "edit", "write"],
				models: [{ id: "faux-1", contextWindow: 5000, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 2500, keepRecentTokens: 100 } },
				resourceLoader: await makeLoader(),
				sessionManager: SessionManager.create(directory, directory),
			});
			harnesses.push(harness);
			try {
				await harness.session.bindExtensions({});
				harness.setResponses([fauxAssistantMessage("o".repeat(1000))]);
				// Leave room for the resumed input and output beneath the real threshold.
				await harness.session.prompt("h".repeat(800));
				const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
				expect(reported).toBeLessThan(2500);
				const { session } = await createAgentSession({
					cwd: harness.tempDir,
					agentDir: directory,
					model: harness.getModel(),
					modelRuntime: harness.session.modelRuntime,
					settingsManager: harness.settingsManager,
					resourceLoader: await makeLoader(),
					sessionManager: SessionManager.open(harness.session.sessionFile!),
					tools: change === "tools" ? ["read"] : undefined,
				});
				try {
					const pendingEstimate = () =>
						estimateContextTokens(
							[
								...session.messages,
								{
									role: "system",
									content: "",
									sections: diffSystemPromptSections(
										getCurrentSystemMessage(session.messages)?.sections ?? {},
										buildSystemPromptSections(
											session.extensionRunner.createCommandContext().getSystemPromptOptions(),
										),
									),
									...getToolStateChanges(getCurrentTools(session.messages), session.state.tools),
									timestamp: 0,
								},
							],
							{ useReportedUsage: false },
						).tokens;
					if (change !== "unchanged") session.setAutoCompactionEnabled(false);
					if (change === "prompt")
						session.extensionRunner.createCommandContext().getSystemPromptOptions().customPrompt =
							"Local edit ".repeat(2000);
					expect(session.resourceLoader.getSkills().skills).toHaveLength(0);
					await session.bindExtensions({ onError: () => {} });
					expect(session.resourceLoader.getSkills().skills).toHaveLength(1);
					if (change === "unchanged") {
						expect.soft(session.getContextUsage()?.tokens).toBe(reported);
						expect.soft(session.systemPrompt).toBe(getCurrentSystemPrompt(session.messages));
					} else {
						expect(session.systemPrompt).not.toBe(getCurrentSystemPrompt(session.messages));
						// Structured updates retain the prefix and append only changed sections/tools.
						expect(session.getContextUsage()!.tokens).toBe(Math.max(reported, pendingEstimate()));
						if (change === "prompt") expect(session.systemPrompt).toContain("Local edit ");
						else expect(session.getActiveToolNames()).toEqual(["read"]);
					}
					const compactions: string[] = [];
					session.subscribe((event) => {
						if (event.type === "compaction_start") compactions.push(event.reason);
					});
					// Disable faux's optional cache-write simulation, not native accounting/preflight.
					session.agent.sessionId = undefined;
					harness.setResponses([fauxAssistantMessage("continued"), fauxAssistantMessage("unexpected summary")]);
					await session.prompt("again");
					if (change === "unchanged")
						expect((session.messages.at(-1) as AssistantMessage).usage.totalTokens).toBeLessThan(2500);
					expect(compactions).toEqual([]);
					expect(harness.getPendingResponseCount()).toBe(1);

					// Once preparation has occurred, even a later startup discovery is a pending change.
					session.setAutoCompactionEnabled(false);
					writeSkill("Later startup guidance ".repeat(30));
					await session.bindExtensions({});
					expect(session.systemPrompt).toContain("Later startup guidance");
					expect(session.systemPrompt).not.toBe(getCurrentSystemPrompt(session.messages));

					// Reloaded resource changes also remain pending rather than becoming startup adoption.
					writeSkill("Changed skill guidance ".repeat(30));
					await session.reload();
					expect(session.systemPrompt).toContain("Changed skill guidance");
					expect(session.systemPrompt).not.toBe(getCurrentSystemPrompt(session.messages));
					const lastReported = (session.messages.at(-1) as AssistantMessage).usage.totalTokens;
					const previousEstimate = estimateContextTokens(session.messages, { useReportedUsage: false }).tokens;
					expect(session.getContextUsage()!.tokens).toBe(lastReported + pendingEstimate() - previousEstimate);
					expect(session.getContextUsage()).toMatchObject({ source: "estimated" });
				} finally {
					session.dispose();
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("counts an explicit SDK resume loadout change as pending", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-accounting-loadout-"));
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createRestartControl({ args: [], send: async () => {} }).extension],
			sessionManager: SessionManager.create(directory, directory),
		});
		harnesses.push(harness);
		try {
			harness.setResponses([fauxAssistantMessage("first")]);
			await harness.session.prompt("hello");
			const extensionsResult = await createTestExtensionsResult(
				[createRestartControl({ args: [], send: async () => {} }).extension],
				harness.tempDir,
			);
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: directory,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				sessionManager: SessionManager.open(harness.session.sessionFile!),
				tools: ["read"],
			});
			try {
				expect(getCurrentTools(session.messages)).toEqual([]);
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(session.systemPrompt).toContain("- read:");
				expect(session.systemPrompt).not.toBe(getCurrentSystemPrompt(session.messages));
				expect(session.getContextUsage()!.tokens).toBeGreaterThan(harness.session.getContextUsage()!.tokens!);
				harness.setResponses([fauxAssistantMessage("resumed")]);
				await session.prompt("with read");
				expect(getCurrentTools(session.messages).map((tool) => tool.name)).toEqual(["read"]);
				expect(getCurrentSystemPrompt(session.messages)).toContain("- read:");
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rebases restored tool selections without discarding pending prompt edits or changing cancelled navigation", async () => {
		let cancel = false;
		const harness = await createHarness({
			tools: [],
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: false, reserveTokens: 1300, keepRecentTokens: 100 } },
			extensionFactories: [
				createRestartControl({ args: [], send: async () => {} }).extension,
				(pi) => {
					for (const name of ["first", "second", "third"])
						pi.registerTool({
							name,
							label: name,
							description: `${name} tool`,
							promptSnippet: `${name} guidance`,
							parameters: Type.Object({}),
							execute: async () => ({ content: [], details: {} }),
						});
					pi.on("session_before_tree", () => (cancel ? { cancel: true } : undefined));
				},
			],
		});
		harnesses.push(harness);
		const session = harness.session;
		const root = harness.sessionManager.appendCustomEntry("root");
		session.setActiveToolsByName(["first"]);
		harness.setResponses([fauxAssistantMessage("o".repeat(1000)), fauxAssistantMessage("second answer")]);
		await session.prompt("h".repeat(1000));
		const first = harness.sessionManager.getLeafId()!;
		const firstPrompt = session.systemPrompt;
		const firstReported = (session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		session.setActiveToolsByName(["second"]);
		await session.prompt("second input");
		const second = harness.sessionManager.getLeafId()!;
		await session.navigateTree(first);
		expect(session.getActiveToolNames()).toEqual(["first"]);
		expect(session.systemPrompt).toBe(firstPrompt);
		expect(session.getContextUsage()?.tokens).toBe(firstReported);

		// Navigation supersedes an idle selection, not just the selection from the last request.
		await session.navigateTree(second);
		session.setActiveToolsByName(["third"]);
		await session.navigateTree(first);
		expect(session.getActiveToolNames()).toEqual(["first"]);
		expect.soft(session.systemPrompt).toBe(firstPrompt);
		expect.soft(session.getContextUsage()?.tokens).toBe(firstReported);
		expect(firstReported).toBeLessThan(1300);
		session.setAutoCompactionEnabled(true);
		harness.setResponses([fauxAssistantMessage("continued"), fauxAssistantMessage("unexpected summary")]);
		await session.prompt("again");
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		session.setAutoCompactionEnabled(false);
		await session.navigateTree(root);
		expect(session.getContextUsage()!.tokens).toBeGreaterThan(0);
		await session.navigateTree(first);
		expect(session.getContextUsage()?.tokens).toBe(firstReported);

		const pendingPrompt = "Pending navigation edit ".repeat(2000);
		session.extensionRunner.createCommandContext().getSystemPromptOptions().customPrompt = pendingPrompt;
		const pendingUsage = session.getContextUsage()?.tokens;
		cancel = true;
		expect(await session.navigateTree(second)).toMatchObject({ cancelled: true });
		expect(harness.sessionManager.getLeafId()).toBe(first);
		expect(session.getContextUsage()?.tokens).toBe(pendingUsage);
		expect(session.systemPrompt).toContain(pendingPrompt);
		cancel = false;
		await session.navigateTree(second);
		expect(session.getActiveToolNames()).toEqual(["second"]);
		expect(session.systemPrompt).toContain(pendingPrompt);
		expect(getCurrentSystemPrompt(session.messages)).not.toContain(pendingPrompt);
		expect(session.getContextUsage()!.tokens).toBeGreaterThan(firstReported + 5000);
		harness.setResponses([fauxAssistantMessage("edited")]);
		await session.prompt("apply pending edit");
		expect(getCurrentSystemPrompt(session.messages)).toContain(pendingPrompt);
	});

	it.each(["tools", "base options", "reload", "navigation"])(
		"accounts for genuinely pending %s changes after a forced-prompt run",
		async (change) => {
			let override = true;
			const harness = await createHarness({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", (event) =>
							override ? { systemPrompt: `${event.systemPrompt}\n\nTemporary guidance.` } : undefined,
						);
						pi.registerCommand("update-prompt", {
							handler: async (_args, ctx) => {
								ctx.getSystemPromptOptions().customPrompt = "Changed base prompt.";
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const root = harness.sessionManager.appendCustomEntry("root");
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			await harness.session.prompt("first");
			(harness.session.messages.at(-1) as AssistantMessage).usage = usage(8000);
			expect(harness.session.getContextUsage()?.tokens).toBe(8000);
			expect(harness.session.systemPrompt).toBe(getCurrentSystemPrompt(harness.session.messages));

			if (change === "tools") harness.session.setActiveToolsByName(["read"]);
			else if (change === "base options") await harness.session.prompt("/update-prompt");
			else if (change === "reload") {
				vi.spyOn(harness.session.resourceLoader, "getSystemPrompt").mockReturnValue("Reloaded base prompt.");
				// Reload clears compat registrations; retain this harness's local faux stream.
				harness.session.agent.streamFunction = getApiProvider(harness.faux.api)!.streamSimple;
				await harness.session.reload();
			} else await harness.session.navigateTree(root);

			const state = harness.session.state;
			const previousEstimate = estimateContextTokens(
				[
					{
						role: "system",
						content: `${getCurrentSystemPrompt(state.messages)}\n\nTemporary guidance.`,
						toolsAdded: getCurrentTools(state.messages),
						timestamp: 0,
					},
					...state.messages.filter((message) => message.role !== "system"),
				],
				{ useReportedUsage: false },
			).tokens;
			const baseOptions = harness.session.extensionRunner.createCommandContext().getSystemPromptOptions();
			const expected = estimateContextTokens(
				[
					...state.messages,
					{
						role: "system",
						content: "",
						sections: diffSystemPromptSections(
							getCurrentSystemMessage(state.messages)?.sections ?? {},
							buildSystemPromptSections(baseOptions),
						),
						...getToolStateChanges(getCurrentTools(state.messages), state.tools),
						timestamp: 0,
					},
				],
				{ model: harness.getModel(), useReportedUsage: false },
			).tokens;
			expect(harness.session.getContextUsage()?.tokens).toBe(
				change === "navigation" ? expected : 8000 + expected - previousEstimate,
			);
			expect(harness.session.getContextUsage()).toMatchObject({ source: "estimated" });
			expect(expected).toBeLessThan(8000);
			expect(harness.session.systemPrompt).not.toContain("Temporary guidance.");
			override = false;
			await harness.session.prompt("second");
			const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
			expect(harness.session.getContextUsage()?.tokens).toBe(reported);
			expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Temporary guidance.");
		},
	);

	it("keeps a base prompt change pending when admission aborts after startup preparation", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("first");
		harness.session.extensionRunner.createCommandContext().getSystemPromptOptions().customPrompt = "Pending change.";
		await expect(
			harness.session.prompt("cancel", {
				preflightResult: (accepted) => {
					if (accepted) void harness.session.abort();
				},
			}),
		).rejects.toThrow();
		expect(harness.session.systemPrompt).toContain("Pending change.");
		expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Pending change.");
		harness.setResponses([fauxAssistantMessage("second")]);
		await harness.session.prompt("retry");
		expect(harness.session.getContextUsage()?.tokens).toBe(
			(harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens,
		);
	});

	it("ends a request-only override when the run settles", async () => {
		let override = true;
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) =>
						override ? { systemPrompt: `${event.systemPrompt}\n\nTemporary guidance.` } : undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		override = false;
		expect(harness.session.systemPrompt).not.toContain("Temporary guidance.");
		await harness.session.prompt("second");
		expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Temporary guidance.");
		expect(harness.session.getContextUsage()?.tokens).toBe(
			(harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens,
		);
	});

	it("checks the next run's forced prompt before deciding whether to roll over", async () => {
		let starts = 0;
		const harness = await createHarness({
			tools: [],
			models: [{ id: "small", contextWindow: 6000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 2000 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						starts++;
						event.systemPromptOptions.sections.hidden = "Hidden guidance. ".repeat(3000);
						return { systemPrompt: "Short request-only instructions." };
					});
					pi.on("session_before_auto_compact", () => ({ newContext: { handoff: "Unexpected rollover" } }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("one");
		const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		expect(harness.session.getContextUsage()?.tokens).toBe(reported);
		expect(harness.session.systemPrompt).not.toContain("Short request-only instructions.");
		await harness.session.prompt("two");
		expect(starts).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("context_window_started")).toEqual([]);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(0);
		// A direct SDK prefix edit keeps the measured conversation and estimates the changed prompt.
		const previous = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		const conversationEstimate = estimateContextTokens(
			harness.session.messages.filter((message) => message.role !== "system"),
			{ useReportedUsage: false },
		).tokens;
		harness.session.agent.state.messages.push({ role: "system", content: "SDK edit", timestamp: Date.now() });
		expect(harness.session.getContextUsage()?.tokens).toBe(
			previous +
				estimateContextTokens(harness.session.messages, { useReportedUsage: false }).tokens -
				conversationEstimate -
				Math.ceil("Short request-only instructions.".length / 4),
		);
	});

	it("counts the forced request once and reuses its reported usage through hidden section updates", async () => {
		let options: ReturnType<typeof buildSystemPromptSections> | undefined;
		const estimates: Array<{ actual: number | null | undefined; expected: number }> = [];
		const reported: Array<{ actual: number | null | undefined; expected: number }> = [];
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						options = event.systemPromptOptions.sections;
						options.hidden = "Hidden structured guidance. ".repeat(2000);
						return { systemPrompt: "Only this forced prompt." };
					});
					pi.registerTool({
						name: "update",
						label: "Update",
						description: "Update the hidden section",
						parameters: Type.Object({}),
						async execute() {
							options!.hidden = "Different hidden guidance. ".repeat(2000);
							return { content: [{ type: "text", text: "updated" }], details: undefined };
						},
					});
					pi.on("turn_end", (event, ctx) => {
						if (event.message.role !== "assistant") throw new Error("expected assistant turn");
						reported.push({
							actual: ctx.getContextUsage()?.tokens,
							expected:
								event.message.usage.totalTokens +
								estimateContextTokens(event.toolResults, { useReportedUsage: false }).tokens,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses(
			[
				fauxAssistantMessage([fauxToolCall("update", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			].map((response) => (context) => {
				estimates.push({
					actual: harness.session.getContextUsage()?.tokens,
					expected: estimateContextTokens(context.messages, { model: harness.getModel() }).tokens,
				});
				return response;
			}),
		);
		await harness.session.prompt("start");
		expect(estimates).toHaveLength(2);
		expect(reported).toHaveLength(2);
		for (const result of [...estimates, ...reported]) expect(result.actual).toBe(result.expected);
		expect(getCurrentSystemPrompt(harness.session.messages)).toContain("Different hidden guidance.");
		expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Only this forced prompt.");
	});

	it.each([
		"identical",
		"handler",
		"label",
		"sampling disabled",
		"description",
		"schema",
		"mutated schema",
		"sampling",
	])("compares model-facing tool definitions after a %s refresh", async (change) => {
		let refresh!: (changes: Partial<ToolDefinition>) => void;
		const parameters = Type.Object({ query: Type.String() });
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					const definition: ToolDefinition = {
						name: "lookup",
						label: "Lookup",
						description: "Lookup a record",
						parameters,
						async execute() {
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					};
					refresh = (changes) => pi.registerTool({ ...definition, ...changes });
					refresh({});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		const before = harness.session.getContextUsage()!.tokens!;
		const beforeEstimate = estimateContextTokens(harness.session.messages, { useReportedUsage: false }).tokens;
		const stateBefore = JSON.stringify(harness.session.agent.state);
		if (change === "mutated schema")
			Object.assign(parameters.properties.query, { description: "Changed field description" });
		refresh(
			change === "handler"
				? { execute: async () => ({ content: [], details: {} }) }
				: change === "label"
					? { label: "New label" }
					: change === "description"
						? { description: "Different description" }
						: change === "schema"
							? { parameters: Type.Object({ query: Type.Number() }) }
							: change === "sampling"
								? { constrainedSampling: { type: "json_schema", strict: "require" } }
								: change === "sampling disabled"
									? { constrainedSampling: false }
									: {},
		);
		if (change === "identical") expect(JSON.stringify(harness.session.agent.state)).toBe(stateBefore);
		if (["identical", "handler", "label", "sampling disabled"].includes(change)) {
			expect(harness.session.getContextUsage()?.tokens).toBe(before);
			const serialize = vi.spyOn(JSON, "stringify");
			for (let i = 0; i < 10; i++) expect(harness.session.getContextUsage()?.tokens).toBe(before);
			// Tuple keys may serialize; unchanged tool schemas must stay cached.
			for (const [value] of serialize.mock.calls) expect(value).toEqual([null, "lookup"]);
		} else {
			const state = harness.session.agent.state;
			expect(harness.session.getContextUsage()?.tokens).toBe(
				before -
					beforeEstimate +
					estimateContextTokens(
						[
							...state.messages,
							{
								role: "system",
								content: "",
								...getToolStateChanges(getCurrentTools(state.messages), state.tools),
								timestamp: Date.now(),
							},
						],
						{
							model: harness.getModel(),
							useReportedUsage: false,
						},
					).tokens,
			);
			expect(harness.session.getContextUsage()?.tokens).not.toBe(before);
		}
	});

	it.each(["prompt addition", "prompt removal", "tool addition", "tool removal", "tool reorder", "grammar"])(
		"retains opaque reported usage through a %s without counting previous output twice",
		async (change) => {
			const tools: AgentTool[] = ["first", "second", "third"].map((name) => ({
				name,
				label: name,
				description: `${name} tool`,
				parameters: Type.Object({ input: Type.String() }),
				execute: async () => ({ content: [], details: {} }),
			}));
			const harness = await createHarness({
				tools,
				initialActiveToolNames: ["first", "second"],
				models: [{ id: "faux-1", contextWindow: 600_000, maxTokens: 128_000 }],
				settings: { compaction: { enabled: false, reserveTokens: 64_000, keepRecentTokens: 40_000 } },
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", () => ({ systemPrompt: "s".repeat(400) }));
						pi.on("message_end", (event) => {
							if (event.message.role === "assistant") {
								event.message.usage = { ...usage(500_000), input: 400_000, output: 100_000 };
							}
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage([
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_test",
							encrypted_content: "opaque-test",
							summary: [],
						}),
					},
					{ type: "text", text: "previous output".repeat(100) },
				]),
			]);
			await harness.session.prompt("hello");
			const session = harness.session;
			const billed = session.getSessionStats();
			const prefixTokens = (prompt: string) =>
				estimateTokens({
					role: "system",
					content: prompt,
					toolsAdded: session.state.tools.map(toToolDeclaration),
					timestamp: 0,
				});
			const beforePrefix = prefixTokens("s".repeat(400));
			expect(session.getContextUsage()?.tokens).toBe(500_000);
			if (change === "tool addition") session.setActiveToolsByName(["first", "second", "third"]);
			if (change === "tool removal") session.setActiveToolsByName(["first"]);
			if (change === "tool reorder") session.setActiveToolsByName(["second", "first"]);
			if (change === "grammar")
				session.state.tools[0] = {
					...session.state.tools[0],
					constrainedSampling: { type: "grammar", variants: { openai_regex: "a".repeat(20_000) } },
				};
			const prompt = "s".repeat(change === "prompt addition" ? 800 : change === "prompt removal" ? 200 : 400);
			session.extensionRunner.createCommandContext().getSystemPromptOptions().forceSystemPrompt = prompt;
			await session.sendCustomMessage({ customType: "tail", content: "t".repeat(1600), display: false });
			expect(session.getContextUsage()).toMatchObject({
				tokens: 500_000 + prefixTokens(prompt) - beforePrefix + 400,
				contextWindow: 600_000,
				source: "estimated",
			});
			expect(session.getSessionStats().tokens).toEqual(billed.tokens);
			expect(session.getSessionStats().cost).toBe(billed.cost);
			expect(session.settingsManager.getCompactionSettings(session.model)).toMatchObject({
				reserveTokens: 64_000,
				keepRecentTokens: 40_000,
			});
		},
	);

	it("adjusts only the effective prefix after a persisted replacement", async () => {
		const harness = await createHarness({ tools: [], settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "system",
			content: "obsolete ".repeat(10_000),
			timestamp: 0,
		});
		harness.session.refreshContext();
		harness.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-test" },
				{ type: "text", text: "answer" },
			]),
		]);
		await harness.session.prompt("hello");
		const session = harness.session;
		const response = session.messages.at(-1) as AssistantMessage;
		response.usage = { ...usage(500_000), input: 400_000, output: 100_000 };
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_000, source: "reported" });
		const systemMessages = session.messages.filter((message) => message.role === "system");
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages[1].replace).toBe(true);
		expect(estimateTokens(systemMessages[0])).toBe(22_500);
		// Native transcript replay discards the obsolete prefix before the measured request.
		const oldPrefix = estimateTokens(getCurrentSystemMessage(session.messages)!);
		session.extensionRunner.createCommandContext().getSystemPromptOptions().forceSystemPrompt = "new";
		expect(session.getContextUsage()).toMatchObject({
			tokens: 500_000 + 1 - oldPrefix,
			source: "estimated",
		});
	});

	it("keeps the measured conversation through custom-message projection and structured prompt edits", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "startup", content: "startup input", display: false },
					}));
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") event.message.usage = usage(500_000);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage({ type: "thinking", thinking: "", thinkingSignature: "opaque-test" }),
		]);
		await harness.session.prompt("hello");
		const session = harness.session;
		session.refreshContext();
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_000, source: "reported" });
		const options = session.extensionRunner.createCommandContext().getSystemPromptOptions();
		options.sections = { ...options.sections, policy: "p".repeat(400) };
		// The 400-character policy plus its XML section framing estimates to 105 tokens.
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_105, source: "estimated" });
		await session.sendCustomMessage({ customType: "tail", content: "t".repeat(1600), display: false });
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_505, source: "estimated" });
		delete options.sections.policy;
		expect(session.getContextUsage()).toMatchObject({ tokens: 500_400, source: "estimated" });
	});

	it.each(["context", "message_end"])(
		"does not apply reported usage to conversation omitted by a %s hook",
		async (hook) => {
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("context", (event) =>
							hook === "context"
								? {
										messages: event.messages.filter((message) => message.role !== "user"),
									}
								: undefined,
						);
						pi.on("message_end", (event) => {
							if (event.message.role !== "assistant") return;
							event.message.usage = usage(500_000);
							if (hook === "message_end") event.message.content = [];
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("omitted input");
			expect(harness.session.getContextUsage()?.tokens).toBeLessThan(500_000);
			expect(harness.session.getContextUsage()).toMatchObject({ source: "estimated" });
		},
	);

	it.each([
		"api",
		"provider",
		"context deletion",
		"SDK deletion",
		"SDK replacement",
		"SDK reasoning deletion",
		"new context",
		"branch",
	])("does not reuse an opaque usage anchor after %s", async (change) => {
		const harness = await createHarness({ tools: [], settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const root = harness.sessionManager.appendCustomEntry("root");
		harness.setResponses([
			fauxAssistantMessage({ type: "thinking", thinking: "", thinkingSignature: "opaque-test" }),
		]);
		await harness.session.prompt("hello");
		const session = harness.session;
		(session.messages.at(-1) as AssistantMessage).usage = usage(500_000);
		expect(session.getContextUsage()?.tokens).toBe(500_000);
		if (change === "api") session.agent.state.model = { ...harness.getModel(), api: "other-api" };
		if (change === "provider") session.agent.state.model = { ...harness.getModel(), provider: "other-provider" };
		if (change === "context deletion") {
			const user = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user")!;
			harness.sessionManager.appendContextEdit(user.id, null);
			session.refreshContext();
		}
		if (change === "SDK deletion")
			session.state.messages = session.messages.filter((message) => message.role !== "user");
		if (change === "SDK replacement") {
			const user = session.messages.find((message) => message.role === "user")!;
			user.content = "replacement";
		}
		if (change === "SDK reasoning deletion") (session.messages.at(-1) as AssistantMessage).content = [];
		if (change === "new context") session.newContext();
		if (change === "branch") await session.navigateTree(root);
		expect(session.getContextUsage()?.tokens).toBeLessThan(500_000);
		expect(session.getContextUsage()).toMatchObject({ source: "estimated" });
	});

	it("does not reuse usage or trigger rollover from a different model after a model switch", async () => {
		const autoCompactionReasons: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "big", contextWindow: 128_000 },
				{ id: "small", contextWindow: 64_000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_auto_compact", (event) => {
						autoCompactionReasons.push(event.reason);
						return { newContext: { handoff: "unexpected rollover" } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hi");
		(harness.session.messages.at(-1) as AssistantMessage).usage = usage(60_000);
		expect(harness.session.getContextUsage()).toMatchObject({ tokens: 60_000, contextWindow: 128_000 });

		await harness.session.setModel(harness.getModel("small")!);

		const switched = harness.session.getContextUsage();
		expect(switched?.contextWindow).toBe(64_000);
		expect(switched?.tokens).toBeGreaterThan(0);
		expect(switched?.tokens).toBeLessThan(60_000);

		harness.setResponses([fauxAssistantMessage("small ok")]);
		await harness.session.prompt("again");

		expect(autoCompactionReasons).toEqual([]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_window")).toBe(false);
		const reported = (harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens;
		expect(harness.session.getContextUsage()?.tokens).toBe(reported);
	});
});
