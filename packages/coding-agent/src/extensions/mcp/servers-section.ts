/** Compact server guidance, appended through Pi's native prompt-section projection. */
import type { McpExposure, McpServerEntry } from "./config.ts";

export const MCP_SERVERS_SECTION = "mcp_servers";
export const MAX_SERVERS_SECTION_CHARS = 4096;
const MAX_SERVER_DESCRIPTION_CHARS = 250;

export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string; catalogKnown?: boolean };
}

export function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	return new Set([entry.config.exposure ?? "codemode", ...Object.values(entry.config.toolExposure ?? {})]);
}

const INTRO =
	"MCP servers connect lazily unless configured eager. Global tool search uses cached metadata and reports undiscovered servers. Scope tool_search to a namespace to discover it, or use searchTools(query, { namespace }) and describeNamespace(name) in codemode. Use callTool(name, args) for a tool discovered in the same script. MCP calls return CallToolResult (content, structuredContent, isError); inspect isError. Read complete permitted results with read using their fullResultPath and json.path/json.fields. Interrupted calls may have run: inspect the server before repeating a write.";

export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter(({ entry, connection }) => {
			if (entry.config.enabled === false) return false;
			const exposures = configuredExposures(entry);
			return (
				exposures.has("codemode") ||
				exposures.has("codemode-deferred") ||
				exposures.has("deferred") ||
				(exposures.has("direct") && !connection?.catalogKnown)
			);
		})
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;
	const heads = listed.map(({ entry }) => {
		const exposures = configuredExposures(entry);
		const reach = exposures.has("codemode") || exposures.has("codemode-deferred") ? "codemode" : "tool_search";
		return `- mcp__${entry.name} (${reach})`;
	});
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more servers; list them with tools.mcp_discover({}) in codemode`] : [];
	const size = (kept: number) => [INTRO, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const text = (server.entry.config.description?.trim() || server.connection?.instructions || "")
			.split("\n", 1)[0]
			.trim();
		const summary =
			perServer <= 0 ? "" : text.length <= perServer ? text : `${text.slice(0, perServer - 1).trimEnd()}…`;
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [INTRO, ...lines, ...omitted(listed.length - kept)].join("\n");
}
