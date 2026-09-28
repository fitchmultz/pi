import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import permissionGate from "../../examples/extensions/permission-gate.ts";
import planMode from "../../examples/extensions/plan-mode/index.ts";
import sandbox from "../../examples/extensions/sandbox/index.ts";
import ssh from "../../examples/extensions/ssh.ts";
import { backgroundCommandDirectory, listBackgroundCommands } from "../../src/core/background-command.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("background shell guards in shipped examples", () => {
	beforeAll(() => initTheme("dark", false));
	let h: Harness | undefined;
	afterEach(() => {
		h?.cleanup();
		vi.restoreAllMocks();
	});

	it.each([
		{ name: "permission", factory: permissionGate, flags: new Map<string, string | boolean>() },
		{ name: "plan", factory: planMode, flags: new Map<string, string | boolean>([["plan", true]]) },
		{ name: "sandbox", factory: sandbox, flags: new Map<string, string | boolean>() },
		{ name: "ssh", factory: ssh, flags: new Map<string, string | boolean>([["ssh", "unused-host:/tmp"]]) },
	])(
		"$name blocks background starts through native preflight while permitting status/cancel",
		async ({ factory, flags }) => {
			vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
			h = await createHarness({ extensionFactories: [factory] });
			for (const [flag, value] of flags)
				h.session.resourceLoader.getExtensions().runtime.flagValues.set(flag, value);
			await h.session.bindExtensions({ mode: "print" });
			if (factory === planMode) {
				expect(h.session.getActiveToolNames()).not.toContain("background_command");
				// A second extension can re-enable tools; the normal call guard still applies.
				h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "background_command"]);
			}
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: "sudo true" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Blocked"),
			]);
			await h.session.prompt("Try the guarded shell path");
			const result = h.session.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({ role: "toolResult", isError: true });
			expect(getMessageText(result)).toMatch(/blocked|disabled|do not support/i);
			expect(listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))).toEqual([]);
			for (const action of ["status", "cancel"] as const) {
				expect(
					await h.session.extensionRunner.emitToolCall({
						type: "tool_call",
						toolName: "background_command",
						toolCallId: action,
						input: { action, id: "00000000-0000-4000-8000-000000000001" },
					}),
				).toBeUndefined();
			}
			// Built-in guards must not confuse a namespaced tool with the native shell.
			expect(
				await h.session.extensionRunner.emitToolCall({
					type: "tool_call",
					toolName: "background_command",
					namespace: "other",
					toolCallId: "other",
					input: { action: "start", command: "sudo true" },
				}),
			).toBeUndefined();
		},
	);

	it.each([
		{ name: "sandbox disabled", factory: sandbox, flags: new Map<string, string | boolean>([["no-sandbox", true]]) },
		{ name: "SSH unselected", factory: ssh, flags: new Map<string, string | boolean>() },
	])("$name leaves ordinary local starts available", async ({ factory, flags }) => {
		h = await createHarness({ extensionFactories: [factory] });
		for (const [flag, value] of flags) h.session.resourceLoader.getExtensions().runtime.flagValues.set(flag, value);
		await h.session.bindExtensions({ mode: "print" });
		expect(
			await h.session.extensionRunner.emitToolCall({
				type: "tool_call",
				toolName: "background_command",
				toolCallId: "start",
				input: { action: "start", command: "printf local" },
			}),
		).toBeUndefined();
	});

	it("keeps literal tool exclusions: excluding bash does not exclude background_command", async () => {
		h = await createHarness({ excludedToolNames: ["bash"] });
		expect(h.session.getActiveToolNames()).not.toContain("bash");
		expect(h.session.getActiveToolNames()).toContain("background_command");
	});
});
