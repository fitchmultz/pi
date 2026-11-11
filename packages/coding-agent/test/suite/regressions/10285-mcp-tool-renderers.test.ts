import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createMcpExtension } from "../../../src/extensions/mcp/index.ts";
import { keyHint } from "../../../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";

const mcpExtension = createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) });

describe("MCP tool renderers", () => {
	// Regression #10285: a resumed session renders MCP tool calls before their server connected, if it
	// ever does. They render with the MCP renderers anyway, instead of the expanded fallback.
	it("renders calls to MCP tools that are not registered", async () => {
		initTheme("dark");
		const harness = await createHarness({ extensionFactories: [mcpExtension] });
		try {
			const resolve = (toolName: string) =>
				harness.session.extensionRunner.resolveToolRenderers(toolName, () =>
					harness.session.getToolDefinition(toolName),
				);

			const call = resolve("mcp__my_docs__search")?.renderCall?.({ query: "pi" }, theme, {
				expanded: false,
			} as unknown as ToolRenderContext);
			expect(stripAnsi(call?.render(100).join("\n") ?? "")).toContain('my_docs/search query="pi"');
			// The MCP call header is the fallback header: cut arguments are followed by the expand key.
			setKeybindings(new KeybindingsManager());
			const long = resolve("mcp__my_docs__search")?.renderCall?.({ query: "pi ".repeat(60) }, theme, {
				expanded: false,
				keyHint,
			} as unknown as ToolRenderContext);
			expect(long?.render(200).map((row) => stripAnsi(row).trim())).toEqual([
				`my_docs/search query="${"pi ".repeat(30)}...`,
				"(ctrl+o to expand)",
			]);
			expect(resolve("not_mcp")).toBeUndefined();
			// Registered tools keep their own renderers.
			expect(resolve("read")?.renderCall).toBe(harness.session.getToolDefinition("read")?.renderCall);
		} finally {
			harness.cleanup();
		}
	});

	it("renders them in HTML exports too", async () => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "pi-10285-"));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ extensionFactories: [mcpExtension], sessionManager });
		try {
			sessionManager.appendMessage({ role: "user", content: "search", timestamp: 1 });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "mcp__my_docs__search", arguments: { query: "pi" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			});

			const html = readFileSync(await harness.session.exportToHtml(join(dir, "export.html")), "utf8");
			const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
			const session = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
			expect(stripAnsi(session.renderedTools?.["call-1"]?.callHtml ?? "")).toContain("my_docs/search");
		} finally {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
