import { collapseSystemMessages, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import instructionGroups, { type InstructionGroupCollector } from "../../src/extensions/instruction-groups.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const full = "Full browser safety instructions: inspect before acting. Preserve all owner guidance.";
function owner(pi: ExtensionAPI) {
	let managed = () => false;
	pi.events.on("pi:instruction-groups", (data) => {
		const collector = data as InstructionGroupCollector;
		collector.register({
			name: "browser",
			description: "Browser actions",
			tools: ["browse", "optional", "hidden"],
			instructions: () => full,
		});
		managed = collector.isManaged;
	});
	for (const name of ["browse", "optional", "hidden"])
		pi.registerTool({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			defaultActive: name === "browse",
			exposure: name === "hidden" ? "hidden" : "direct",
			execute: async () => ({ content: [{ type: "text", text: "acted" }], details: {} }),
		});
	pi.registerTool({
		name: "plain",
		label: "plain",
		description: "Unrelated action",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "plain ran" }], details: {} }),
	});
	pi.registerTool({
		name: "nested",
		label: "nested",
		description: "Nested call",
		parameters: Type.Object({}),
		exposure: "model-only",
		execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool("browse", {})).result,
	});
	pi.on("before_agent_start", (event) => {
		if (!managed()) event.systemPromptOptions.appendSystemPrompt += full;
	});
}
const discover = () =>
	fauxAssistantMessage([fauxToolCall("discover_tools", { enable: ["browser"] })], { stopReason: "toolUse" });

describe("grouped instructions through the public lifecycle", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});
	async function setup(options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [instructionGroups, owner],
			...options,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("delivers full instructions before actions, blocks same-batch direct and nested calls, and never activates optional tools", async () => {
		const harness = await setup();
		const active = harness.session.getActiveToolNames();
		const callable = harness.session.getCallableToolNames();
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("browse");
				expect(JSON.stringify(context.messages)).not.toContain(full);
				return fauxAssistantMessage(
					[
						fauxToolCall("discover_tools", { enable: ["browser"] }),
						fauxToolCall("browse", {}),
						fauxToolCall("nested", {}),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(full);
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				expect(getToolResult(harness, "browse").isError).toBe(true);
				expect(getToolResult(harness, "nested").content).toEqual(
					expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("prior turn") })]),
				);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "browse").content).toEqual([{ type: "text", text: "acted" }]);
		expect(harness.session.getActiveToolNames()).toEqual(active);
		expect(harness.session.getCallableToolNames()).toEqual(callable);
		expect(active).not.toContain("optional");
		expect(callable).not.toContain("hidden");
	});

	it("does not advertise groups whose tools are excluded, and supports eager owner fallback when discovery is inactive", async () => {
		const denied = await setup({ excludedToolNames: ["browse", "optional", "hidden"] });
		denied.setResponses([
			fauxAssistantMessage([fauxToolCall("discover_tools", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await denied.session.prompt("list");
		expect(getToolResult(denied, "discover_tools").content).toEqual([
			{ type: "text", text: "No instruction groups available." },
		]);
		const plain = await setup({ excludedToolNames: ["discover_tools"] });
		plain.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(full);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await plain.session.prompt("act");
		expect(getToolResult(plain, "browse").isError).not.toBe(true);
	});

	it("blocks same-batch codemode actions and permits them after the next instruction-bearing request", async () => {
		const harness = await setup({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [instructionGroups, owner, createCodemodeExtension()],
		});
		const code = () => fauxToolCall("codemode", { code: "return await tools.browse({});" });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("discover_tools", { enable: ["browser"] }), code()], {
				stopReason: "toolUse",
			}),
			() => {
				expect(getToolResult(harness, "codemode").isError).toBe(true);
				expect(JSON.stringify(getToolResult(harness, "codemode").content)).toContain("prior turn");
				return fauxAssistantMessage([code()], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("discover and use codemode");
		expect(JSON.stringify(getToolResult(harness, "codemode").content)).toContain("acted");
	});

	it.each(["parallel", "sequential"] as const)(
		"runs unchanged plain and codemode siblings after discovery in %s mode",
		async (toolExecution) => {
			const harness = await setup({
				initialActiveToolNames: ["plain", "codemode"],
				extensionFactories: [instructionGroups, owner, createCodemodeExtension()],
			});
			harness.session.agent.toolExecution = toolExecution;
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("discover_tools", { enable: ["browser"] }),
						fauxToolCall("plain", {}),
						fauxToolCall("codemode", { code: "return 1;" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("discover and run unrelated tools");
			expect(getToolResult(harness, "plain")).toMatchObject({
				isError: false,
				content: [{ type: "text", text: "plain ran" }],
			});
			expect(getToolResult(harness, "codemode")).toMatchObject({
				isError: false,
				content: expect.arrayContaining([{ type: "text", text: "1" }]),
			});
		},
	);

	it("does not authorize from instructions removed by forced prompt projection", async () => {
		let prune = false;
		const harness = await setup({
			extensionFactories: [
				instructionGroups,
				owner,
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.forceSystemPrompt = "Forced prompt";
					});
					pi.on("context", (event) =>
						prune ? { messages: event.messages.filter((message) => message.role === "user") } : undefined,
					);
				},
			],
		});
		harness.setResponses([discover(), fauxAssistantMessage("enabled")]);
		await harness.session.prompt("enable");
		prune = true;
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain(full);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("act");
		expect(getToolResult(harness, "browse").isError).toBe(true);
	});

	it("does not authorize from superseded instruction sections absent from the provider context", async () => {
		let prune = false;
		const harness = await setup({
			extensionFactories: [
				instructionGroups,
				owner,
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (prune) event.systemPromptOptions.appendSystemPrompt = "";
					});
					pi.on("context", (event) => {
						if (!prune) return;
						for (const message of event.messages) {
							if (message.role === "toolResult" && message.toolName === "discover_tools")
								message.content = [{ type: "text", text: "Result omitted by context budget policy" }];
						}
					});
				},
			],
		});
		harness.setResponses([discover(), fauxAssistantMessage("enabled")]);
		await harness.session.prompt("enable");
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(collapseSystemMessages(context))).toContain(full);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("persist instruction section");
		prune = true;
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain(full);
				expect(JSON.stringify(collapseSystemMessages(context))).not.toContain(full);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("act");
		expect(getToolResult(harness, "browse").isError).toBe(true);
	});

	it("restores enabled names from the selected raw branch and recalculates declarations", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("before")]);
		await harness.session.prompt("before discovery");
		const before = harness.sessionManager.getLeafId()!;
		harness.setResponses([discover(), fauxAssistantMessage("enabled")]);
		await harness.session.prompt("enable");
		const after = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(before);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("browse");
				return fauxAssistantMessage("old branch");
			},
		]);
		await harness.session.prompt("old");
		await harness.session.navigateTree(after);
		// Rebinding emits session_start and recollects owner registrations.
		await harness.session.bindExtensions({});
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(full);
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("restored");
		expect(getToolResult(harness, "browse").isError).not.toBe(true);
	});

	it("keeps the compaction repair stable when another group is discovered later", async () => {
		const repairs: unknown[] = [];
		const harness = await setup({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				instructionGroups,
				owner,
				(pi) => {
					pi.events.on("pi:instruction-groups", (data) =>
						(data as InstructionGroupCollector).register({
							name: "later",
							description: "Later instructions",
							tools: ["nested"],
							instructions: () => "Full later instructions",
						}),
					);
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("context_with_system", (event) => {
						const index = event.messages.findLastIndex((message) => message.role === "compactionSummary");
						if (index >= 0) repairs.push(event.messages[index + 1]);
					});
				},
			],
		});
		harness.setResponses([discover(), fauxAssistantMessage("enabled")]);
		await harness.session.prompt("enable browser");
		await harness.session.compact();
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "discover_tools",
			),
		).toBe(false);
		const boundary = harness.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("discover_tools", { enable: ["later"] }), fauxToolCall("browse", {})], {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Full later instructions");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("enable later group");
		expect(getToolResult(harness, "browse").isError).not.toBe(true);
		expect(repairs).toHaveLength(2);
		expect(repairs[0]).toEqual(repairs[1]);
		expect(repairs[0]).toMatchObject({
			role: "custom",
			content: `## browser\n\n${full}`,
			timestamp: Date.parse(boundary.timestamp),
		});
	});

	it("repairs instructions immediately after compaction when discovery mid-run triggers automatic compaction", async () => {
		const large = full + " guidance".repeat(1800);
		const repairs: unknown[] = [];
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 12000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 6000, keepRecentTokens: 1 } },
			extensionFactories: [
				instructionGroups,
				(pi) => {
					pi.events.on("pi:instruction-groups", (data) =>
						(data as InstructionGroupCollector).register({
							name: "browser",
							description: "Browser",
							tools: ["browse"],
							instructions: () => large,
						}),
					);
					pi.registerTool({
						name: "browse",
						label: "browse",
						description: "browse",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "acted" }], details: {} }),
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "summary without instructions",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("context_with_system", (event) => {
						const index = event.messages.findLastIndex((message) => message.role === "compactionSummary");
						if (index >= 0) {
							const repair = event.messages[index + 1];
							expect(repair).toMatchObject({
								role: "custom",
								display: false,
								content: `## browser\n\n${large}`,
							});
							expect(event.messages[0].role).toBe("system");
							repairs.push(repair);
						}
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("Earlier answer")]);
		await harness.session.prompt("Earlier context ".repeat(800));
		harness.setResponses([
			discover(),
			fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("discover then act");
		expect(harness.eventsOfType("compaction_end").length).toBeGreaterThan(0);
		expect(repairs.length).toBeGreaterThan(0);
		expect(getToolResult(harness, "browse").isError).not.toBe(true);
	});
});
