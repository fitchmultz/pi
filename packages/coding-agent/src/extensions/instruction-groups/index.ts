import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";

export interface InstructionGroup {
	name: string;
	description: string;
	tools: string[];
	instructions(ctx: ExtensionContext): string;
}

/** Owners subscribe during factory registration and register synchronously at session_start. */
export interface InstructionGroupCollector {
	register(group: InstructionGroup): void;
	isManaged(): boolean;
}

const stateType = "pi:instruction-groups";
const repairType = "pi:instruction-groups:compaction";

export default function instructionGroups(pi: ExtensionAPI): void {
	const groups = new Map<string, InstructionGroup>();
	const enabled = new Set<string>();
	const inactive = new Set<string>();
	const ready = new Set<string>();
	let permitted = new Set<string>();
	let processedLeaf: string | null = null;
	let boundary: { names: Set<string>; timestamp: number } | undefined;
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

	// Only startup/tree restore walks the whole branch. Requests consume newly appended entries.
	const replay = (ctx: ExtensionContext) => {
		const leaf = ctx.sessionManager.getLeafId();
		const pending: SessionEntry[] = [];
		let id = leaf;
		while (id && id !== processedLeaf) {
			const entry = ctx.sessionManager.getEntry(id);
			if (!entry) throw new Error(`Missing instruction state entry: ${id}`);
			pending.push(entry);
			id = entry.parentId;
		}
		for (const entry of pending.reverse()) {
			if (entry.type === "compaction") {
				boundary = { names: new Set(enabled), timestamp: Date.parse(entry.timestamp) };
			} else if (entry.type === "custom" && entry.customType === stateType) {
				const data = entry.data as { enabled?: unknown; inactive?: unknown } | null;
				if (Array.isArray(data?.enabled))
					for (const name of data.enabled) if (typeof name === "string") enabled.add(name);
				if (Array.isArray(data?.inactive)) {
					inactive.clear();
					for (const name of data.inactive) if (typeof name === "string") inactive.add(name);
				}
			}
		}
		processedLeaf = leaf;
	};
	const restore = (ctx: ExtensionContext) => {
		enabled.clear();
		inactive.clear();
		ready.clear();
		boundary = undefined;
		processedLeaf = null;
		replay(ctx);
		pi.setActiveTools(pi.getActiveTools());
	};

	pi.registerTool({
		name: "discover_tools",
		label: "Discover instructions",
		description:
			"List available instruction groups, or enable groups to read their FULL instructions and restore their previously selected tools for the next request. Read the result before calling a group's tools in a later turn.",
		exposure: "model-only",
		parameters: Type.Object({ enable: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })) }),
		prepareLoadout(loadout) {
			const registered = new Set(loadout.registered.map((tool) => tool.name));
			permitted = new Set([
				...loadout.declared.map((tool) => tool.name),
				...loadout.callable.map((tool) => tool.name),
				...[...inactive].filter((name) => registered.has(name)),
			]);
			return undefined;
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
				const restored = selected.flatMap((group) => group.tools.filter((name) => inactive.has(name)));
				for (const name of restored) inactive.delete(name);
				pi.appendEntry(stateType, { enabled: selected.map((group) => group.name), inactive: [...inactive] });
				replay(ctx);
				pi.setActiveTools([...pi.getActiveTools(), ...restored]);
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
				)
					throw new Error("Invalid or duplicate instruction group");
				groups.set(group.name, { ...group, tools: [...group.tools] });
			},
			isManaged,
		} satisfies InstructionGroupCollector);
		collecting = false;
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("turn_start", () => ready.clear());
	pi.on("before_agent_start", (event, ctx) => {
		// ponytail: prompt-start suppression only; use a loadout-selection hook if mid-batch suppression is needed.
		if (!isManaged()) return;
		replay(ctx);
		const pending = new Set(
			available()
				.filter((group) => !enabled.has(group.name))
				.flatMap((group) => group.tools),
		);
		const active = pi.getActiveTools();
		const deferred = active.filter((name) => pending.has(name));
		if (deferred.length) {
			for (const name of deferred) inactive.add(name);
			pi.appendEntry(stateType, { enabled: [], inactive: [...inactive] });
			replay(ctx);
			pi.setActiveTools(active.filter((name) => !pending.has(name)));
			event.systemPromptOptions.selectedTools = pi.getActiveTools();
		}
		const text = available()
			.filter((group) => enabled.has(group.name))
			.map((group) => section(group, ctx))
			.join("\n\n");
		if (text) event.systemPromptOptions.appendSystemPrompt += `\n\n${text}`;
	});
	pi.on("context_with_system", (event, ctx) => {
		ready.clear();
		if (!isManaged()) return;
		replay(ctx);
		let messages = event.messages;
		const summaryIndex = messages.findLastIndex((message) => message.role === "compactionSummary");
		if (boundary && summaryIndex >= 0) {
			const names = boundary.names;
			const text = available()
				.filter((group) => names.has(group.name))
				.map((group) => section(group, ctx))
				.join("\n\n");
			if (text) {
				messages = [...messages];
				messages.splice(summaryIndex + 1, 0, {
					role: "custom",
					customType: repairType,
					content: text,
					display: false,
					timestamp: boundary.timestamp,
				});
			}
		}
		const instructionText = messages
			.flatMap((message) => {
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
			})
			.join("\n");
		// 1.0 projects forced prompts after this event; both prompt views must retain the section.
		const transcriptPrompt = getCurrentSystemPrompt(messages);
		const effectivePrompt = ctx.getSystemPrompt();
		for (const group of available()) {
			if (!enabled.has(group.name)) continue;
			const text = section(group, ctx);
			if (instructionText.includes(text) || (transcriptPrompt.includes(text) && effectivePrompt.includes(text)))
				ready.add(group.name);
		}
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
