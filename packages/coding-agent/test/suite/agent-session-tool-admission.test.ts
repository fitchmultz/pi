import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("AgentSession queued tool admission", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const execution of ["sequential", "parallel"] as const) {
		for (const change of [
			"inactive registration",
			"identical registration",
			"active refresh",
			"description refresh",
			"loadout description",
		] as const) {
			it(`executes an unchanged queued tool once after ${change} (${execution})`, async () => {
				let effects = 0;
				let api: ExtensionAPI;
				const stable: ToolDefinition = {
					name: "stable",
					label: "stable",
					description: "A stable tool",
					parameters: Type.Object({}),
					prepareLoadout:
						change === "loadout description"
							? () => ({ descriptions: { stable: "Presented description" } })
							: undefined,
					async execute(_id, _args, signal, _update, ctx) {
						expect(this).toBe(stable);
						expect(signal).toBeInstanceOf(AbortSignal);
						expect(ctx.signal).toBeInstanceOf(AbortSignal);
						effects++;
						return { content: [{ type: "text", text: ctx.cwd }], details: {} };
					},
				};
				const update = () => {
					if (change === "identical registration") api.registerTool(stable);
					else if (change === "active refresh") api.setActiveTools(api.getActiveTools());
					else if (change === "description refresh") {
						stable.description = "Updated description";
						api.registerTool(stable);
					} else api.registerTool({ ...stable, name: "inactive", defaultActive: false });
				};
				const harness = await createHarness({
					initialActiveToolNames: [],
					extensionFactories: [
						(pi) => {
							api = pi;
							pi.registerTool(stable);
							pi.registerTool({
								...stable,
								name: "writer",
								executionMode: execution,
								execute: async () => {
									if (execution === "sequential") update();
									return { content: [{ type: "text", text: "updated" }], details: {} };
								},
							});
							pi.on("tool_call", (event) => {
								// Parallel calls are all prepared before any executor starts.
								if (execution === "parallel" && event.toolName === "stable") update();
							});
						},
					],
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				harness.setResponses([
					(context: TranscriptContext) => {
						expect(getCurrentTools(context.messages).find((tool) => tool.name === "stable")?.description).toBe(
							change === "loadout description" ? "Presented description" : "A stable tool",
						);
						return fauxAssistantMessage([fauxToolCall("writer", {}), fauxToolCall("stable", {})], {
							stopReason: "toolUse",
						});
					},
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				expect(effects).toBe(1);
				expect(getToolResult(harness, "stable")).toMatchObject({
					isError: false,
					content: [{ type: "text", text: harness.tempDir }],
				});
				if (change === "inactive registration") expect(api!.getActiveTools()).not.toContain("inactive");
			});
		}
	}

	it("executes a queued built-in tool after its registration source is rebuilt", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read"],
			extensionFactories: [
				(pi) => {
					const inactive: ToolDefinition = {
						name: "inactive",
						label: "inactive",
						description: "inactive",
						parameters: Type.Object({}),
						defaultActive: false,
						execute: async () => ({ content: [], details: {} }),
					};
					pi.registerTool({
						...inactive,
						name: "writer",
						defaultActive: true,
						executionMode: "sequential",
						execute: async () => {
							pi.registerTool(inactive);
							return { content: [], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "notes.txt"), "native read\n");
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("writer", {}), fauxToolCall("read", { path: "notes.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "read")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "native read\n" }],
		});
		expect(harness.eventsOfType("tool_execution_end").filter((event) => event.toolName === "read")).toHaveLength(1);
	});

	for (const presentation of [false, true]) {
		for (const change of [
			"executor",
			"schema",
			"sampling",
			"arguments",
			"execution mode",
			"owner",
			"withdrawal",
		] as const) {
			for (const refresh of [false, true]) {
				if (!refresh && (change === "owner" || change === "withdrawal")) continue;
				it(`refuses a prepared call after a genuine ${change} change (refresh: ${refresh}, presentation: ${presentation})`, async () => {
					let effects = 0;
					let replacementEffects = 0;
					let otherApi: ExtensionAPI;
					const replacement: ToolDefinition["execute"] = async () => {
						replacementEffects++;
						return { content: [{ type: "text", text: "replacement" }], details: {} };
					};
					const stable: ToolDefinition = {
						name: "stable",
						label: "stable",
						description: "A stable tool",
						parameters: Type.Object({}),
						prepareLoadout: presentation
							? () => ({ descriptions: { stable: "Presented description" } })
							: undefined,
						execute: async () => {
							effects++;
							return { content: [{ type: "text", text: "effect" }], details: {} };
						},
					};
					const harness = await createHarness({
						initialActiveToolNames: [],
						extensionFactories: [
							{
								path: "<inline:new-owner>",
								factory: (pi) => {
									otherApi = pi;
								},
							},
							{
								path: "<inline:original-owner>",
								factory: (pi) => {
									pi.registerTool(stable);
									pi.on("tool_call", () => {
										if (change === "owner") otherApi.registerTool(stable);
										else if (change === "withdrawal") pi.setActiveTools([]);
										else {
											if (change === "executor") stable.execute = replacement;
											if (change === "schema") stable.parameters = Type.Object({ required: Type.String() });
											if (change === "sampling")
												stable.constrainedSampling = { type: "json_schema", strict: "require" };
											if (change === "arguments") stable.prepareArguments = () => ({});
											if (change === "execution mode") stable.executionMode = "sequential";
											if (refresh) pi.registerTool(stable);
										}
									});
								},
							},
						],
					});
					harnesses.push(harness);
					await harness.session.bindExtensions({});
					harness.setResponses([
						(context: TranscriptContext) => {
							expect(getCurrentTools(context.messages).find((tool) => tool.name === "stable")?.description).toBe(
								presentation ? "Presented description" : "A stable tool",
							);
							return fauxAssistantMessage([fauxToolCall("stable", {})], { stopReason: "toolUse" });
						},
						fauxAssistantMessage("done"),
					]);
					await harness.session.prompt("go");
					expect(effects).toBe(0);
					expect(replacementEffects).toBe(0);
					expect(getToolResult(harness, "stable")).toMatchObject({
						isError: true,
						content: [
							{
								type: "text",
								text:
									change === "withdrawal"
										? "Tool stable is no longer available"
										: "Tool stable changed before execution",
							},
						],
					});
				});
			}
		}
	}

	for (const change of ["unchanged", "executor", "schema", "sampling", "arguments", "execution mode"] as const) {
		for (const refresh of [false, true]) {
			it(`rechecks a caller-supplied base tool after ${change} (refresh: ${refresh})`, async () => {
				let effects = 0;
				let replacementEffects = 0;
				let argumentCount = 0;
				const stable: AgentTool = {
					name: "stable",
					label: "stable",
					description: "A stable tool",
					parameters: Type.Object({}),
					async execute(...args) {
						expect(this).toBe(stable);
						argumentCount = args.length;
						expect(args[2]).toBeInstanceOf(AbortSignal);
						effects++;
						return { content: [{ type: "text", text: "original" }], details: {} };
					},
				};
				const harness = await createHarness({
					tools: [stable],
					extensionFactories: [
						(pi) => {
							pi.on("tool_call", () => {
								if (change === "executor") {
									stable.execute = async () => {
										replacementEffects++;
										return { content: [], details: {} };
									};
								}
								if (change === "schema") stable.parameters = Type.Object({ required: Type.String() });
								if (change === "sampling")
									stable.constrainedSampling = { type: "json_schema", strict: "require" };
								if (change === "arguments") stable.prepareArguments = () => ({});
								if (change === "execution mode") stable.executionMode = "sequential";
								if (refresh) {
									pi.registerTool({
										name: "inactive",
										label: "inactive",
										description: "inactive",
										parameters: Type.Object({}),
										defaultActive: false,
										execute: async () => ({ content: [], details: {} }),
									});
								}
							});
						},
					],
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("stable", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				expect(effects).toBe(change === "unchanged" ? 1 : 0);
				expect(replacementEffects).toBe(0);
				if (change === "unchanged") expect(argumentCount).toBe(4);
				expect(getToolResult(harness, "stable")).toMatchObject({
					isError: change !== "unchanged",
					content: [
						{ type: "text", text: change === "unchanged" ? "original" : "Tool stable changed before execution" },
					],
				});
			});
		}
	}

	it("preserves a caller-supplied read tool's configured cwd", async () => {
		const configuredCwd = mkdtempSync(join(tmpdir(), "configured-read-"));
		try {
			writeFileSync(join(configuredCwd, "only-here.txt"), "configured directory\n");
			const harness = await createHarness({ tools: [createReadTool(configuredCwd)] });
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "only-here.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			expect(getToolResult(harness, "read")).toMatchObject({
				isError: false,
				content: [{ type: "text", text: "configured directory\n" }],
			});
		} finally {
			rmSync(configuredCwd, { recursive: true });
		}
	});

	it("aborts an admitted call on reload and revokes the old extension's registration authority", async () => {
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let effects = 0;
		let api: ExtensionAPI;
		const stable: ToolDefinition = {
			name: "stable",
			label: "stable",
			description: "A stable tool",
			parameters: Type.Object({}),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "effect" }], details: {} };
			},
		};
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool(stable);
					pi.on("tool_call", async () => {
						enter();
						await released;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage([fauxToolCall("stable", {})], { stopReason: "toolUse" })]);
		const originalApi = api!;
		const prompt = harness.session.prompt("go");
		try {
			await entered;
			const reload = harness.session.reload();
			release();
			await Promise.all([prompt, reload]);
			expect(effects).toBe(0);
			expect(getToolResult(harness, "stable")).toMatchObject({
				isError: true,
				content: [{ type: "text", text: "Operation aborted" }],
			});
			expect(() => originalApi.registerTool(stable)).toThrow("stale");
		} finally {
			release();
			await prompt;
		}
	});
});
