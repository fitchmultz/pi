/**
 * What `/export`, `/share` and the RPC `export_html` command store for tool cards drawn by their TUI
 * renderers. The page shows each call once and switches a result between two forms on a click.
 */

import { fauxAssistantMessage, fauxToolCall, type JsonValue, type Message } from "@earendil-works/pi-ai";
import { setKeybindings, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import backgroundCommand from "../../src/extensions/background-command/index.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { exportSessionToolCards as exportCards } from "./ui-harness.ts";

function call(id: string, name: string, args: Record<string, string>): Message {
	return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
}

beforeAll(() => {
	initTheme("dark");
	// The default keys, as in the interactive mode: the terminal's expand hint names ctrl+o.
	setKeybindings(new KeybindingsManager());
});

describe("tool cards in an HTML export", () => {
	test("a call is drawn in the state of its saved result", async () => {
		// A call renderer that shows the call's status, as cards with a status word or marker do.
		const deploy = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "deploy",
				label: "deploy",
				description: "Deploys a service",
				parameters: Type.Object({ service: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "deployed" }], details: {} }),
				renderCall: (args, _theme, context) =>
					new Text(
						`deploy ${args.service} · ${context.isPartial ? "running" : context.isError ? "failed" : "done"}`,
						0,
						0,
					),
			});
		};
		const result = (toolCallId: string, isError: boolean): Message => ({
			role: "toolResult",
			toolCallId,
			toolName: "deploy",
			content: [{ type: "text", text: isError ? "image not found" : "deployed" }],
			isError,
			timestamp: 3,
		});

		const cards = await exportCards(
			[deploy],
			[
				call("call-done", "deploy", { service: "billing" }),
				result("call-done", false),
				call("call-failed", "deploy", { service: "search" }),
				result("call-failed", true),
				// A call the session ended on: no result was saved.
				call("call-unfinished", "deploy", { service: "mail" }),
			],
		);

		expect(cards["call-done"]?.call).toEqual(["deploy billing · done"]);
		expect(cards["call-failed"]?.call).toEqual(["deploy search · failed"]);
		expect(cards["call-unfinished"]?.call).toEqual(["deploy mail · running"]);
	});

	test("a codemode result states the time the script took, not the time of the export", async () => {
		const cards = await exportCards(
			[createCodemodeExtension()],
			[
				call("call-1", "codemode", { code: 'text("ready")' }),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "codemode",
					content: [
						{ type: "text", text: "Script completed\nWall time 4.2 seconds\nOutput:\n" },
						{ type: "text", text: "ready" },
					],
					details: { calls: [] },
					isError: false,
					timestamp: 3,
					durationMs: 4200,
				},
			],
		);

		expect(cards["call-1"]?.expanded).toEqual(["ready", "", "Took 4.2s"]);
	});

	test("a result's expand hint names the click that expands it on the page", async () => {
		const lines = (count: number) => Array.from({ length: count }, (_, index) => `row ${index + 1}`).join("\n");
		const result = (toolCallId: string, toolName: string, text: string, details?: JsonValue): Message => ({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			details,
			isError: false,
			timestamp: 3,
		});
		const noJobs = { jobs: [], total: 0, nextOffset: null };
		const nestedCalls = Array.from({ length: 10 }, (_, index) => ({
			id: `call/${index}`,
			name: "read",
			args: "{}",
			status: "ok",
		}));

		// Every built-in renderer that shortens a result, each with more output than its collapsed form shows.
		const cards = await exportCards(
			[
				backgroundCommand,
				createCodemodeExtension(),
				createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
			],
			[
				call("jobs", "background_command", { action: "status" }),
				result("jobs", "background_command", JSON.stringify(noJobs, null, 2), noJobs),
				call("grep", "grep", { pattern: "row" }),
				result("grep", "grep", lines(20)),
				call("find", "find", { pattern: "*.md" }),
				result("find", "find", lines(25)),
				call("shell", "powershell", { command: "Get-ChildItem" }),
				result("shell", "powershell", lines(8)),
				call("script", "codemode", { code: 'text("rows")' }),
				result("script", "codemode", lines(8), { calls: nestedCalls }),
				// A call to an MCP tool whose server is not connected, drawn by the MCP renderers.
				call("mcp", "mcp__my_docs__search", { query: "pi" }),
				result("mcp", "mcp__my_docs__search", lines(8)),
			],
		);

		// The terminal's cards name its expand key here, "ctrl+o"; a browser has no such key.
		const hints = Object.fromEntries(
			Object.entries(cards).map(([id, card]) => [id, card.collapsed?.filter((row) => row.includes("to expand"))]),
		);
		expect(hints).toEqual({
			jobs: ["No background jobs (click to expand)"],
			grep: ["... (5 more lines, click to expand)"],
			find: ["... (5 more lines, click to expand)"],
			shell: ["... (3 earlier lines, click to expand)"],
			script: ["... (2 earlier calls, click to expand)", "... (3 more lines, click to expand)"],
			mcp: ["... (3 more lines, click to expand)"],
		});
	});

	test("a tool with a result renderer and no call renderer keeps its arguments", async () => {
		const notify = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "notify",
				label: "notify",
				description: "Posts a message",
				parameters: Type.Object({ channel: Type.String(), message: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "posted" }], details: {} }),
				renderResult: () => new Text("posted", 0, 0),
			});
		};

		const cards = await exportCards(
			[notify],
			[
				call("call-1", "notify", { channel: "releases", message: "Version 2 is out.\nNotes follow." }),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "notify",
					content: [{ type: "text", text: "posted" }],
					isError: false,
					timestamp: 3,
				},
			],
		);

		// The header a card without a call renderer gets in the terminal when expanded.
		expect(cards["call-1"]?.call).toEqual([
			"notify",
			"  channel: releases",
			"  message: Version 2 is out.",
			"    Notes follow.",
		]);
		expect(cards["call-1"]?.expanded).toEqual(["posted"]);
	});
});
