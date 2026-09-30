import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import {
	type CallToolResult,
	type GetPromptResult,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	type Prompt,
	type Tool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { ProcessTerminal, stripTerminalSequences, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { McpCatalogStore } from "../../src/extensions/mcp/catalog.ts";
import { loadMcpConfig, type McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import {
	createHarness,
	createTestUiContext,
	getMessageText,
	getToolResult,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

const FETCH: Tool = {
	name: "fetch",
	description: "Fetch project notes",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
	outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	annotations: { readOnlyHint: true },
};

interface ServerSpec {
	tools?: Tool[];
	prompts?: Prompt[];
	resources?: boolean;
	initialize?: () => Promise<void>;
	call?: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
	prompt?: GetPromptResult;
}

/** Only the wire peer is a fixture. Native catalogs, clients, registry, hooks and sandbox are real. */
function nativeFixture(entries: McpServerEntry[], specs: Record<string, ServerSpec> = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-native-mcp-"));
	const catalog = new McpCatalogStore({ agentDir: cwd });
	const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
	const opened: string[] = [];
	const requests: { server: string; request: JsonRpcRequest }[] = [];
	const peers: { name: string; pair: ReturnType<typeof createInMemoryTransportPair> }[] = [];
	const sessions: Harness[] = [];
	const notifications: string[] = [];

	async function session(options: HarnessOptions = {}, extra: ExtensionFactory[] = []) {
		const harness = await createHarness({
			cwd,
			...(options.sessionManager ? {} : { initialActiveToolNames: ["read"] }),
			...options,
			extensionFactories: [
				createCodemodeExtension({ models: false }),
				createToolSearchExtension(),
				createMcpExtension({
					loadConfig: () => ({ servers: entries, errors: [] }),
					catalog,
					credentials,
					createTransport: (entry) => {
						opened.push(entry.name);
						const spec = specs[entry.name] ?? { tools: [FETCH] };
						const pair = createInMemoryTransportPair();
						peers.push({ name: entry.name, pair });
						pair.server.onMessage((message) => {
							if (!("id" in message) || !("method" in message)) return;
							const request = message as JsonRpcRequest;
							requests.push({ server: entry.name, request });
							queueMicrotask(async () => {
								let result: unknown;
								switch (request.method) {
									case "initialize":
										await spec.initialize?.();
										result = {
											protocolVersion: LATEST_PROTOCOL_VERSION,
											capabilities: {
												...(spec.tools ? { tools: {} } : {}),
												...(spec.prompts ? { prompts: {} } : {}),
												...(spec.resources ? { resources: {} } : {}),
											},
											serverInfo: { name: entry.name, version: "1" },
											instructions: "Read project notes with fetch.",
										};
										break;
									case "tools/list":
										result = { tools: spec.tools };
										break;
									case "prompts/list":
										result = { prompts: spec.prompts };
										break;
									case "prompts/get":
										result = spec.prompt ?? {
											messages: [{ role: "assistant", content: { type: "text", text: "Prepared prompt" } }],
										};
										break;
									case "resources/list":
										result = {
											resources: [
												{ uri: "notes://intro", name: "intro" },
												{ uri: "ui://viewer", name: "viewer" },
											],
										};
										break;
									case "resources/templates/list":
										result = { resourceTemplates: [] };
										break;
									case "resources/read":
										result = { contents: [{ uri: "notes://intro", text: "Project introduction" }] };
										break;
									case "tools/call": {
										const args = (request.params as { arguments?: Record<string, unknown> }).arguments ?? {};
										result = await (spec.call?.(args) ?? {
											content: [{ type: "text", text: "Project notes" }],
											structuredContent: { value: "notes" },
										});
										break;
									}
									default:
										result = {};
								}
								await pair.server.send({ jsonrpc: "2.0", id: request.id, result }).catch(() => {});
							});
						});
						void pair.server.start();
						return pair.client;
					},
				}),
				...extra,
			],
		});
		sessions.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return harness;
	}

	return {
		cwd,
		catalog,
		credentials,
		opened,
		requests,
		peers,
		notifications,
		session,
		async close() {
			for (const harness of sessions) {
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				harness.cleanup();
			}
			for (const { pair } of peers) await pair.server.close();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function entry(name: string, exposure: "codemode" | "direct" = "codemode"): McpServerEntry {
	return { name, config: { url: `http://${name}.invalid/mcp`, exposure }, source: "fixture" };
}

async function run(harness: Harness, name: string, args: JsonObject): Promise<ToolResultMessage> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	return getToolResult(harness, name);
}

function scriptValue(result: ToolResultMessage): unknown {
	if (result.isError) throw new Error(getMessageText(result));
	return JSON.parse(getMessageText({ content: result.content.slice(1, 2) }));
}

function fullResultPath(result: ToolResultMessage): string {
	const path = getMessageText(result).match(/\[Full MCP result: (.+) \(read with /)?.[1];
	if (!path) throw new Error("No complete result artifact");
	return path;
}

describe("native MCP lazy lifecycle", () => {
	const fixtures: ReturnType<typeof nativeFixture>[] = [];
	afterEach(async () => {
		vi.useRealTimers();
		while (fixtures.length) await fixtures.pop()?.close();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});
	function fixture(entries: McpServerEntry[], specs?: Record<string, ServerSpec>) {
		const current = nativeFixture(entries, specs);
		fixtures.push(current);
		return current;
	}

	it("keeps default direct and stdio servers dormant for status/global search, then discovers only the scope", async () => {
		const f = fixture([
			entry("docs"),
			entry("pinned", "direct"),
			{ name: "stdio", config: { command: "unused", env: { SECRET: "!exit 1" } }, source: "fixture" },
		]);
		const harness = await f.session();
		await harness.session.prompt("/mcp");
		expect(f.opened).toEqual([]);
		expect(f.notifications.at(-1)).toContain("pinned: lazy · undiscovered");
		const global = await run(harness, "codemode", {
			code: `// tools.mcp__pinned__fetch({})\nconst ignored = /tools.mcp__stdio__fetch/; return await searchTools("tools.mcp__docs__fetch() mcp__docs");`,
		});
		expect(getMessageText(global)).toContain("Undiscovered servers: docs, pinned, stdio");
		expect(f.opened).toEqual([]);
		const scoped = await run(harness, "codemode", {
			code: `const [match] = await searchTools("fetch", { server: "docs" }); const ns = await describeNamespace("docs"); const result = await callTool(match.name, { query: "live" }); return { name: match.name, instructions: ns.instructions, value: result.structuredContent.value };`,
		});
		expect(scriptValue(scoped)).toEqual({
			name: "mcp__docs__fetch",
			instructions: "Read project notes with fetch.",
			value: "notes",
		});
		expect(f.opened).toEqual(["docs"]);
		expect(f.requests.filter(({ request }) => request.method === "tools/call")).toHaveLength(1);
		const pinned = await run(harness, "tool_search", { query: "fetch", server: "pinned" });
		expect(getMessageText(pinned)).toContain("Direct tools are available from your next call");
		expect(harness.session.getActiveToolNames()).toContain("mcp__pinned__fetch");
		expect(f.opened).toEqual(["docs", "pinned"]);
	});

	it("connects only explicitly eager servers and waits for an eager direct declaration", async () => {
		const eager = entry("eager", "direct");
		eager.config.connection = "eager";
		const f = fixture([eager, entry("lazy", "direct")]);
		const harness = await f.session();
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("mcp__eager__fetch");
				return fauxAssistantMessage("ready");
			},
		]);
		await harness.session.prompt("start");
		expect(f.opened).toEqual(["eager"]);
	});

	it("refuses a manager save through a Pi-owned link to the loader's custom shared source", async () => {
		const f = fixture([]);
		const agentDir = join(f.cwd, "agent");
		mkdirSync(agentDir);
		const sharedConfigPath = join(f.cwd, "shared.json");
		const before = JSON.stringify({ mcpServers: { local: { command: "must-never-run", exposure: "hidden" } } });
		writeFileSync(sharedConfigPath, before);
		const path = join(agentDir, "mcp.json");
		symlinkSync("../shared.json", path);
		let managed = false;
		let uiError: unknown;
		initTheme("dark");
		const harness = await createHarness({
			cwd: f.cwd,
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => loadMcpConfig({ agentDir, cwd: f.cwd, projectTrusted: false, sharedConfigPath }),
					credentials: f.credentials,
					catalog: f.catalog,
				}),
			],
		});
		try {
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					custom: (factory) =>
						new Promise((resolve, reject) => {
							// The real manager renders and handles keys; its terminal stays stopped.
							Promise.resolve(
								factory(new TuiMainScreen(new ProcessTerminal()), theme, new KeybindingsManager(), resolve),
							)
								.then(async (view) => {
									view.handleInput?.("\r");
									await vi.waitFor(() => expect(view.render(160).join("\n")).toContain("Disable"));
									view.handleInput?.("\x1b[B");
									view.handleInput?.("\x1b[B");
									view.handleInput?.("\r");
									await vi.waitFor(() =>
										expect(
											view.render(160).map(stripTerminalSequences).join(" ").replace(/\s+/g, " "),
										).toContain("read-only shared source"),
									);
									view.handleInput?.("\x1b");
									await vi.waitFor(() => expect(view.render(160).join("\n")).toContain("MCP servers"));
									view.handleInput?.("\x1b");
									managed = true;
								})
								.catch((error) => {
									uiError = error;
									reject(error);
								});
						}),
				}),
			});
			await harness.session.prompt("/mcp");
			if (uiError) throw uiError;
			expect(managed).toBe(true);
			expect(readlinkSync(path)).toBe("../shared.json");
			expect(readFileSync(sharedConfigPath, "utf8")).toBe(before);
		} finally {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	it("gives independent SDK sessions their own lazy clients and shutdown lifecycles", async () => {
		const f = fixture([entry("docs", "direct")]);
		const parent = await f.session();
		const child = await f.session();
		expect(f.opened).toEqual([]);
		await parent.session.prompt("/mcp reconnect docs");
		await child.session.prompt("/mcp reconnect docs");
		expect(f.opened).toEqual(["docs", "docs"]);
		expect((await run(parent, "mcp__docs__fetch", {})).isError).toBe(false);
		await parent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect((await run(child, "mcp__docs__fetch", {})).isError).toBe(false);
		expect(f.opened).toEqual(["docs", "docs"]);
		expect(f.requests.filter(({ request }) => request.method === "tools/call")).toHaveLength(2);
	});

	it("restores the actual persisted catalog and cached prompt commands without starting transports", async () => {
		const spec = { tools: [FETCH], prompts: [{ name: "brief", description: "Prepare a brief" }] };
		const f = fixture([entry("docs")], { docs: spec });
		const original = await f.session();
		await run(original, "codemode", { code: `await describeNamespace("docs");` });
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const resumed = await f.session({ sessionManager: original.sessionManager });
		expect(f.opened).toEqual(["docs"]);
		expect(resumed.session.getCallableToolNames()).toContain("mcp__docs__fetch");
		expect(resumed.session.extensionRunner.getCommand("mcp__docs__brief")?.description).toBe("Prepare a brief");
		await resumed.session.prompt("/mcp prompts docs");
		expect(f.notifications.at(-1)).toContain("/mcp__docs__brief");
		expect(f.opened).toEqual(["docs"]);
		spec.tools = [FETCH, { ...FETCH, name: "constructor" }, { ...FETCH, name: "__proto__" }];
		await resumed.session.prompt("/mcp reconnect docs");
		expect(resumed.session.getCallableToolNames()).toEqual(
			expect.arrayContaining(["mcp__docs__constructor", "mcp__docs____proto__"]),
		);
		const result = await run(resumed, "codemode", {
			code: `await callTool("mcp__docs__constructor", {}); await callTool("mcp__docs____proto__", {});`,
		});
		expect(result.isError).toBe(false);
		expect(
			f.requests
				.filter(({ request }) => request.method === "tools/call")
				.map(({ request }) => (request.params as { name: string }).name),
		).toEqual(["constructor", "__proto__"]);
	});

	it("does not cache a live account's list-change metadata under a replacement environment account", async () => {
		vi.stubEnv("PI_MCP_FIXTURE_TOKEN", "account-one");
		const profile = entry("docs", "direct");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
		if ("url" in profile.config) profile.config.headers = { Authorization: "Bearer ${PI_MCP_FIXTURE_TOKEN}" };
		const accountOne = { tools: [FETCH] };
		const specs = { docs: accountOne };
		const f = fixture([profile], specs);
		const original = await f.session();
		await original.session.prompt("/mcp reconnect docs");
		expect(original.session.getCallableToolNames()).toContain("mcp__docs__fetch");

		vi.stubEnv("PI_MCP_FIXTURE_TOKEN", "account-two");
		accountOne.tools = [FETCH, { ...FETCH, name: "account_one_only" }];
		await f.peers.at(-1)?.pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(original.session.getCallableToolNames()).toContain("mcp__docs__account_one_only"));
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

		specs.docs = { tools: [{ ...FETCH, name: "lookup" }] };
		const replacement = await f.session();
		expect(f.opened).toEqual(["docs"]);
		expect(replacement.session.getCallableToolNames()).not.toContain("mcp__docs__account_one_only");
		expect(replacement.session.getCallableToolNames()).not.toContain("mcp__docs__fetch");
		await run(replacement, "tool_search", { query: "lookup", server: "docs" });
		expect((await run(replacement, "mcp__docs__lookup", {})).isError).toBe(false);
		expect(f.opened).toEqual(["docs", "docs"]);
		expect(
			f.requests
				.filter(({ request }) => request.method === "tools/call")
				.map(({ request }) => (request.params as { name: string }).name),
		).toEqual(["lookup"]);
	});

	it("restores a root's tools, prompts and selected declarations after another root saves the same profile", async () => {
		const spec = { tools: [FETCH], prompts: [{ name: "brief", description: "Root A brief" }] };
		const f = fixture([entry("docs", "direct")], { docs: spec });
		const original = await f.session();
		await original.session.prompt("/mcp reconnect docs");
		original.session.setActiveToolsByName(["read", "mcp__docs__fetch"]);
		original.setResponses([fauxAssistantMessage("saved")]);
		await original.session.prompt("save root A selection");
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

		const otherRoot = join(f.cwd, "other-root");
		mkdirSync(otherRoot);
		spec.tools = [{ ...FETCH, name: "lookup" }];
		spec.prompts = [{ name: "other", description: "Root B brief" }];
		const other = await f.session({ cwd: otherRoot });
		await other.session.prompt("/mcp reconnect docs");
		await other.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

		const restored = await f.session({ sessionManager: original.sessionManager });
		expect(f.opened).toEqual(["docs", "docs"]);
		expect(restored.session.getCallableToolNames()).toContain("mcp__docs__fetch");
		expect(restored.session.getCallableToolNames()).not.toContain("mcp__docs__lookup");
		expect(restored.session.extensionRunner.getCommand("mcp__docs__brief")?.description).toBe("Root A brief");
		expect(restored.session.extensionRunner.getCommand("mcp__docs__other")).toBeUndefined();
		restored.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("mcp__docs__fetch");
				return fauxAssistantMessage("ready");
			},
		]);
		await restored.session.prompt("continue root A");
		expect(f.opened).toEqual(["docs", "docs"]);
	});

	it("reuses stdio catalogs across inherited bookkeeping changes but separates credential and explicit env changes", async () => {
		for (const name of ["PI_SESSION_ID", "PI_SUBAGENT_RUN_ID", "TERM_SESSION_ID", "PWD"])
			vi.stubEnv(name, "session-one");
		vi.stubEnv("SSH_AUTH_SOCK", "/fixture/agent-one");
		vi.stubEnv("PI_MCP_ACCOUNT_TOKEN", "account-one");
		const profile: McpServerEntry = { name: "stdio", config: { command: "unused" }, source: "fixture" };
		const f = fixture([profile]);
		const original = await f.session();
		await original.session.prompt("/mcp reconnect stdio");
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		for (const name of ["PI_SESSION_ID", "PI_SUBAGENT_RUN_ID", "TERM_SESSION_ID", "PWD"])
			vi.stubEnv(name, "session-two");
		const restored = await f.session();
		expect(restored.session.getCallableToolNames()).toContain("mcp__stdio__fetch");
		expect(f.opened).toEqual(["stdio"]);

		for (const [name, changed] of [
			["SSH_AUTH_SOCK", "/fixture/agent-two"],
			["PI_MCP_ACCOUNT_TOKEN", "account-two"],
			["__MISE_DIFF", "different-credential-baseline"],
		]) {
			const previous = process.env[name];
			vi.stubEnv(name, changed);
			const separate = await f.session();
			expect(separate.session.getCallableToolNames(), name).not.toContain("mcp__stdio__fetch");
			vi.stubEnv(name, previous);
		}
		if ("command" in profile.config) profile.config.env = { PI_SESSION_ID: "explicit-account-one" };
		const explicit = await f.session();
		await explicit.session.prompt("/mcp reconnect stdio");
		if ("command" in profile.config) profile.config.env = { PI_SESSION_ID: "explicit-account-two" };
		const replaced = await f.session();
		expect(replaced.session.getCallableToolNames()).not.toContain("mcp__stdio__fetch");
		vi.stubEnv("PI_MODEL", "referenced-account-one");
		if ("command" in profile.config) {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
			profile.config.env = { PI_SESSION_ID: "${PI_MODEL}" };
		}
		const referenced = await f.session();
		await referenced.session.prompt("/mcp reconnect stdio");
		vi.stubEnv("PI_MODEL", "referenced-account-two");
		const changedReference = await f.session();
		expect(changedReference.session.getCallableToolNames()).not.toContain("mcp__stdio__fetch");
		expect(f.opened).toEqual(["stdio", "stdio", "stdio"]);
	});

	it("keeps serialized request declarations stable through cached discovery, unchanged refresh and reconnect", async () => {
		const f = fixture([entry("docs")]);
		const original = await f.session();
		await run(original, "codemode", { code: `await describeNamespace("docs");` });
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const harness = await f.session();
		const declarations: string[] = [];
		const requests: TranscriptContext["messages"][] = [];
		const response = (context: TranscriptContext) => {
			requests.push(structuredClone(context.messages));
			declarations.push(
				JSON.stringify({
					prompt: getCurrentSystemPrompt(context.messages),
					tools: getCurrentTools(context.messages),
				}),
			);
			return fauxAssistantMessage("ready");
		};
		harness.setResponses([response, response, response]);
		await harness.session.prompt("first");
		expect(declarations[0]).not.toContain("mcp__docs__fetch");
		await harness.session.prompt("/mcp reconnect docs");
		await f.peers.at(-1)?.pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() =>
			expect(f.requests.filter(({ request }) => request.method === "tools/list")).toHaveLength(3),
		);
		await harness.session.prompt("second");
		await harness.session.prompt("/mcp reconnect docs");
		await harness.session.prompt("third");
		expect(declarations).toEqual([declarations[0], declarations[0], declarations[0]]);
		expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);
	});

	it("rejects a changed live schema before dispatching a cached prepared call", async () => {
		const spec = { tools: [FETCH] };
		const f = fixture([entry("docs", "direct")], { docs: spec });
		const original = await f.session();
		await original.session.prompt("/mcp reconnect docs");
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		spec.tools = [
			{
				...FETCH,
				inputSchema: {
					type: "object",
					properties: { confirmation: { type: "string" } },
					required: ["confirmation"],
				},
			},
		];
		const resumed = await f.session();
		const result = await run(resumed, "mcp__docs__fetch", {});
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/changed|no longer available/);
		expect(f.requests.filter(({ request }) => request.method === "tools/call")).toEqual([]);
	});

	it("revokes account-bound catalogs locally and catches a grant change after pipeline admission", async () => {
		const profile = entry("docs", "direct");
		const f = fixture([profile, entry("other")]);
		let changeAccount = false;
		const harness = await f.session({}, [
			(pi) => {
				pi.on("tool_call", async (event) => {
					if (event.toolName === "mcp__docs__fetch" && changeAccount) {
						await f.credentials.importGrant(profile, {
							serverUrl: "http://docs.invalid/mcp",
							tokens: { access_token: "new-account", token_type: "Bearer" },
						});
					}
				});
			},
		]);
		await harness.session.prompt("/mcp reconnect docs");
		changeAccount = true;
		const result = await run(harness, "mcp__docs__fetch", {});
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("changed accounts");
		expect(f.requests.filter(({ request }) => request.method === "tools/call")).toEqual([]);
		const global = await run(harness, "tool_search", { query: "fetch" });
		expect(getMessageText(global)).toContain("Undiscovered servers: docs, other");
		expect(harness.session.getCallableToolNames()).not.toContain("mcp__docs__fetch");
		expect(f.opened).toEqual(["docs"]);
	});

	it.each(["http", "mixed-http", "mixed-stdio"] as const)(
		"rejects changed environment credentials after admission and installs a fresh binding on rediscovery (%s)",
		async (profileKind) => {
			const previous = process.env.PI_MCP_FIXTURE_TOKEN;
			process.env.PI_MCP_FIXTURE_TOKEN = "account-one";
			const profile = entry("docs", "direct");
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
			if ("url" in profile.config) profile.config.headers = { Authorization: "Bearer ${PI_MCP_FIXTURE_TOKEN}" };
			if (profileKind === "mixed-stdio") {
				profile.config = {
					command: "unused",
					exposure: "direct",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
					env: { TOKEN: "${PI_MCP_FIXTURE_TOKEN}" },
				};
			}
			const f = fixture([profile]);
			const commandMarker = join(f.cwd, "secret-command-ran");
			if (profileKind !== "http") {
				const command = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'ran'); process.stdout.write('stable')`)}`;
				if ("url" in profile.config) profile.config.headers = { ...profile.config.headers, "X-Extra": command };
				else profile.config.env = { ...profile.config.env, EXTRA: command };
			}
			let changeAccount = false;
			const harness = await f.session({}, [
				(pi) => {
					pi.on("tool_call", (event) => {
						if (event.toolName === "mcp__docs__fetch" && changeAccount)
							process.env.PI_MCP_FIXTURE_TOKEN = "account-two";
					});
				},
			]);
			try {
				await harness.session.prompt("/mcp reconnect docs");
				changeAccount = true;
				const stale = await run(harness, "mcp__docs__fetch", {});
				expect(stale.isError).toBe(true);
				expect(getMessageText(stale)).toContain("changed accounts");
				expect(f.requests.filter(({ request }) => request.method === "tools/call")).toEqual([]);
				changeAccount = false;
				await harness.session.prompt("/mcp reconnect docs");
				const fresh = await run(harness, "mcp__docs__fetch", {});
				expect(fresh.isError).toBe(false);
				expect(f.requests.filter(({ request }) => request.method === "tools/call")).toHaveLength(1);
				expect(f.opened).toEqual(["docs", "docs"]);
				expect(existsSync(commandMarker)).toBe(false);
			} finally {
				if (previous === undefined) delete process.env.PI_MCP_FIXTURE_TOKEN;
				else process.env.PI_MCP_FIXTURE_TOKEN = previous;
			}
		},
	);

	it.each([
		{ transport: "http", reconnect: "idle", changed: false },
		{ transport: "http", reconnect: "idle", changed: true },
		{ transport: "http", reconnect: "expired", changed: false },
		{ transport: "http", reconnect: "expired", changed: true },
		{ transport: "stdio", reconnect: "idle", changed: false },
		{ transport: "stdio", reconnect: "idle", changed: true },
	])(
		"keeps an opaque $transport credential prepared call valid after $reconnect only when its resolved account is unchanged ($changed)",
		async ({ transport, reconnect, changed }) => {
			vi.useFakeTimers();
			const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-live-secret-"));
			const tokenPath = join(cwd, "token");
			const requestsPath = join(cwd, "requests.jsonl");
			const serverPath = join(cwd, "server.mjs");
			writeFileSync(tokenPath, "Bearer account-one");
			writeFileSync(requestsPath, "");
			if (transport === "stdio")
				writeFileSync(
					serverPath,
					`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (!("id" in request)) continue;
	appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({ method: request.method, token: process.env.TOKEN }) + "\\n");
	const result = request.method === "initialize"
		? { protocolVersion: ${JSON.stringify(LATEST_PROTOCOL_VERSION)}, capabilities: { tools: {} }, serverInfo: { name: "opaque", version: "1" } }
		: request.method === "tools/list" ? { tools: [${JSON.stringify(FETCH)}] }
		: { content: [{ type: "text", text: "ok" }], structuredContent: { value: "ok" } };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}`,
				);
			const command = `!${JSON.stringify(process.execPath)} -p ${JSON.stringify(`require('node:fs').readFileSync(${JSON.stringify(tokenPath)}, 'utf8')`)}`;
			const profile: McpServerEntry = {
				name: "opaque",
				source: "fixture",
				config:
					transport === "http"
						? { url: "http://opaque.invalid/mcp", headers: { Authorization: command }, exposure: "direct" }
						: { command: process.execPath, args: [serverPath], env: { TOKEN: command }, exposure: "direct" },
			};
			let initialized = 0;
			let expired = false;
			const requests = () =>
				readFileSync(requestsPath, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { method: string; token: string | null });
			const calls = () =>
				requests()
					.filter((request) => request.method === "tools/call")
					.map((request) => request.token);
			vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
				if (init?.method !== "POST") return new Response(null, { status: init?.method === "GET" ? 405 : 200 });
				const request = JSON.parse(String(init.body)) as JsonRpcRequest;
				if (!("id" in request)) return new Response(null, { status: 202 });
				const headers = new Headers(init.headers);
				if (request.method === "tools/call" && expired && headers.get("mcp-session-id") === "session-1")
					return new Response(null, { status: 404 });
				appendFileSync(
					requestsPath,
					`${JSON.stringify({ method: request.method, token: headers.get("authorization") })}\n`,
				);
				const result =
					request.method === "initialize"
						? {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: { name: "opaque", version: "1" },
							}
						: request.method === "tools/list"
							? { tools: [FETCH] }
							: { content: [{ type: "text", text: "ok" }], structuredContent: { value: "ok" } };
				return Response.json(
					{ jsonrpc: "2.0", id: request.id, result },
					{
						headers: request.method === "initialize" ? { "mcp-session-id": `session-${++initialized}` } : {},
					},
				);
			});
			const harness = await createHarness({
				cwd,
				initialActiveToolNames: ["read"],
				extensionFactories: [
					createMcpExtension({
						loadConfig: () => ({ servers: [profile], errors: [] }),
						credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
						catalog: new McpCatalogStore({ agentDir: cwd }),
					}),
				],
			});
			try {
				await harness.session.bindExtensions({});
				expect(requests()).toEqual([]);
				await harness.session.prompt("/mcp reconnect opaque");
				if (reconnect === "idle") await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
				else expired = true;
				if (changed) writeFileSync(tokenPath, "Bearer account-two");
				const result = await run(harness, "mcp__opaque__fetch", {});
				expect(result.isError).toBe(changed);
				expect(requests().filter((request) => request.method === "initialize")).toHaveLength(2);
				if (changed) {
					expect(getMessageText(result)).toMatch(/changed|no longer available/);
					expect(calls()).toEqual([]);
					expect((await run(harness, "mcp__opaque__fetch", {})).isError).toBe(false);
					expect(calls()).toEqual(["Bearer account-two"]);
				} else {
					expect(calls()).toEqual(["Bearer account-one"]);
				}
			} finally {
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				harness.cleanup();
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);

	it("preserves permissions and exclusions when discovery installs a real native tool", async () => {
		const f = fixture([entry("docs")]);
		const harness = await f.session({}, [
			(pi) => {
				pi.on("tool_call", (event) =>
					event.toolName === "mcp__docs__fetch" ? { block: true, reason: "Permission denied" } : undefined,
				);
			},
		]);
		const denied = await run(harness, "codemode", {
			code: `const [match] = await searchTools("fetch", { server: "docs" }); await callTool(match.name, {});`,
		});
		expect(denied.isError).toBe(true);
		expect(getMessageText(denied)).toContain("Permission denied");
		const excluded = await f.session({ allowedToolNames: ["codemode", "mcp_discover"] });
		const filtered = await run(excluded, "codemode", {
			code: `return await searchTools("fetch", { server: "docs" });`,
		});
		expect(scriptValue(filtered)).toEqual([]);
		expect(f.requests.filter(({ request }) => request.method === "tools/call")).toEqual([]);
	});

	it("preserves dormant native selections across resume, reload and fork without widening policy", async () => {
		const f = fixture([entry("docs")]);
		const manager = SessionManager.inMemory(f.cwd);
		manager.appendCustomEntry("pi-tool-loadout", ["read", "mcp__docs__fetch"]);
		const original = await f.session({ sessionManager: manager });
		original.setResponses([fauxAssistantMessage("ready")]);
		await original.session.prompt("save dormant selection");
		const forkPoint = manager.getLeafId()!;
		const resumed = await f.session({ sessionManager: manager });
		await resumed.session.reload();
		manager.createBranchedSession(forkPoint);
		const forked = await f.session({ sessionManager: manager });
		expect(f.opened).toEqual([]);
		await forked.session.prompt("/mcp reconnect docs");
		expect(forked.session.getActiveToolNames()).toContain("mcp__docs__fetch");
		const cleared = await f.session({ sessionManager: manager });
		cleared.session.setActiveToolsByName(["read", "codemode"]);
		cleared.setResponses([fauxAssistantMessage("ready")]);
		await cleared.session.prompt("clear previous selection");
		await cleared.session.reload();
		expect(cleared.session.getActiveToolNames()).not.toContain("mcp__docs__fetch");
	});

	it("migrates raw adapter selections once using collision-safe native names and retains inactive pins", async () => {
		const tools = [
			{ ...FETCH, name: "a.b" },
			{ ...FETCH, name: "a_b" },
		];
		const spec = { tools };
		const f = fixture([entry("docs", "direct")], { docs: spec });
		const manager = SessionManager.inMemory(f.cwd);
		manager.appendCustomEntry("mcp-tool-selection", {
			selected: [{ server: "docs", tool: "a_b" }],
			inactive: [{ server: "docs", tool: "a.b" }],
			features: ["script"],
			inactiveFeatures: ["gateway"],
		});
		const harness = await f.session({ sessionManager: manager });
		expect(f.opened).toEqual([]);
		expect(harness.session.getActiveToolNames()).toContain("codemode");
		expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
		await harness.session.prompt("/mcp reconnect docs");
		const selected = harness.session.getActiveToolNames().find((name) => /^mcp__docs__a_b_[a-f0-9]{8}$/.test(name));
		expect(selected).toBeDefined();
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__a_b");
		const definition = harness.session.getToolDefinition("mcp__docs__a_b");
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "mcp__docs__a_b"]);
		spec.tools = tools.filter((tool) => tool.name !== "a.b");
		await f.peers.at(-1)?.pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__a_b"));
		spec.tools = tools;
		await f.peers.at(-1)?.pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__a_b"));
		expect(harness.session.getToolDefinition("mcp__docs__a_b")).toBe(definition);
		harness.session.setActiveToolsByName(["codemode"]);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("save native choice");
		const resumed = await f.session({ sessionManager: manager });
		expect(resumed.session.getActiveToolNames()).toEqual(["codemode"]);
		const migration = manager
			.getBranch()
			.findLast((item) => item.type === "custom" && item.customType === "mcp-native-selection");
		expect(migration?.type === "custom" ? migration.data : undefined).toMatchObject({ pending: [], features: [] });
	});

	it("publishes complete hook-permitted JSON, supports native JSON readback, and does not replay artifact failures", async () => {
		const f = fixture([entry("docs", "direct")], {
			docs: {
				tools: [FETCH],
				call: () => ({
					content: [{ type: "text", text: "raw-secret" }],
					structuredContent: { value: "raw-secret" },
				}),
			},
		});
		const harness = await f.session({}, [
			(pi) => {
				pi.on("tool_result", (event) =>
					event.toolName === "mcp__docs__fetch"
						? { content: [{ type: "text", text: "permitted" }], details: { stale: "raw-secret" } }
						: undefined,
				);
			},
		]);
		await harness.session.prompt("/mcp reconnect docs");
		const result = await run(harness, "mcp__docs__fetch", {});
		const path = fullResultPath(result);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ content: [{ type: "text", text: "permitted" }] });
		const readback = await run(harness, "read", { path, json: { path: "/content/0", fields: ["text"] } });
		expect(JSON.parse(getMessageText(readback))).toEqual({ text: "permitted" });
		expect(f.requests.filter(({ request }) => request.method === "tools/call")).toHaveLength(1);
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = join(f.cwd, "missing-directory");
		try {
			const failedFile = await run(harness, "mcp__docs__fetch", {});
			expect(getMessageText(failedFile)).toContain("Could not save the complete MCP result");
			expect(f.requests.filter(({ request }) => request.method === "tools/call")).toHaveLength(2);
		} finally {
			process.env.TMPDIR = previous;
		}
	});

	it("rejects invalid success output without retrying and preserves declared MCP error results for scripts", async () => {
		let response: CallToolResult = { content: [], structuredContent: { value: 42 } };
		const f = fixture([entry("docs", "direct")], { docs: { tools: [FETCH], call: () => response } });
		const harness = await f.session();
		await harness.session.prompt("/mcp reconnect docs");
		const invalid = await run(harness, "mcp__docs__fetch", {});
		expect(invalid.isError).toBe(true);
		expect(getMessageText(invalid)).toContain("does not match its output schema");
		response = {
			content: [{ type: "text", text: "Permission denied by server" }],
			structuredContent: { error: "denied" },
			isError: true,
		};
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "codemode"]);
		const result = await run(harness, "codemode", {
			code: `const result = await callTool("mcp__docs__fetch", {}); return { error: result.structuredContent.error, isError: result.isError };`,
		});
		expect(scriptValue(result)).toEqual({ error: "denied", isError: true });
		expect(f.requests.filter(({ request }) => request.method === "tools/call")).toHaveLength(2);
	});

	it("discovers cold resource-only servers on a scoped read without connecting unrelated profiles", async () => {
		const f = fixture([entry("docs"), entry("other")], { docs: { resources: true } });
		const harness = await f.session();
		const empty = await run(harness, "codemode", { code: `await tools.list_mcp_resources({ server: " " });` });
		expect(empty.isError).toBe(true);
		expect(getMessageText(empty)).toContain("server must not be empty");
		expect(f.opened).toEqual([]);
		const result = await run(harness, "codemode", {
			code: `const listed = await tools.list_mcp_resources({ server: "docs" }); const read = await tools.read_mcp_resource({ server: "docs", uri: listed.resources[0].uri }); return { listed: listed.resources, text: read.contents[0].text, artifact: read.fullResultPath };`,
		});
		expect(scriptValue(result)).toMatchObject({
			listed: [{ server: "docs", uri: "notes://intro", name: "intro" }],
			text: "Project introduction",
			artifact: expect.any(String),
		});
		expect(f.opened).toEqual(["docs"]);
		expect(f.requests.some(({ request }) => request.method === "tools/list")).toBe(false);
	});

	it("restores prompt-only commands, preserves argument/role contracts and withdraws live commands", async () => {
		const spec: ServerSpec = {
			prompts: [
				{
					name: "brief",
					description: "Brief",
					arguments: [{ name: "subject", required: true }, { name: "detail" }],
				},
				{ name: "a.b", description: "Dotted prompt" },
				{ name: "a_b", description: "Underscored prompt" },
			],
		};
		const f = fixture([entry("prompts"), entry("other")], { prompts: spec });
		const original = await f.session();
		await original.session.prompt("/mcp reconnect prompts");
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const harness = await f.session();
		expect(f.opened).toEqual(["prompts"]);
		harness.setResponses([fauxAssistantMessage("received")]);
		await harness.session.prompt(`/mcp__prompts__brief "a=b" "" extra=ok __proto__=safe`);
		const calls = () => f.requests.filter(({ request }) => request.method === "prompts/get");
		const args = (calls()[0].request.params as { arguments: Record<string, string> }).arguments;
		expect(args.subject).toBe("a=b");
		expect(args.detail).toBe("");
		expect(args.extra).toBe("ok");
		expect(Object.hasOwn(args, "__proto__")).toBe(true);
		expect(args.__proto__).toBe("safe");
		await vi.waitFor(() => expect(getUserTexts(harness).at(-1)).toBe("[assistant]\nPrepared prompt"));
		await harness.session.waitForIdle();
		await harness.session.prompt(`/mcp__prompts__brief subject=""`);
		expect(f.notifications.at(-1)).toContain("Missing required prompt argument");
		expect(calls()).toHaveLength(1);
		const commands = harness.session.extensionRunner
			.getRegisteredCommands()
			.filter((command) => command.description?.endsWith("prompt"));
		expect(commands).toHaveLength(2);
		for (const command of commands) {
			const before = getUserTexts(harness).length;
			harness.setResponses([fauxAssistantMessage("received")]);
			await harness.session.prompt(`/${command.invocationName}`);
			await vi.waitFor(() => expect(getUserTexts(harness)).toHaveLength(before + 1));
			await harness.session.waitForIdle();
		}
		expect(
			calls()
				.slice(1)
				.map(({ request }) => (request.params as { name: string }).name),
		).toEqual(["a.b", "a_b"]);
		spec.prompts = [];
		await f.peers.at(-1)?.pair.server.send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
		await vi.waitFor(() => expect(harness.session.extensionRunner.getCommand("mcp__prompts__brief")).toBeUndefined());
		expect(f.requests.some(({ request }) => request.method === "tools/list")).toBe(false);
		expect(f.opened.every((name) => name === "prompts")).toBe(true);
	});

	it("refuses a cached prompt from a replaced account before connecting or fetching it", async () => {
		const profile = entry("prompts");
		const f = fixture([profile], { prompts: { prompts: [{ name: "brief" }] } });
		const harness = await f.session();
		await harness.session.prompt("/mcp reconnect prompts");
		await f.credentials.importGrant(profile, {
			serverUrl: "http://prompts.invalid/mcp",
			tokens: { access_token: "new-account", token_type: "Bearer" },
		});
		await harness.session.prompt("/mcp__prompts__brief");
		expect(f.notifications.at(-1)).toContain("belongs to an old account");
		expect(f.requests.filter(({ request }) => request.method === "prompts/get")).toEqual([]);
		expect(f.opened).toEqual(["prompts"]);
		expect(harness.session.extensionRunner.getCommand("mcp__prompts__brief")).toBeUndefined();
	});
});
