import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
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
	GPT_6_2_MODEL_GUIDANCE,
	isGpt62Model,
} from "../src/core/system-prompt.ts";
import type { ExtensionFactory } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";

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
			expect(Object.keys(head.sections ?? {})).toEqual(["preamble", "tools", "rules", "docs", "cwd", "host"]);
			expect(head.toolsAdded?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
			expect(getSystemMessageText(head)).toBe(harness.session.systemPrompt);
		} finally {
			harness.cleanup();
		}
	});

	// #11495
	test("does not patch the prompt when the active tools are only reordered", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			await harness.session.prompt("one");
			const before = harness.session.getActiveToolNames();
			harness.session.setActiveToolsByName([...before].reverse());
			expect(harness.session.getActiveToolNames()).toEqual(before);
			await harness.session.prompt("two");
			const systemMessages = harness.session.messages.filter((message) => message.role === "system");
			expect(systemMessages).toHaveLength(1);
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

	test("applies model_guidance and omits generic conciseness only for GPT-6.2 models", () => {
		expect(isGpt62Model("gpt-6.2-astra")).toBe(true);
		expect(isGpt62Model("gpt-6.2-sol")).toBe(true);
		expect(isGpt62Model("openai/gpt-6.2-sol")).toBe(true);
		expect(isGpt62Model("gpt-6.1-sol")).toBe(false);
		expect(isGpt62Model("gemini-4-neon")).toBe(false);
		expect(isGpt62Model("claude-opus-5-5")).toBe(false);
		expect(isGpt62Model(undefined)).toBe(false);

		const baseline = buildSystemPromptSections({ cwd: "/tmp" });
		const gemini = buildSystemPromptSections({ cwd: "/tmp", modelId: "gemini-4-neon" });
		const claude = buildSystemPromptSections({ cwd: "/tmp", modelId: "claude-opus-5-5" });
		expect(gemini).toEqual(baseline);
		expect(claude).toEqual(baseline);
		expect(baseline.model_guidance).toBeUndefined();
		expect(baseline.rules).toContain("Be concise in your responses");

		const astra = buildSystemPromptSections({ cwd: "/tmp", modelId: "gpt-6.2-astra" });
		const sol = buildSystemPromptSections({ cwd: "/tmp", modelId: "gpt-6.2-sol" });
		expect(astra).toEqual(sol);
		expect(astra.model_guidance).toBe(`<model_guidance>\n${GPT_6_2_MODEL_GUIDANCE}\n</model_guidance>`);
		expect(astra.rules).not.toContain("Be concise in your responses");
		expect(diffSystemPromptSections(astra, sol)).toBeUndefined();

		const enterGpt62 = diffSystemPromptSections(gemini, sol);
		expect(enterGpt62?.model_guidance).toBe(sol.model_guidance);
		expect(enterGpt62?.rules).toBe(sol.rules);

		const leaveGpt62 = diffSystemPromptSections(sol, gemini);
		expect(leaveGpt62?.model_guidance).toBeNull();
		expect(leaveGpt62?.rules).toBe(gemini.rules);

		const customPromptSections = buildSystemPromptSections({
			cwd: "/tmp",
			customPrompt: "Custom instructions.",
			modelId: "gpt-6.2-sol",
		});
		expect(customPromptSections.model_guidance).toBeUndefined();

		const overridden = buildSystemPromptSections({
			cwd: "/tmp",
			modelId: "gpt-6.2-sol",
			sections: { model_guidance: "Custom guidance." },
		});
		expect(overridden.model_guidance).toBe("<model_guidance>\nCustom guidance.\n</model_guidance>");
	});

	test("diffs GPT-6.2 model_guidance cleanly across mid-session model switches", async () => {
		const harness = await createHarness();
		try {
			const originalModel = harness.session.model;
			if (!originalModel) throw new Error("expected initial faux model");
			const gpt62Model = { ...originalModel, id: "gpt-6.2-sol" };
			const gpt62Astra = { ...originalModel, id: "gpt-6.2-astra" };
			harness.setResponses([
				fauxAssistantMessage("turn 1"),
				fauxAssistantMessage("turn 2"),
				fauxAssistantMessage("turn 3"),
				fauxAssistantMessage("turn 4"),
			]);

			await harness.session.prompt("start on baseline");
			expect(harness.session.messages.filter((message) => message.role === "system")).toHaveLength(1);
			expect(harness.session.systemPrompt).not.toContain("<model_guidance>");

			// Switching into GPT-6.2 appends a mid-conversation system update without mutating the leading message.
			harness.session.agent.state.model = gpt62Model;
			expect(harness.session.systemPrompt).toContain("<model_guidance>");
			await harness.session.prompt("switch to gpt-6.2-sol");
			const afterEnter = harness.session.messages.filter((message) => message.role === "system");
			expect(afterEnter).toHaveLength(2);
			expect(afterEnter[0]?.sections?.model_guidance).toBeUndefined();
			expect(afterEnter[1]?.sections?.model_guidance).toContain(GPT_6_2_MODEL_GUIDANCE);

			// Switching between GPT-6.2 models emits no additional system update.
			harness.session.agent.state.model = gpt62Astra;
			await harness.session.prompt("switch to gpt-6.2-astra");
			expect(harness.session.messages.filter((message) => message.role === "system")).toHaveLength(2);

			// Switching back out of GPT-6.2 removes model_guidance and restores baseline rules.
			harness.session.agent.state.model = originalModel;
			await harness.session.prompt("switch back");
			const afterLeave = harness.session.messages.filter((message) => message.role === "system");
			expect(afterLeave).toHaveLength(3);
			expect(afterLeave[2]?.sections?.model_guidance).toBeNull();
			expect(afterLeave[2]?.sections?.rules).toContain("Be concise in your responses");
		} finally {
			harness.cleanup();
		}
	});
});
