import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
const deliveryType = "pi:instruction-groups:instructions";
const instructionTypes = new Set([repairType, deliveryType]);

interface InstructionSpan {
	name: string;
	start: number;
	end: number;
}

interface InstructionSection {
	name: string;
	text: string;
}

function instructionAnchor(message: AgentMessage): { text: string; legacyText: string; details: unknown } | undefined {
	if (
		!(message.role === "toolResult" && message.toolName === "discover_tools" && !message.isError) &&
		!(message.role === "custom" && instructionTypes.has(message.customType))
	)
		return undefined;
	const parts =
		typeof message.content === "string"
			? [message.content]
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	return {
		text: parts.join("\n"),
		legacyText: parts[0] ?? "",
		details: message.details,
	};
}

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
	const sections = (selected: InstructionSection[]) => {
		const spans: InstructionSpan[] = [];
		let text = "";
		for (const entry of selected) {
			if (text) text += "\n\n";
			const start = text.length;
			text += entry.text;
			spans.push({ name: entry.name, start, end: text.length });
		}
		return { text, details: { instructionSections: spans } };
	};
	const latestSections = (messages: AgentMessage[]) => {
		const latest = new Map<string, string>();
		for (const message of messages) {
			const anchor = instructionAnchor(message);
			if (!anchor) continue;
			const spans = (anchor.details as { instructionSections?: unknown } | null)?.instructionSections;
			if (Array.isArray(spans)) {
				for (const span of spans as Partial<InstructionSpan>[])
					if (typeof span?.name === "string" && groups.has(span.name))
						latest.set(
							span.name,
							typeof span.start === "number" && typeof span.end === "number"
								? anchor.text.slice(span.start, span.end)
								: "",
						);
				continue;
			}
			// Older sessions stored all sections in the first text block without boundaries.
			const starts: { name: string; index: number }[] = [];
			for (const name of groups.keys()) {
				const heading = `## ${name}\n\n`;
				for (
					let index = anchor.legacyText.indexOf(heading);
					index >= 0;
					index = anchor.legacyText.indexOf(heading, index + 1)
				) {
					if (index === 0 || anchor.legacyText.slice(index - 2, index) === "\n\n") starts.push({ name, index });
				}
			}
			starts.sort((a, b) => a.index - b.index);
			for (let index = 0; index < starts.length; index++) {
				const start = starts[index];
				const end = starts[index + 1]?.index;
				latest.set(start.name, anchor.legacyText.slice(start.index, end === undefined ? undefined : end - 2));
			}
		}
		return latest;
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
		pi.refreshTools();
	};

	pi.registerTool({
		name: "discover_tools",
		label: "Discover instructions",
		description:
			"List available instruction groups, or enable groups to receive their FULL instructions and restore their previously selected tools for the next request. Read the full instructions before calling a group's tools in a later turn.",
		promptSnippet:
			"List available capabilities; enable instruction groups and read their full instructions before use",
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
			const { text, details } = sections(selected.map((group) => ({ name: group.name, text: section(group, ctx) })));
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
				details: selected.length ? details : undefined,
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
	// Script output can be discarded, truncated, or lost to a rejection, so nested enables deliver
	// the full instructions as their own message and hand the script a receipt.
	pi.on("tool_result", (event) => {
		const names = (event.input.enable as string[] | undefined) ?? [];
		if (event.toolName !== "discover_tools" || !event.parentToolCallId || event.isError || !names.length) return;
		pi.sendMessage(
			{ customType: deliveryType, content: event.content, display: false, details: event.details },
			{ triggerTurn: false },
		);
		return {
			content: [
				{
					type: "text",
					text: `Enabled ${names.join(", ")}. Full instructions arrive as a separate message before the next model request.`,
				},
			],
		};
	});
	pi.on("turn_start", () => ready.clear());
	pi.on("before_agent_start", (event, ctx) => {
		// ponytail: prompt-start suppression only; use a loadout-selection hook if mid-batch suppression is needed.
		if (!isManaged()) return;
		replay(ctx);
		const summaries = available().map((group) => `- ${group.name}: ${group.description}`);
		if (summaries.length)
			event.systemPromptOptions.sections.instruction_groups = [
				"Available instruction groups (capability summaries, not loaded tools):",
				"Before claiming a capability is unavailable, inspect or enable the relevant group with discover_tools. searchTools and MCP searches cover different catalogs. Read the full instructions before using the group's tools in a later turn.",
				...summaries,
			].join("\n");
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
		const selected = available().filter((group) => enabled.has(group.name));
		if (!selected.length) return;
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const latest = latestSections(messages);
		const compacted = messages.some((message) => message.role === "compactionSummary");
		const current = selected.map((group) => ({ name: group.name, text: section(group, ctx) }));
		const missing = current.filter((entry) => {
			const last = latest.get(entry.name);
			if (last === entry.text) return false;
			// A missing pre-compaction anchor is restored at the summary, not appended here.
			return !(last === undefined && compacted && boundary?.names.has(entry.name));
		});
		if (missing.length) {
			const { text, details } = sections(missing);
			return { message: { customType: deliveryType, content: text, details, display: false } };
		}
	});
	pi.on("context_with_system", (event, ctx) => {
		ready.clear();
		if (!isManaged()) return;
		replay(ctx);
		const selected = available().filter((group) => enabled.has(group.name));
		if (!selected.length) return;
		let messages = event.messages;
		const latest = latestSections(messages);
		const current = selected.map((group) => ({ name: group.name, text: section(group, ctx) }));
		const summaryIndex = messages.findLastIndex((message) => message.role === "compactionSummary");
		if (boundary && summaryIndex >= 0) {
			const missing = current.filter((entry) => boundary?.names.has(entry.name) && !latest.has(entry.name));
			if (missing.length) {
				const { text, details } = sections(missing);
				messages = [...messages];
				messages.splice(summaryIndex + 1, 0, {
					role: "custom",
					customType: repairType,
					content: text,
					details,
					display: false,
					timestamp: boundary.timestamp,
				});
				for (const entry of missing) latest.set(entry.name, entry.text);
			}
		}
		for (const entry of current) {
			if (latest.get(entry.name) === entry.text) ready.add(entry.name);
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
