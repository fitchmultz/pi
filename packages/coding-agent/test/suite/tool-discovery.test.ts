import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	type ToolReference,
	toolId,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionCheckpoint, writeSessionCheckpoint } from "../../src/core/checkpoint.ts";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { discoverySectionTools } from "../../src/core/tool-discovery.ts";
import { createHarness, type Harness } from "./harness.ts";

const lookup: ToolReference = { namespace: "browser", name: "lookup" };
const browserGroup = {
	name: "browser",
	description: "Browse and verify web pages",
	sections: ["browser_manual"],
} as const;
const desktopGroup = { name: "desktop", description: "Inspect native applications" } as const;
const manual = `Browser safety: observe before mutation. Preserve user-owned sessions. ${"Full instructions. ".repeat(100)}`;
const harnesses: Harness[] = [];
const sessionDirs: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of sessionDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function registerTools(pi: ExtensionAPI, execute = () => {}, discovery = true) {
	for (const reference of [lookup, { name: "advanced" }, { name: "desktop" }]) {
		pi.registerTool({
			...reference,
			discovery: discovery
				? {
						group: reference.name === "desktop" ? desktopGroup : browserGroup,
						role: reference.name === "advanced" ? "advanced" : "entry",
					}
				: undefined,
			label: reference.name,
			description: `Full ${reference.name} schema and documentation`,
			promptGuidelines: [`${reference.name}: do not bypass safeguards`],
			parameters: Type.Object({ key: Type.String() }),
			async execute(_id, params) {
				execute();
				return { content: [{ type: "text", text: `verified ${params.key}` }], details: {} };
			},
		});
	}
	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions.sectionTools.browser_manual || event.prompt.includes("browser"))
			event.systemPromptOptions.sections.browser_manual = manual;
		event.systemPromptOptions.sections.always_on_safety = "Always-on policy remains enabled";
	});
}

async function setup(options: Parameters<typeof createHarness>[0] = {}) {
	const harness = await createHarness({
		tools: [],
		api: "openai-responses",
		compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true },
		extensionFactories: [registerTools],
		...options,
	});
	harnesses.push(harness);
	return harness;
}

it("starts lean without removing capabilities, lifecycle hooks, or unrelated instructions", async () => {
	const harness = await setup();
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
	expect(harness.session.getAllTools().map((tool) => tool.id)).toEqual([
		toolId(lookup),
		"advanced",
		"desktop",
		"discover_tools",
	]);
	harness.setResponses([
		(context) => {
			const prompt = getCurrentSystemPrompt(context.messages);
			expect(prompt).not.toContain(manual);
			expect(prompt).not.toContain("lookup: do not bypass safeguards");
			expect(prompt).toContain("Always-on policy remains enabled");
			const tools = getCurrentTools(context.messages);
			expect(tools.map((tool) => tool.name)).toEqual(["discover_tools"]);
			expect(tools[0].description).toContain("browser: Browse and verify web pages");
			return fauxAssistantMessage("Dependency audit complete without optional integrations.");
		},
	]);
	await harness.session.prompt("List dependencies");
	expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
});

it("delivers complete schemas, guidelines, and scoped sections before the first integration call", async () => {
	let calls = 0;
	let guarded = 0;
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				registerTools(pi, () => {
					calls++;
				});
				pi.on("tool_call", (event) => {
					if (event.namespace === "browser") guarded++;
				});
			},
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		(context) => {
			expect(calls).toBe(0);
			expect(getCurrentSystemPrompt(context.messages)).toContain(manual);
			expect(getCurrentSystemPrompt(context.messages)).toContain("lookup: do not bypass safeguards");
			const tools = getCurrentTools(context.messages);
			expect(tools.every((tool) => !("discovery" in tool))).toBe(true);
			expect(tools.map((tool) => tool.description)).toEqual([
				expect.stringContaining("Enable optional integrations"),
				"Full lookup schema and documentation",
			]);
			expect(tools[1].parameters).toEqual(Type.Object({ key: Type.String() }));
			return fauxAssistantMessage(
				{ ...fauxToolCall(tools[1].name, { key: "page" }, { id: "page-lookup" }), namespace: tools[1].namespace },
				{
					stopReason: "toolUse",
				},
			);
		},
		(context) => {
			expect(
				context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "page-lookup"),
			).toMatchObject({ content: [{ text: "verified page" }], isError: false });
			return fauxAssistantMessage("Verified page");
		},
	]);
	await harness.session.prompt("Find the evidence needed to resolve this question");
	expect(
		harness.session.messages
			.filter((message) => message.role === "assistant" && message.stopReason === "error")
			.map((message) => (message.role === "assistant" ? message.errorMessage : "")),
	).toEqual([]);
	expect(calls).toBe(1);
	expect(guarded).toBe(1);
	expect(harness.session.getActiveToolNames()).not.toContain("desktop");
	expect(harness.session.getActiveToolNames()).not.toContain("advanced");
});

it("validates all requested groups before activation and allows idempotent multi-group loading", async () => {
	const harness = await setup();
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser", "missing"] }), {
			stopReason: "toolUse",
		}),
		() => {
			expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
			return fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser", "desktop"] }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done"),
	]);
	await harness.session.prompt("Use both integrations");
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup), "desktop"]);
	expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({ isError: true });
});

it("keeps exclusions binding, omits unavailable catalog groups, and never widens namespace identities", async () => {
	const harness = await setup({ excludedToolNames: [lookup] });
	const discovery = harness.session.getToolDefinition("discover_tools")!;
	expect(discovery.description).not.toContain("browser: Browse");
	expect(harness.session.getActiveToolNames()).toContain("advanced");
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Unavailable"),
	]);
	await harness.session.prompt("Try browser");
	expect(harness.session.getActiveToolNames()).not.toContain(toolId(lookup));
	expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({ isError: true });
});

it.each([{ allowedToolNames: [lookup] }, { allowedToolNames: [] }, { excludedToolNames: ["discover_tools"] }])(
	"respects explicit tool policies instead of silently deferring their tools: %j",
	async (options) => {
		const harness = await setup(options);
		expect(harness.session.getActiveToolNames()).not.toContain("discover_tools");
		if (options.allowedToolNames?.length === 0) expect(harness.session.getActiveToolNames()).toEqual([]);
		else expect(harness.session.getActiveToolNames()).toContain(toolId(lookup));
	},
);

it.each<{ api: string; compat?: Model<Api>["compat"] }>([
	{ api: "faux" },
	{ api: "cursor-sdk", compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true } },
	{ api: "openai-responses", compat: { supportsAdditionalTools: true } },
	{ api: "openai-responses", compat: { supportsMidConvoSystemMessages: true } },
	{ api: "anthropic-messages", compat: { supportsMidConvoToolChanges: true } },
	{ api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true } },
	{ api: "openai-completions", compat: { supportsMidConvoToolAdditions: true } },
	{ api: "openai-completions", compat: { supportsMidConvoSystemMessages: true } },
])("keeps ordinary exposure without both native capabilities: %j", async (options) => {
	const harness = await setup({ ...options, compat: options.compat });
	expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "advanced", "desktop"]);
	harness.setResponses([
		(context) => {
			expect(getCurrentSystemPrompt(context.messages)).toContain(manual);
			return fauxAssistantMessage("Original behavior");
		},
	]);
	await harness.session.prompt("Use browser");
	expect(
		harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
	).toEqual([]);
});

it.each<{ api: string; compat: Model<Api>["compat"] }>([
	{ api: "openai-responses", compat: { supportsToolSearch: true, supportsMidConvoSystemMessages: true } },
	{ api: "openai-codex-responses", compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true } },
	{ api: "azure-openai-responses", compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true } },
	{ api: "anthropic-messages", compat: { supportsMidConvoToolChanges: true, supportsMidConvoSystemMessages: true } },
	{ api: "openai-completions", compat: { supportsMidConvoToolAdditions: true, supportsMidConvoSystemMessages: true } },
])("discovers through capable native API contracts: %j", async (options) => {
	const harness = await setup(options);
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		(context) => {
			expect(getCurrentSystemPrompt(context.messages)).toContain(manual);
			expect(getCurrentTools(context.messages).map((tool) => tool.description)).toEqual([
				expect.stringContaining("Enable optional integrations"),
				"Full lookup schema and documentation",
			]);
			return fauxAssistantMessage("Loaded");
		},
	]);
	await harness.session.prompt("Find evidence");
	expect(
		harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
	).toEqual([]);
});

it("does not reactivate deferred tools on registry refresh or reload, but keeps new unrelated tools", async () => {
	let api!: ExtensionAPI;
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				api = pi;
				registerTools(pi);
			},
		],
	});
	api.registerTool({
		name: "utility",
		label: "Utility",
		description: "Utility",
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {} };
		},
	});
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", "utility"]);
	await harness.session.reload();
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", "utility"]);
});

it("automatically catalogs late registrations and enables only actual entry tools without configuration", async () => {
	let api!: ExtensionAPI;
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				api = pi;
				registerTools(pi);
			},
		],
	});
	const base = harness.session.getToolDefinition(lookup)!;
	api.registerTool({ ...base, name: "new_entry" });
	api.registerTool({ ...base, name: "new_advanced", discovery: { group: browserGroup, role: "advanced" } });
	api.registerTool({
		...base,
		name: "new_service",
		discovery: { group: { name: "new_service", description: "A newly installed service" }, role: "entry" },
	});
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
	expect(harness.session.getToolDefinition("discover_tools")!.description).toContain(
		"new_service: A newly installed service",
	);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser", "new_service"] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Ready"),
	]);
	await harness.session.prompt("Find evidence");
	expect(harness.session.getActiveToolReferences()).toEqual([
		{ name: "discover_tools" },
		lookup,
		{ namespace: "browser", name: "new_entry" },
		{ namespace: "browser", name: "new_service" },
	]);
	expect(harness.session.getAllTools().find((tool) => tool.id === toolId(lookup))?.discovery).toEqual({
		group: browserGroup,
		role: "entry",
	});
});

it("preserves exact namespaces when only one same-named member is excluded", async () => {
	const otherLookup = { namespace: "other", name: "lookup" };
	const harness = await setup({
		excludedToolNames: [lookup],
		extensionFactories: [
			(pi) => {
				registerTools(pi);
				pi.registerTool({
					...otherLookup,
					label: "Other lookup",
					description: "Other lookup",
					parameters: Type.Object({}),
					discovery: { group: browserGroup, role: "entry" },
					async execute() {
						return { content: [], details: {} };
					},
				});
			},
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Ready"),
	]);
	await harness.session.prompt("Find evidence");
	expect(harness.session.getActiveToolReferences()).toEqual([{ name: "discover_tools" }, otherLookup]);
	expect(harness.session.getToolDefinition(lookup)).toBeUndefined();
});

it("derives metadata from final permitted definitions rather than shadowed or excluded registrations", async () => {
	const harness = await setup({
		excludedToolNames: ["excluded"],
		extensionFactories: [
			registerTools,
			(pi) => {
				for (const reference of [lookup, { name: "excluded" }])
					pi.registerTool({
						...reference,
						label: "Unused",
						description: "Unused",
						parameters: Type.Object({}),
						discovery: {
							group: { ...browserGroup, description: "Must not replace the winning descriptor" },
							role: "entry",
						},
						async execute() {
							return { content: [], details: {} };
						},
					});
			},
		],
	});
	expect(harness.session.getToolDefinition("discover_tools")!.description).toContain(
		"browser: Browse and verify web pages",
	);
	expect(harness.session.getToolDefinition("excluded")).toBeUndefined();
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
});

it("applies exact checkpoint selection after recovery hooks without widening it", async () => {
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				registerTools(pi);
				pi.on("session_start", () => pi.setActiveToolReferences([...pi.getActiveToolReferences(), lookup]));
			},
		],
	});
	harness.session.restoreCheckpointTools([]);
	await harness.session.bindExtensions({});
	expect(harness.session.getActiveToolNames()).toEqual([]);
});

it("persists activation through resume, reload, and a fresh context window without rediscovery", async () => {
	const harness = await setup();
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Ready"),
	]);
	await harness.session.prompt("Use browser");
	harness.session.newContext({ handoff: "Continue browsing safely" });
	await harness.session.reload();
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
	const { session } = await createAgentSession({
		sessionManager: harness.sessionManager,
		settingsManager: harness.settingsManager,
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
	});
	try {
		expect(session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
		harness.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).toContain(manual);
				return fauxAssistantMessage("Continued");
			},
		]);
		await session.prompt("Continue");
	} finally {
		session.dispose();
	}
});

it("preserves automatic recovery activation requested by a lifecycle hook", async () => {
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				registerTools(pi);
				pi.on("session_start", () => pi.setActiveToolReferences([...pi.getActiveToolReferences(), lookup]));
			},
		],
	});
	await harness.session.bindExtensions({});
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
});

it("keeps native MCP search independent of the ordinary integration loader", async () => {
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				registerTools(pi);
				pi.registerToolSearch({
					name: "mcp_search",
					label: "MCP",
					description: "MCP discovery",
					parameters: Type.Object({}),
					async execute() {
						return { content: [], details: {}, tools: [] };
					},
				});
			},
		],
	});
	expect(harness.session.getActiveToolNames()).toEqual(["mcp_search", "discover_tools"]);
	expect(harness.session.state.tools.filter((tool) => tool.toolSearch).map((tool) => tool.name)).toEqual([
		"mcp_search",
	]);
});

it("restores front-door tools when switching to an unsupported API without enabling advanced tools", async () => {
	const harness = await setup();
	const runtime = harness.session.modelRuntime;
	runtime.registerProvider("unevaluated", {
		api: "cursor-sdk",
		apiKey: "faux-key",
		baseUrl: "http://unused",
		models: [{ ...harness.getModel(), api: "cursor-sdk", id: "other" }],
	});
	const unevaluatedModel = runtime.getModel("unevaluated", "other")!;
	await harness.session.setModel(unevaluatedModel);
	expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "desktop"]);
	await harness.session.setModel(harness.getModel());
	expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "desktop", "discover_tools"]);
	await harness.session.setModel(unevaluatedModel);
	expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "desktop"]);
});

it.each(["selection", "registration"] as const)(
	"rechecks current capabilities when the same model changes via %s",
	async (change) => {
		let api!: ExtensionAPI;
		const harness = await setup({
			extensionFactories: [
				(pi) => {
					api = pi;
					registerTools(pi);
				},
			],
		});
		const model = { ...harness.getModel(), compat: undefined };
		if (change === "selection") await harness.session.setModel(model);
		else
			api.registerProvider(model.provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "faux-key",
				models: [model],
			});
		expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "desktop"]);
	},
);

it.each([{ selected: [] }, { selected: ["read"] }, { selected: ["read", toolId(lookup)] }])(
	"does not widen a deliberate tool selection on provider switch: %j",
	async ({ selected }) => {
		const harness = await setup({ tools: undefined });
		const runtime = harness.session.modelRuntime;
		const originalModel = harness.getModel();
		runtime.registerProvider("unevaluated", {
			api: "cursor-sdk",
			apiKey: "faux-key",
			baseUrl: "http://unused",
			models: [{ ...originalModel, api: "cursor-sdk", id: "other" }],
		});
		harness.session.setActiveToolsByName(selected);
		for (let roundTrip = 0; roundTrip < 2; roundTrip++) {
			await harness.session.setModel(runtime.getModel("unevaluated", "other")!);
			expect(harness.session.getActiveToolNames()).toEqual(selected);
			await harness.session.setModel(originalModel);
			expect(harness.session.getActiveToolNames()).toEqual(selected);
		}
	},
);

it("restores ordinary exposure after partial live metadata removal and reload", async () => {
	let api!: ExtensionAPI;
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				api = pi;
				registerTools(pi);
			},
		],
	});
	const entry = harness.session.getToolDefinition(lookup)!;
	api.registerTool({ ...entry, name: "second_entry" });
	api.registerTool({ ...entry, discovery: undefined });
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Ready"),
	]);
	await harness.session.prompt("Load the remaining browser entry");
	expect(harness.session.getActiveToolNames()).toEqual([
		"discover_tools",
		toolId(lookup),
		toolId({ namespace: "browser", name: "second_entry" }),
	]);
	api.registerTool({ ...entry, name: "second_entry", discovery: undefined });
	registerTools(api, undefined, false);
	await harness.session.reload();
	expect(harness.session.getActiveToolNames()).toContain(toolId(lookup));
	expect(harness.session.getActiveToolNames()).toContain("desktop");
	expect(harness.session.getActiveToolNames()).not.toContain("discover_tools");
});

it.each(["empty", "loader removed", "excluded", "advanced", "moved"] as const)(
	"keeps restrictions when entry metadata changes: %s",
	async (restriction) => {
		let api!: ExtensionAPI;
		const harness = await setup({
			excludedToolNames: restriction === "excluded" ? [lookup] : undefined,
			extensionFactories: [
				(pi) => {
					api = pi;
					registerTools(pi);
				},
			],
		});
		const entry = { ...harness.session.getToolDefinition("advanced")!, ...lookup };
		if (restriction !== "moved")
			api.registerTool({ ...entry, name: "second_entry", discovery: { group: browserGroup, role: "entry" } });
		if (restriction === "empty") harness.session.setActiveToolsByName([]);
		if (restriction === "loader removed") harness.session.setActiveToolsByName(["desktop"]);
		const before = harness.session.getActiveToolNames();
		api.registerTool({
			...entry,
			discovery:
				restriction === "advanced"
					? { group: browserGroup, role: "advanced" }
					: restriction === "moved"
						? { group: desktopGroup, role: "entry" }
						: undefined,
		});
		expect(harness.session.getActiveToolNames()).toEqual(before);
		if (restriction === "excluded") expect(harness.session.getToolDefinition(lookup)).toBeUndefined();
	},
);

it.each([
	"resume",
	"compaction",
	"fresh window",
	"branch",
	"checkpoint",
	"empty",
	"loader removed",
	"excluded",
	"advanced",
	"moved",
	"no loader",
] as const)("restores only known retired entries on cold resume: %s", async (mode) => {
	// PR #142: cold restoration must distinguish former entries from tools never selected.
	const directory = mkdtempSync(join(tmpdir(), "pi-discovery-resume-"));
	sessionDirs.push(directory);
	const manager = SessionManager.create(directory, directory);
	const ordinary = { namespace: "ordinary", name: "lookup" };
	const extension = (retired: boolean) => (pi: ExtensionAPI) => {
		for (const reference of [lookup, { name: "desktop" }, { name: "advanced" }, ordinary]) {
			const isRetired = retired && (reference === lookup || mode === "no loader");
			pi.registerTool({
				...reference,
				label: reference.name,
				description: reference.name,
				parameters: Type.Object({}),
				discovery:
					reference === ordinary || (isRetired && mode !== "advanced" && mode !== "moved")
						? undefined
						: {
								group:
									reference === lookup && mode !== "advanced" && !(isRetired && mode === "moved")
										? browserGroup
										: desktopGroup,
								role:
									reference.name === "advanced" || (isRetired && mode === "advanced") ? "advanced" : "entry",
							},
				async execute() {
					return { content: [], details: {} };
				},
			});
		}
	};
	const original = await setup({ tools: undefined, sessionManager: manager, extensionFactories: [extension(false)] });
	// Ordinary and built-in tools are deliberately omitted before their first declaration.
	original.session.setActiveToolsByName(["discover_tools"]);
	original.setResponses([fauxAssistantMessage("Lean")]);
	await original.session.prompt("Start lean");
	const leanLeaf = manager.getLeafId()!;
	const selected = mode === "empty" ? [] : mode === "loader removed" ? ["desktop"] : ["discover_tools"];
	if (mode === "empty" || mode === "loader removed" || mode === "branch") {
		original.session.setActiveToolsByName(mode === "branch" ? [] : selected);
		original.setResponses([fauxAssistantMessage("Selection saved")]);
		await original.session.prompt("Keep this selection");
		if (mode === "branch") {
			await original.session.navigateTree(leanLeaf);
			original.setResponses([fauxAssistantMessage("Lean branch")]);
			await original.session.prompt("Continue the lean branch");
		}
	}
	if (mode === "compaction") manager.appendCompaction("Lean summary", null, 100);
	if (mode === "fresh window") manager.appendContextWindow("Continue lean", 100);
	const checkpointPath = join(directory, "checkpoint.json");
	if (mode === "checkpoint") {
		original.session.setActiveToolsByName([]);
		const hold = await original.session.acquireCheckpoint({ quiesce: () => () => {} });
		try {
			writeSessionCheckpoint(checkpointPath, hold.checkpoint);
		} finally {
			hold.release();
		}
	}
	original.session.dispose();

	const resumed = await setup({
		tools: undefined,
		sessionManager: SessionManager.open(manager.getSessionFile()!),
		extensionFactories: [extension(true)],
		excludedToolNames: mode === "excluded" ? [lookup] : undefined,
	});
	const restored = ["excluded", "advanced", "moved", "empty", "loader removed"].includes(mode)
		? selected
		: mode === "no loader"
			? [toolId(lookup), "desktop"]
			: ["discover_tools", toolId(lookup)];
	expect(resumed.session.getActiveToolNames()).toEqual(restored);
	expect(resumed.session.getActiveToolNames()).not.toContain(toolId(ordinary));
	expect(resumed.session.getActiveToolNames()).not.toContain("read");
	if (mode === "excluded") expect(resumed.session.getToolDefinition(lookup)).toBeUndefined();
	if (mode === "checkpoint") {
		const { session } = await createAgentSession({
			checkpoint: readSessionCheckpoint(checkpointPath),
			modelRuntime: original.session.modelRuntime,
			resourceLoader: resumed.session.resourceLoader,
			settingsManager: original.settingsManager,
		});
		try {
			expect(session.getActiveToolNames()).toEqual([]);
			await session.navigateTree(manager.getEntry(leanLeaf)!.parentId!);
			expect(session.getActiveToolNames()).toEqual(restored);
		} finally {
			session.dispose();
		}
	}
	resumed.setResponses([
		(context) => {
			expect(JSON.stringify(context)).not.toContain("deferredToolEntries");
			expect(getCurrentTools(context.messages).map(toolId)).toEqual(restored);
			return fauxAssistantMessage("Restored");
		},
	]);
	await resumed.session.prompt("Continue");
	expect(resumed.session.getLastAssistantText()).toBe("Restored");
});

it.each([false, true])("preserves the unannotated historical fallback (loader missing=%s)", async (missingLoader) => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({
		role: "system",
		content: "Historical prompt",
		toolsAdded: [{ name: "discover_tools", description: "Legacy loader", parameters: Type.Object({}) }],
		timestamp: 0,
	});
	const harness = await setup({
		sessionManager: manager,
		extensionFactories: [
			(pi) => {
				registerTools(pi, undefined, false);
				if (missingLoader) return;
				pi.registerTool({
					name: "surviving_entry",
					label: "Surviving entry",
					description: "Surviving entry",
					parameters: Type.Object({}),
					discovery: { group: desktopGroup, role: "entry" },
					async execute() {
						return { content: [], details: {} };
					},
				});
			},
		],
	});
	expect(harness.session.getActiveToolNames()).toEqual(
		missingLoader ? [toolId(lookup), "advanced", "desktop"] : ["discover_tools"],
	);
});

it("snapshots entry reclassification without changing visible declarations and replays the selected branch", async () => {
	let api!: ExtensionAPI;
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				api = pi;
				registerTools(pi);
			},
		],
	});
	const entry = harness.session.getToolDefinition(lookup)!;
	api.registerTool({ ...entry, name: "second_entry" });
	harness.setResponses([fauxAssistantMessage("Entry snapshot"), fauxAssistantMessage("Advanced snapshot")]);
	await harness.session.prompt("Start lean");
	const entryLeaf = harness.sessionManager.getLeafId()!;
	const declarations = getCurrentTools(harness.session.messages);
	api.registerTool({ ...entry, discovery: { group: browserGroup, role: "advanced" } });
	await harness.session.prompt("Stay lean");
	const advancedLeaf = harness.sessionManager.getLeafId()!;
	expect(getCurrentTools(harness.session.messages)).toEqual(declarations);
	api.registerTool({ ...entry, discovery: undefined });
	const { session } = await createAgentSession({
		sessionManager: harness.sessionManager,
		settingsManager: harness.settingsManager,
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
	});
	try {
		expect(session.getActiveToolNames()).toEqual(["discover_tools"]);
		await session.navigateTree(entryLeaf);
		expect(session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
		await session.navigateTree(advancedLeaf);
		expect(session.getActiveToolNames()).toEqual(["discover_tools"]);
	} finally {
		session.dispose();
	}
});

it("restores each branch's declared selection without inheriting discoveries from another branch", async () => {
	const harness = await setup();
	harness.setResponses([fauxAssistantMessage("No integrations needed")]);
	await harness.session.prompt("Start lean");
	const root = harness.sessionManager.getLeafId()!;
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Ready"),
	]);
	await harness.session.prompt("Use browser");
	const leaf = harness.sessionManager.getLeafId()!;
	await harness.session.navigateTree(root);
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
	await harness.session.navigateTree(leaf);
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
});

it("preserves recovery activation and pending prompt edits when navigating before the first declaration", async () => {
	// PR #139: an undeclared target must not reset native selection or prompt state.
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				registerTools(pi);
				pi.on("session_start", () => pi.setActiveToolReferences([...pi.getActiveToolReferences(), lookup]));
			},
		],
	});
	await harness.session.bindExtensions({});
	const root = harness.sessionManager.appendCustomEntry("root-anchor", {});
	harness.setResponses([fauxAssistantMessage("Recovery tool remains available")]);
	await harness.session.prompt("Continue");
	const leaf = harness.sessionManager.getLeafId()!;
	const options = harness.session.extensionRunner.createCommandContext().getSystemPromptOptions();
	options.appendSystemPrompt = "Pending local guidance must survive navigation";
	await harness.session.navigateTree(root);
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
	expect(harness.session.systemPrompt).toContain(options.appendSystemPrompt);
	await harness.session.navigateTree(leaf);
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools", toolId(lookup)]);
	expect(harness.session.systemPrompt).toContain(options.appendSystemPrompt);
});

it.each([false, true])(
	"keeps deselected builtins off when resuming on an unsupported API or without metadata (removed=%s)",
	async (removed) => {
		// PR #139: ordinary fallback restores extension exposure, not unselected shell/file tools.
		let api!: ExtensionAPI;
		const harness = await setup({
			tools: undefined,
			extensionFactories: [
				(pi) => {
					api = pi;
					registerTools(pi);
				},
			],
		});
		harness.session.setActiveToolsByName(["read", "discover_tools"]);
		harness.setResponses([fauxAssistantMessage("Read-only work")]);
		await harness.session.prompt("Use only the selected tools");
		if (removed) registerTools(api, undefined, false);
		const { session } = await createAgentSession({
			sessionManager: harness.sessionManager,
			settingsManager: SettingsManager.inMemory(),
			model: removed ? harness.getModel() : { ...harness.getModel(), api: "cursor-sdk" },
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
		});
		try {
			expect(session.getActiveToolNames()).toEqual(["read", toolId(lookup), "desktop"]);
		} finally {
			session.dispose();
		}
	},
);

it("restores capabilities when reopening a lean session on an unsupported API", async () => {
	const harness = await setup();
	harness.setResponses([fauxAssistantMessage("Done")]);
	await harness.session.prompt("No optional tools needed");
	const { session } = await createAgentSession({
		model: { ...harness.getModel(), api: "cursor-sdk" },
		sessionManager: harness.sessionManager,
		settingsManager: SettingsManager.inMemory(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
	});
	try {
		expect(session.getActiveToolNames()).toContain(toolId(lookup));
		expect(session.getActiveToolNames()).toContain("desktop");
		expect(session.getActiveToolNames()).not.toContain("discover_tools");
	} finally {
		session.dispose();
	}
});

it.each([false, true])(
	"keeps discovery reachable when resuming a pre-discovery selection (empty=%s)",
	async (empty) => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "system",
			content: "Legacy prompt",
			timestamp: 0,
			toolsAdded: empty ? [] : [{ name: "read", description: "Read", parameters: Type.Object({}) }],
		});
		const harness = await setup({ tools: undefined, sessionManager: manager });
		expect(harness.session.getActiveToolNames()).toEqual(empty ? [] : ["read", "discover_tools"]);
	},
);

it("does not undo deliberate removal of the loader in a discovery-aware branch", async () => {
	const harness = await setup({ tools: undefined });
	harness.setResponses([fauxAssistantMessage("First"), fauxAssistantMessage("Read only")]);
	await harness.session.prompt("Start");
	harness.session.setActiveToolsByName(["read"]);
	await harness.session.prompt("Continue with only the selected tools");
	const { session } = await createAgentSession({
		sessionManager: harness.sessionManager,
		settingsManager: harness.settingsManager,
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
	});
	try {
		expect(session.getActiveToolNames()).toEqual(["read"]);
	} finally {
		session.dispose();
	}
});

it("does not activate on canceled discovery or inventory-only requests", async () => {
	const harness = await setup();
	const controller = new AbortController();
	controller.abort();
	await expect(
		harness.session
			.getToolDefinition("discover_tools")!
			.execute(
				"cancel",
				{ enable: ["browser"] },
				controller.signal,
				undefined,
				harness.session.extensionRunner.createContext(),
			),
	).rejects.toThrow();
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Catalog available"),
	]);
	await harness.session.prompt("List capabilities");
	expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
});

it("does not bypass an execution guard after discovery", async () => {
	let executed = false;
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				registerTools(pi, () => {
					executed = true;
				});
				pi.on("tool_call", (event) =>
					event.namespace === "browser" ? { block: true, reason: "Approval required" } : undefined,
				);
			},
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("discover_tools", { enable: ["browser"] }), { stopReason: "toolUse" }),
		(context) => {
			const tool = getCurrentTools(context.messages).find(
				(tool) => tool.description === "Full lookup schema and documentation",
			)!;
			return fauxAssistantMessage(
				{ ...fauxToolCall(tool.name, { key: "page" }, { id: "guarded" }), namespace: tool.namespace },
				{
					stopReason: "toolUse",
				},
			);
		},
		fauxAssistantMessage("Approval required"),
	]);
	await harness.session.prompt("Use browser");
	expect(executed).toBe(false);
	expect(
		harness.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "guarded"),
	).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Approval required") }] });
});

it("restores a pending native integration call across a fresh window and resume without relaunching it", async () => {
	let resumed = 0;
	let launched = 0;
	const harness = await setup({
		extensionFactories: [
			(pi) => {
				registerTools(pi);
				pi.registerTool({
					name: "desktop",
					discovery: { group: desktopGroup, role: "entry" },
					label: "Desktop",
					description: "Recoverable desktop job",
					parameters: Type.Object({ key: Type.String() }),
					async: true,
					async execute() {
						launched++;
						throw new Error("Must not relaunch saved work");
					},
					async resume() {
						resumed++;
						return { content: [{ type: "text", text: "Recovered original work" }], details: {} };
					},
				});
			},
		],
	});
	harness.sessionManager.appendMessage({
		role: "system",
		content: "Saved selection",
		timestamp: 0,
		toolsAdded: ["discover_tools", "desktop"].map((name) =>
			toToolDeclaration(harness.session.getToolDefinition(name)!),
		),
	});
	harness.sessionManager.appendMessage(
		fauxAssistantMessage(
			{
				type: "toolCall",
				id: "saved|fc_saved",
				name: "desktop",
				arguments: { key: "original" },
				async: true,
				executionStarted: true,
				executionDetached: true,
				responsesItem: {
					type: "function_call",
					id: "fc_saved",
					call_id: "saved",
					name: "desktop",
					arguments: '{"key":"original"}',
					async: true,
					status: "completed",
				},
			},
			{ responseId: "saved-response", stopReason: "toolUse" },
		),
	);
	harness.session.refreshContext();
	harness.session.newContext({ handoff: "Recover existing work" });
	const { session } = await createAgentSession({
		sessionManager: harness.sessionManager,
		settingsManager: harness.settingsManager,
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
	});
	try {
		expect(session.getActiveToolNames()).toContain("desktop");
		harness.setResponses([fauxAssistantMessage("Recovered")]);
		await session.prompt("Continue");
		expect(resumed).toBe(1);
		expect(launched).toBe(0);
		expect(session.getPendingToolCalls()).toEqual([]);
		expect(
			session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "saved|fc_saved"),
		).toMatchObject({ content: [{ text: "Recovered original work" }], isError: false });
	} finally {
		session.dispose();
	}
});

it("never defers ordinary built-in coding tools", async () => {
	const harness = await setup({
		tools: undefined,
	});
	expect(harness.session.getActiveToolNames()).toEqual([
		"read",
		"bash",
		"background_command",
		"edit",
		"write",
		"discover_tools",
	]);
});

it("handles shared section ownership and prototype-like section names without dropping unrelated text", () => {
	const sectionTools = discoverySectionTools([
		{ name: "one", description: "One", tools: [lookup], defaultTools: [lookup], sections: ["constructor", "shared"] },
		{
			name: "two",
			description: "Two",
			tools: [{ name: "desktop" }],
			defaultTools: [{ name: "desktop" }],
			sections: ["shared"],
		},
	]);
	const options = {
		cwd: "/test",
		sections: { constructor: "Constructor guidance", shared: "Shared guidance", unrelated: "Unrelated guidance" },
	};
	expect(buildSystemPrompt({ ...options, selectedTools: [] })).toContain("Constructor guidance");
	const inactive = buildSystemPrompt({ ...options, sectionTools, selectedTools: [] });
	expect(inactive).not.toContain("Constructor guidance");
	expect(inactive).not.toContain("Shared guidance");
	expect(inactive).toContain("Unrelated guidance");
	expect(buildSystemPrompt({ ...options, sectionTools, selectedTools: ["desktop"] })).toContain("Shared guidance");
	expect(buildSystemPrompt({ ...options, sectionTools, selectedTools: [lookup] })).toContain("Constructor guidance");
});

describe("registration metadata validation", () => {
	it.each([
		{ group: { ...browserGroup, name: "Bad Group" }, role: "entry" },
		{ group: browserGroup, role: "invalid" },
		{ group: { ...browserGroup, description: "" }, role: "entry" },
		{ group: { ...browserGroup, sections: ["bad section"] }, role: "entry" },
		{ group: { ...browserGroup, sections: ["project_context"] }, role: "entry" },
		{ group: { ...browserGroup, description: "Conflicting description" }, role: "entry" },
		{ group: { ...browserGroup, sections: ["different_section"] }, role: "entry" },
	])("rejects invalid or conflicting metadata without changing the permitted registry: %j", async (discovery) => {
		let api!: ExtensionAPI;
		const harness = await setup({
			extensionFactories: [
				(pi) => {
					api = pi;
					registerTools(pi);
				},
			],
		});
		const before = harness.session.getAllTools();
		expect(() =>
			api.registerTool({
				...harness.session.getToolDefinition(lookup)!,
				name: "invalid",
				// Untyped extension inputs still require runtime validation.
				discovery: discovery as ToolDefinition["discovery"],
			}),
		).toThrow(/Invalid discovery|core prompt|Conflicting/);
		expect(harness.session.getAllTools()).toEqual(before);
		expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
	});

	it("rejects a self-deferred loader", async () => {
		let api!: ExtensionAPI;
		const harness = await setup({
			extensionFactories: [
				(pi) => {
					api = pi;
					registerTools(pi);
				},
			],
		});
		expect(() =>
			api.registerTool({
				...harness.session.getToolDefinition(lookup)!,
				name: "discover_tools",
				namespace: undefined,
			}),
		).toThrow("defer itself");
		expect(harness.session.getActiveToolNames()).toEqual(["discover_tools"]);
	});
});
