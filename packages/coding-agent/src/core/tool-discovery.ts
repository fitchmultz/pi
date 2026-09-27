import { isDeepStrictEqual } from "node:util";
import {
	type AnthropicMessagesCompat,
	type Api,
	type Model,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	type ToolReference,
	type ToolSelection,
	toolId,
	toolKey,
	toToolReference,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ToolDefinition, ToolDiscoveryGroup } from "./extensions/types.ts";

const discoverySchema = Type.Object(
	{
		group: Type.Object(
			{
				name: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
				description: Type.String({ minLength: 1, maxLength: 240 }),
				sections: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }), { uniqueItems: true })),
			},
			{ additionalProperties: false },
		),
		role: Type.Union([Type.Literal("entry"), Type.Literal("advanced")]),
	},
	{ additionalProperties: false },
);

export interface AvailableDiscoveryGroup extends ToolDiscoveryGroup {
	tools: ToolReference[];
	defaultTools: ToolReference[];
}
export const DISCOVER_TOOLS_NAME = "discover_tools";
const reservedSections = new Set([
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"project_context",
	"skills",
	"cwd",
]);

/** Only native transports with both tail-loaded tools and prompt additions can defer integrations. */
export function supportsToolDiscovery(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	switch (model.api) {
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses": {
			const compat = model.compat as OpenAIResponsesCompat | undefined;
			return (
				compat?.supportsMidConvoSystemMessages === true &&
				(compat.supportsAdditionalTools === true || compat.supportsToolSearch === true)
			);
		}
		case "anthropic-messages": {
			const compat = model.compat as AnthropicMessagesCompat | undefined;
			return compat?.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolChanges === true;
		}
		case "openai-completions": {
			const compat = model.compat as OpenAICompletionsCompat | undefined;
			return compat?.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true;
		}
		default:
			return false;
	}
}

/** Derive membership from final permitted definitions, never from a separate tool inventory. */
export function availableDiscoveryGroups(definitions: readonly ToolDefinition[]): AvailableDiscoveryGroup[] {
	const groups = new Map<string, AvailableDiscoveryGroup>();
	for (const definition of definitions) {
		const discovery = definition.discovery;
		if (discovery === undefined) continue;
		if (!Check(discoverySchema, discovery)) throw new Error(`Invalid discovery metadata for ${toolId(definition)}`);
		if (toolKey(definition) === toolKey(DISCOVER_TOOLS_NAME))
			throw new Error("The discovery tool cannot defer itself");
		const descriptor = discovery.group;
		const sections = [...(descriptor.sections ?? [])].sort();
		for (const section of sections) {
			if (reservedSections.has(section)) throw new Error(`Cannot defer core prompt section: ${section}`);
		}
		let group = groups.get(descriptor.name);
		if (group && (group.description !== descriptor.description || !isDeepStrictEqual(group.sections, sections)))
			throw new Error(`Conflicting tool discovery group: ${descriptor.name}`);
		if (!group) {
			group = { ...descriptor, sections, tools: [], defaultTools: [] };
			groups.set(group.name, group);
		}
		group.tools.push(toToolReference(definition));
		if (discovery.role === "entry") group.defaultTools.push(toToolReference(definition));
	}
	// An excluded/missing entry must not strand the remaining tools behind an unusable group.
	return [...groups.values()].filter((group) => group.defaultTools.length > 0);
}

/** Shared sections stay visible when any owning tool is active. Original text is never summarized. */
export function discoverySectionTools(groups: readonly AvailableDiscoveryGroup[]): Record<string, ToolSelection[]> {
	const sections = new Map<string, ToolSelection[]>();
	for (const group of groups) {
		for (const section of group.sections ?? []) {
			sections.set(section, [...(sections.get(section) ?? []), ...group.tools]);
		}
	}
	return Object.fromEntries(sections);
}

const discoveryParams = Type.Object(
	{ enable: Type.Optional(Type.Array(Type.String(), { minItems: 1, uniqueItems: true })) },
	{ additionalProperties: false },
);

export function createDiscoverToolsDefinition(options: {
	groups: readonly AvailableDiscoveryGroup[];
	getGroups: () => readonly AvailableDiscoveryGroup[];
	getActive: () => ToolReference[];
	setActive: (tools: ToolReference[]) => void;
}): ToolDefinition<typeof discoveryParams> {
	return {
		name: DISCOVER_TOOLS_NAME,
		label: "Discover Tools",
		description: [
			"Enable optional integrations by group name before using them. Omit enable to list. Full tools and instructions appear on the next request; enabling executes no integration action. Available groups:",
			...options.groups.map((group) => `${group.name}: ${group.description}`),
		].join("\n"),
		promptSnippet:
			"Discover optional capabilities before substituting a less suitable tool or declaring them unavailable",
		parameters: discoveryParams,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			signal?.throwIfAborted();
			const groups = options.getGroups();
			const selected = (params.enable ?? []).map((name) => {
				const group = groups.find((candidate) => candidate.name === name);
				if (!group)
					throw new Error(
						`Unavailable integration group: ${name}. Available: ${groups.map((item) => item.name).join(", ") || "none"}`,
					);
				return group;
			});
			// Validate the entire request before changing selection. Activation is additive and idempotent.
			if (selected.length) {
				options.setActive([
					...options.getActive(),
					...selected.flatMap((group) => group.defaultTools.map(toToolReference)),
				]);
			}
			const active = new Set(options.getActive().map(toolKey));
			const inventory = (selected.length ? selected : groups).map((group) => ({
				name: group.name,
				description: group.description,
				activeTools: group.tools
					.filter((tool) => active.has(toolKey(tool)))
					.map((tool) => toolId(toToolReference(tool))),
			}));
			return {
				content: [
					{
						type: "text",
						text: inventory
							.map(
								(group) =>
									`${group.name}: ${group.description}\nActive: ${group.activeTools.join(", ") || "none; enable this group to load its tools"}`,
							)
							.join("\n\n"),
					},
				],
				details: { groups: inventory },
			};
		},
	};
}
