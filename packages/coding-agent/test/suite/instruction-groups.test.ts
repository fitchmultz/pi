import { collapseSystemMessages, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	createCodemodeExtension,
	type InstructionGroupCollector,
	instructionGroupsExtension,
} from "../../src/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const full = "Full browser safety instructions: inspect before acting. Preserve all owner guidance.";
const later = "Full later instructions";
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
			execute: async () => ({ content: [{ type: "text", text: "acted" }], details: undefined }),
		});
	pi.registerTool({
		name: "plain",
		label: "plain",
		description: "Unrelated action",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "plain ran" }], details: undefined }),
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
const discover = (enable = ["browser"]) =>
	fauxAssistantMessage([fauxToolCall("discover_tools", { enable })], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage("done");

// These exercise the real request, nested-call, branch, and compaction boundaries with no provider traffic.
describe("on-demand instruction groups", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});
	async function setup(options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [instructionGroupsExtension, owner],
			...options,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it.each(["parallel", "sequential"] as const)(
		"gates direct, nested, and codemode calls until the next read in %s execution",
		async (mode) => {
			const harness = await setup({
				initialActiveToolNames: ["codemode"],
				extensionFactories: [instructionGroupsExtension, owner, createCodemodeExtension()],
			});
			harness.session.agent.toolExecution = mode;
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
							fauxToolCall("codemode", { code: "return await tools.browse({});" }),
							fauxToolCall("plain", {}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					expect(JSON.stringify(context.messages)).toContain(full);
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
					for (const name of ["browse", "nested", "codemode"])
						expect(JSON.stringify(getToolResult(harness, name).content)).toContain("prior turn");
					expect(getToolResult(harness, "plain")).toMatchObject({
						isError: false,
						content: [{ type: "text", text: "plain ran" }],
					});
					return fauxAssistantMessage(
						[
							fauxToolCall("browse", {}),
							fauxToolCall("nested", {}),
							fauxToolCall("codemode", { code: "return await tools.browse({});" }),
						],
						{ stopReason: "toolUse" },
					);
				},
				done(),
			]);
			await harness.session.prompt("discover and act");
			for (const name of ["browse", "nested", "codemode"]) {
				expect(getToolResult(harness, name).isError).toBe(false);
				expect(JSON.stringify(getToolResult(harness, name).content)).toContain("acted");
			}
			expect(harness.session.getActiveToolNames()).toEqual(active);
			expect(harness.session.getCallableToolNames()).toEqual(callable);
			expect(active).not.toContain("optional");
			expect(callable).not.toContain("hidden");
			expect(callable).not.toContain("discover_tools");
		},
	);

	it("lists without enabling and rejects unavailable or duplicate enables without changing state", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("discover_tools", {})], { stopReason: "toolUse" }),
			(context) => {
				expect(getToolResult(harness, "discover_tools").content).toEqual([
					{ type: "text", text: "browser: Browser actions" },
				]);
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("browse");
				return fauxAssistantMessage([fauxToolCall("discover_tools", { enable: ["browser", "missing"] })], {
					stopReason: "toolUse",
				});
			},
			() => {
				expect(getToolResult(harness, "discover_tools").isError).toBe(true);
				return fauxAssistantMessage([fauxToolCall("discover_tools", { enable: ["browser", "browser"] })], {
					stopReason: "toolUse",
				});
			},
			done(),
		]);
		await harness.session.prompt("list and invalid enables");
		expect(getToolResult(harness, "discover_tools").isError).toBe(true);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
	});

	it("respects exclusions and allowlists, and keeps owners eager when discovery is inactive", async () => {
		for (const options of [
			{ excludedToolNames: ["browse", "optional", "hidden"] },
			{ allowedToolNames: ["discover_tools", "plain"] },
		]) {
			const denied = await setup(options);
			denied.setResponses([
				fauxAssistantMessage([fauxToolCall("discover_tools", {})], { stopReason: "toolUse" }),
				done(),
			]);
			await denied.session.prompt("list");
			expect(getToolResult(denied, "discover_tools").content).toEqual([
				{ type: "text", text: "No instruction groups available." },
			]);
		}
		const eager = await setup({ excludedToolNames: ["discover_tools"] });
		eager.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(full);
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await eager.session.prompt("act");
		expect(getToolResult(eager, "browse").isError).toBe(false);
	});

	it("collects synchronously and rejects invalid, duplicate, and late registrations", async () => {
		let collector: InstructionGroupCollector | undefined;
		const errors: string[] = [];
		await setup({
			extensionFactories: [
				instructionGroupsExtension,
				owner,
				(pi) => {
					pi.events.on("pi:instruction-groups", (data) => {
						collector = data as InstructionGroupCollector;
						for (const group of [
							{ name: "browser", description: "duplicate", tools: ["browse"], instructions: () => full },
							{ name: "invalid", description: "invalid", tools: ["discover_tools"], instructions: () => full },
						]) {
							try {
								collector.register(group);
							} catch (error) {
								errors.push(error instanceof Error ? error.message : String(error));
							}
						}
					});
				},
			],
		});
		expect(collector).toBeDefined();
		expect(collector?.isManaged()).toBe(true);
		expect(errors).toEqual(["Invalid or duplicate instruction group", "Invalid or duplicate instruction group"]);
		expect(() =>
			collector?.register({ name: "late", description: "late", tools: ["browse"], instructions: () => full }),
		).toThrow("must register synchronously");
	});

	it.each(["forced", "superseded"] as const)(
		"does not authorize full instructions removed from the effective %s prompt",
		async (projection) => {
			let prune = false;
			const harness = await setup({
				extensionFactories: [
					instructionGroupsExtension,
					owner,
					(pi) => {
						pi.on("before_agent_start", (event) => {
							if (projection === "forced") event.systemPromptOptions.forceSystemPrompt = "Forced prompt";
							else if (prune) event.systemPromptOptions.appendSystemPrompt = "";
						});
						pi.on("context", (event) => {
							if (!prune) return;
							if (projection === "forced")
								return { messages: event.messages.filter((message) => message.role === "user") };
							for (const message of event.messages) {
								if (message.role === "toolResult" && message.toolName === "discover_tools")
									message.content = [{ type: "text", text: "Result omitted" }];
							}
						});
					},
				],
			});
			harness.setResponses([discover(), done()]);
			await harness.session.prompt("enable");
			harness.setResponses([done()]);
			await harness.session.prompt("persist instruction section");
			prune = true;
			harness.setResponses([
				(context) => {
					expect(JSON.stringify(collapseSystemMessages(context))).not.toContain(full);
					return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
				},
				done(),
			]);
			await harness.session.prompt("act");
			expect(getToolResult(harness, "browse").isError).toBe(true);
		},
	);

	it("restores only the selected branch on tree navigation, then restores enabled names in a fresh runtime", async () => {
		const harness = await setup();
		harness.setResponses([done()]);
		await harness.session.prompt("before");
		const before = harness.sessionManager.getLeafId()!;
		harness.setResponses([discover(), done()]);
		await harness.session.prompt("enable");
		const after = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(before);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("browse");
				expect(JSON.stringify(context.messages)).not.toContain(full);
				return done();
			},
		]);
		await harness.session.prompt("old branch");
		await harness.session.navigateTree(after);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await harness.session.prompt("enabled branch");
		expect(getToolResult(harness, "browse").isError).toBe(false);
		const restored = await setup({
			sessionManager: SessionManager.inMemory(harness.tempDir, undefined, [
				harness.sessionManager.getHeader()!,
				...harness.sessionManager.getBranch(),
			]),
		});
		restored.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("browse");
				expect(restored.session.systemPrompt).toContain(full);
				return fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" });
			},
			done(),
		]);
		await restored.session.prompt("resumed");
		expect(getToolResult(restored, "browse").isError).toBe(false);
	});

	it("repairs only groups enabled at each compaction boundary, including after resume", async () => {
		const repairs: unknown[] = [];
		const extra = (pi: ExtensionAPI) => {
			pi.events.on("pi:instruction-groups", (data) =>
				(data as InstructionGroupCollector).register({
					name: "later",
					description: "Later",
					tools: ["nested"],
					instructions: () => later,
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
		};
		const options = {
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [instructionGroupsExtension, owner, extra],
		};
		const harness = await setup(options);
		harness.setResponses([discover(), done()]);
		await harness.session.prompt("enable browser");
		await harness.session.compact();
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "discover_tools",
			),
		).toBe(false);
		const boundary = harness.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
		harness.setResponses([discover(["later"]), done()]);
		await harness.session.prompt("enable later");
		expect(repairs).toHaveLength(2);
		expect(repairs[0]).toEqual(repairs[1]);
		expect(repairs[0]).toMatchObject({
			role: "custom",
			display: false,
			content: `## browser\n\n${full}`,
			timestamp: Date.parse(boundary.timestamp),
		});
		const resumed = await setup({
			...options,
			sessionManager: SessionManager.inMemory(harness.tempDir, undefined, [
				harness.sessionManager.getHeader()!,
				...harness.sessionManager.getBranch(),
			]),
		});
		resumed.setResponses([done()]);
		await resumed.session.prompt("resume after compaction");
		expect(repairs.at(-1)).toEqual(repairs[0]);
		await resumed.session.compact();
		resumed.setResponses([done()]);
		await resumed.session.prompt("after second compaction");
		expect(repairs.at(-1)).toMatchObject({ content: `## browser\n\n${full}\n\n## later\n\n${later}` });
	});

	it("repairs discovery immediately when automatic compaction removes its result mid-run", async () => {
		const large = full + " guidance".repeat(1800);
		const repairs: { headRole: string; message: unknown }[] = [];
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 12000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 6000, keepRecentTokens: 1 } },
			extensionFactories: [
				instructionGroupsExtension,
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
						execute: async () => ({ content: [{ type: "text", text: "acted" }], details: undefined }),
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
						if (index < 0) return;
						repairs.push({ headRole: event.messages[0].role, message: event.messages[index + 1] });
					});
				},
			],
		});
		harness.setResponses([done()]);
		await harness.session.prompt("Earlier context ".repeat(800));
		harness.setResponses([
			discover(),
			fauxAssistantMessage([fauxToolCall("browse", {})], { stopReason: "toolUse" }),
			done(),
		]);
		await harness.session.prompt("discover then act");
		expect(harness.eventsOfType("compaction_end").length).toBeGreaterThan(0);
		expect(repairs.length).toBeGreaterThan(0);
		for (const repair of repairs) {
			expect(repair.headRole).toBe("system");
			expect(repair.message).toMatchObject({
				role: "custom",
				display: false,
				content: `## browser\n\n${large}`,
			});
		}
		expect(getToolResult(harness, "browse").isError).toBe(false);
	});
});
