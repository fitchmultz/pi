import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionToolContext, ToolInfo } from "../../core/extensions/types.ts";

export const MCP_DISCOVERY_TOOL_NAME = "mcp_discover";
export const mcpDiscoverySchema = Type.Object({ server: Type.Optional(Type.String()) });

export const mcpDiscoveryOutputSchema = Type.Object({
	servers: Type.Array(
		Type.Object({
			name: Type.String(),
			namespace: Type.String(),
			state: Type.String(),
			catalog: Type.Boolean(),
			description: Type.Optional(Type.String()),
		}),
	),
	complete: Type.Boolean(),
	undiscovered: Type.Array(Type.String()),
});

export type McpDiscoveryReport = Static<typeof mcpDiscoveryOutputSchema>;

/** Identify the native tool, not an unrelated extension using the same name. */
export function isMcpDiscoveryTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === MCP_DISCOVERY_TOOL_NAME && tool.parameters === mcpDiscoverySchema;
}

/**
 * Without a scope, read cached coverage only. A scope connects just that server.
 * Results after permission/redaction hooks are authoritative; never recover data from details.
 */
export async function discoverMcpTools(
	ctx: ExtensionToolContext | undefined,
	server?: string,
	signal?: AbortSignal,
): Promise<McpDiscoveryReport | undefined> {
	if (!ctx?.tools.some(isMcpDiscoveryTool)) return undefined;
	const outcome = await ctx.executeTool(MCP_DISCOVERY_TOOL_NAME, server === undefined ? {} : { server }, { signal });
	const text = outcome.result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (outcome.isError) throw new Error(text || "MCP discovery failed");
	if (!Check(mcpDiscoveryOutputSchema, outcome.result.structuredContent)) {
		throw new Error(text || "MCP discovery did not return catalog coverage");
	}
	return outcome.result.structuredContent;
}

/** Canonical names win; raw and normalized namespace/server aliases must be unambiguous. */
export function resolveToolNamespace(names: readonly string[], query: string): string | undefined {
	const unique = [...new Set(names)];
	if (unique.includes(query)) return query;
	const matches = unique.filter((name) => {
		const suffix = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
		const server = name.startsWith("mcp__") ? name.slice("mcp__".length) : suffix;
		return [
			toCodemodeIdentifier(name),
			server,
			toCodemodeIdentifier(server),
			suffix,
			toCodemodeIdentifier(suffix),
		].includes(query);
	});
	if (matches.length > 1) throw new Error(`Ambiguous namespace "${query}": ${matches.join(", ")}`);
	return matches[0];
}

export function formatMcpDiscoveryCoverage(report: McpDiscoveryReport): string {
	return `Global search used a partial cached catalog. Undiscovered servers: ${report.undiscovered.join(", ") || "unknown"}. Use a namespace/server-scoped search to discover one.`;
}

/** Explicit script references, excluding search strings, comments, regexes and inventory filters. */
export function literalToolReferences(code: string): string[] {
	// ponytail: this is a conservative literal scan, not a JavaScript parser. For aliases, computed
	// names or calls inside template interpolation, use scoped discovery followed by callTool().
	const tokens =
		code
			.match(
				/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\/(?:\\.|[^/\\\r\n])+\/[dgimsuvy]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\?\.|\S/g,
			)
			?.filter((token) => !token.startsWith("//") && !token.startsWith("/*")) ?? [];
	const names: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index - 1] === "." || tokens[index - 1] === "?.") continue;
		const token = tokens[index];
		const next = tokens[index + 1];
		if (token === "tools" && (next === "." || next === "?.")) {
			if (/^[A-Za-z_$][\w$]*$/.test(tokens[index + 2] ?? "")) names.push(tokens[index + 2]);
		} else if ((token === "tools" && next === "[") || (token === "callTool" && next === "(")) {
			const literal = tokens[index + 2] ?? "";
			if (/^["'`][A-Za-z0-9_$-]+["'`]$/.test(literal)) names.push(literal.slice(1, -1));
		}
	}
	return names;
}
