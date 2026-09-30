/** One-time branch migration. Raw selections wait for the owner's actual native name assignment. */
import type { SessionEntry } from "../../core/session-manager.ts";

export const MCP_SELECTION_MIGRATION = "mcp-native-selection";

interface Selection {
	server: string;
	tool: string;
}

type Feature = "gateway" | "script";

export interface McpSelectionMigration {
	sourceId: string;
	pending: Selection[];
	inactive: Selection[];
	features: Feature[];
	inactiveFeatures: Feature[];
}

function selections(value: unknown): Selection[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item: unknown) =>
		item !== null &&
		typeof item === "object" &&
		"server" in item &&
		typeof item.server === "string" &&
		"tool" in item &&
		typeof item.tool === "string"
			? [{ server: item.server, tool: item.tool }]
			: [],
	);
}

function features(value: unknown): Feature[] {
	return Array.isArray(value) ? value.filter((item): item is Feature => item === "gateway" || item === "script") : [];
}

export function readMcpSelectionMigration(branch: SessionEntry[]): McpSelectionMigration | undefined {
	const source = branch.findLast((entry) => entry.type === "custom" && entry.customType === "mcp-tool-selection");
	if (source?.type !== "custom" || !source.data || typeof source.data !== "object") return undefined;
	let data = source.data;
	const saved = branch.findLast((entry) => entry.type === "custom" && entry.customType === MCP_SELECTION_MIGRATION);
	if (
		saved?.type === "custom" &&
		saved.data !== null &&
		typeof saved.data === "object" &&
		"sourceId" in saved.data &&
		saved.data.sourceId === source.id
	)
		data = saved.data;
	return {
		sourceId: source.id,
		pending: selections("pending" in data ? data.pending : "selected" in data ? data.selected : undefined),
		inactive: selections("inactive" in data ? data.inactive : undefined),
		features: features("features" in data ? data.features : undefined),
		inactiveFeatures: features("inactiveFeatures" in data ? data.inactiveFeatures : undefined),
	};
}
