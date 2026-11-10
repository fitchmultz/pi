import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition, ToolExposure } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

const WEATHER_SNIPPET = "Look up the weather for a city";
const WEATHER_GUIDELINE = "Use lookup_weather for weather questions.";
const UNREACHABLE_WARNING =
	"Tools that the toolExposure setting makes codemode or deferred are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.";

/** `lookup_weather` as an extension registers it, `direct` unless `overrides` says otherwise. */
function weatherTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "lookup_weather",
		label: "Lookup Weather",
		description: "Look up the current weather for a city",
		promptSnippet: WEATHER_SNIPPET,
		promptGuidelines: [WEATHER_GUIDELINE],
		parameters: Type.Object({ city: Type.String() }),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `Weather for ${(params as { city: string }).city}: sunny` }],
			details: {},
		}),
		...overrides,
	};
}

const weatherExtension = (pi: ExtensionAPI) => pi.registerTool(weatherTool());

/** What one model request declared and said about tools. */
interface RequestRecord {
	tools: string[];
	systemPrompt: string;
}

describe("toolExposure setting", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Parameters<typeof createHarness>[0], notifications: string[] = []) {
		const harness = await createHarness(options);
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return harness;
	}

	const exposureOf = (harness: Harness, name: string): ToolExposure | undefined =>
		harness.session.getAllTools().find((tool) => tool.name === name)?.exposure;

	/** A response step that records the request before answering with `message`. */
	const recording =
		(requests: RequestRecord[], message: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
			requests.push({
				tools: getCurrentTools(context.messages).map((tool) => tool.name),
				systemPrompt: getCurrentSystemPrompt(context.messages) ?? "",
			});
			return message;
		};

	it("leaves a direct tool set to deferred undeclared until tool_search loads it", async () => {
		const harness = await setup({
			settings: { toolExposure: { lookup_weather: "deferred" } },
			initialActiveToolNames: ["tool_search"],
			extensionFactories: [weatherExtension, createToolSearchExtension()],
		});
		expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		// Extensions decide on the exposure in effect.
		expect(exposureOf(harness, "lookup_weather")).toBe("deferred");

		const requests: RequestRecord[] = [];
		harness.setResponses([
			recording(
				requests,
				fauxAssistantMessage([fauxToolCall("tool_search", { query: "weather for a city" })], {
					stopReason: "toolUse",
				}),
			),
			recording(
				requests,
				fauxAssistantMessage([fauxToolCall("lookup_weather", { city: "Oslo" })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(requests[0].tools).toEqual(["tool_search"]);
		expect(requests[0].systemPrompt).not.toContain("lookup_weather");
		// Once loaded it is declared with its snippet and guidelines, like any loaded tool.
		expect(requests[1].tools).toEqual(["tool_search", "lookup_weather"]);
		expect(requests[1].systemPrompt).toContain(`- lookup_weather: ${WEATHER_SNIPPET}`);
		expect(requests[1].systemPrompt).toContain(WEATHER_GUIDELINE);
		expect(getMessageText(getToolResult(harness, "lookup_weather"))).toBe("Weather for Oslo: sunny");
	});

	it("lets codemode scripts call a tool set to deferred or codemode without declaring it", async () => {
		for (const exposure of ["deferred", "codemode"] as const) {
			const harness = await setup({
				settings: { toolExposure: { lookup_weather: exposure } },
				initialActiveToolNames: ["codemode"],
				extensionFactories: [weatherExtension, createCodemodeExtension()],
			});
			const requests: RequestRecord[] = [];
			const script = fauxToolCall("codemode", { code: 'return await tools.lookup_weather({ city: "Oslo" })' });
			harness.setResponses([
				recording(requests, fauxAssistantMessage([script], { stopReason: "toolUse" })),
				recording(requests, fauxAssistantMessage("done")),
			]);
			await harness.session.prompt("go");

			expect(getMessageText(getToolResult(harness, "codemode"))).toContain("Weather for Oslo: sunny");
			expect(requests.map((request) => request.tools)).toEqual([["codemode"], ["codemode"]]);
			// Codemode lists `codemode` tools in its description and leaves `deferred` tools out.
			const description = harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description;
			if (exposure === "codemode") expect(description).toContain("lookup_weather");
			else expect(description).not.toContain("lookup_weather");
		}
	});

	it("changes nothing for tools without an entry", async () => {
		const registers = (pi: ExtensionAPI) => {
			pi.registerTool(weatherTool());
			pi.registerTool(weatherTool({ name: "scripted", exposure: "codemode" }));
			pi.registerTool(weatherTool({ name: "searched", exposure: "deferred" }));
			pi.registerTool(weatherTool({ name: "asks", exposure: "model-only" }));
		};
		const state = async (settings?: Partial<Settings>) => {
			const harness = await setup({ settings, extensionFactories: [registers, createCodemodeExtension()] });
			return {
				exposures: harness.session.getAllTools().map((tool) => [tool.name, tool.exposure]),
				active: harness.session.getActiveToolNames(),
				callable: harness.session.getCallableToolNames(),
				systemPrompt: harness.session.systemPrompt.replaceAll(harness.tempDir, "<cwd>"),
				declarations: harness.session.agent.state.tools.map((tool) => [tool.name, tool.description]),
			};
		};
		const unset = await state();
		expect(unset.active).toEqual(["read", "bash", "edit", "write", "lookup_weather", "asks"]);
		expect(await state({ toolExposure: { other_tool: "hidden", "other_*": "deferred" } })).toEqual(unset);
	});

	it("declares a tool set to deferred when a selection names it", async () => {
		const settings = { toolExposure: { lookup_weather: "deferred" } } as const;
		const extensionFactories = [weatherExtension, createToolSearchExtension()];

		// `defaultTools`, a plain `--tools` list and `--tools +name` all arrive as initial names.
		const named = await setup({ settings, initialActiveToolNames: ["read", "lookup_weather"], extensionFactories });
		expect(named.session.getActiveToolNames()).toEqual(["read", "lookup_weather"]);
		expect(named.session.systemPrompt).toContain(WEATHER_GUIDELINE);

		const allowed = await setup({
			settings,
			initialActiveToolNames: ["read", "lookup_weather"],
			allowedToolNames: ["read", "lookup_weather"],
			extensionFactories,
		});
		expect(allowed.session.getActiveToolNames()).toEqual(["read", "lookup_weather"]);

		// A pattern keeps the tool registered for tool_search and scripts, and declares only tools
		// that are declared by default.
		const matched = await setup({
			settings,
			initialActiveToolNames: ["read", "lookup_*", "tool_search"],
			allowedToolNames: ["read", "lookup_*", "tool_search"],
			extensionFactories,
		});
		expect(matched.session.getActiveToolNames()).toEqual(["read", "tool_search"]);
		expect(matched.session.getCallableToolNames()).toEqual(["read", "lookup_weather"]);

		// An allowlist that does not name the tool removes it, as it removes a direct tool.
		const unlisted = await setup({
			settings,
			initialActiveToolNames: ["read"],
			allowedToolNames: ["read"],
			extensionFactories,
		});
		expect(exposureOf(unlisted, "lookup_weather")).toBeUndefined();

		const excluded = await setup({ settings, excludedToolNames: ["lookup_weather"], extensionFactories });
		expect(exposureOf(excluded, "lookup_weather")).toBeUndefined();
	});

	it("follows setActiveTools like a tool registered with that exposure", async () => {
		const harness = await setup({
			settings: { toolExposure: { lookup_weather: "deferred" } },
			initialActiveToolNames: [],
			extensionFactories: [weatherExtension],
		});
		expect(harness.session.getActiveToolNames()).toEqual([]);

		harness.session.setActiveToolsByName(["lookup_weather"]);
		expect(harness.session.getActiveToolNames()).toEqual(["lookup_weather"]);
		expect(harness.session.systemPrompt).toContain(WEATHER_GUIDELINE);

		harness.session.setActiveToolsByName([]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		// Deactivated, it stays callable from scripts.
		expect(harness.session.getCallableToolNames()).toEqual(["lookup_weather"]);
	});

	it("applies the other exposures as if the tool had registered with them", async () => {
		const registers = (pi: ExtensionAPI) => {
			pi.registerTool(weatherTool({ name: "searched", exposure: "deferred" }));
			pi.registerTool(weatherTool({ name: "inactive", exposure: "deferred", defaultActive: false }));
			pi.registerTool(weatherTool({ name: "declared_only" }));
			pi.registerTool(weatherTool({ name: "removed" }));
		};
		const harness = await setup({
			settings: {
				toolExposure: { searched: "direct", inactive: "direct", declared_only: "model-only", removed: "hidden" },
			},
			// Naming a hidden tool does not declare it.
			initialActiveToolNames: ["removed"],
			extensionFactories: [registers],
		});

		// `direct` declares a tool on registration unless it registered with `defaultActive: false`.
		expect(harness.session.getActiveToolNames()).toEqual(["searched", "declared_only"]);
		// `model-only` keeps scripts from calling a tool; `hidden` makes it unreachable.
		expect(harness.session.getCallableToolNames()).toEqual(["searched"]);
		harness.session.setActiveToolsByName(["searched", "removed"]);
		expect(harness.session.getActiveToolNames()).toEqual(["searched"]);
	});

	it("keeps a tool hidden that an extension registered as hidden", async () => {
		const harness = await setup({
			settings: { toolExposure: { withdrawn: "deferred", "*": "direct" } },
			initialActiveToolNames: ["withdrawn"],
			extensionFactories: [(pi) => pi.registerTool(weatherTool({ name: "withdrawn", exposure: "hidden" }))],
		});

		expect(exposureOf(harness, "withdrawn")).toBe("hidden");
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(harness.session.getCallableToolNames()).toEqual([]);
	});

	describe("resume", () => {
		/** A session whose transcript records the loadout `toolNames`, as a run records it. */
		function recordedSession(toolNames: string[]): SessionManager {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage({
				role: "system",
				content: "",
				toolsAdded: toolNames.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
				timestamp: Date.now(),
			});
			return sessionManager;
		}

		const resume = (sessionManager: SessionManager) =>
			setup({
				settings: { toolExposure: { lookup_weather: "deferred" } },
				sessionManager,
				extensionFactories: [weatherExtension],
			});

		it("keeps a tool declared that the journal recorded as declared", async () => {
			const harness = await resume(recordedSession(["read", "lookup_weather"]));
			expect(harness.session.getActiveToolNames()).toEqual(["read", "lookup_weather"]);
		});

		it("does not declare a tool the journal never mentioned", async () => {
			const harness = await resume(recordedSession(["read"]));
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		});
	});

	describe("unreachable tools", () => {
		const settings = { toolExposure: { lookup_weather: "deferred" } } as const;
		const discovery = [createCodemodeExtension(), createToolSearchExtension()];

		it("warns when neither codemode nor tool_search is active", async () => {
			const notifications: string[] = [];
			await setup({ settings, extensionFactories: [weatherExtension, ...discovery] }, notifications);
			expect(notifications).toEqual([UNREACHABLE_WARNING]);
		});

		it.each(["codemode", "tool_search"])("does not warn while %s is active", async (name) => {
			const notifications: string[] = [];
			await setup(
				{ settings, initialActiveToolNames: [name], extensionFactories: [weatherExtension, ...discovery] },
				notifications,
			);
			expect(notifications).toEqual([]);
		});

		/** Starts a session and returns its extension API, to register tools after `session_start`. */
		async function startThenRegister(options: Parameters<typeof createHarness>[0], notifications: string[]) {
			const apis: ExtensionAPI[] = [];
			await setup(
				{ ...options, extensionFactories: [(pi) => void apis.push(pi), ...(options?.extensionFactories ?? [])] },
				notifications,
			);
			return apis[0];
		}

		// Tools register after `session_start` when their extension must connect first, as MCP tools do.
		it("warns once when tools the setting defers register after session_start", async () => {
			const notifications: string[] = [];
			const pi = await startThenRegister(
				{ settings: { toolExposure: { "lookup_*": "deferred" } }, extensionFactories: discovery },
				notifications,
			);
			expect(notifications).toEqual([]);

			pi.registerTool(weatherTool());
			expect(notifications).toEqual([UNREACHABLE_WARNING]);
			pi.registerTool(weatherTool({ name: "lookup_tides" }));
			expect(notifications).toEqual([UNREACHABLE_WARNING]);
		});

		it("does not warn again for a late tool after the warning at session_start", async () => {
			const notifications: string[] = [];
			const pi = await startThenRegister(
				{ settings: { toolExposure: { "lookup_*": "deferred" } }, extensionFactories: [weatherExtension] },
				notifications,
			);
			pi.registerTool(weatherTool({ name: "lookup_tides" }));
			expect(notifications).toEqual([UNREACHABLE_WARNING]);
		});

		it("does not warn for a late tool that tool_search reaches or the setting does not change", async () => {
			const notifications: string[] = [];
			const reached = await startThenRegister(
				{ settings, initialActiveToolNames: ["tool_search"], extensionFactories: discovery },
				notifications,
			);
			reached.registerTool(weatherTool());

			const unchanged = await startThenRegister(
				{ settings: { toolExposure: { other_tool: "deferred" } }, extensionFactories: discovery },
				notifications,
			);
			unchanged.registerTool(weatherTool());
			unchanged.registerTool(weatherTool({ name: "searched", exposure: "deferred" }));

			const unset = await startThenRegister({ extensionFactories: discovery }, notifications);
			unset.registerTool(weatherTool({ exposure: "deferred" }));
			expect(notifications).toEqual([]);
		});

		it("does not warn for a declared tool or for tools the setting does not change", async () => {
			const notifications: string[] = [];
			await setup(
				{ settings, initialActiveToolNames: ["lookup_weather"], extensionFactories: [weatherExtension] },
				notifications,
			);
			// A tool its extension registered as deferred is that extension's to report.
			await setup(
				{
					settings: { toolExposure: { other_tool: "deferred" } },
					extensionFactories: [(pi) => pi.registerTool(weatherTool({ exposure: "deferred" }))],
				},
				notifications,
			);
			expect(notifications).toEqual([]);
		});
	});
});
