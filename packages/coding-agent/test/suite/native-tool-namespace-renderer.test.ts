import type { ToolReference } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

const lookup = (
	InteractiveMode.prototype as unknown as {
		getRegisteredToolDefinition(
			this: { session: { getToolDefinition(tool: ToolReference): ToolDefinition | undefined } },
			name: string,
			namespace?: string,
		): ToolDefinition | undefined;
	}
).getRegisteredToolDefinition;

it("looks up the exact namespace and does not inherit same-leaf built-in renderers", () => {
	const definition: ToolDefinition = {
		name: "read",
		namespace: "records",
		label: "Read record",
		description: "Read record",
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {} };
		},
	};
	const getToolDefinition = vi.fn((tool: ToolReference) => (tool.namespace === "records" ? definition : undefined));
	const resolved = lookup.call({ session: { getToolDefinition } }, "read", "records");
	expect(getToolDefinition).toHaveBeenCalledWith({ name: "read", namespace: "records" });
	expect(resolved).toBe(definition);
	expect(resolved?.renderCall).toBeUndefined();
	expect(resolved?.renderResult).toBeUndefined();
});

it("keeps built-in renderer fallback for an unnamespaced read", () => {
	const resolved = lookup.call({ session: { getToolDefinition: () => undefined } }, "read");
	expect(resolved?.renderCall).toBeTypeOf("function");
});
