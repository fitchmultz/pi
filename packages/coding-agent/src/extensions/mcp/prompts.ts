/** Cached slash commands for MCP prompts; fetching a prompt connects only its current owner. */
import type { Prompt } from "@earendil-works/pi-mcp";
import { toLlmContent } from "@earendil-works/pi-mcp";
import type { ExtensionAPI, RegisteredCommand } from "../../core/extensions/types.ts";
import type { McpServerConnection } from "./runtime.ts";

function promptArguments(input: string, prompt: Prompt): Record<string, string> {
	const tokens: { value: string; equals: number }[] = [];
	let token = "";
	let equals = -1;
	let started = false;
	let quote = "";
	let escaped = false;
	for (const char of input) {
		if (escaped) {
			token += char;
			escaped = false;
		} else if (char === "\\" && quote !== "'") escaped = true;
		else if (quote) {
			if (char === quote) quote = "";
			else token += char;
		} else if (char === "'" || char === '"') quote = char;
		else if (/\s/.test(char)) {
			if (started) tokens.push({ value: token, equals });
			token = "";
			equals = -1;
			started = false;
			continue;
		} else {
			if (char === "=" && equals === -1) equals = token.length;
			token += char;
		}
		started = true;
	}
	if (quote || escaped) throw new Error("Unfinished quote or escape in prompt arguments");
	if (started) tokens.push({ value: token, equals });
	const args = new Map<string, string>();
	const positional: string[] = [];
	for (const { value, equals } of tokens) {
		if (equals > 0) args.set(value.slice(0, equals), value.slice(equals + 1));
		else positional.push(value);
	}
	let index = 0;
	for (const argument of prompt.arguments ?? []) {
		if (!args.has(argument.name) && positional[index] !== undefined) args.set(argument.name, positional[index++]);
		if (argument.required && !args.get(argument.name))
			throw new Error(`Missing required prompt argument "${argument.name}"`);
	}
	if (index < positional.length) throw new Error("Too many positional prompt arguments");
	return Object.fromEntries(args);
}

export function createMcpPromptCommand(
	pi: ExtensionAPI,
	server: string,
	cached: Prompt,
	getConnection: () => Promise<McpServerConnection>,
	getIdentity: () => string,
	identity: string,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	const { name } = cached;
	return {
		description: cached.description?.trim() || cached.title || `MCP prompt ${server}/${name}`,
		async handler(input, ctx) {
			try {
				const connection = await getConnection();
				if (getIdentity() !== identity || connection.bindingIdentity !== identity) {
					throw new Error(
						`MCP prompt "${server}/${name}" belongs to an old account; discover the current server first.`,
					);
				}
				await connection.getClient();
				const prompt = connection.prompts.find((prompt) => prompt.name === name);
				if (!prompt) throw new Error(`MCP prompt "${server}/${name}" is no longer offered.`);
				const result = await connection.getPrompt(
					name,
					promptArguments(input, prompt),
					{ signal: ctx.signal, timeoutMs: connection.timeoutMs },
					identity,
				);
				const content = result.messages.flatMap((message) => [
					...(result.messages.length > 1 || message.role !== "user"
						? [{ type: "text" as const, text: `[${message.role}]` }]
						: []),
					...toLlmContent({ content: [message.content] }),
				]);
				if (content.length === 0) throw new Error(`MCP prompt "${server}/${name}" returned no content.`);
				pi.sendUserMessage(content);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	};
}
