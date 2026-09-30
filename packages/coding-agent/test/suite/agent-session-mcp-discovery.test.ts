import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory, ToolDefinition, ToolNamespace } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	MCP_DISCOVERY_TOOL_NAME,
	type McpDiscoveryReport,
	mcpDiscoverySchema,
} from "../../src/extensions/mcp/discovery.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * Offline native discovery fixture. Only the lifecycle/catalog owner is faked:
 * registry updates, nested admission, hooks, parent ids, and QuickJS run through AgentSession.
 */
function discoveryFixture(serverName = "dev-radius") {
	const connected: string[] = [];
	let executions = 0;
	let withdraw: (() => void) | undefined;
	const namespace: ToolNamespace & { instructions: string } = {
		name: `mcp__${serverName}`,
		description: "Project notes",
		instructions: "Read project notes with fetch.",
	};
	const fetchSchema = Type.Object({ mode: Type.Optional(Type.String()) });
	const fetch: ToolDefinition<typeof fetchSchema> = {
		name: `mcp__${serverName}__fetch`,
		label: "Fetch",
		description: "Fetch project notes",
		namespace,
		parameters: fetchSchema,
		outputSchema: Type.Unknown(),
		exposure: "deferred",
		execute: async (_id, args) => {
			executions++;
			const result = {
				content: [{ type: "text", text: "private notes" }],
				structuredContent: { notes: ["private"], ...(args.mode === undefined ? {} : { mode: args.mode }) },
				isError: args.mode === "error",
			};
			return {
				content: [{ type: "text", text: "private notes" }],
				structuredContent: result,
				isError: result.isError,
				details: {},
			};
		},
	};
	const extension: ExtensionFactory = (pi) => {
		withdraw = () => pi.registerTool({ ...fetch, exposure: "hidden" });
		pi.registerTool({
			name: MCP_DISCOVERY_TOOL_NAME,
			label: "MCP discovery",
			description: "Read coverage or discover a scoped server",
			parameters: mcpDiscoverySchema,
			outputSchema: Type.Unknown(),
			exposure: "deferred",
			annotations: { readOnlyHint: true },
			execute: async (_id, { server }) => {
				if (server !== undefined) {
					if (server !== serverName) throw new Error(`Unknown server ${server}`);
					connected.push(server);
					// Discovery must finish before consumers read the updated registry.
					await Promise.resolve();
					pi.registerTool(fetch);
					for (const exposure of ["hidden", "model-only"] as const) {
						pi.registerTool({ ...fetch, name: `${fetch.name}_${exposure}`, exposure });
					}
				}
				const report: McpDiscoveryReport = {
					servers: [
						{
							name: serverName,
							namespace: namespace.name,
							state: connected.length ? "connected" : "disconnected",
							catalog: connected.length > 0,
						},
						{ name: "other", namespace: "mcp__other", state: "disconnected", catalog: false },
					],
					complete: false,
					undiscovered: connected.length ? ["other"] : [serverName, "other"],
				};
				return { content: [], structuredContent: report, details: { unredacted: report } };
			},
		});
	};
	return { extension, connected, executions: () => executions, withdraw: () => withdraw?.() };
}

describe("native MCP scoped discovery consumers", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup(extra: ExtensionFactory[] = [], options: Partial<HarnessOptions> = {}, serverName?: string) {
		const fixture = discoveryFixture(serverName);
		const harness = await createHarness({
			initialActiveToolNames: ["codemode", "tool_search"],
			extensionFactories: [
				createCodemodeExtension({ models: false }),
				createToolSearchExtension(),
				fixture.extension,
				...extra,
			],
			...options,
		});
		harnesses.push(harness);
		return { harness, fixture };
	}

	async function run(harness: Harness, name: string, args: JsonObject) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, name);
	}

	it.each(["mcp__dev-radius", "mcp__dev_radius", "dev-radius", "dev_radius"])(
		"discovers only %s and calls a new tool in the same sandbox cell",
		async (alias) => {
			const { harness, fixture } = await setup();
			const before = harness.session.agent.state.tools.map((tool) => tool.description);
			const result = await run(harness, "codemode", {
				code: `
				const matches = await searchTools("fetch", { namespace: ${JSON.stringify(alias)} });
				const declared = await describeTool(matches[0].name);
				const ns = await describeNamespace("dev-radius");
				const called = await callTool(matches[0].name, {});
				return { names: matches.map(t => t.name), declared, ns, called,
					snapshotHasFetch: ALL_TOOLS.some(t => t.name.includes("fetch")),
					mapHasFetch: typeof tools.mcp__dev_radius__fetch === "function" };
			`,
			});
			expect(result.isError).toBe(false);
			const output = JSON.parse(getMessageText({ content: result.content.slice(1) }));
			expect(output.names).toEqual(["mcp__dev_radius__fetch"]);
			expect(output.declared).toContain("Fetch project notes");
			expect(output.ns).toEqual({
				name: "mcp__dev-radius",
				description: "Project notes",
				instructions: "Read project notes with fetch.",
				tools: ["mcp__dev_radius__fetch"],
			});
			expect(output.called).toEqual({
				content: [{ type: "text", text: "private notes" }],
				structuredContent: { notes: ["private"] },
				isError: false,
			});
			expect(output.snapshotHasFetch).toBe(false);
			expect(output.mapHasFetch).toBe(false);
			expect(fixture.connected.every((name) => name === "dev-radius")).toBe(true);
			expect(fixture.executions()).toBe(1);
			expect(getMessageText(result)).not.toContain("Undiscovered servers");
			expect(
				harness.session.agent.state.tools
					.filter((tool) => ["codemode", "tool_search"].includes(tool.name))
					.map((tool) => tool.description),
			).toEqual(before);
			const nested = harness.eventsOfType("tool_execution_start").filter((event) => event.parentToolCallId);
			expect(nested.some((event) => event.toolName === "mcp__dev-radius__fetch")).toBe(true);
			expect(
				nested.every(
					(event) =>
						event.parentToolCallId === result.toolCallId && event.toolCallId.startsWith(`${result.toolCallId}/`),
				),
			).toBe(true);
		},
	);

	it("global searches stay cache-only and report partial coverage without changing the ranked array", async () => {
		const { harness, fixture } = await setup();
		const scripted = await run(harness, "codemode", {
			code: `const found = await searchTools("fetch"); await searchTools("notes"); return { array: Array.isArray(found), names: found.map(t => t.name) };`,
		});
		expect(getMessageText(scripted)).toContain('{"array":true,"names":[]}');
		expect(getMessageText(scripted).match(/Global search used a partial cached catalog/g)).toHaveLength(1);
		expect(getMessageText(scripted)).toContain("Undiscovered servers: dev-radius, other");
		const searched = await run(harness, "tool_search", { query: "fetch" });
		expect(getMessageText(searched)).toContain("No matching tools found.");
		expect(getMessageText(searched)).toContain("Undiscovered servers: dev-radius, other");
		expect(fixture.connected).toEqual([]);
		await run(harness, "tool_search", { query: "fetch", server: "dev-radius" });
		const cached = await run(harness, "codemode", { code: `return (await searchTools("fetch")).map(t => t.name);` });
		expect(getMessageText(cached)).toContain('["mcp__dev_radius__fetch"]');
		expect(getMessageText(cached)).toContain("Undiscovered servers: other");
		expect(fixture.connected).toEqual(["dev-radius"]);
	});

	it("scoped discovery accepts the full configured server name containing namespace separators", async () => {
		const { harness, fixture } = await setup([], {}, "docs__v2");
		const result = await run(harness, "codemode", {
			code: `
			const [match] = await searchTools("fetch", { server: "docs__v2" });
			return { name: match.name, result: await callTool(match.name, {}) };
		`,
		});
		expect(result.isError).toBe(false);
		expect(JSON.parse(getMessageText({ content: result.content.slice(1) })).name).toBe("mcp__docs__v2__fetch");
		expect(fixture.connected).toEqual(["docs__v2"]);
		expect(fixture.executions()).toBe(1);
	});

	it("tool_search discovers its scope before loading only callable deferred matches", async () => {
		const { harness, fixture } = await setup();
		const result = await run(harness, "tool_search", { query: "fetch", server: "dev_radius" });
		expect(result.details).toMatchObject({ loaded: ["mcp__dev-radius__fetch"] });
		expect(fixture.connected).toEqual(["dev-radius"]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__dev-radius__fetch");
		expect(getMessageText(result)).not.toContain("Undiscovered servers");
	});

	it("live calls preserve permissions, hook-redacted results, raw MCP errors, and withdrawn-tool rejection", async () => {
		let fixture: ReturnType<typeof discoveryFixture>;
		const configured = await setup([
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "mcp__dev-radius__fetch" && event.input.mode === "blocked")
						return { block: true, reason: "Permission denied" };
					return undefined;
				});
				pi.on("tool_result", (event) => {
					if (event.toolName === "mcp__dev-radius__fetch" && event.input.mode === "redact") {
						return { content: [{ type: "text", text: "redacted" }] };
					}
					if (event.toolName === "mcp__dev-radius__fetch" && event.input.mode === "withdraw") fixture.withdraw();
					return undefined;
				});
			},
		]);
		fixture = configured.fixture;
		const result = await run(configured.harness, "codemode", {
			code: `
			const [match] = await searchTools("fetch", { server: "dev-radius" });
			const attempt = async (name, args) => { try { return await callTool(name, args); } catch (e) { return e.message; } };
			const blocked = await attempt(match.name, { mode: "blocked" });
			const invalid = await attempt(match.name, { mode: { unexpected: true } });
			const redacted = await callTool(match.name, { mode: "redact" });
			const failed = await callTool(match.name, { mode: "error" });
			await callTool(match.name, { mode: "withdraw" });
			return { blocked, invalid, redacted, failed, withdrawn: await attempt(match.name, {}),
				hidden: await attempt("mcp__dev-radius__fetch_hidden", {}),
				missing: await attempt("missing", {}),
				descriptionGone: await describeTool(match.name) === undefined };
		`,
		});
		expect(result.isError).toBe(false);
		const output = JSON.parse(getMessageText({ content: result.content.slice(1) }));
		expect(output.blocked).toBe("Permission denied");
		expect(output.invalid).toContain("mode");
		expect(output.redacted).toBe("redacted");
		expect(output.failed.isError).toBe(true);
		expect(output.failed.structuredContent.mode).toBe("error");
		expect(output.withdrawn).toContain("unavailable tool");
		expect(output.hidden).toContain("unavailable tool");
		expect(output.missing).toContain("unavailable tool");
		expect(output.descriptionGone).toBe(true);
		expect(fixture.executions()).toBe(3);
	});

	it("scoped discovery failures and coverage redaction reject without replay or stale details", async () => {
		const { harness, fixture } = await setup([
			(pi) => {
				pi.on("tool_call", (event) =>
					event.toolName === MCP_DISCOVERY_TOOL_NAME && event.input.server
						? { block: true, reason: "Discovery denied" }
						: undefined,
				);
			},
		]);
		const result = await run(harness, "codemode", { code: `await searchTools("fetch", { server: "dev-radius" });` });
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Discovery denied");
		expect(fixture.connected).toEqual([]);
		const redacted = await setup([
			(pi) => {
				pi.on("tool_result", (event) =>
					event.toolName === MCP_DISCOVERY_TOOL_NAME
						? { content: [{ type: "text", text: "Coverage redacted" }] }
						: undefined,
				);
			},
		]);
		const searched = await run(redacted.harness, "tool_search", { query: "fetch", server: "dev-radius" });
		expect(searched.isError).toBe(true);
		expect(getMessageText(searched)).toContain("Coverage redacted");
		expect(redacted.fixture.connected).toEqual([]);
	});

	it("does not expose discovered tools excluded by the session allowlist", async () => {
		const { harness, fixture } = await setup([], {
			allowedToolNames: ["codemode", "tool_search", MCP_DISCOVERY_TOOL_NAME],
		});
		const result = await run(harness, "tool_search", { query: "fetch", server: "dev-radius" });
		expect(result.details).toMatchObject({ loaded: [] });
		expect(fixture.connected).toEqual(["dev-radius"]);
		expect(fixture.executions()).toBe(0);
	});

	it("rejects ambiguous namespace aliases before connecting and accepts exact canonical names", async () => {
		const { harness, fixture } = await setup([
			(pi) =>
				pi.registerTool({
					name: "extension_fetch",
					label: "Fetch",
					description: "Fetch extension notes",
					parameters: Type.Object({}),
					namespace: { name: "mcp__dev_radius" },
					exposure: "deferred",
					execute: async () => ({ content: [], details: undefined }),
				}),
		]);
		const scripted = await run(harness, "codemode", {
			code: `await searchTools("fetch", { namespace: "dev_radius" });`,
		});
		expect(scripted.isError).toBe(true);
		expect(getMessageText(scripted)).toContain('Ambiguous namespace "dev_radius"');
		const searched = await run(harness, "tool_search", { query: "fetch", namespace: "dev_radius" });
		expect(searched.isError).toBe(true);
		expect(fixture.connected).toEqual([]);
		const canonical = await run(harness, "tool_search", { query: "fetch", namespace: "mcp__dev-radius" });
		expect(canonical.details).toMatchObject({ loaded: ["mcp__dev-radius__fetch"] });
		expect(fixture.connected).toEqual(["dev-radius"]);
	});

	it("search results retain native tool names when script identifiers collide", async () => {
		let otherCalls = 0;
		const { harness, fixture } = await setup([
			(pi) =>
				pi.registerTool({
					name: "mcp__dev_radius__fetch",
					label: "Other fetch",
					description: "Fetch project notes",
					parameters: Type.Object({}),
					namespace: { name: "mcp__dev-radius" },
					exposure: "deferred",
					execute: async () => {
						otherCalls++;
						return { content: [{ type: "text", text: "other notes" }], details: undefined };
					},
				}),
		]);
		const result = await run(harness, "codemode", {
			code: `
			const matches = await searchTools("fetch", { namespace: "dev-radius" });
			const values = {};
			for (const match of matches) values[match.name] = await callTool(match.name, {});
			return values;
		`,
		});
		expect(result.isError).toBe(false);
		const values = JSON.parse(getMessageText({ content: result.content.slice(1) }));
		expect(values["mcp__dev-radius__fetch"].structuredContent).toEqual({ notes: ["private"] });
		expect(values.mcp__dev_radius__fetch).toBe("other notes");
		expect(fixture.executions()).toBe(1);
		expect(otherCalls).toBe(1);
	});
});
