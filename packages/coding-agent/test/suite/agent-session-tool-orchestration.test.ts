import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A tool that calls other tools, built only on the extension API: its own name, exposure, loadout
 * hook, and ctx.executeTool(). Codemode and tool search use the same mechanisms.
 */
function orchestratorExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "echo",
		description: "Echo text.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo: ${text}` }], details: {} }),
	});
	pi.registerTool({
		name: "helper",
		label: "helper",
		description: "Only reachable from other tools.",
		parameters: Type.Object({}),
		exposure: "codemode",
		execute: async () => ({ content: [{ type: "text", text: "helped" }], details: {} }),
	});
	pi.registerTool({
		name: "run_tools",
		label: "run_tools",
		description: "Runs tools.",
		parameters: Type.Object({}),
		exposure: "model-only",
		prepareLoadout: (loadout) => ({
			descriptions: {
				run_tools: `Runs tools: ${loadout.callable.map((tool) => tool.name).join(", ")}`,
				echo: "Echo text (also callable from run_tools).",
			},
			hiddenDeclarations: ["echo"],
		}),
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			const helper = await ctx.executeTool("helper", {});
			const echo = await ctx.executeTool("echo", { text: "hi" });
			const self = await ctx.executeTool("run_tools", {});
			const text = [helper, echo, self]
				.map((outcome) => (outcome.result.content[0] as { text: string }).text)
				.join(" | ");
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}

describe("AgentSession tool orchestration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("supports tools that call other tools under any name through the extension API", async () => {
		const toolCalls: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				orchestratorExtension,
				(pi) => {
					pi.on("tool_call", (event) => {
						toolCalls.push(`${event.toolName}:${event.parentToolCallId ?? "top"}`);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		expect(harness.session.getActiveToolNames()).toEqual(["echo", "run_tools"]);
		expect(harness.session.getCallableToolNames()).toEqual(["echo", "helper"]);
		const find = (name: string) => harness.session.agent.state.tools.find((tool) => tool.name === name);
		expect(find("run_tools")?.description).toBe("Runs tools: echo, helper");
		expect(find("echo")?.description).toBe("Echo text (also callable from run_tools).");

		const requestTools: string[][] = [];
		harness.setResponses([
			(context: TranscriptContext) => {
				requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage([fauxToolCall("run_tools", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		// echo stays active, but its declaration is left out of requests.
		expect(requestTools[0]).toEqual(["run_tools"]);
		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		if (!result) throw new Error("No tool result");
		expect(result.content).toEqual([{ type: "text", text: "helped | echo: hi | Tool run_tools not found" }]);
		const parent = result.toolCallId;
		expect(toolCalls).toEqual(["run_tools:top", `helper:${parent}`, `echo:${parent}`]);
		expect(result.nestedCalls?.calls.map((call) => [call.id, call.name, call.status])).toEqual([
			[`${parent}/1`, "helper", "ok"],
			[`${parent}/2`, "echo", "ok"],
			[`${parent}/3`, "run_tools", "error"],
		]);
		// The record is persisted with the session.
		const persisted = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(persisted?.type === "message" && persisted.message).toMatchObject({ nestedCalls: result.nestedCalls });
	});

	it("registers codemode and tool_search inactive until they are named", async () => {
		const extensionFactories = [createCodemodeExtension(), createToolSearchExtension()];
		const plain = await createHarness({ extensionFactories });
		harnesses.push(plain);
		expect(plain.session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["codemode", "tool_search"]),
		);
		expect(plain.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

		// --tools and the defaultTools setting name them explicitly.
		const allowed = await createHarness({ allowedToolNames: ["read", "codemode"], extensionFactories });
		harnesses.push(allowed);
		expect(allowed.session.getActiveToolNames()).toEqual(["read", "codemode"]);
		const initial = await createHarness({ initialActiveToolNames: ["tool_search"], extensionFactories });
		harnesses.push(initial);
		expect(initial.session.getActiveToolNames()).toEqual(["tool_search"]);
	});

	it("leaves results without nested calls unchanged", async () => {
		const harness = await createHarness({ initialActiveToolNames: [], extensionFactories: [orchestratorExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result && "nestedCalls" in result).toBe(false);
	});
});

/** Tools as a session with MCP servers has them: some loadable by `tool_search`, one active, one unreachable. */
function searchCatalogExtension(pi: ExtensionAPI): void {
	const register = (name: string, description: string, exposure?: "deferred" | "hidden") =>
		pi.registerTool({
			name,
			label: name,
			description,
			parameters: Type.Object({}),
			...(exposure ? { exposure } : {}),
			execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
		});
	register("tracker_list_issues", "List the issues of a project.\nSupports paging.", "deferred");
	register("tracker_save_issue", "Create or update an issue.", "deferred");
	register("metrics_query", "Query metrics. Set start and end to choose the command interval.", "deferred");
	register("board_status", "Show the board.");
	register("fleet_runs", "Inspect runs.", "hidden");
}

describe("tool_search", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** Runs the searches in one prompt and returns each result's text and details. */
	async function search(...queries: { query: string; limit?: number }[]) {
		const harness = await createHarness({
			initialActiveToolNames: ["tool_search", "board_status"],
			extensionFactories: [createToolSearchExtension(), searchCatalogExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			...queries.map((args) => fauxAssistantMessage([fauxToolCall("tool_search", args)], { stopReason: "toolUse" })),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const results = harness.session.messages
			.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.map((message) => ({ text: (message.content[0] as { text: string }).text, details: message.details }));
		return { results, active: harness.session.getActiveToolNames() };
	}

	it("lists the closest tools without loading them when none is a good match, and loads one by its name", async () => {
		// A search for a tool that does not exist: `metrics_query` shares three of its four words, in its description.
		const { results, active } = await search(
			{ query: "background job start command interval", limit: 2 },
			{ query: "metrics_query" },
		);
		expect(results[0]).toEqual({
			text: [
				"No tool is a close match, so none was loaded. Closest matches; search for an exact name to load one:",
				"- metrics_query: Query metrics. Set start and end to choose the command interval.",
			].join("\n"),
			details: { loaded: [], listed: ["metrics_query"] },
		});
		expect(results[1]).toEqual({
			text: [
				"Loaded 1 tool. They are available from your next call:",
				"- metrics_query: Query metrics. Set start and end to choose the command interval.",
			].join("\n"),
			details: { loaded: ["metrics_query"] },
		});
		expect(active).toEqual(["tool_search", "board_status", "metrics_query"]);
	});

	it("loads the tools that match most of the query, within the names a +word requires", async () => {
		// `metrics_query` has `query`, but `+tracker` leaves it out.
		const { results, active } = await search({ query: "+tracker issues query" });
		expect(results[0].text).toBe(
			[
				"Loaded 2 tools. They are available from your next call:",
				"- tracker_save_issue: Create or update an issue.",
				"- tracker_list_issues: List the issues of a project.",
			].join("\n"),
		);
		expect(results[0].details).toEqual({ loaded: ["tracker_save_issue", "tracker_list_issues"] });
		expect(active).toEqual(["tool_search", "board_status", "tracker_save_issue", "tracker_list_issues"]);
	});

	it("says when a tool it found or the query names is already active", async () => {
		const { results, active } = await search(
			{ query: "tracker_save_issue" },
			// Once loaded, the tool is not replaced by the next best match.
			{ query: "tracker save issue", limit: 1 },
			{ query: "+board_status show" },
		);
		expect(results[1]).toEqual({
			text: "tracker_save_issue is already active; call it directly.",
			details: { loaded: [], active: ["tracker_save_issue"] },
		});
		expect(results[2]).toEqual({
			text: "board_status is already active; call it directly.",
			details: { loaded: [], active: ["board_status"] },
		});
		expect(active).toEqual(["tool_search", "board_status", "tracker_save_issue"]);
	});

	it("says when the query names a tool it cannot load or that is not registered", async () => {
		const { results, active } = await search(
			{ query: "fleet_runs inspect", limit: 1 },
			{ query: "+background_command start command", limit: 2 },
			{ query: "background_command start command", limit: 1 },
			{ query: "+café query" },
			{ query: "fleet runs" },
		);
		const notAvailable = {
			text: "fleet_runs is not available in this session; tool_search cannot load it.",
			details: { loaded: [], unavailable: ["fleet_runs"] },
		};
		expect(results[0]).toEqual(notAvailable);
		// The whole query is the name, written with a space.
		expect(results[4]).toEqual(notAvailable);
		expect(results[1]).toEqual({
			text: "No tool or server in this session has background_command in its name.",
			details: { loaded: [], unavailable: ["background_command"] },
		});
		expect(results[2]).toEqual({
			text: [
				"No tool or server in this session has background_command in its name.",
				"No tool is a close match, so none was loaded. Closest matches; search for an exact name to load one:",
				"- metrics_query: Query metrics. Set start and end to choose the command interval.",
			].join("\n"),
			details: { loaded: [], listed: ["metrics_query"], unavailable: ["background_command"] },
		});
		expect(results[3]).toEqual({
			text: "No tool or server in this session has café in its name.",
			details: { loaded: [], unavailable: ["café"] },
		});
		expect(active).toEqual(["tool_search", "board_status"]);
	});
});
