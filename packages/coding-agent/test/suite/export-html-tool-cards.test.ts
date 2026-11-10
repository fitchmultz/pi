/**
 * What `/export`, `/share` and the RPC `export_html` command store for tool cards drawn by their TUI
 * renderers. The page shows each call once and switches a result between two forms on a click.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { setKeybindings, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, onTestFinished, test } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import backgroundCommand from "../../src/extensions/background-command/index.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type HarnessOptions } from "./harness.ts";

interface ExportedCard {
	call?: string[];
	collapsed?: string[];
	expanded?: string[];
}

/** The text rows of a card part, without markup. */
function rows(html: string | undefined): string[] | undefined {
	return html
		?.split("</div>")
		.filter((row) => row !== "")
		.map((row) =>
			row
				.replace(/<[^>]+>/g, "")
				.replace(/&nbsp;/g, "")
				.trimEnd(),
		);
}

function call(id: string, name: string, args: Record<string, string>): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
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
	};
}

/** Saves the messages in a session with the extensions, exports it, and returns what the page holds per call id. */
async function exportCards(
	extensionFactories: NonNullable<HarnessOptions["extensionFactories"]>,
	messages: Message[],
): Promise<Record<string, ExportedCard>> {
	const dir = mkdtempSync(join(tmpdir(), "pi-export-cards-"));
	const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
	const harness = await createHarness({ extensionFactories, sessionManager });
	onTestFinished(async () => {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});
	sessionManager.appendMessage({ role: "user", content: "Go.", timestamp: 1 });
	for (const message of messages) sessionManager.appendMessage(message);

	const html = readFileSync(await harness.session.exportToHtml(join(dir, "export.html")), "utf8");
	const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
	const rendered: Record<string, { callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string }> =
		JSON.parse(Buffer.from(data, "base64").toString("utf8")).renderedTools ?? {};
	return Object.fromEntries(
		Object.entries(rendered).map(([id, card]) => [
			id,
			{
				call: rows(card.callHtml),
				collapsed: rows(card.resultHtmlCollapsed),
				expanded: rows(card.resultHtmlExpanded),
			},
		]),
	);
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
		const details = { jobs: [], total: 0, nextOffset: null };
		const cards = await exportCards(
			[backgroundCommand],
			[
				call("call-1", "background_command", { action: "status" }),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "background_command",
					content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
					details,
					isError: false,
					timestamp: 3,
				},
			],
		);

		// The terminal's card reads "No background jobs (ctrl+o to expand)"; a browser has no such key.
		expect(cards["call-1"]?.collapsed).toEqual(["No background jobs (click to expand)"]);
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
