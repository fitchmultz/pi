import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Message, Tool } from "../src/types.ts";
import { findTool, toolKey } from "../src/utils/tool-identity.ts";
import {
	getCurrentSystemMessage,
	getCurrentTools,
	getDeclaredTools,
	getToolStateChanges,
	hasNonAdditiveToolChanges,
	toToolDeclaration,
	withoutToolSearchState,
} from "../src/utils/transcript.ts";
import { validateToolCall } from "../src/utils/validation.ts";

const left: Tool = { namespace: "left", name: "lookup", description: "Left", parameters: Type.Object({}) };
const right: Tool = { ...left, namespace: "right", description: "Right" };

it("resolves the exact namespace rather than the first same-name tool", () => {
	expect(findTool([left, right], right)).toBe(right);
	expect(findTool([left, right], { name: "lookup" })).toBeUndefined();
	expect(() => validateToolCall([left], { type: "toolCall", id: "call", ...right, arguments: {} })).toThrow(
		"not found",
	);
	expect(toolKey({ namespace: "a.b", name: "c" })).not.toBe(toolKey({ namespace: "a", name: "b.c" }));
});

describe("namespaced declaration replay", () => {
	const messages: Message[] = [
		{ role: "system", content: "", toolsAdded: [left], timestamp: 0 },
		{
			role: "toolResult",
			toolCallId: "search",
			toolName: "discover",
			toolCallKind: "toolSearch",
			toolsAdded: [right],
			content: [],
			isError: false,
			timestamp: 1,
		},
	];

	it("preserves both leaves and does not redeclare native search results", () => {
		expect(getCurrentTools(messages)).toEqual([left, right]);
		expect(getDeclaredTools(messages)).toEqual([left, right]);
		expect(getToolStateChanges(getCurrentTools(messages), [left, right])).toEqual({
			toolsAdded: [],
			toolsRemoved: [],
		});
		expect(getToolStateChanges([left, right], [right]).toolsRemoved).toEqual([{ name: "lookup", namespace: "left" }]);
	});

	it("allows identical repeated search results but detects changed declarations", () => {
		expect(hasNonAdditiveToolChanges([...messages, messages[1]])).toBe(false);
		const repeated = { ...messages[1], toolsAdded: [{ ...right, description: "Changed" }] } as Message;
		expect(hasNonAdditiveToolChanges([...messages, repeated])).toBe(true);
	});

	it("does not resurrect a removed search match behind a full-state checkpoint", () => {
		const removed: Message[] = [...messages, { role: "system", content: "", toolsRemoved: [right], timestamp: 2 }];
		const checkpoint = getCurrentSystemMessage(removed)!;
		const retained = removed.filter((message) => message.role !== "system");
		// Retained search results are history, not new declarations after this checkpoint.
		expect(getCurrentTools([checkpoint, ...withoutToolSearchState(retained)])).toEqual([left]);
		expect(messages[1]).toMatchObject({ toolsAdded: [right], toolCallKind: "toolSearch" });
	});

	it("snapshots grammar declarations independently of mutable registrations", () => {
		const registered: Tool = {
			...right,
			constrainedSampling: { type: "grammar", variants: { openai_regex: "[a-z]+" } },
		};
		const declaration = toToolDeclaration(registered);
		if (registered.constrainedSampling && registered.constrainedSampling.type === "grammar")
			registered.constrainedSampling.variants.openai_regex = "[0-9]+";
		expect(declaration.constrainedSampling).toEqual({ type: "grammar", variants: { openai_regex: "[a-z]+" } });
	});

	it("persists declarations without executable or display fields", () => {
		const declaration = toToolDeclaration({ ...right, execute() {}, label: "UI" } as Tool);
		expect(JSON.parse(JSON.stringify(declaration))).toEqual(right);
	});
});
