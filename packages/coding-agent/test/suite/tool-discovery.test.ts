import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ToolReference,
	toolId,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { discoverySectionTools, validateToolDiscoverySettings } from "../../src/core/tool-discovery.ts";
import { createHarness, type Harness } from "./harness.ts";

const lookup: ToolReference = { namespace: "browser", name: "lookup" };
const settings = {
	enabled: true,
	providers: ["faux"],
	groups: [
		{
			name: "browser",
			description: "Browse and verify web pages",
			tools: [lookup, "advanced"],
			defaultTools: [lookup],
			sections: ["browser_manual"],
		},
		{ name: "desktop", description: "Inspect native applications", tools: ["desktop"] },
	],
};
const manual = `Browser safety: observe before mutation. Preserve user-owned sessions. ${"Full instructions. ".repeat(100)}`;
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function registerTools(pi: ExtensionAPI, execute = () => {}) {
	for (const reference of [lookup, { name: "advanced" }, { name: "desktop" }]) {
		pi.registerTool({
			...reference,
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
		event.systemPromptOptions.sections.browser_manual = manual;
		event.systemPromptOptions.sections.always_on_safety = "Always-on policy remains enabled";
	});
}

async function setup(options: Parameters<typeof createHarness>[0] = {}) {
	const harness = await createHarness({
		tools: [],
		settings: { toolDiscovery: settings },
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
			expect(tools.map((tool) => tool.description)).toEqual([
				expect.stringContaining("Enable optional integrations"),
				"Full lookup schema and documentation",
			]);
			expect(tools[1].parameters).toEqual(Type.Object({ key: Type.String() }));
			return fauxAssistantMessage(fauxToolCall(tools[1].name, { key: "page" }, { id: "page-lookup" }), {
				stopReason: "toolUse",
			});
		},
		(context) => {
			expect(
				context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "page-lookup"),
			).toMatchObject({ content: [{ text: "verified page" }], isError: false });
			return fauxAssistantMessage("Verified page");
		},
	]);
	await harness.session.prompt("Verify this web page");
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

it.each([false, true])(
	"leaves the original behavior intact when disabled or on an unevaluated provider (%s)",
	async (unevaluated) => {
		const harness = await setup({
			settings: { toolDiscovery: { ...settings, enabled: unevaluated, providers: ["other-provider"] } },
		});
		expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "advanced", "desktop"]);
		harness.setResponses([
			(context) => {
				expect(getCurrentSystemPrompt(context.messages)).toContain(manual);
				return fauxAssistantMessage("Original behavior");
			},
		]);
		await harness.session.prompt("Continue");
	},
);

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

it("restores front-door tools when switching to an unevaluated provider without enabling advanced tools", async () => {
	const harness = await setup();
	const runtime = harness.session.modelRuntime;
	runtime.registerProvider("unevaluated", {
		api: harness.getModel().api,
		apiKey: "faux-key",
		baseUrl: "http://unused",
		models: [{ ...harness.getModel(), id: "other" }],
	});
	const unevaluatedModel = runtime.getModel("unevaluated", "other")!;
	await harness.session.setModel(unevaluatedModel);
	expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "desktop"]);
	await harness.session.setModel(harness.getModel());
	expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "desktop", "discover_tools"]);
	await harness.session.setModel(unevaluatedModel);
	expect(harness.session.getActiveToolNames()).toEqual([toolId(lookup), "desktop"]);
});

it.each([{ selected: [] }, { selected: ["read"] }, { selected: ["read", toolId(lookup)] }])(
	"does not widen a deliberate tool selection on provider switch: %j",
	async ({ selected }) => {
		const harness = await setup({ tools: undefined });
		const runtime = harness.session.modelRuntime;
		const originalModel = harness.getModel();
		runtime.registerProvider("unevaluated", {
			api: originalModel.api,
			apiKey: "faux-key",
			baseUrl: "http://unused",
			models: [{ ...originalModel, id: "other" }],
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

it("can roll back via settings and reload without leaving capabilities hidden", async () => {
	const harness = await setup();
	// Settings overrides are intentionally cleared by reload; model a persisted setting change.
	const manager = harness.settingsManager;
	const storage = SettingsManager.inMemory({ toolDiscovery: { ...settings, enabled: false } });
	manager.getToolDiscoverySettings = () => storage.getToolDiscoverySettings();
	await harness.session.reload();
	expect(harness.session.getActiveToolNames()).toContain(toolId(lookup));
	expect(harness.session.getActiveToolNames()).toContain("desktop");
	expect(harness.session.getActiveToolNames()).not.toContain("discover_tools");
});

it("restores the selected branch and does not inherit discoveries when navigating before the first request", async () => {
	const harness = await setup();
	const root = harness.sessionManager.appendCustomEntry("root-anchor", {});
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

it("restores capabilities when reopening a lean session with the setting removed", async () => {
	const harness = await setup();
	harness.setResponses([fauxAssistantMessage("Done")]);
	await harness.session.prompt("No optional tools needed");
	const { session } = await createAgentSession({
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
			return fauxAssistantMessage(fauxToolCall(tool.name, { key: "page" }, { id: "guarded" }), {
				stopReason: "toolUse",
			});
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
		settings: {
			toolDiscovery: {
				...settings,
				groups: [
					...settings.groups,
					{
						name: "bad-coding-group",
						description: "Not an integration",
						tools: ["read", "bash", "background_command", "edit", "write"],
					},
				],
			},
		},
	});
	expect(harness.session.getActiveToolNames()).toEqual([
		"read",
		"bash",
		"background_command",
		"edit",
		"write",
		"discover_tools",
	]);
	expect(harness.session.getToolDefinition("discover_tools")!.description).not.toContain("bad-coding-group");
});

it("handles shared section ownership and prototype-like section names without dropping unrelated text", () => {
	const sectionTools = discoverySectionTools([
		{ name: "one", description: "One", tools: [lookup], sections: ["constructor", "shared"] },
		{ name: "two", description: "Two", tools: ["desktop"], sections: ["shared"] },
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

describe("configuration validation", () => {
	it("requires an explicit provider rollout and rejects ambiguous or unsafe groups", () => {
		expect(() => validateToolDiscoverySettings({ ...settings, providers: [] })).toThrow("provider IDs");
		expect(() =>
			validateToolDiscoverySettings({ ...settings, groups: [settings.groups[0], settings.groups[0]] }),
		).toThrow("Duplicate");
		expect(() =>
			validateToolDiscoverySettings({ ...settings, groups: [{ ...settings.groups[0], defaultTools: ["missing"] }] }),
		).toThrow("not a member");
		expect(() =>
			validateToolDiscoverySettings({
				...settings,
				groups: [{ ...settings.groups[0], sections: ["project_context"] }],
			}),
		).toThrow("core prompt");
		expect(() =>
			validateToolDiscoverySettings({ ...settings, groups: [{ ...settings.groups[0], tools: ["discover_tools"] }] }),
		).toThrow("defer itself");
	});
});
