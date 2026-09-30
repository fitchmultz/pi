/** Account-bound MCP descriptors. Reading a catalog never starts a server or resolves commands. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Prompt, Resource, ResourceTemplate, Tool } from "@earendil-works/pi-mcp";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { isCommandConfigValue, resolveConfigValue } from "../../core/resolve-config-value.ts";
import type { McpServerEntry } from "./config.ts";

export interface McpServerCatalog {
	tools: Tool[];
	hasResources: boolean;
	resources: Resource[];
	resourceTemplates: ResourceTemplate[];
	prompts: Prompt[];
	instructions?: string;
	/** Names assigned to raw tools, including collision suffixes. */
	names?: Record<string, string>;
}

interface StoredCatalog extends McpServerCatalog {
	identity: string;
}

// ponytail: eight recently saved roots/accounts per profile; an evicted identity needs discovery.
const MAX_CATALOG_IDENTITIES = 8;
// ponytail: servers using inherited routing/terminal state as configuration must set it explicitly in env.
const INHERITED_BOOKKEEPING = new Set([
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_SUBAGENT_CHILD_INDEX",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_EAGER_TOOL",
	"PI_SUBAGENT_FANOUT_CHILD",
	"PI_SUBAGENT_INHERIT_PROJECT_CONTEXT",
	"PI_SUBAGENT_INHERIT_SKILLS",
	"PI_SUBAGENT_INHERITED_EXTENSIONS_JSON",
	"PI_SUBAGENT_INTERCOM_SESSION_NAME",
	"PI_SUBAGENT_ORCHESTRATOR_TARGET",
	"PI_SUBAGENT_PARENT_CAPABILITY_TOKEN",
	"PI_SUBAGENT_PARENT_CHILD_INDEX",
	"PI_SUBAGENT_PARENT_CONTROL_INBOX",
	"PI_SUBAGENT_PARENT_DEPTH",
	"PI_SUBAGENT_PARENT_EVENT_SINK",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_SUBAGENT_PARENT_ROOT_RUN_ID",
	"PI_SUBAGENT_PARENT_RUN_ID",
	"PI_SUBAGENT_ROOT_SESSION_ID",
	"PI_SUBAGENT_RUN_ID",
	"PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE",
	"PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA",
	"MCP_DIRECT_TOOLS",
	"PWD",
	"OLDPWD",
	"SHLVL",
	"_",
	"TERM_SESSION_ID",
	"ITERM_SESSION_ID",
	"TMUX_PANE",
	"_P9K_TTY",
	"_P9K_SSH_TTY",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCatalog(value: unknown): value is StoredCatalog {
	if (!isRecord(value) || typeof value.identity !== "string" || typeof value.hasResources !== "boolean") return false;
	if (value.instructions !== undefined && typeof value.instructions !== "string") return false;
	if (
		!Array.isArray(value.tools) ||
		!value.tools.every(
			(tool) =>
				isRecord(tool) &&
				typeof tool.name === "string" &&
				isRecord(tool.inputSchema) &&
				(tool.outputSchema === undefined || isRecord(tool.outputSchema)) &&
				(tool.description === undefined || typeof tool.description === "string") &&
				(tool.title === undefined || typeof tool.title === "string") &&
				(tool.annotations === undefined || isRecord(tool.annotations)),
		)
	)
		return false;
	if (
		!Array.isArray(value.resources) ||
		!value.resources.every((item) => isRecord(item) && typeof item.uri === "string" && typeof item.name === "string")
	)
		return false;
	if (
		!Array.isArray(value.resourceTemplates) ||
		!value.resourceTemplates.every(
			(item) => isRecord(item) && typeof item.uriTemplate === "string" && typeof item.name === "string",
		)
	)
		return false;
	if (
		!Array.isArray(value.prompts) ||
		!value.prompts.every(
			(item) =>
				isRecord(item) &&
				typeof item.name === "string" &&
				(item.title === undefined || typeof item.title === "string") &&
				(item.description === undefined || typeof item.description === "string") &&
				(item.arguments === undefined ||
					(Array.isArray(item.arguments) &&
						item.arguments.every(
							(arg) =>
								isRecord(arg) &&
								typeof arg.name === "string" &&
								(arg.description === undefined || typeof arg.description === "string") &&
								(arg.required === undefined || typeof arg.required === "boolean"),
						))),
		)
	)
		return false;
	return (
		value.names === undefined ||
		(isRecord(value.names) &&
			Object.values(value.names).every(
				(name) => typeof name === "string" && /^mcp__[A-Za-z0-9_-]+$/.test(name) && name.length <= 64,
			))
	);
}

function parseCatalogs(content: string | undefined): Record<string, unknown> {
	if (!content?.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(content);
		return isRecord(parsed) && parsed.version === 2 && isRecord(parsed.servers) ? parsed.servers : {};
	} catch {
		return {};
	}
}

type ConfigIdentityValue = string | undefined | { command: string };

function configIdentityValue(value: string): ConfigIdentityValue {
	return isCommandConfigValue(value) ? { command: value } : resolveConfigValue(value);
}

/** Only environment substitution is safe at cache-only startup. Command-backed secrets stay opaque. */
function environment(values: Record<string, string> | undefined): Record<string, ConfigIdentityValue> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(
		Object.entries(values)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, value]) => [name, configIdentityValue(value)]),
	);
}

/** Identity inputs only; this does not change the environment inherited by the child. */
export function mcpStdioIdentityEnvironment(
	configured: Record<string, ConfigIdentityValue> | undefined,
	inherit = true,
): Record<string, ConfigIdentityValue> {
	return Object.fromEntries(
		Object.entries({
			...(inherit
				? Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED_BOOKKEEPING.has(name)))
				: {}),
			...configured,
		}).sort(([a], [b]) => a.localeCompare(b)),
	);
}

/** Observable config and grant inputs; command values are identified without executing them. */
export function mcpConfigIdentity(entry: McpServerEntry, cwd: string, credentialIdentity: string): string {
	const { config } = entry;
	const transport =
		"url" in config
			? {
					url: String(new URL(config.url)),
					headers: environment(config.headers),
					oauth: config.oauth && {
						...config.oauth,
						clientSecret:
							config.oauth.clientSecret === undefined
								? undefined
								: configIdentityValue(config.oauth.clientSecret),
					},
				}
			: {
					command: config.command,
					args: config.args,
					env: mcpStdioIdentityEnvironment(environment(config.env)),
					cwd: resolve(cwd, config.cwd?.replace(/^~(?=\/|$)/, homedir()) ?? "."),
				};
	return createHash("sha256")
		.update(JSON.stringify({ profile: entry.name, cwd: resolve(cwd), transport, credentialIdentity }))
		.digest("hex");
}

export function mcpCatalogIdentity(entry: McpServerEntry, cwd: string, credentialIdentity: string): string | undefined {
	const { config } = entry;
	const secrets =
		"url" in config
			? [...Object.values(config.headers ?? {}), config.oauth?.clientSecret]
			: Object.values(config.env ?? {});
	// ponytail: command-backed credentials have no observable account identity at cache-only startup;
	// rediscover that profile explicitly rather than running a secret command or reusing another account's catalog.
	if (secrets.some((value) => value !== undefined && isCommandConfigValue(value))) return undefined;
	return mcpConfigIdentity(entry, cwd, credentialIdentity);
}

export class McpCatalogStore {
	private readonly backend: AuthStorageBackend;
	private readonly path: string | undefined;

	constructor(options: { agentDir?: string; backend?: AuthStorageBackend } = {}) {
		this.path = options.backend ? undefined : join(options.agentDir ?? getAgentDir(), "mcp-catalog.json");
		this.backend = options.backend ?? new FileAuthStorageBackend(this.path);
	}

	load(entry: McpServerEntry, cwd: string, credentialIdentity: string): McpServerCatalog | undefined {
		const identity = mcpCatalogIdentity(entry, cwd, credentialIdentity);
		if (!identity || (this.path && !existsSync(this.path))) return undefined;
		return this.backend.withLock((content) => {
			const servers = parseCatalogs(content);
			const stored = Object.hasOwn(servers, entry.name) ? servers[entry.name] : undefined;
			const catalog = Array.isArray(stored)
				? stored.find((value) => validCatalog(value) && value.identity === identity)
				: undefined;
			return {
				result: validCatalog(catalog) ? structuredClone(catalog) : undefined,
			};
		});
	}

	save(entry: McpServerEntry, cwd: string, credentialIdentity: string, catalog: McpServerCatalog): void {
		const identity = mcpCatalogIdentity(entry, cwd, credentialIdentity);
		if (!identity) return;
		this.backend.withLock((content) => {
			const servers = parseCatalogs(content);
			const stored = Object.hasOwn(servers, entry.name) ? servers[entry.name] : undefined;
			const catalogs = Array.isArray(stored) ? stored.filter(validCatalog) : [];
			const previous = catalogs.find((value) => value.identity === identity);
			const next = {
				...catalog,
				...(catalog.names === undefined && previous?.names ? { names: previous.names } : {}),
				identity,
			};
			if (isDeepStrictEqual(catalogs[0], next)) return { result: undefined };
			return {
				result: undefined,
				next: `${JSON.stringify(
					{
						version: 2,
						servers: {
							...servers,
							[entry.name]: [next, ...catalogs.filter((value) => value.identity !== identity)].slice(
								0,
								MAX_CATALOG_IDENTITIES,
							),
						},
					},
					null,
					2,
				)}\n`,
			};
		});
	}
}
