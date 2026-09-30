/**
 * MCP server configuration.
 *
 * Servers are read from `~/.config/mcp/mcp.json`, Pi's global `mcp.json`, and trusted project
 * `<project>/.pi/mcp.json`, in that precedence order. Each source replaces whole entries with
 * the same name; management writes only to Pi-owned files.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` or `codemode-deferred` exposure is configured. Higher-precedence sources override it.
 */

import { randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { type McpExposure, type McpServerConfig, validateMcpServerConfig } from "../../core/mcp-servers.ts";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	source: string;
	/**
	 * The shared, global or project `mcp.json`, or `extension` for servers registered with
	 * `pi.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	scope?: "shared" | "global" | "project" | "extension";
	/** Pi-owned destination for edits. Shared entries are copied here as whole entries. */
	writableSource?: string;
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	/** Read-only shared source to protect when saving Pi-owned overrides. */
	sharedConfigPath?: string;
	/** Activate codemode for configured `codemode` or `codemode-deferred` servers. Default: true. */
	autoEnableCodemode?: boolean;
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	autoEnableCodemode?: boolean;
	errors: string[];
}

function readConfigFile(
	path: string,
	scope: "shared" | "global" | "project",
	writableSource: string,
	state: McpConfigState,
): void {
	const { servers, errors } = state;
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		servers.set(name, { name, config, source: path, scope, writableSource });
	}
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	sharedConfigPath?: string;
}): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	const global = join(options.agentDir, "mcp.json");
	const sharedConfigPath = options.sharedConfigPath ?? join(homedir(), ".config", "mcp", "mcp.json");
	readConfigFile(sharedConfigPath, "shared", global, state);
	readConfigFile(global, "global", global, state);
	if (options.projectTrusted) {
		const project = join(options.cwd, CONFIG_DIR_NAME, "mcp.json");
		readConfigFile(project, "project", project, state);
	}
	return {
		servers: [...state.servers.values()],
		sharedConfigPath,
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
	};
}

/** Settings `/mcp` changes. `enabled: true` and `exposure: "codemode"` are the defaults and remove the key. */
export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
	connection?: "lazy" | "eager";
}

/**
 * Change one entry in its Pi-owned destination. Inherited shared entries are copied whole.
 * Other content and indentation are preserved.
 */
export function updateMcpServerConfig(
	entry: McpServerEntry,
	patch: McpServerConfigPatch,
	sharedConfigPath: string | undefined = entry.scope === "shared" ? entry.source : undefined,
): void {
	if (entry.scope === "extension") throw new Error("Extension MCP settings are runtime-local");
	const path = entry.writableSource ?? (entry.scope === "shared" ? undefined : entry.source);
	if (!path) throw new Error("MCP entry has no Pi-owned writable destination");
	editMcpServers(path, sharedConfigPath, (servers, parsed) => {
		const existing = Object.hasOwn(servers, entry.name) ? servers[entry.name] : undefined;
		const server = structuredClone(isRecord(existing) ? existing : entry.config) as Record<string, unknown>;
		if (patch.enabled !== undefined) {
			if (patch.enabled) delete server.enabled;
			else server.enabled = false;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === "codemode") delete server.exposure;
			else server.exposure = patch.exposure;
		}
		if (patch.connection !== undefined) {
			if (patch.connection === "lazy") delete server.connection;
			else server.connection = patch.connection;
		}
		const validated = validateMcpServerConfig(entry.name, server);
		if (typeof validated === "string") throw new Error(validated);
		parsed.mcpServers = { ...servers, [entry.name]: server };
		return true;
	});
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced. Returns true when an entry was replaced.
 */
export function addMcpServerConfig(
	path: string,
	name: string,
	config: McpServerConfig,
	sharedConfigPath?: string,
): boolean {
	let replaced = false;
	editMcpServers(path, sharedConfigPath, (servers, parsed) => {
		replaced = Object.hasOwn(servers, name);
		parsed.mcpServers = { ...servers, [name]: config };
		return true;
	});
	return replaced;
}

/** Explicit import only: copy missing whole entries; reject all writes if a destination already exists. */
export function copyMcpServerConfigs(path: string, entries: McpServerEntry[], sharedConfigPath?: string): void {
	if (entries.length === 0) return;
	editMcpServers(path, sharedConfigPath, (servers, parsed) => {
		for (const entry of entries) {
			if (Object.hasOwn(servers, entry.name))
				throw new Error(`MCP server "${entry.name}" already exists in ${path}`);
		}
		parsed.mcpServers = { ...servers, ...Object.fromEntries(entries.map((entry) => [entry.name, entry.config])) };
		return true;
	});
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
	for (const entry of entries) {
		if (JSON.stringify(parsed.mcpServers[entry.name]) !== JSON.stringify(entry.config)) {
			throw new Error(`MCP config import verification failed for "${entry.name}"`);
		}
	}
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServerConfig(path: string, name: string, sharedConfigPath?: string): boolean {
	if (!lstatSync(path, { throwIfNoEntry: false })) return false;
	let removed = false;
	editMcpServers(path, sharedConfigPath, (servers) => {
		if (!Object.hasOwn(servers, name)) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

/** Resolve and validate a Pi-owned destination without creating files (also used by import preflight). */
export function resolveMcpConfigWriteTarget(
	path: string,
	sharedConfigPath = join(homedir(), ".config", "mcp", "mcp.json"),
): string {
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (entry && !entry.isFile() && !entry.isSymbolicLink()) throw new Error(`${path}: expected a regular file`);
	const target = entry
		? realpathSync(path)
		: existsSync(dirname(path))
			? join(realpathSync(dirname(path)), basename(path))
			: resolve(path);
	const sharedTarget = existsSync(sharedConfigPath)
		? realpathSync(sharedConfigPath)
		: existsSync(dirname(sharedConfigPath))
			? join(realpathSync(dirname(sharedConfigPath)), basename(sharedConfigPath))
			: resolve(sharedConfigPath);
	if (resolve(path) === resolve(sharedConfigPath) || target === sharedTarget) {
		throw new Error(`${path}: Pi-owned config must not alias the read-only shared source ${sharedConfigPath}`);
	}
	const stat = lstatSync(target, { throwIfNoEntry: false });
	if (stat && !stat.isFile()) throw new Error(`${path}: expected a regular file`);
	if (stat) {
		if ((stat.mode & 0o222) === 0) throw new Error(`${path}: config target is not writable`);
		accessSync(target, constants.W_OK);
	}
	return target;
}

/** Read, edit and atomically publish under the canonical target lock. Other content and indentation are kept. */
function editMcpServers(
	path: string,
	sharedConfigPath: string | undefined,
	edit: (servers: Record<string, unknown>, parsed: Record<string, unknown>) => boolean,
): void {
	const resolved = resolveMcpConfigWriteTarget(path, sharedConfigPath);
	mkdirSync(dirname(resolved), { recursive: true });
	const target = resolveMcpConfigWriteTarget(resolved, sharedConfigPath);
	const release = lockfile.lockSync(target, { realpath: false });
	try {
		const stat = lstatSync(target, { throwIfNoEntry: false });
		if (stat && !stat.isFile()) throw new Error(`${path}: expected a regular file`);
		if (stat) {
			if ((stat.mode & 0o222) === 0) throw new Error(`${path}: config target is not writable`);
			accessSync(target, constants.W_OK);
		}
		const text = stat ? readFileSync(target, "utf8") : undefined;
		const parsed: unknown = text === undefined ? {} : JSON.parse(text);
		if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
			throw new Error(`${path}: expected an object with an "mcpServers" object`);
		}
		const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
		parsed.mcpServers = servers;
		if (!edit(servers, parsed)) return;
		const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
		const mode = stat ? stat.mode & 0o777 : 0o600;
		const stage = `${target}.${randomUUID()}.tmp`;
		try {
			writeFileSync(stage, `${JSON.stringify(parsed, null, indent)}\n`, {
				flag: "wx",
				mode,
			});
			chmodSync(stage, mode);
			renameSync(stage, target);
		} finally {
			rmSync(stage, { force: true });
		}
	} finally {
		release();
	}
}
