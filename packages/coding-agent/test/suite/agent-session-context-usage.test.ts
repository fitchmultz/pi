import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	type Usage,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestartControl } from "../../src/cli/restart-worker.ts";
import { estimateContextTokens } from "../../src/core/compaction/index.ts";
import type { ToolDefinition } from "../../src/core/extensions/index.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
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

	it.each(["root", "window", "compaction", "response"])(
		"avoids historical arrays when checking current usage after %s",
		async (boundary) => {
			const harness = await createHarness({ tools: [] });
			harnesses.push(harness);
			const sm = harness.sessionManager;
			for (let i = 0; i < 100; i++) sm.appendCustomEntry("old", i);
			const kept = sm.appendMessage({ ...fauxAssistantMessage("old"), usage: usage(60_000) });
			if (boundary !== "root") sm.appendCompaction("summary", kept, 60_000);
			if (boundary === "window") sm.appendContextWindow("fresh", 60_000);
			if (boundary === "response") sm.appendMessage({ ...fauxAssistantMessage("new"), usage: usage(1234) });
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
		const old = { ...fauxAssistantMessage("retained"), usage: usage(60_000) };
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
			sm.appendMessage(message);
			sync();
			expect(harness.session.getContextUsage()).toMatchObject({ tokens: null, percent: null });
		}
		const valid = sm.appendMessage({ ...fauxAssistantMessage("valid"), usage: usage(1234) });
		sync();
		expect(harness.session.getContextUsage()?.tokens).toBe(1234);
		sm.appendMessage({ ...fauxAssistantMessage("zero"), usage: usage(0) });
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
			expect(harness.session.getContextUsage()?.tokens).toBe(expected);
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

	it("removes a per-run override on the next request without treating idle as a pending reset", async () => {
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
		expect(harness.session.systemPrompt).toContain("Temporary guidance.");
		await harness.session.prompt("second");
		expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("Temporary guidance.");
		expect(harness.session.getContextUsage()?.tokens).toBe(
			(harness.session.messages.at(-1) as AssistantMessage).usage.totalTokens,
		);
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
		const before = harness.session.getContextUsage()?.tokens;
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
			expect(serialize).not.toHaveBeenCalled();
		} else {
			const state = harness.session.agent.state;
			expect(harness.session.getContextUsage()?.tokens).toBe(
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
