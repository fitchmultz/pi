import type { InlineExtension } from "../core/extensions/types.ts";
import backgroundCommandExtension from "./background-command/index.ts";
import codemodeExtension from "./codemode/index.ts";
import instructionGroupsExtension from "./instruction-groups/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import restartExtension from "./restart/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "restart", factory: restartExtension, builtin: true },
	{ name: "background-command", factory: backgroundCommandExtension, replaceable: true, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension registering the same tool, command, or flag takes over
	// instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "instruction-groups", factory: instructionGroupsExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
