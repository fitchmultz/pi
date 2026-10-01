/**
 * Native MCP integration. Every server is lazy unless configured eager, independently of exposure.
 * Account-bound cached tools and prompts register before startup completes; discovery and calls
 * connect only their target. Tool execution uses pi's validation, admission and permission hooks.
 * `/mcp` manages configuration and native browser sign-in without connecting dormant servers merely
 * to show status.
 */

import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { SelectItem } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { getLatestCustomEntry } from "../../core/session-metadata-cursor.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { CODEMODE_TOOL_NAME, isCodemodeTool } from "../codemode/tool.ts";
import { isToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";
import { McpCatalogStore, mcpConfigIdentity } from "./catalog.ts";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
} from "./config.ts";
import type { McpDiscoveryReport } from "./discovery.ts";
import {
	literalToolReferences,
	MCP_DISCOVERY_TOOL_NAME,
	mcpDiscoveryOutputSchema,
	mcpDiscoverySchema,
	resolveToolNamespace,
} from "./discovery.ts";
import type { McpOAuthCredentialStore, McpSignInFlow, McpSignInPrompt } from "./oauth.ts";
import { createMcpPromptCommand } from "./prompts.ts";
import {
	createMcpResourceToolDefinitions,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "./resources.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
import type { McpServerConnection, McpServerLog, McpTransportFactory } from "./runtime.ts";
import { MCP_SELECTION_MIGRATION, type McpSelectionMigration, readMcpSelectionMigration } from "./selection.ts";
import { configuredExposures, MCP_SERVERS_SECTION, renderServersSection } from "./servers-section.ts";
import { createMcpToolDefinition, createMcpToolName, type McpToolDetails } from "./tools.ts";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.ts";

export type { McpTransportFactory } from "./runtime.ts";
export { MAX_SERVERS_SECTION_CHARS, MCP_SERVERS_SECTION, renderServersSection } from "./servers-section.ts";

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** Account-bound native metadata store. Defaults to mcp-catalog.json in the agent directory. */
	catalog?: McpCatalogStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/** Saves `/mcp` changes to the server's config file. Defaults to editing its `mcp.json`. */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/**
	 * How long the first prompt waits for servers that are still connecting at startup, in
	 * milliseconds. Their tools become available when they connect. Default: 10000.
	 */
	startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

/** A configured server. Disabled servers have no connection. */
interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	/** For servers extensions registered: the config as registered, to detect re-registrations. */
	registeredConfig?: string;
	/** Result of the last `/mcp` action that failed, shown in the manager. */
	message?: string;
	ready?: Promise<void>;
	names?: Record<string, string>;
}

const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
	codemode: "called from codemode scripts; discover with scoped searchTools()",
	"codemode-deferred": "called from codemode scripts, not listed; scripts find them with searchTools()",
	deferred: "not declared until tool_search loads them, then called directly; no codemode needed",
	direct: "declared to the model like built-in tools",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function isEnabled(server: McpServer): boolean {
	return server.entry.config.enabled !== false;
}

function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? "codemode";
}

/** Short state for lists and the startup report. `withError` appends the first line of a failure. */
function describeState(server: McpServer, withError = true): string {
	if (!isEnabled(server)) return "disabled";
	const connection = server.connection;
	if (!connection) return "lazy · undiscovered";
	switch (connection.state) {
		case "idle":
			return connection.catalogKnown
				? `lazy · ${connection.tools.length} cached tools${connection.prompts.length ? ` · ${connection.prompts.length} cached prompts` : ""}`
				: "lazy · undiscovered";
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
		case "connected": {
			const { tools, resources } = connection;
			const count = resources.length;
			const resourceCount = count > 0 ? ` · ${count} resource${count === 1 ? "" : "s"}` : "";
			const promptCount = connection.prompts.length;
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${resourceCount}${promptCount ? ` · ${promptCount} prompt${promptCount === 1 ? "" : "s"}` : ""}`;
		}
		case "connecting":
			return "connecting…";
		default:
			return connection.state;
	}
}

/** Servers that need the user first. */
function attentionRank(server: McpServer): number {
	if (!isEnabled(server)) return 5;
	switch (server.connection?.state) {
		case "needs-auth":
			return 0;
		case "failed":
			return 1;
		case "disconnected":
			return 2;
		case "connected":
			return 4;
		default:
			return 3;
	}
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if ("url" in config) return config.url;
	return [config.command, ...(config.args ?? [])].join(" ");
}

const MCP_USAGE =
	"Usage: /mcp, /mcp prompts [server], /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let servers: McpServer[] = [];
		/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
		let configuredEntries: McpServerEntry[] = [];
		let configErrors: string[] = [];
		let sharedConfigPath: string | undefined;
		/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
		let overridden: string[] = [];
		/** Between session_start and session_shutdown. Registrations before that are read on session_start. */
		let sessionActive = false;
		let autoEnableCodemode = true;
		/** Whether the "codemode tools unreachable" warning was shown since the session started. */
		let warnedUnreachable = false;
		let pending: Promise<unknown> | undefined;
		/** Whether a prompt already waited for the startup connections since the session started. */
		let waitedForStartup = false;
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		/** Bumped on every session start and shutdown so a runtime load that resolves late is dropped. */
		let generation = 0;
		/** Working directory of the session, for stdio servers. */
		let sessionCwd = process.cwd();
		let sessionContext: ExtensionContext | undefined;
		let selectionMigration: McpSelectionMigration | undefined;
		let inactiveToolNames = new Set<string>();
		let inactiveMigrationOwners = new Set<string>();
		const migratedFeatures = { gateway: TOOL_SEARCH_TOOL_NAME, script: CODEMODE_TOOL_NAME };
		let credentials = options.credentials;
		let serverLog: McpServerLog | undefined;
		let signInFlow: McpSignInFlow | undefined;
		const catalog = options.catalog ?? new McpCatalogStore();
		const openUrl = options.openUrl ?? openBrowser;
		const updateConfig =
			options.updateConfig ?? ((entry, patch) => updateMcpServerConfig(entry, patch, sharedConfigPath));
		const authServers = new Map<string, McpServer>();

		const listeners = new Set<() => void>();
		const emitChange = () => {
			for (const listener of listeners) listener();
		};
		const subscribe = (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};

		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		const findServer = (name: string) => servers.find((server) => server.entry.name === name);

		/** Servers extensions registered, except names `mcp.json` defines, which take precedence. */
		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			const registered: McpServer[] = [];
			const overriddenNames: string[] = [];
			for (const { name, config, extensionPath } of pi.getMcpServers()) {
				const configured = configuredEntries.find((entry) => entry.name === name);
				if (configured) {
					overriddenNames.push(`"${name}" registered by ${extensionPath} is overridden by ${configured.source}`);
					continue;
				}
				registered.push({
					entry: { name, config, source: extensionPath, scope: "extension" },
					registeredConfig: JSON.stringify(config),
				});
			}
			return { servers: registered, overridden: overriddenNames };
		};

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore();
			return credentials;
		};

		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log"));
			return serverLog;
		};

		/** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
		const toolOwners = new Map<string, string>();
		/** Tool names currently offered by each server. */
		const serverTools = new Map<string, Set<string>>();
		/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();
		const metadata = new Map<string, unknown>();
		const promptCommands = new Map<string, Map<string, string>>();

		const restoreSelection = (ctx: ExtensionContext) => {
			sessionContext = ctx;
			const branch = ctx.sessionManager.getBranch();
			selectionMigration = readMcpSelectionMigration(branch);
			inactiveMigrationOwners = new Set(
				selectionMigration?.inactive.map(({ server, tool }) => `${server}\0${tool}`),
			);
			const snapshots = branch.flatMap((entry) =>
				entry.type === "custom" && entry.customType === "pi-tool-loadout" && Array.isArray(entry.data)
					? [entry.data.filter((name): name is string => typeof name === "string")]
					: [],
			);
			const selected = new Set(snapshots.at(-1));
			inactiveToolNames = new Set(
				snapshots.flat().filter((name) => name.startsWith("mcp__") && !selected.has(name)),
			);
		};

		const migrateSelection = () => {
			const migration = selectionMigration;
			if (!migration || !sessionContext) return;
			const known = new Map([...toolOwners].map(([name, owner]) => [owner, name]));
			const names = migration.pending.flatMap(({ server, tool }) => {
				const name = known.get(`${server}\0${tool}`);
				return name ? [name] : [];
			});
			const permitted = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			const activate = [...names, ...migration.features.map((feature) => migratedFeatures[feature])].filter(
				(name) => permitted.has(name) && permitted.get(name)?.exposure !== "hidden",
			);
			if (activate.length) {
				pi.setActiveTools([...pi.getActiveTools(), ...activate], { preservePending: true });
				const previous = getLatestCustomEntry(sessionContext.sessionManager, "pi-tool-loadout");
				const pending =
					previous?.type === "custom" && Array.isArray(previous.data)
						? previous.data.filter(
								(name): name is string =>
									typeof name === "string" &&
									!["mcp", "mcp_search", "mcp_script"].includes(name) &&
									!permitted.has(name),
							)
						: [];
				pi.appendEntry("pi-tool-loadout", [...new Set([...pi.getActiveTools(), ...pending])]);
			}
			selectionMigration = {
				...migration,
				pending: migration.pending.filter(({ server, tool }) => !known.has(`${server}\0${tool}`)),
				features: [],
			};
			const saved = getLatestCustomEntry(sessionContext.sessionManager, MCP_SELECTION_MIGRATION);
			if (saved?.type !== "custom" || !isDeepStrictEqual(saved.data, selectionMigration)) {
				pi.appendEntry(MCP_SELECTION_MIGRATION, selectionMigration);
			}
		};

		const rememberDirectSelection = (server: string) => {
			const offered = serverTools.get(server);
			const active = new Set(pi.getActiveTools());
			for (const tool of pi.getAllTools()) {
				if (tool.exposure !== "direct" || !offered?.has(tool.name)) continue;
				if (active.has(tool.name)) inactiveToolNames.delete(tool.name);
				else inactiveToolNames.add(tool.name);
			}
		};

		const registerTools = (connection: McpServerConnection) => {
			const server = connection.entry.name;
			const currentServer = findServer(server);
			if (currentServer?.connection !== connection || !isEnabled(currentServer)) return;
			rememberDirectSelection(server);
			const entry = currentServer.entry;
			const namespaceName = `mcp__${server}`;
			const namespace = {
				name: namespaceName,
				...(entry.config.description?.trim() ? { description: entry.config.description.trim() } : {}),
				...(connection.instructions ? { instructions: connection.instructions } : {}),
			};
			const previous = serverTools.get(server) ?? new Set<string>();
			const current = new Set<string>();
			const assignName = (tool: string, owner: string) => {
				const assigned = [...toolOwners].find(([, existing]) => existing === owner)?.[0];
				const cached =
					currentServer.names && Object.hasOwn(currentServer.names, tool) ? currentServer.names[tool] : undefined;
				const taken = (candidate: string) => {
					const existing = toolOwners.get(candidate);
					return (existing !== undefined && existing !== owner) || current.has(candidate);
				};
				const name = assigned ?? (cached && !taken(cached) ? cached : createMcpToolName(server, tool, taken));
				toolOwners.set(name, owner);
				current.add(name);
				return name;
			};
			for (const tool of connection.tools) {
				const name = assignName(tool.name, `${server}\0${tool.name}`);
				const exposure = getMcpToolExposure(entry.config, tool.name);
				if (inactiveMigrationOwners.delete(`${server}\0${tool.name}`)) inactiveToolNames.add(name);
				const inactive = inactiveToolNames.has(name);
				const next = {
					tool,
					exposure,
					namespace,
					timeoutMs: connection.timeoutMs,
					bindingIdentity: connection.bindingIdentity,
				};
				const existing = definitions.get(name);
				if (existing && isDeepStrictEqual(metadata.get(name), next)) {
					existing.defaultActive = !inactive;
					pi.registerTool(existing);
					continue;
				}
				const definition = createMcpToolDefinition({
					server,
					tool,
					name,
					exposure,
					namespace,
					timeoutMs: connection.timeoutMs,
					getClient: async () => {
						const current = findServer(server);
						if (!current || !isEnabled(current)) throw new Error(`MCP server "${server}" is no longer enabled.`);
						return current.connection ?? prepareServer(current);
					},
					bindingIdentity: connection.bindingIdentity,
					readableResources: () => serversWithResources().some((current) => current.entry.name === server),
				});
				if (inactive) definition.defaultActive = false;
				definitions.set(definition.name, definition);
				metadata.set(definition.name, structuredClone(next));
				pi.registerTool(definition);
			}
			serverTools.set(server, current);
			// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
			// the server offers them again they are registered with their configured exposure above.
			for (const name of previous) {
				const definition = definitions.get(name);
				if (!current.has(name) && definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			migrateSelection();
			syncResourceTools();
			const previousPrompts = promptCommands.get(server) ?? new Map<string, string>();
			const currentPrompts = new Map<string, string>();
			for (const prompt of exposureOf(entry) === "hidden" ? [] : connection.prompts) {
				const name =
					previousPrompts.get(prompt.name) ??
					createMcpToolName(
						server,
						prompt.name,
						(candidate) =>
							[...promptCommands].some(
								([owner, names]) => owner !== server && [...names.values()].includes(candidate),
							) || [...currentPrompts.values()].includes(candidate),
					);
				currentPrompts.set(prompt.name, name);
				pi.registerCommand(
					name,
					createMcpPromptCommand(
						pi,
						server,
						prompt,
						async () => {
							if (
								findServer(server) !== currentServer ||
								!isEnabled(currentServer) ||
								exposureOf(currentServer.entry) === "hidden"
							) {
								throw new Error(`MCP prompt "${server}/${prompt.name}" is no longer available.`);
							}
							return prepareServer(currentServer);
						},
						() => currentServer.connection?.bindingIdentity ?? "",
						connection.bindingIdentity,
					),
				);
			}
			for (const name of previousPrompts.values())
				if (![...currentPrompts.values()].includes(name)) pi.unregisterCommand(name);
			promptCommands.set(server, currentPrompts);
			if (connection.state === "connected") {
				currentServer.names = Object.fromEntries(
					[...toolOwners]
						.filter(([, owner]) => owner.startsWith(`${server}\0`))
						.map(([name, owner]) => [owner.slice(server.length + 1), name]),
				);
				if (connection.configIdentity !== mcpConfigIdentity(entry, sessionCwd, connection.credentialIdentity))
					return;
				try {
					catalog.save(entry, sessionCwd, connection.credentialIdentity, {
						tools: connection.tools,
						hasResources: connection.hasResources,
						resources: connection.resources,
						resourceTemplates: connection.resourceTemplates,
						prompts: connection.prompts,
						instructions: connection.instructions,
						names: currentServer.names,
					});
				} catch (error) {
					currentServer.message = `Could not save the MCP catalog: ${errorMessage(error)}`;
				}
			}
		};

		/** Make a disabled server's tools unreachable. */
		const hideTools = (server: string) => {
			rememberDirectSelection(server);
			for (const name of serverTools.get(server) ?? []) {
				const definition = definitions.get(name);
				if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			serverTools.set(server, new Set());
			for (const name of promptCommands.get(server)?.values() ?? []) pi.unregisterCommand(name);
			promptCommands.delete(server);
			syncResourceTools();
		};

		/** Visible servers, including cold resource-only servers. Resource requests discover capabilities. */
		const serversWithResources = (): McpServer[] =>
			servers.filter(
				(server) =>
					isEnabled(server) &&
					exposureOf(server.entry) !== "hidden" &&
					(!server.connection?.catalogKnown || server.connection.hasResources),
			);
		const resourceServers = (): McpServerConnection[] =>
			serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

		/** Exposure the resource tools were last registered with; undefined until a server has resources. */
		let resourceToolsExposure: McpExposure | undefined;
		/**
		 * Register the resource tools with the widest exposure of the servers they reach: `direct` when
		 * one of them is direct, and so on. They are hidden when no server has resources.
		 */
		const syncResourceTools = () => {
			const exposures = new Set(serversWithResources().map((server) => exposureOf(server.entry)));
			const exposure = (["direct", "codemode", "codemode-deferred", "deferred"] as const).find((candidate) =>
				exposures.has(candidate),
			);
			const next = exposure ?? "hidden";
			if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
			const wasDirect = resourceToolsExposure === "direct";
			resourceToolsExposure = next;
			const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers });
			for (const definition of resourceDefinitions) pi.registerTool(definition);
			if (wasDirect) {
				const names = new Set(resourceDefinitions.map((definition) => definition.name));
				pi.setActiveTools(
					pi.getActiveTools().filter((name) => !names.has(name)),
					{ preservePending: true },
				);
			}
		};

		/**
		 * Tools that are not declared to the model are reached through the codemode tool (scripts call
		 * them) or the tool_search tool (it declares them). Either reaches every such tool. Activate the
		 * one the tools' exposure asks for: codemode for `codemode` and `codemode-deferred` unless
		 * `autoEnableCodemode` is false, tool_search for `deferred`.
		 */
		const ensureDiscoveryActive = (ctx: ExtensionContext) => {
			const exposures = new Set<McpExposure>();
			for (const server of servers) {
				if (!isEnabled(server)) continue;
				for (const exposure of configuredExposures(server.entry)) exposures.add(exposure);
			}
			const needsCodemode = exposures.has("codemode") || exposures.has("codemode-deferred");
			const needsToolSearch =
				exposures.has("deferred") ||
				servers.some(
					(server) =>
						isEnabled(server) &&
						configuredExposures(server.entry).has("direct") &&
						!server.connection?.catalogKnown &&
						(server.entry.config.connection !== "eager" || waitedForStartup),
				);
			if (!needsCodemode && !needsToolSearch) return;
			// Other extensions' tools of the same names cannot reach MCP tools, so never activate them.
			const tools = pi.getAllTools();
			const hasCodemode = tools.some(isCodemodeTool);
			const hasToolSearch = tools.some(isToolSearchTool);
			const active = pi.getActiveTools();
			const activate: string[] = [];
			const inactive = new Set(selectionMigration?.inactiveFeatures.map((feature) => migratedFeatures[feature]));
			if (
				needsCodemode &&
				hasCodemode &&
				autoEnableCodemode &&
				!inactive.has(CODEMODE_TOOL_NAME) &&
				!active.includes(CODEMODE_TOOL_NAME)
			) {
				activate.push(CODEMODE_TOOL_NAME);
			}
			if (
				needsToolSearch &&
				hasToolSearch &&
				!inactive.has(TOOL_SEARCH_TOOL_NAME) &&
				!active.includes(TOOL_SEARCH_TOOL_NAME)
			) {
				activate.push(TOOL_SEARCH_TOOL_NAME);
			}
			if (activate.length > 0) pi.setActiveTools([...active, ...activate], { preservePending: true });
			const reachable = [...active, ...activate];
			if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return;
			if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return;
			if (warnedUnreachable) return;
			warnedUnreachable = true;
			const reason = needsCodemode && hasCodemode && !autoEnableCodemode ? " (autoEnableCodemode is false)" : "";
			ctx.ui.notify(
				`MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
				"warning",
			);
		};

		const onConnectionChange = () => emitChange();

		/** Create an idle connection; no process, socket, secret command, or consent starts here. */
		const createConnection = async (server: McpServer): Promise<McpServerConnection> => {
			if (!sessionActive || !servers.includes(server) || !isEnabled(server)) {
				throw new Error(`MCP server "${server.entry.name}" is no longer enabled.`);
			}
			if (server.connection) return server.connection;
			const runtime = await loadMcpRuntime();
			if (!sessionActive || !servers.includes(server) || !isEnabled(server)) {
				throw new Error(`MCP server "${server.entry.name}" is no longer enabled.`);
			}
			if (server.connection) return server.connection;
			const connection = new runtime.McpServerConnection({
				entry: server.entry,
				cwd: sessionCwd,
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				credentials: getCredentials(runtime),
				log: getServerLog(runtime),
				onTools: registerTools,
				onChange: onConnectionChange,
			});
			server.connection = connection;
			emitChange();
			return connection;
		};

		/** Revoke another account's descriptors before any call can be admitted. */
		const prepareServer = async (server: McpServer): Promise<McpServerConnection> => {
			const runtime = await loadMcpRuntime();
			const store = getCredentials(runtime);
			const credentialIdentity = store.catalogIdentity(server.entry);
			const identity = mcpConfigIdentity(server.entry, sessionCwd, credentialIdentity);
			if (
				server.connection &&
				server.connection.credentialIdentity === credentialIdentity &&
				server.connection.configIdentity === identity
			)
				return server.connection;
			const previous = server.connection;
			server.connection = undefined;
			server.names = undefined;
			hideTools(server.entry.name);
			await previous?.close();
			const connection = await createConnection(server);
			if (
				connection.credentialIdentity !== credentialIdentity ||
				connection.configIdentity !== identity ||
				store.catalogIdentity(server.entry) !== credentialIdentity ||
				mcpConfigIdentity(server.entry, sessionCwd, credentialIdentity) !== identity
			) {
				return prepareServer(server);
			}
			connection.requestedScope = previous?.requestedScope;
			const challengedScopes = previous?.challenge?.scope?.split(/\s+/).filter(Boolean);
			const grantedScopes = store.tokens(server.entry)?.scope?.split(/\s+/) ?? [];
			// Scope strings guide consent only; the server owns operation permissions and scope hierarchies.
			if (challengedScopes?.some((scope) => !grantedScopes.includes(scope)))
				connection.challenge = previous?.challenge;
			try {
				const cached = catalog.load(server.entry, sessionCwd, credentialIdentity);
				if (cached) {
					server.names = cached.names;
					connection.restoreCatalog(cached);
				}
			} catch (error) {
				server.message = `Could not read the MCP catalog: ${errorMessage(error)}`;
			}
			return connection;
		};

		const discoverServer = async (server: McpServer, signal?: AbortSignal) => {
			signal?.throwIfAborted();
			const connection = await prepareServer(server);
			await connection.getClient();
			signal?.throwIfAborted();
			return connection;
		};

		const discoveryReport = (): McpDiscoveryReport => {
			const visible = servers.filter(
				(server) =>
					isEnabled(server) && [...configuredExposures(server.entry)].some((exposure) => exposure !== "hidden"),
			);
			const undiscovered = visible
				.filter((server) => !server.connection?.catalogKnown)
				.map((server) => server.entry.name);
			return {
				servers: visible.map((server) => ({
					name: server.entry.name,
					namespace: `mcp__${server.entry.name}`,
					state: server.connection?.state ?? "idle",
					catalog: server.connection?.catalogKnown ?? false,
					...(server.entry.config.description ? { description: server.entry.config.description } : {}),
				})),
				complete: undiscovered.length === 0,
				undiscovered,
			};
		};

		/**
		 * One message for everything that needs the user after startup, or only for `only`, servers
		 * that connected later.
		 */
		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			for (const server of only ?? servers) {
				const state = server.connection?.state;
				if (state === "needs-auth" || state === "failed")
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			if (lines.length === 0) return;
			ctx.ui.notify(
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				"warning",
			);
		};

		/**
		 * Save a config change; returns an error message when the file could not be updated. Changes to
		 * registered servers only apply to the current session.
		 */
		const saveConfig = (server: McpServer, patch: McpServerConfigPatch): string | undefined => {
			if (server.entry.scope !== "extension") {
				try {
					updateConfig(server.entry, patch);
				} catch (error) {
					return `Could not update ${server.entry.writableSource ?? server.entry.source}: ${errorMessage(error)}`;
				}
			}
			server.entry = { ...server.entry, config: { ...server.entry.config, ...patch } };
			return undefined;
		};

		const signIn = async (server: McpServer, prompt: McpSignInPrompt): Promise<string | undefined> => {
			const connection = await prepareServer(server);
			if (!connection.oauthUrl) return `MCP server "${server.entry.name}" does not use OAuth.`;
			const runtime = await loadMcpRuntime();
			try {
				signInFlow ??= new runtime.McpSignInFlow();
				await runtime.signInMcpServer({
					entry: server.entry,
					store: getCredentials(runtime).forServer(server.entry),
					flow: signInFlow,
					settings: connection.oauthSettings(),
					challenge: connection.challenge,
					requestedScope: connection.requestedScope,
					onRequestedScope: (scope) => {
						connection.requestedScope = scope;
					},
					prompt,
				});
			} catch (error) {
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			try {
				await discoverServer(server);
			} catch (error) {
				return `Signed in, but ${errorMessage(error)}`;
			}
			return undefined;
		};

		const signOut = async (server: McpServer): Promise<boolean> => {
			const connection = await prepareServer(server);
			if (!connection.oauthUrl) return false;
			const removed = await getCredentials(await loadMcpRuntime()).remove(server.entry);
			const fresh = await prepareServer(server);
			await fresh.signOut();
			return removed;
		};

		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			if (!isEnabled(server)) return `MCP server "${server.entry.name}" is disabled.`;
			try {
				const connection = await prepareServer(server);
				await connection.reconnect();
				return undefined;
			} catch (error) {
				return errorMessage(error);
			}
		};

		/** Returns an error message when the config could not be saved; connection errors show in the state. */
		const setEnabled = async (server: McpServer, enabled: boolean): Promise<string | undefined> => {
			const failed = saveConfig(server, { enabled });
			if (failed) return failed;
			if (!enabled) {
				const connection = server.connection;
				server.connection = undefined;
				hideTools(server.entry.name);
				emitChange();
				await connection?.close();
				return undefined;
			}
			const connection = await prepareServer(server);
			if (server.entry.config.connection === "eager") await connection.getClient().catch(() => undefined);
			return undefined;
		};

		const setExposure = (server: McpServer, exposure: McpExposure): string | undefined => {
			const failed = saveConfig(server, { exposure });
			if (failed) return failed;
			if (server.connection?.catalogKnown) registerTools(server.connection);
			syncResourceTools();
			// Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
			const indirect = new Set(
				pi
					.getAllTools()
					.filter((tool) => tool.exposure !== "direct")
					.map((tool) => tool.name),
			);
			const tools = serverTools.get(server.entry.name) ?? new Set<string>();
			pi.setActiveTools(
				pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)),
				{ preservePending: true },
			);
			emitChange();
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// Manager (`/mcp` in the TUI)
		// ---------------------------------------------------------------------------------------

		const notices = () => [
			...configErrors.map((error) => `config: ${error}`),
			...overridden.map((line) => `overridden: ${line}`),
		];

		const serversMenu = (): McpMenu => ({
			title: "MCP servers",
			error: notices().join("\n") || undefined,
			items: [...servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.scope ?? server.entry.source}`,
				})),
			empty: `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`,
			confirmLabel: "manage",
			cancelLabel: "close",
		});

		const serverMenu = (name: string): McpMenu => {
			const server = findServer(name);
			if (!server) {
				return {
					title: name,
					items: [],
					empty: "This server is no longer configured.",
					confirmLabel: "",
					cancelLabel: "back",
				};
			}
			const { entry, connection } = server;
			const saved =
				entry.scope === "extension" ? "for this session" : `saved to ${entry.writableSource ?? entry.source}`;
			const items: SelectItem[] = [];
			if (!isEnabled(server)) {
				items.push({ value: "enable", label: "Enable", description: saved });
			} else {
				const state = connection?.state;
				if (usesOAuth(server)) items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				if (connection?.catalogKnown) {
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
					items.push({ value: "prompts", label: "Prompts", description: `${connection.prompts.length} offered` });
				}
				items.push({ value: "reconnect", label: state === "idle" ? "Connect" : "Reconnect" });
				if (usesOAuth(server) && credentials?.tokens(entry)) {
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				items.push({ value: "disable", label: "Disable", description: saved });
			}
			const details = [
				describeTransport(entry),
				`${entry.scope ?? "config"}: ${entry.source}`,
				`State: ${describeState(server, false)}`,
			];
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				title: `MCP server ${name}`,
				details: details.join("\n"),
				error: error || undefined,
				items,
				selected: items[0]?.value,
				confirmLabel: "select",
				cancelLabel: "back",
			};
		};

		const showTools = async (ui: McpUi, server: McpServer) => {
			const exposure = exposureOf(server.entry);
			const overridden = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			await ui.menu(() => ({
				title: `Tools of ${server.entry.name}`,
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
				items: (server.connection?.tools ?? []).map((tool) => {
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					const description = firstLine(tool.description ?? "");
					return {
						value: tool.name,
						label: tool.name,
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				empty: "The server offers no tools.",
				confirmLabel: "back",
				cancelLabel: "back",
			}));
		};

		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const current = exposureOf(server.entry);
			const choice = await ui.menu(() => ({
				title: `Exposure of ${server.entry.name}`,
				details:
					server.entry.scope === "extension"
						? `Applies to this session; the server is registered by ${server.entry.source}.`
						: `Saved to ${server.entry.writableSource ?? server.entry.source}.`,
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					value: exposure,
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				selected: current,
				confirmLabel: "save",
				cancelLabel: "back",
			}));
			if (!choice || choice === current) return undefined;
			return setExposure(server, choice as McpExposure);
		};

		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			const { name } = server.entry;
			let message: string | undefined;
			switch (action) {
				case "signin": {
					const title = `Sign in to ${name}`;
					let authorizationUrl = "";
					ui.status(title, "Contacting the authorization server…");
					message = await signIn(server, {
						showAuthorizationUrl: (url) => {
							authorizationUrl = url.href;
							openUrl(url.href);
						},
						promptForRedirectUrl: async (signal) => {
							const value = await ui.redirectUrl(title, authorizationUrl, signal);
							ui.status(title, "Connecting…");
							return value;
						},
					});
					break;
				}
				case "reconnect":
					// A failure shows as the connection's state and error.
					ui.status(`MCP server ${name}`, "Reconnecting…");
					await reconnect(server);
					break;
				case "signout":
					await signOut(server);
					break;
				case "tools":
					await showTools(ui, server);
					break;
				case "prompts":
					await ui.menu(() => ({
						title: `Prompts of ${name}`,
						items: (server.connection?.prompts ?? []).map((prompt) => ({
							value: prompt.name,
							label: `/${promptCommands.get(name)?.get(prompt.name)}${(prompt.arguments ?? []).map((arg) => (arg.required ? ` <${arg.name}>` : ` [${arg.name}]`)).join("")}`,
							description: firstLine(prompt.description ?? ""),
						})),
						empty: "The server offers no prompts.",
						confirmLabel: "back",
						cancelLabel: "back",
					}));
					break;
				case "exposure":
					message = await chooseExposure(ui, server);
					break;
				case "enable":
				case "disable":
					ui.status(`MCP server ${name}`, action === "enable" ? "Enabling…" : "Disconnecting…");
					message = await setEnabled(server, action === "enable");
					break;
			}
			server.message = message;
			ensureDiscoveryActive(ctx);
			emitChange();
		};
		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			for (;;) {
				const name = await ui.menu(serversMenu, subscribe);
				if (!name) return;
				for (;;) {
					const action = await ui.menu(() => serverMenu(name), subscribe);
					const server = findServer(name);
					if (!action || !server) break;
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// Subcommands and plain status (no TUI)
		// ---------------------------------------------------------------------------------------

		const formatStatus = (): string => {
			if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
				return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`;
			}
			const lines = servers.map((server) => {
				const { name } = server.entry;
				const exposure = exposureOf(server.entry);
				const connection = server.connection;
				if (connection?.state === "needs-auth")
					return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
				const state = describeState(server, false);
				const error =
					connection?.error && connection.state !== "connected"
						? `\n    ${connection.error.split("\n").join("\n    ")}`
						: "";
				return `${name}: ${state} (${exposure})${error}`;
			});
			for (const error of configErrors) lines.push(`config error: ${error}`);
			for (const line of overridden) lines.push(`overridden: ${line}`);
			return lines.join("\n");
		};

		/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
		const pickServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
			options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			if (name) {
				const server = findServer(name);
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
				return server && options.eligible(server) ? server : undefined;
			}
			const candidates = servers.filter(options.eligible);
			if (candidates.length === 0) {
				ctx.ui.notify(options.none, "info");
				return undefined;
			}
			const preferred = candidates.filter(options.preferred);
			if (candidates.length === 1) return candidates[0];
			if (preferred.length === 1) return preferred[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((server) => server.entry.name),
			);
			return candidates.find((server) => server.entry.name === choice);
		};

		const usesOAuth = (server: McpServer) =>
			isEnabled(server) &&
			"url" in server.entry.config &&
			!Object.keys(server.entry.config.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
		const oauthPick = {
			eligible: usesOAuth,
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			const failure = await signIn(server, {
				showAuthorizationUrl: (url) => {
					ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
					openUrl(url.href);
				},
				promptForRedirectUrl: (signal) =>
					ctx.ui.input(
						`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
						"http://127.0.0.1:.../callback?code=...",
						{ signal },
					),
			});
			if (failure) {
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				return;
			}
			ensureDiscoveryActive(ctx);
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		pi.on("session_start", async (_event, ctx) => {
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			sharedConfigPath = loaded.sharedConfigPath;
			configErrors = loaded.errors;
			autoEnableCodemode = loaded.autoEnableCodemode ?? true;
			warnedUnreachable = false;
			waitedForStartup = false;
			sessionCwd = ctx.cwd;
			const current = ++generation;
			sessionActive = true;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			restoreSelection(ctx);
			emitChange();
			await Promise.all(servers.filter(isEnabled).map((server) => prepareServer(server)));
			if (current !== generation) return;
			migrateSelection();
			syncResourceTools();
			ensureDiscoveryActive(ctx);
			reportProblems(ctx);
			const eager = servers.filter((server) => isEnabled(server) && server.entry.config.connection === "eager");
			for (const server of eager) {
				server.ready = discoverServer(server).then(
					() => {
						if (current === generation) ensureDiscoveryActive(ctx);
					},
					() => {
						if (current === generation) reportProblems(ctx, [server]);
					},
				);
			}
			pending = Promise.all(
				eager.filter((server) => configuredExposures(server.entry).has("direct")).map((server) => server.ready),
			);
		});

		pi.on("session_tree", (_event, ctx) => {
			restoreSelection(ctx);
			for (const connection of connections()) if (connection.catalogKnown) registerTools(connection);
			migrateSelection();
			ensureDiscoveryActive(ctx);
		});

		pi.on("before_agent_start", async (event, ctx) => {
			const coldEager: McpServer[] = [];
			for (const server of servers.filter(isEnabled)) {
				const connection = await prepareServer(server);
				if (server.entry.config.connection === "eager" && connection.state === "idle") coldEager.push(server);
			}
			const current = generation;
			for (const server of coldEager) {
				server.ready = discoverServer(server).then(
					() => {
						if (current === generation) ensureDiscoveryActive(ctx);
					},
					() => {
						if (current === generation) reportProblems(ctx, [server]);
					},
				);
			}
			if (coldEager.some((server) => configuredExposures(server.entry).has("direct"))) {
				pending = Promise.all(
					coldEager
						.filter((server) => configuredExposures(server.entry).has("direct"))
						.map((server) => server.ready),
				);
				waitedForStartup = false;
			}
			if (pending && !waitedForStartup) {
				waitedForStartup = true;
				let timer: NodeJS.Timeout | undefined;
				const finished = await Promise.race([
					pending.then(() => true),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), startupWaitMs);
					}),
				]);
				clearTimeout(timer);
				if (!finished)
					ctx.ui.notify(
						"Eager MCP servers are still connecting; their tools become available once connected.",
						"info",
					);
			}
			ensureDiscoveryActive(ctx);
			const section = renderServersSection(servers);
			if (section) event.systemPromptOptions.sections[MCP_SERVERS_SECTION] = section;
			else delete event.systemPromptOptions.sections[MCP_SERVERS_SECTION];
		});

		// Reconcile only the called owner before the core's prepared-call guard rechecks its binding.
		pi.on("tool_call", async (event, ctx) => {
			const owner = toolOwners.get(event.toolName);
			if (owner) {
				const server = findServer(owner.slice(0, owner.indexOf("\0")));
				if (!server) throw new Error(`MCP tool "${event.toolName}" is no longer configured.`);
				await discoverServer(server, ctx.signal);
				return;
			}
			if (
				[LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL].includes(event.toolName)
			) {
				const scope = "server" in event.input ? event.input.server : undefined;
				const targets =
					typeof scope === "string" ? servers.filter((server) => server.entry.name === scope) : servers;
				await Promise.all(
					targets
						.filter((server) => isEnabled(server) && exposureOf(server.entry) !== "hidden")
						.map(prepareServer),
				);
				return;
			}
			if (event.toolName !== CODEMODE_TOOL_NAME || typeof event.input.code !== "string") return;
			const targets = new Set<McpServer>();
			for (const name of literalToolReferences(event.input.code)) {
				const exactOwner = toolOwners.get(name);
				const aliases = exactOwner ? [] : [...toolOwners].filter(([tool]) => toCodemodeIdentifier(tool) === name);
				if (aliases.length > 1) throw new Error(`Ambiguous MCP tool "${name}"; use its native name.`);
				const known = exactOwner ?? aliases[0]?.[1];
				if (known) {
					const toolName = exactOwner ? name : aliases[0][0];
					const info = pi.getAllTools().find((tool) => tool.name === toolName);
					if (
						!info ||
						info.exposure === "hidden" ||
						(info.exposure === "direct" && !pi.getActiveTools().includes(toolName))
					)
						continue;
					const server = findServer(known.slice(0, known.indexOf("\0")));
					if (server) targets.add(server);
					continue;
				}
				const exact = servers.filter((server) => name.startsWith(`mcp__${server.entry.name}__`));
				const candidates =
					exact.length > 0
						? exact
						: servers.filter((server) => name.startsWith(toCodemodeIdentifier(`mcp__${server.entry.name}__`)));
				if (candidates.length > 1)
					throw new Error(`Ambiguous MCP tool "${name}"; use scoped discovery and callTool().`);
				if (candidates[0]) targets.add(candidates[0]);
			}
			await Promise.all(
				[...targets]
					.filter(
						(server) =>
							isEnabled(server) &&
							[...configuredExposures(server.entry)].some((exposure) => exposure !== "hidden"),
					)
					.map((server) => discoverServer(server, ctx.signal)),
			);
		});

		pi.on("mcp_servers_change", async (_event, ctx) => {
			if (!sessionActive) return;
			const current = generation;
			const registered = registeredServers();
			overridden = registered.overridden;
			const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
			const removed = servers.filter(
				(server) =>
					server.entry.scope === "extension" &&
					next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
			);
			servers = servers.filter((server) => !removed.includes(server));
			for (const server of removed) hideTools(server.entry.name);
			await Promise.all(removed.map((server) => server.connection?.close()));
			const added = registered.servers.filter((server) => !findServer(server.entry.name));
			servers.push(...added);
			await Promise.all(added.filter(isEnabled).map((server) => prepareServer(server)));
			if (current !== generation) return;
			syncResourceTools();
			ensureDiscoveryActive(ctx);
			emitChange();
			for (const server of added.filter(
				(server) => isEnabled(server) && server.entry.config.connection === "eager",
			)) {
				void discoverServer(server).then(
					() => ensureDiscoveryActive(ctx),
					() => reportProblems(ctx, [server]),
				);
			}
		});

		pi.on("session_shutdown", async () => {
			sessionActive = false;
			generation++;
			await signInFlow?.close();
			signInFlow = undefined;
			authServers.clear();
			const closing = connections();
			servers = [];
			sessionContext = undefined;
			emitChange();
			await Promise.all(closing.map((connection) => connection.close()));
		});

		pi.registerTool({
			name: MCP_DISCOVERY_TOOL_NAME,
			label: "MCP discovery",
			description:
				"Read native MCP catalog coverage without connecting. With server, discover only that enabled server; never starts browser consent.",
			parameters: mcpDiscoverySchema,
			outputSchema: mcpDiscoveryOutputSchema,
			exposure: "deferred",
			annotations: { readOnlyHint: true },
			async execute(_id, { server: name }, signal, _update, ctx) {
				await Promise.all(servers.filter(isEnabled).map(prepareServer));
				if (name !== undefined) {
					const visible = discoveryReport().servers;
					const namespace = resolveToolNamespace(
						visible.map((server) => server.namespace),
						name,
					);
					const entry = visible.find((server) => server.namespace === namespace);
					const server = entry && findServer(entry.name);
					if (!server) throw new Error(`No enabled MCP server named "${name}".`);
					await discoverServer(server, signal);
					if (ctx) ensureDiscoveryActive(ctx);
				}
				const report = discoveryReport();
				return {
					content: [{ type: "text", text: JSON.stringify(report) }],
					details: undefined,
					structuredContent: report,
				};
			},
		});

		pi.registerTool({
			name: "mcp_auth",
			label: "MCP sign-in",
			description:
				"Explicit native browser sign-in. begin opens the browser for one server and returns its authorization URL for remote-host sign-in. complete uses the captured callback, or the full pasted redirectUrl for a remote host. cancel discards a pending flow. Ordinary discovery never starts consent.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("begin"), Type.Literal("complete"), Type.Literal("cancel")]),
				server: Type.Optional(Type.String()),
				id: Type.Optional(Type.String()),
				redirectUrl: Type.Optional(Type.String()),
			}),
			outputSchema: Type.Object({
				state: Type.Union([Type.Literal("pending"), Type.Literal("signed-in"), Type.Literal("cancelled")]),
				server: Type.Optional(Type.String()),
				id: Type.String(),
				authorizationUrl: Type.Optional(Type.String()),
				redirectUrl: Type.Optional(Type.String()),
			}),
			exposure: "deferred",
			async execute(_callId, input, signal, _update, ctx) {
				const runtime = await loadMcpRuntime();
				signInFlow ??= new runtime.McpSignInFlow();
				signal?.throwIfAborted();
				if (input.action === "begin") {
					if (!input.server || input.id || input.redirectUrl) throw new Error("begin requires only server");
					const visible = discoveryReport().servers;
					const namespace = resolveToolNamespace(
						visible.map((server) => server.namespace),
						input.server,
					);
					const entry = visible.find((server) => server.namespace === namespace);
					const server = entry && findServer(entry.name);
					if (!server || !usesOAuth(server))
						throw new Error(`No enabled OAuth MCP server named "${input.server}".`);
					const connection = await prepareServer(server);
					const started = await signInFlow.begin({
						entry: server.entry,
						store: getCredentials(runtime).forServer(server.entry),
						settings: connection.oauthSettings(),
						challenge: connection.challenge,
						requestedScope: connection.requestedScope,
						onRequestedScope: (scope) => {
							connection.requestedScope = scope;
						},
						signal,
					});
					if (signal?.aborted) {
						await signInFlow.cancel(started.id);
						signal.throwIfAborted();
					}
					authServers.set(started.id, server);
					openUrl(started.authorizationUrl);
					const payload = { state: "pending", server: server.entry.name, ...started };
					return {
						content: [{ type: "text", text: JSON.stringify(payload) }],
						details: undefined,
						structuredContent: payload,
					};
				}
				if (!input.id || input.server) throw new Error(`${input.action} requires id, not server`);
				const server = authServers.get(input.id);
				if (input.action === "cancel") {
					await signInFlow.cancel(input.id);
					authServers.delete(input.id);
					const payload = { state: "cancelled", id: input.id };
					return {
						content: [{ type: "text", text: JSON.stringify(payload) }],
						details: undefined,
						structuredContent: payload,
					};
				}
				if (!server || findServer(server.entry.name) !== server || !usesOAuth(server)) {
					throw new Error("Unknown, expired, or withdrawn MCP sign-in");
				}
				const cancel = () => {
					void signInFlow?.cancel(input.id!);
				};
				signal?.addEventListener("abort", cancel, { once: true });
				try {
					await signInFlow.complete(input.id, input.redirectUrl);
				} finally {
					signal?.removeEventListener("abort", cancel);
					if (!signInFlow.has(input.id)) authServers.delete(input.id);
				}
				// Install only this grant's metadata; sign-in does not eagerly connect unrelated profiles.
				await prepareServer(server);
				if (ctx) ensureDiscoveryActive(ctx);
				const payload = { state: "signed-in", server: server.entry.name, id: input.id };
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }],
					details: undefined,
					structuredContent: payload,
				};
			},
		});

		pi.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect", "prompts"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout" && action !== "reconnect" && action !== "prompts")
					return null;
				const items = servers
					.filter((candidate) =>
						action === "reconnect" || action === "prompts" ? isEnabled(candidate) : usesOAuth(candidate),
					)
					.filter((candidate) => candidate.entry.name.startsWith(server))
					.map((candidate) => ({
						value: `${action} ${candidate.entry.name}`,
						label: candidate.entry.name,
						description: describeState(candidate),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx));
					else ctx.ui.notify(formatStatus(), "info");
					return;
				}
				if (extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				switch (action) {
					case "prompts": {
						const visible = servers.filter(
							(server) =>
								isEnabled(server) &&
								exposureOf(server.entry) !== "hidden" &&
								(!name || server.entry.name === name),
						);
						if (!visible.length) {
							ctx.ui.notify(name ? `No enabled MCP server named "${name}".` : "No enabled MCP servers.", "info");
							return;
						}
						ctx.ui.notify(
							visible
								.map((server) => {
									const connection = server.connection;
									if (!connection?.catalogKnown)
										return `${server.entry.name}: prompts undiscovered; run /mcp reconnect ${server.entry.name}.`;
									const prompts = connection.prompts.map(
										(prompt) =>
											`  /${promptCommands.get(server.entry.name)?.get(prompt.name)}${(prompt.arguments ?? []).map((arg) => (arg.required ? ` <${arg.name}>` : ` [${arg.name}]`)).join("")}`,
									);
									return `${server.entry.name}: ${prompts.length} prompts${prompts.length ? `\n${prompts.join("\n")}` : ""}`;
								})
								.join("\n"),
							"info",
						);
						return;
					}
					case "login": {
						const server = await pickServer(name, ctx, oauthPick);
						if (server) await loginCommand(server, ctx);
						return;
					}
					case "logout": {
						const server = await pickServer(name, ctx, oauthPick);
						if (!server) return;
						const removed = await signOut(server);
						ctx.ui.notify(
							removed
								? `Signed out of MCP server "${server.entry.name}".`
								: `No stored credentials for MCP server "${server.entry.name}".`,
							"info",
						);
						return;
					}
					case "reconnect": {
						const server = await pickServer(name, ctx, {
							eligible: isEnabled,
							preferred: (candidate) =>
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							none: "No enabled MCP server to reconnect.",
						});
						if (!server) return;
						const failure = await reconnect(server);
						if (failure) ctx.ui.notify(failure, "error");
						else {
							ensureDiscoveryActive(ctx);
							ctx.ui.notify(
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								"info",
							);
						}
						return;
					}
					default:
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export default createMcpExtension();
