import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import programmaticTools from "../examples/extensions/openai-programmatic-tools.ts";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

type PayloadHandler = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown;

function setup() {
	let tool: ToolDefinition | undefined;
	let handler: PayloadHandler | undefined;
	programmaticTools({
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
		on(event: string, callback: PayloadHandler) {
			if (event === "before_provider_request") handler = callback;
		},
	} as unknown as ExtensionAPI);
	return { tool: tool!, handler: handler! };
}

describe("OpenAI programmatic tool example", () => {
	it("returns the structured value programs consume, relative to the active cwd", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-programmatic-example-"));
		try {
			await writeFile(join(directory, "sample.txt"), "hello");
			const { tool } = setup();
			const result = await tool.execute("call", { path: "sample.txt" }, undefined, undefined, {
				cwd: directory,
			} as ExtensionContext);
			expect(result.content).toEqual([{ type: "text", text: '{"bytes":5,"directory":false}' }]);
			expect(tool.allowedCallers).toEqual(["direct", "programmatic"]);
			expect(tool.async).not.toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("appends the hosted declaration once without replacing tools or changing other providers", () => {
		const { handler } = setup();
		const ctx = { model: { provider: "openai", api: "openai-responses" } } as ExtensionContext;
		const tools = [{ type: "function", name: "existing", parameters: {}, strict: false }];
		const payload = { model: "gpt-6-sol", tools };
		const next = handler({ type: "before_provider_request", payload }, ctx);
		expect(next).toEqual({ ...payload, tools: [...tools, { type: "programmatic_tool_calling" }] });
		expect(payload.tools).toEqual(tools);
		expect(handler({ type: "before_provider_request", payload: next }, ctx)).toBeUndefined();
		expect(
			handler({ type: "before_provider_request", payload }, {
				model: { provider: "other", api: "openai-responses" },
			} as ExtensionContext),
		).toBeUndefined();
	});
});
