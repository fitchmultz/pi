import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	buildSystemPromptSections,
	buildSystemPromptState,
	diffSystemPromptSections,
} from "../src/core/system-prompt.ts";
import type { ExtensionFactory } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("system prompt updates", () => {
	test("declares the prompt and tools once and reuses them across resume", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			const systemEntries = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "system");
			expect(systemEntries).toHaveLength(1);
			expect(harness.session.messages.map((message) => message.role)).toEqual([
				"system",
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			const head = harness.session.messages[0];
			if (head?.role !== "system") throw new Error("expected system message");
			expect(head.content).toBe("");
			expect(Object.keys(head.sections ?? {})).toEqual(["preamble", "tools", "rules", "docs", "cwd"]);
			expect(head.toolsAdded?.map((tool) => tool.name)).toEqual([
				"read",
				"bash",
				"background_command",
				"edit",
				"write",
			]);
			expect(getSystemMessageText(head)).toBe(harness.session.systemPrompt);
		} finally {
			harness.cleanup();
		}
	});

	test("opens a transcript without a system message and declares the prompt on the first request", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-system-prompt-migration-"));
		try {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({ role: "user", content: "existing", timestamp: 1 });
			const created = await createAgentSession({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: SettingsManager.inMemory(),
				sessionManager,
				noTools: "all",
			});
			try {
				// Nothing is synthesized or persisted until a request needs it.
				expect(created.session.messages.map((message) => message.role)).toEqual(["user"]);
				expect(sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual(["user"]);
				expect(getCurrentSystemMessage(created.session.messages)).toBeUndefined();
			} finally {
				created.session.dispose();
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("diffs sections into a patch", () => {
		const previous = buildSystemPromptSections({ cwd: "/tmp", sections: { plan_mode: "Plan only." } });
		const current = buildSystemPromptSections({ cwd: "/tmp", sections: { plan_mode: "Implementation allowed." } });
		expect(diffSystemPromptSections(previous, current)).toEqual({
			plan_mode: "<plan_mode>\nImplementation allowed.\n</plan_mode>",
		});
		expect(diffSystemPromptSections(previous, previous)).toBeUndefined();
		expect(diffSystemPromptSections(previous, buildSystemPromptSections({ cwd: "/tmp" }))).toEqual({
			plan_mode: null,
		});
	});

	test("keeps the preamble untagged and replaces it like any section", () => {
		const previous = buildSystemPromptSections({ customPrompt: "You are A.", cwd: "/tmp" });
		const current = buildSystemPromptSections({ customPrompt: "You are B.", cwd: "/tmp" });
		expect(previous.preamble).toBe("You are A.");
		expect(diffSystemPromptSections(previous, current)).toEqual({ preamble: "You are B." });

		expect(buildSystemPromptState({ forceSystemPrompt: "Exact prompt.", cwd: "/tmp" })).toEqual({
			content: "Exact prompt.",
		});
		expect(buildSystemPromptState({ cwd: "/tmp" })).toEqual({
			content: "",
			sections: buildSystemPromptSections({ cwd: "/tmp" }),
		});
		expect(() => buildSystemPromptSections({ cwd: "/tmp", sections: { preamble: "x" } })).toThrow(
			"Invalid system prompt section name",
		);
	});

	test("a forced prompt is sent as the leading prompt for the run and never recorded", async () => {
		let turn = 0;
		const extension: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event) => {
				if (++turn === 3) event.systemPromptOptions.sections.plan_mode = "Plan only.";
				return turn === 2 || turn === 3 ? { systemPrompt: "Exact prompt." } : undefined;
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		try {
			const requests: TranscriptContext[] = [];
			harness.setResponses(
				["one", "two", "three", "four"].map((text) => (providerContext: TranscriptContext) => {
					requests.push(providerContext);
					return fauxAssistantMessage(text);
				}),
			);
			for (const text of ["one", "two", "three", "four"]) await harness.session.prompt(text);
			const systemMessages = requests.map((request) =>
				request.messages.filter((message) => message.role === "system"),
			);
			// Forced turns collapse to one leading message; the unforced fourth turn passes the
			// recorded head and both plan_mode patches through.
			expect(systemMessages.map((messages) => messages.length)).toEqual([1, 1, 1, 3]);

			const forced = systemMessages[1]?.at(-1);
			expect(forced).toEqual({
				role: "system",
				content: "Exact prompt.",
				toolsAdded: systemMessages[0]?.[0]?.toolsAdded,
				timestamp: systemMessages[0]?.[0]?.timestamp,
			});
			expect(systemMessages[2]?.at(-1)).toEqual(forced);
			expect(getCurrentSystemPrompt(requests[2]!.messages)).toBe("Exact prompt.");
			expect(requests[2]!.messages.map((message) => message.role)).toEqual([
				"system",
				"user",
				"assistant",
				"user",
				"assistant",
				"user",
			]);

			// The transcript only records the structured sections, never the forced text.
			const recorded = harness.session.messages.flatMap((message) =>
				message.role === "system" ? [message.sections] : [],
			);
			expect(recorded).toEqual([
				systemMessages[0]?.[0]?.sections,
				{ plan_mode: "<plan_mode>\nPlan only.\n</plan_mode>" },
				{ plan_mode: null },
			]);
			expect(getCurrentSystemPrompt(harness.session.messages)).toBe(harness.session.systemPrompt);
		} finally {
			harness.cleanup();
		}
	});

	test("restores structured state and tool selection across rollover and regenerates forced requests", async () => {
		let force = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (!force) return;
						event.systemPromptOptions.selectedTools = ["read"];
						return { systemPrompt: "Exact checkpoint prompt." };
					});
				},
			],
		});
		try {
			const requests: TranscriptContext[] = [];
			harness.setResponses(
				["base", "forced", "continued"].map((text) => (context: TranscriptContext) => {
					requests.push(context);
					return fauxAssistantMessage(text);
				}),
			);
			await harness.session.prompt("base");
			const baseLeaf = harness.sessionManager.getLeafId()!;
			force = true;
			await harness.session.prompt("force");
			harness.session.newContext({ handoff: "Continue the task" });
			const windowLeaf = harness.sessionManager.getLeafId()!;
			expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Exact checkpoint prompt.");
			expect(getCurrentSystemMessage(harness.session.messages)?.sections?.preamble).toBeDefined();
			expect(getCurrentTools(harness.session.messages).map((tool) => tool.name)).toEqual(["read"]);
			expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "custom"]);
			await harness.session.navigateTree(baseLeaf);
			expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "background_command", "edit", "write"]);
			await harness.session.navigateTree(windowLeaf);
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
			expect(harness.session.systemPrompt).toBe(getCurrentSystemPrompt(harness.session.messages));
			await harness.session.prompt("continue");
			expect(getCurrentSystemPrompt(requests[1].messages)).toBe("Exact checkpoint prompt.");
			expect(getCurrentSystemPrompt(requests[2].messages)).toBe("Exact checkpoint prompt.");
			expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Exact checkpoint prompt.");
			expect(getCurrentSystemMessage(harness.session.messages)?.sections?.preamble).toBeDefined();
			expect(harness.session.messages.filter((message) => message.role === "system")).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	test("replays a saved replacement on SDK resume and resets its opaque prefix on the next run", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-replacement-resume-"));
		const harness = await createHarness({
			sessionManager: SessionManager.create(directory, directory),
			settings: { compaction: { enabled: false } },
		});
		try {
			harness.setResponses([fauxAssistantMessage("old answer")]);
			await harness.session.prompt("old question");
			const read = getCurrentTools(harness.session.messages).find((tool) => tool.name === "read")!;
			harness.sessionManager.appendMessage({
				role: "system",
				content: "Saved exact prompt.",
				replace: true,
				toolsAdded: [read],
				timestamp: 10,
			});
			harness.sessionManager.appendMessage({
				role: "system",
				content: "",
				sections: { legacy: "Saved section." },
				timestamp: 11,
			});
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: directory,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				sessionManager: SessionManager.open(harness.session.sessionFile!),
			});
			try {
				expect(session.systemPrompt).toBe("Saved exact prompt.\n\nSaved section.");
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(getCurrentTools(session.messages)).toEqual([read]);
				const requests: TranscriptContext[] = [];
				harness.setResponses(
					["resumed", "next"].map((text) => (context: TranscriptContext) => {
						requests.push(context);
						return fauxAssistantMessage(text);
					}),
				);
				await session.prompt("resume");
				await session.prompt("next");
				for (const request of requests) {
					expect(getCurrentSystemPrompt(request.messages)).not.toContain("Saved ");
					expect(getCurrentSystemPrompt(request.messages)).toContain("<cwd>");
					expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual(["read"]);
				}
				const replacements = session.messages.filter((message) => message.role === "system" && message.replace);
				expect(replacements).toHaveLength(2); // The saved record and one structured reset, not one per run.
				expect(getCurrentSystemMessage(session.messages)?.content).toBe("");
				expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
			} finally {
				session.dispose();
			}
		} finally {
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps exact forced guidance across same-run rollover and dynamic tool loading", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.sections.policy = "Structured policy.";
						return { systemPrompt: "Exact child guidance." };
					});
					pi.on("context", (event) => ({
						messages: [
							...event.messages,
							{ role: "system", content: "Context must not override force.", timestamp: 0 },
						],
					}));
					pi.registerTool({
						name: "load",
						label: "Load",
						description: "Load a final tool and start a fresh window",
						parameters: Type.Object({}),
						async execute() {
							pi.registerTool({
								name: "structured_output",
								label: "Output",
								description: "Deliver the result",
								parameters: Type.Object({ answer: Type.String() }),
								async execute(_id, params) {
									return {
										content: [{ type: "text", text: params.answer }],
										details: undefined,
										terminate: true,
									};
								},
							});
							pi.setActiveTools(["structured_output"]);
							return { content: [], details: undefined, newContext: { handoff: "Continue here." } };
						},
					});
				},
			],
		});
		try {
			const requests: TranscriptContext[] = [];
			const prompts: string[] = [];
			harness.setResponses(
				[fauxToolCall("load", {}), fauxToolCall("structured_output", { answer: "done" })].map(
					(call) => (context: TranscriptContext) => {
						requests.push(context);
						prompts.push(harness.session.systemPrompt);
						return fauxAssistantMessage([call], { stopReason: "toolUse" });
					},
				),
			);
			await harness.session.prompt("start");
			expect(requests).toHaveLength(2);
			expect(prompts).toEqual(["Exact child guidance.", "Exact child guidance."]);
			for (const request of requests) {
				expect(getCurrentSystemPrompt(request.messages)).toBe("Exact child guidance.");
				expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
			}
			expect(getCurrentTools(requests[0].messages).map((tool) => tool.name)).toEqual(["load"]);
			expect(getCurrentTools(requests[1].messages).map((tool) => tool.name)).toEqual(["structured_output"]);
			expect(JSON.stringify(requests[1].messages)).toContain("Continue here.");
			expect(harness.eventsOfType("context_window_started")).toHaveLength(1);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "toolResult",
				toolName: "structured_output",
				isError: false,
			});
			expect(getCurrentSystemPrompt(harness.session.messages)).toContain("Structured policy.");
			expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Exact child guidance.");
			expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionContext().messages);
		} finally {
			harness.cleanup();
		}
	});

	test("setActiveTools emits prompt sections and tool changes before the next request", async () => {
		const extension: ExtensionFactory = (pi) => {
			for (const name of ["first", "second"]) {
				pi.registerTool({
					name,
					label: name,
					description: `${name} description`,
					promptSnippet: `${name} prompt snippet`,
					promptGuidelines: [`Use ${name} carefully.`],
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
				});
			}
		};
		const harness = await createHarness({ extensionFactories: [extension], initialActiveToolNames: ["first"] });
		try {
			// Faux response callbacks swallow thrown assertions, so capture and assert afterwards.
			const requests: TranscriptContext[] = [];
			harness.setResponses([
				(providerContext) => {
					requests.push(providerContext);
					return fauxAssistantMessage("first");
				},
				(providerContext) => {
					requests.push(providerContext);
					return fauxAssistantMessage([fauxToolCall("first", {})], { stopReason: "toolUse" });
				},
				(providerContext) => {
					requests.push(providerContext);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("first");
			harness.session.setActiveToolsByName(["second"]);
			await harness.session.prompt("second");
			expect(requests).toHaveLength(3);

			expect(Object.keys(requests[0] ?? {})).toEqual(["messages"]);
			const initial = requests[0]?.messages[0];
			if (initial?.role !== "system") throw new Error("expected initial system message");
			expect(initial.toolsAdded?.map((value) => value.name)).toEqual(["first", "second"]);
			expect(initial.sections?.tools).toContain("first prompt snippet");

			const update = requests[1]?.messages.filter((message) => message.role === "system").at(-1);
			expect(update).toEqual({
				role: "system",
				content: "",
				sections: { tools: expect.stringContaining("second prompt snippet"), rules: expect.any(String) },
				toolsRemoved: [{ name: "first" }],
				timestamp: expect.any(Number),
			});
			expect(update?.sections?.tools).not.toContain("first prompt snippet");
			expect(update?.sections?.rules).not.toContain("Use first carefully.");

			const result = requests[2]?.messages.filter((message) => message.role === "toolResult").at(-1);
			expect(result).toMatchObject({ role: "toolResult", toolName: "first", isError: true });

			const current = getCurrentSystemMessage(harness.session.messages);
			expect(current?.toolsAdded?.map((value) => value.name)).toEqual(["second"]);
			expect(getSystemMessageText(current!)).toBe(harness.session.systemPrompt);
		} finally {
			harness.cleanup();
		}
	});

	test("setActiveTools in before_agent_start controls the same request", async () => {
		const extension: ExtensionFactory = (pi) => {
			for (const name of ["first", "second"]) {
				pi.registerTool({
					name,
					label: name,
					description: `${name} description`,
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
				});
			}
			let turn = 0;
			pi.on("before_agent_start", () => {
				if (turn++ === 1) pi.setActiveTools(["second"]);
			});
		};
		const harness = await createHarness({ extensionFactories: [extension], initialActiveToolNames: ["first"] });
		try {
			const requests: TranscriptContext[] = [];
			harness.setResponses([
				(providerContext) => {
					requests.push(providerContext);
					return fauxAssistantMessage("first");
				},
				(providerContext) => {
					requests.push(providerContext);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			expect(requests).toHaveLength(2);
			const update = requests[1]?.messages.filter((message) => message.role === "system").at(-1);
			expect(update?.toolsRemoved).toEqual([{ name: "first" }]);
			expect(update?.toolsAdded).toBeUndefined();
			expect(harness.session.getActiveToolNames()).toEqual(["second"]);
		} finally {
			harness.cleanup();
		}
	});

	test("restores checkpoint prompt and executable tools on file-backed SDK resume after rollover", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-window-resume-"));
		const tools: AgentTool[] = ["first", "second"].map((name) => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		}));
		const resourceLoader = { ...createTestResourceLoader(), getSystemPrompt: () => "Persistent runtime guidance" };
		const harness = await createHarness({
			tools,
			initialActiveToolNames: ["first"],
			resourceLoader,
			sessionManager: SessionManager.create(directory, directory),
			settings: { compaction: { enabled: false } },
		});
		try {
			harness.setResponses([fauxAssistantMessage("old first answer"), fauxAssistantMessage("old second answer")]);
			await harness.session.prompt("old first input");
			harness.session.setActiveToolsByName(["second"]);
			await harness.session.prompt("old second input");
			const prompt = harness.session.agent.state.systemPrompt;
			harness.session.newContext({ handoff: "continue here" });
			expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "custom"]);
			expect(harness.session.agent.state.systemPrompt).toBe(prompt);
			for (const type of ["message_start", "message_end"] as const) {
				expect(harness.eventsOfType(type).at(-1)?.message).toMatchObject({
					role: "custom",
					customType: "context-window",
				});
			}
			const { session: resumed } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: directory,
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader,
				customTools: tools,
				sessionManager: SessionManager.open(harness.session.sessionFile!),
			});
			try {
				expect(resumed.messages.map((message) => message.role)).toEqual(["system", "custom"]);
				expect(resumed.agent.state.systemPrompt).toBe(prompt);
				expect(resumed.systemPrompt).toBe(prompt);
				expect(resumed.getActiveToolNames()).toEqual(["second"]);
				expect(JSON.stringify(resumed.messages)).not.toContain("old first");
				expect(JSON.stringify(resumed.messages)).not.toContain("old second");
				let request: TranscriptContext | undefined;
				harness.setResponses([
					(context) => {
						request = context;
						return fauxAssistantMessage("resumed");
					},
				]);
				await resumed.prompt("new input");
				expect(getCurrentTools(request?.messages ?? []).map((tool) => tool.name)).toEqual(["second"]);
				expect(getCurrentSystemPrompt(request?.messages ?? [])).toBe(prompt);
				expect(JSON.stringify(request?.messages)).toContain("continue here");
				expect(JSON.stringify(request?.messages)).not.toContain("old first");
				expect(resumed.messages.filter((message) => message.role === "system")).toHaveLength(1);
			} finally {
				resumed.dispose();
			}
		} finally {
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("retains the complete prompt when preflight rollover checkpoints the base of a pending patch", async () => {
		let turn = 0;
		const harness = await createHarness({
			tools: [],
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 5000 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.sections.policy = ++turn === 1 ? "first policy" : "second policy";
					});
					pi.on("session_before_auto_compact", () => ({ newContext: { handoff: "keep working" } }));
				},
			],
		});
		try {
			const requests: Array<{ context: TranscriptContext; prompt: string }> = [];
			harness.setResponses([
				fauxAssistantMessage("first"),
				(context) => {
					requests.push({ context, prompt: harness.session.systemPrompt });
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("a".repeat(36_000));
			await harness.session.prompt("b".repeat(28_000));
			expect(requests).toHaveLength(1);
			expect(harness.eventsOfType("context_window_started")).toHaveLength(1);
			expect(getCurrentSystemPrompt(requests[0].context.messages)).toBe(requests[0].prompt);
			expect(requests[0].prompt).toContain("second policy");
			expect(requests[0].prompt).toContain("<cwd>");
			expect(getCurrentTools(requests[0].context.messages)).toEqual([]);
			expect(getCurrentSystemPrompt(harness.sessionManager.buildSessionContext().messages)).toBe(requests[0].prompt);
			expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionContext().messages);
			const branch = harness.sessionManager.getBranch();
			const boundary = branch.findIndex((entry) => entry.type === "context_window");
			expect(
				branch.slice(boundary + 1).filter((entry) => entry.type === "message" && entry.message.role === "system")
					.length,
			).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});

	test("keeps tool declarations stable across a session JSON round-trip", async () => {
		const executableTool: AgentTool = {
			name: "plain",
			label: "Plain",
			description: "Plain tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		const harness = await createHarness({ tools: [executableTool], initialActiveToolNames: ["plain"] });
		try {
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			await harness.session.prompt("one");
			const head = harness.session.messages[0];
			if (head?.role !== "system") throw new Error("expected system message");
			const declaration = head.toolsAdded?.[0];
			if (!declaration) throw new Error("expected tool declaration");
			expect(Object.hasOwn(declaration, "constrainedSampling")).toBe(false);
			expect(Object.hasOwn(declaration, "execute")).toBe(false);

			// Simulate a resume: the persisted JSON must replay to the same declarations.
			harness.session.agent.state.messages = JSON.parse(JSON.stringify(harness.session.messages));
			await harness.session.prompt("two");
			expect(harness.session.messages.filter((message) => message.role === "system")).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});
});
