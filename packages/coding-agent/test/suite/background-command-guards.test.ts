import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import permissionGate from "../../examples/extensions/permission-gate.ts";
import planMode from "../../examples/extensions/plan-mode/index.ts";
import ssh from "../../examples/extensions/ssh.ts";
import backgroundCommand from "../../src/extensions/background-command/index.ts";
import { backgroundCommandDirectory, listBackgroundCommands } from "../../src/extensions/background-command/jobs.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("background shell permission guards", () => {
	let h: Harness | undefined;
	beforeAll(() => initTheme("dark", false));
	afterEach(async () => {
		await h?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h?.cleanup();
	});
	it.each([
		{ name: "permission", factory: permissionGate, flag: undefined },
		{ name: "plan", factory: planMode, flag: ["plan", true] as const },
		{ name: "ssh", factory: ssh, flag: ["ssh", "unused-host:/tmp"] as const },
	])("$name blocks background starts without disabling status", async ({ factory, flag }) => {
		h = await createHarness({ extensionFactories: [backgroundCommand, factory] });
		if (flag) h.session.resourceLoader.getExtensions().runtime.flagValues.set(flag[0], flag[1]);
		await h.session.bindExtensions({ mode: "print" });
		h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "background_command"]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: "sudo true" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Blocked"),
		]);
		await h.session.prompt("Try a guarded command");
		expect(getToolResult(h, "background_command").isError).toBe(true);
		expect(getMessageText(getToolResult(h, "background_command"))).toMatch(/blocked|disabled|does not support/i);
		expect(listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))).toEqual([]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "status" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Inspected"),
		]);
		await h.session.prompt("Inspect jobs");
		expect(getToolResult(h, "background_command").isError).toBe(false);
		expect(JSON.parse(getMessageText(getToolResult(h, "background_command")))).toEqual({
			jobs: [],
			total: 0,
			nextOffset: null,
		});
	});

	it("does not enable strict constrainedSampling on its multiplexed optional-field schema", async () => {
		h = await createHarness({ extensionFactories: [backgroundCommand] });
		await h.session.bindExtensions({ mode: "print" });
		const definition = h.session.getToolDefinition("background_command");
		expect(definition).toBeDefined();
		expect(definition?.constrainedSampling).toBeUndefined();
		expect((definition?.parameters as { required?: string[] } | undefined)?.required).toEqual(["action"]);
	});

	it.each<{ args: JsonObject; isError: boolean; expected: RegExp }>([
		{
			args: { action: "status", id: "null" },
			isError: false,
			expected: /"jobs": \[\]/,
		},
		{
			args: { action: "cancel", id: "null" },
			isError: true,
			expected: /Validation failed.*background_command/,
		},
		{
			args: { action: "start", command: "echo started", cwd: "null" },
			isError: true,
			expected: /literal directory name.*omit cwd.*JSON null/,
		},
	])("handles a literal null argument for $args.action", async ({ args, isError, expected }) => {
		h = await createHarness({ extensionFactories: [backgroundCommand] });
		await h.session.bindExtensions({ mode: "print" });
		h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "background_command"]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", args), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await h.session.prompt("Try the background command");
		const result = getToolResult(h, "background_command");
		expect(result.isError).toBe(isError);
		expect(getMessageText(result)).toMatch(expected);
	});
});
