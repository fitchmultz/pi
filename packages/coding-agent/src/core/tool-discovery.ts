import { type ToolReference, type ToolSelection, toolId, toolKey, toToolReference } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ToolDefinition } from "./extensions/types.ts";

const referenceSchema = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Object(
		{ name: Type.String({ minLength: 1 }), namespace: Type.Optional(Type.String({ minLength: 1 })) },
		{ additionalProperties: false },
	),
]);
const settingsSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		providers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		groups: Type.Optional(
			Type.Array(
				Type.Object(
					{
						name: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
						description: Type.String({ minLength: 1, maxLength: 240 }),
						tools: Type.Array(referenceSchema, { minItems: 1 }),
						defaultTools: Type.Optional(Type.Array(referenceSchema, { minItems: 1 })),
						sections: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }))),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 32 },
			),
		),
	},
	{ additionalProperties: false },
);

/** An explicit, opt-in catalog. Unlisted tools and extension lifecycle hooks are unchanged. */
export type ToolDiscoverySettings = Static<typeof settingsSchema>;
export type ToolDiscoveryGroup = NonNullable<ToolDiscoverySettings["groups"]>[number];
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

export function validateToolDiscoverySettings(value: unknown): ToolDiscoverySettings {
	if (value === undefined) return {};
	if (!Check(settingsSchema, value)) throw new Error("Invalid toolDiscovery settings. See docs/tool-discovery.md.");
	if (value.enabled && !value.providers?.length)
		throw new Error("toolDiscovery.providers must list the provider IDs evaluated for discovery");
	const names = new Set<string>();
	const tools = new Set<string>();
	for (const group of value.groups ?? []) {
		if (names.has(group.name)) throw new Error(`Duplicate tool discovery group: ${group.name}`);
		names.add(group.name);
		const members = new Set(group.tools.map(toolKey));
		for (const tool of group.tools) {
			const key = toolKey(tool);
			if (tools.has(key))
				throw new Error(`Tool belongs to multiple discovery groups: ${toolId(toToolReference(tool))}`);
			if (key === toolKey(DISCOVER_TOOLS_NAME)) throw new Error("The discovery tool cannot defer itself");
			tools.add(key);
		}
		for (const tool of group.defaultTools ?? []) {
			if (!members.has(toolKey(tool)))
				throw new Error(`Default tool is not a member of ${group.name}: ${toolId(toToolReference(tool))}`);
		}
		for (const section of group.sections ?? []) {
			if (reservedSections.has(section)) throw new Error(`Cannot defer core prompt section: ${section}`);
		}
	}
	return structuredClone(value);
}

/** Filter the catalog through the actual permitted registry, never through a guessed tool name. */
export function availableDiscoveryGroups(
	settings: ToolDiscoverySettings,
	available: readonly ToolReference[],
): ToolDiscoveryGroup[] {
	const keys = new Set(available.map(toolKey));
	return (settings.groups ?? []).flatMap((group) => {
		const tools = group.tools.filter((tool) => keys.has(toolKey(tool)));
		const defaultTools = (group.defaultTools ?? group.tools).filter((tool) => keys.has(toolKey(tool)));
		return tools.length && defaultTools.length ? [{ ...group, tools, defaultTools }] : [];
	});
}

/** Shared sections stay visible when any owning tool is active. Original text is never summarized. */
export function discoverySectionTools(groups: readonly ToolDiscoveryGroup[]): Record<string, ToolSelection[]> {
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
	groups: readonly ToolDiscoveryGroup[];
	getGroups: () => readonly ToolDiscoveryGroup[];
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
					...selected.flatMap((group) => (group.defaultTools ?? group.tools).map(toToolReference)),
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
