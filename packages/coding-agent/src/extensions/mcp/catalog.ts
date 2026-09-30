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
		return isRecord(parsed) && parsed.version === 1 && isRecord(parsed.servers) ? parsed.servers : {};
	} catch {
		return {};
	}
}

/** Only environment substitution is safe at cache-only startup. Command-backed secrets stay opaque. */
function environment(values: Record<string, string> | undefined): Record<string, string | undefined> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(
		Object.entries(values)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, value]) => [name, resolveConfigValue(value)]),
	);
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
								: resolveConfigValue(config.oauth.clientSecret),
					},
				}
			: {
					command: config.command,
					args: config.args,
					env: Object.fromEntries(
						Object.entries({ ...process.env, ...environment(config.env) }).sort(([a], [b]) => a.localeCompare(b)),
					),
					cwd: resolve(cwd, config.cwd?.replace(/^~(?=\/|$)/, homedir()) ?? "."),
				};
	return createHash("sha256")
		.update(JSON.stringify({ profile: entry.name, cwd: resolve(cwd), transport, credentialIdentity }))
		.digest("hex");
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
			const catalog = Object.hasOwn(servers, entry.name) ? servers[entry.name] : undefined;
			return {
				result: validCatalog(catalog) && catalog.identity === identity ? structuredClone(catalog) : undefined,
			};
		});
	}

	save(entry: McpServerEntry, cwd: string, credentialIdentity: string, catalog: McpServerCatalog): void {
		const identity = mcpCatalogIdentity(entry, cwd, credentialIdentity);
		if (!identity) return;
		this.backend.withLock((content) => {
			const servers = parseCatalogs(content);
			const next = { ...catalog, identity };
			if (isDeepStrictEqual(servers[entry.name], next)) return { result: undefined };
			return {
				result: undefined,
				next: `${JSON.stringify({ version: 1, servers: { ...servers, [entry.name]: next } }, null, 2)}\n`,
			};
		});
	}
}
