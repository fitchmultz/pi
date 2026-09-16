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
import { buildSystemPromptSections, diffSystemPromptSections } from "../src/core/system-prompt.ts";
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
			expect(head.toolsAdded?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
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

		const override = buildSystemPromptSections({ forceSystemPrompt: "Exact prompt.", cwd: "/tmp" });
		expect(override).toEqual({ preamble: "Exact prompt." });
		expect(diffSystemPromptSections(current, override)).toEqual({ preamble: "Exact prompt.", cwd: null });
		expect(() => buildSystemPromptSections({ cwd: "/tmp", sections: { preamble: "x" } })).toThrow(
			"Invalid system prompt section name",
		);
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
