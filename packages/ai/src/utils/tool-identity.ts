import type { ToolReference, ToolSelection } from "../types.ts";

/** Collision-free identity; dots and other separators are legal in either component. */
export function toolKey(tool: ToolSelection): string {
	return JSON.stringify(typeof tool === "string" ? [null, tool] : [tool.namespace ?? null, tool.name]);
}

/** Copy identity without schemas, execution, or display metadata. */
export function toToolReference(tool: ToolSelection): ToolReference {
	if (typeof tool === "string") return { name: tool };
	return { name: tool.name, ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }) };
}

/** Legacy public string ID. Registries must reject collisions with unnamespaced names. */
export function toolId(tool: ToolReference): string {
	return tool.namespace === undefined ? tool.name : toolKey(tool);
}

/** Resolve exact identity. An omitted namespace means the unnamespaced tool only. */
export function findTool<T extends ToolReference>(tools: readonly T[], reference: ToolReference): T | undefined {
	return tools.find((tool) => tool.name === reference.name && tool.namespace === reference.namespace);
}
