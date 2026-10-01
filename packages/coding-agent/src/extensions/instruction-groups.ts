import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { SessionMetadataCursor } from "../core/session-metadata-cursor.ts";

export interface InstructionGroup {
	name: string;
	description: string;
	tools: string[];
	instructions(ctx: ExtensionContext): string;
}

/** Owners subscribe during factory registration and call register synchronously. */
export interface InstructionGroupCollector {
	register(group: InstructionGroup): void;
	isManaged(): boolean;
}

const stateType = "pi:instruction-groups";
const repairType = "pi:instruction-groups:compaction";

export default function instructionGroups(pi: ExtensionAPI): void {
	const groups = new Map<string, InstructionGroup>();
	let enabled = new Set<string>();
	let permitted = new Set<string>();
	let ready = new Set<string>();
	const isManaged = () => pi.getActiveTools().includes("discover_tools");
	const available = () =>
		[...groups.values()]
			.filter((group) => group.tools.some((name) => permitted.has(name)))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const section = (group: InstructionGroup, ctx: ExtensionContext) => {
		const text = group.instructions(ctx);
		if (!text.trim()) throw new Error(`Instruction group ${group.name} returned empty instructions`);
		return `## ${group.name}\n\n${text}`;
	};
	const cursor = new SessionMetadataCursor();
	const names = new Set<string>();
	let atBoundary = new Set<string>();
	const replay = (ctx: ExtensionContext) => {
		const { entries, reset } = cursor.read(ctx.sessionManager, true);
		if (reset) {
			names.clear();
			atBoundary.clear();
		}
		for (const metadata of entries) {
			if (metadata.type === "compaction") atBoundary = new Set(names);
			if (metadata.type !== "custom" || metadata.customType !== stateType) continue;
			const entry = ctx.sessionManager.getEntry(metadata.id);
			if (entry?.type !== "custom" || !Array.isArray(entry.data)) continue;
			for (const name of entry.data) if (typeof name === "string") names.add(name);
		}
		return new Set(names);
	};
	const restore = (ctx: ExtensionContext) => {
		ready.clear();
		enabled = replay(ctx);
		pi.setActiveTools(pi.getActiveTools());
	};

	pi.registerTool({
		name: "discover_tools",
		label: "Discover instructions",
		description:
			"List available instruction groups, or enable groups to read their FULL instructions. Enabling never activates tools. Read the result before calling a group's tools in a later turn.",
		exposure: "model-only",
		parameters: Type.Object({ enable: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })) }),
		prepareLoadout(loadout) {
			permitted = new Set([...loadout.declared, ...loadout.callable].map((tool) => tool.name));
			return {
				hiddenDeclarations: available()
					.filter((group) => !enabled.has(group.name))
					.flatMap((group) => group.tools),
			};
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const candidates = available();
			const requested = new Set(params.enable ?? []);
			for (const name of requested) {
				if (!candidates.some((group) => group.name === name))
					throw new Error(`Unavailable instruction group: ${name}`);
			}
			const selected = candidates.filter((group) => requested.has(group.name));
			const text = selected.map((group) => section(group, ctx)).join("\n\n");
			if (selected.length) {
				pi.appendEntry(
					stateType,
					selected.map((group) => group.name),
				);
				for (const group of selected) enabled.add(group.name);
				pi.setActiveTools(pi.getActiveTools());
			}
			return {
				content: [
					{
						type: "text",
						text:
							text ||
							candidates.map((group) => `${group.name}: ${group.description}`).join("\n") ||
							"No instruction groups available.",
					},
				],
				details: undefined,
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		groups.clear();
		let collecting = true;
		pi.events.emit(stateType, {
			register(group: InstructionGroup) {
				if (!collecting) throw new Error("Instruction groups must register synchronously");
				if (
					!group.name?.trim() ||
					!group.description?.trim() ||
					!Array.isArray(group.tools) ||
					!group.tools.length ||
					group.tools.some((name) => typeof name !== "string" || !name.trim() || name === "discover_tools") ||
					typeof group.instructions !== "function" ||
					groups.has(group.name)
				) {
					throw new Error("Invalid or duplicate instruction group");
				}
				groups.set(group.name, { ...group, tools: [...group.tools] });
			},
			isManaged,
		} satisfies InstructionGroupCollector);
		collecting = false;
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("turn_start", () => {
		ready.clear();
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (!isManaged()) return;
		const text = available()
			.filter((group) => enabled.has(group.name))
			.map((group) => section(group, ctx))
			.join("\n\n");
		if (text) event.systemPromptOptions.appendSystemPrompt += `\n\n${text}`;
	});
	pi.on("context_with_system", (event, ctx) => {
		ready.clear();
		if (!isManaged()) return;
		let messages = event.messages;
		replay(ctx);
		const boundaryId = ctx.sessionManager.getBranchState().contextStartId;
		const boundary = boundaryId ? ctx.sessionManager.getEntryMetadata(boundaryId) : undefined;
		const summaryIndex = messages.findLastIndex((message) => message.role === "compactionSummary");
		if (boundary?.type === "compaction" && summaryIndex >= 0) {
			const text = available()
				.filter((group) => atBoundary.has(group.name))
				.map((group) => section(group, ctx))
				.join("\n\n");
			if (text) {
				messages = [...messages];
				messages.splice(summaryIndex + 1, 0, {
					role: "custom",
					customType: repairType,
					content: text,
					display: false,
					timestamp: Date.parse(boundary.timestamp),
				});
			}
		}
		const instructionText = [
			getCurrentSystemPrompt(messages),
			...messages.flatMap((message) => {
				if (
					!(message.role === "toolResult" && message.toolName === "discover_tools" && !message.isError) &&
					!(message.role === "custom" && message.customType === repairType)
				)
					return [];
				return [
					typeof message.content === "string"
						? message.content
						: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
				];
			}),
		].join("\n");
		const nextReady = new Set<string>();
		for (const group of available()) {
			if (enabled.has(group.name) && instructionText.includes(section(group, ctx))) nextReady.add(group.name);
		}
		ready = nextReady;
		return { messages };
	});
	pi.on("tool_call", (event) => {
		if (!isManaged()) return;
		const missing = available().filter((group) => group.tools.includes(event.toolName) && !ready.has(group.name));
		if (missing.length)
			return {
				block: true,
				reason: `Read discover_tools instructions for ${missing.map((group) => group.name).join(", ")} in a prior turn before using this tool.`,
			};
	});
}
