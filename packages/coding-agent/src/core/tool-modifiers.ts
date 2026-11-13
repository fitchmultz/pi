/** Tools enabled at startup when `defaultTools` does not change them. */
export const DEFAULT_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];

/** Whether a tool selection entry is a `+name` or `-name` modifier. */
export function isToolModifier(entry: unknown): boolean {
	return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}

/**
 * Validate a tool list from `--tools` or the SDK `tools` option. It is either an allowlist of plain
 * names and patterns or a list of only `+name`/`-name` entries with exact names. Returns the
 * problem, or undefined when the list is valid.
 */
export function getToolListError(entries: readonly string[]): string | undefined {
	const modifiers = entries.filter(isToolModifier);
	if (modifiers.length === 0) return undefined;
	if (modifiers.length < entries.length) return "tool names cannot be mixed with +name or -name entries";
	const pattern = modifiers.find((entry) => entry.includes("*"));
	if (pattern) return `+name and -name entries take exact tool names, not patterns: ${pattern}`;
	return undefined;
}

/**
 * Apply the `+name` and `-name` entries of `entries` to `base` in order: `+name` adds a tool and
 * `-name` removes one. Other entries are ignored.
 */
export function applyToolModifiers(base: readonly string[], entries: readonly string[]): string[] {
	const tools = [...base];
	for (const entry of entries) {
		if (!isToolModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}
