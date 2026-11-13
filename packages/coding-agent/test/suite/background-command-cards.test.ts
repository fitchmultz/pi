import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import { withBuiltInRenderers } from "../../src/core/tools/renderers/index.ts";
import backgroundCommand, { BACKGROUND_COMMAND_NOTICE } from "../../src/extensions/background-command/index.ts";
import { CustomMessageComponent } from "../../src/modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness } from "./harness.ts";
import { exportSessionToolCards } from "./ui-harness.ts";

const WIDTH = 120;
const id = "0a1b2c3d-1111-4222-8333-444455556666";
const logFile = `/tmp/sessions/--tmp-project--/background-commands/9f8e7d6c-1111-4222-8333-444455556666/${id}/output.log`;
const ui = { requestRender() {} } as TUI;
/** A command that is a script: 30 lines. */
const script = ["set -euo pipefail", ...Array.from({ length: 28 }, (_, index) => `echo step ${index + 1}`), "npm test"];

/** The renderers the session registered, as the interactive mode hands them to the cards. */
async function registered() {
	const harness = await createHarness({ extensionFactories: [backgroundCommand] });
	onTestFinished(async () => {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	});
	const runner = harness.session.extensionRunner;
	return {
		notice: runner.getMessageRenderer(BACKGROUND_COMMAND_NOTICE),
		tool: runner.resolveToolRenderers("background_command", () =>
			withBuiltInRenderers("background_command", harness.session.getToolDefinition("background_command")),
		),
	};
}

/** The card's rows that hold text, without styling or padding. */
function rows(component: Component): string[] {
	return component
		.render(WIDTH)
		.map((line) => stripAnsi(line).trim())
		.filter((line) => line !== "");
}

function click(component: Component, y: number): boolean {
	const height = component.render(WIDTH).length;
	return (
		component.handleMouse?.({
			type: "click",
			button: "left",
			x: 4,
			y,
			screenX: 4,
			screenY: y,
			width: WIDTH,
			height,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		})?.handled === true
	);
}

beforeAll(() => {
	initTheme("dark");
	// The default keys, so a hint names ctrl+o.
	setKeybindings(new KeybindingsManager());
});

describe("background-command-complete notice, compact view off", () => {
	// Shapes of recorded notices: one JSON line per job, and the output tail of a job that did not succeed.
	const jobLine = (status: string, exitCode: number, command: string) =>
		JSON.stringify({ id, status, exitCode, commandPreview: command, logFile });
	const notice = (status: string, content: string): CustomMessage => ({
		role: "custom",
		customType: BACKGROUND_COMMAND_NOTICE,
		content,
		display: true,
		details: { jobIds: [id], jobs: [{ id, status }] },
		timestamp: 1,
	});
	const output = [
		...Array.from({ length: 18 }, (_, index) => `test ${index + 1} passed`),
		"test 19 failed: expected 1 to be 2",
		"npm error Test failed. See above for more details.",
	];
	const failed = notice(
		"failed",
		`Background commands finished:\n${jobLine("failed", 1, "cd /tmp/project && npm test")}\nOutput tail:\n${output.join("\n")}\n`,
	);

	test("a failed job shows its summary, the hint and the last five rows of its output until expanded", async () => {
		const { notice: renderer } = await registered();
		const component = new CustomMessageComponent(failed, renderer, undefined, 1, [], undefined, undefined, false);
		const collapsed = rows(component);
		expect(collapsed[0]).toBe("1 background command finished, 1 failed");
		expect(collapsed[1]).toMatch(/^\.\.\. \(\d+ earlier lines, ctrl\+o to expand\)$/);
		expect(collapsed.slice(2)).toEqual(output.slice(-5));
		// The blank row above the card, the card's two padding rows, and the seven rows above.
		expect(component.render(WIDTH)).toHaveLength(10);

		component.setExpanded(true);
		const expanded = rows(component);
		expect(expanded[0]).toBe(`[${BACKGROUND_COMMAND_NOTICE}]`);
		expect(expanded).toContain("Background commands finished:");
		for (const line of output) expect(expanded).toContain(line);
		expect(expanded.join("\n")).not.toContain("to expand");

		// Compact view keeps its one summary row.
		expect(rows(new CustomMessageComponent(failed, renderer, undefined, 1, [], undefined, undefined, true))).toEqual([
			"1 background command finished, 1 failed",
		]);
	});

	test("a notice that fits shows all of it without a hint", async () => {
		const { notice: renderer } = await registered();
		const line = jobLine("succeeded", 0, "npm run build");
		const component = new CustomMessageComponent(
			notice("succeeded", `Background commands finished:\n${line}`),
			renderer,
			undefined,
			1,
			[],
			undefined,
			undefined,
			false,
		);
		const [summary, ...body] = rows(component);
		expect(summary).toBe("1 background command finished");
		expect(body.join("").replace(/\s+/g, "")).toBe(line.replace(/\s+/g, ""));
	});

	test("a click expands the card and a second click collapses it", async () => {
		const { notice: renderer } = await registered();
		const component = new CustomMessageComponent(failed, renderer, undefined, 1, [], undefined, undefined, false);
		const collapsed = rows(component);
		expect(click(component, 3)).toBe(true);
		expect(rows(component)).toContain(output[0]);
		expect(click(component, 3)).toBe(true);
		expect(rows(component)).toEqual(collapsed);
	});
});

describe("background_command tool card, compact view off", () => {
	// Shape of recorded results: the job record with its output tail, also as the JSON text of the result.
	const record = (command: string, fields: Record<string, unknown>) => {
		const details = {
			id,
			command,
			cwd: "/tmp/project",
			createdAt: "2026-11-01T00:00:00.000Z",
			logFile,
			timeout: 600,
			pid: 4242,
			...fields,
			outputTail: "",
		};
		return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details, isError: false };
	};
	const card = async (args: Record<string, unknown>) => {
		const { tool } = await registered();
		return new ToolExecutionComponent("background_command", "call", args, {}, tool, ui, process.cwd());
	};

	test("a long command shows ten rows and both hints until expanded", async () => {
		const command = script.join("\n");
		const component = await card({ action: "start", command, timeout: 600 });
		component.updateResult(record(command, { status: "running" }));
		expect(rows(component)).toEqual([
			`background start ${script[0]}`,
			...script.slice(1, 10),
			"... (20 more lines, ctrl+o to expand)",
			"Started in background · 0a1b2c3d (ctrl+o to expand)",
		]);

		component.setExpanded(true);
		const expanded = rows(component);
		expect(expanded.slice(0, script.length)).toEqual([`background start ${script[0]}`, ...script.slice(1)]);
		expect(expanded).toContain('"outputTail": ""');
		expect(expanded.join("\n")).not.toContain("to expand");
	});

	test("a short command is whole, and every collapsed status line carries the hint", async () => {
		const started = await card({ action: "start", command: "npm run check" });
		started.updateResult(record("npm run check", { status: "running" }));
		expect(rows(started)).toEqual([
			"background start npm run check",
			"Started in background · 0a1b2c3d (ctrl+o to expand)",
		]);

		const finished = await card({ action: "status", id });
		finished.updateResult(record("npm run check", { status: "failed", exitCode: 1 }));
		expect(rows(finished)).toEqual([
			"background status 0a1b2c3d",
			"Job failed · exit 1 · 0a1b2c3d (ctrl+o to expand)",
		]);

		const list = await card({ action: "status" });
		const details = { jobs: [], total: 0, nextOffset: null };
		list.updateResult({
			content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
			details,
			isError: false,
		});
		expect(rows(list)).toEqual(["background status", "No background jobs (ctrl+o to expand)"]);
	});

	test("an error result is shown in full without a hint", async () => {
		const component = await card({ action: "start" });
		component.updateResult({
			content: [{ type: "text", text: "start requires command" }],
			details: {},
			isError: true,
		});
		expect(rows(component)).toEqual(["background start", "start requires command"]);
	});
});

describe("background_command in an HTML export", () => {
	// The exported page has no control that expands a call, so it must show the call whole.
	test("the exported call holds the whole command and no expand hint", async () => {
		const cards = await exportSessionToolCards(
			[backgroundCommand],
			[
				fauxAssistantMessage(
					fauxToolCall("background_command", { action: "start", command: script.join("\n") }, { id: "call-1" }),
					{ stopReason: "toolUse" },
				),
			],
		);
		const call = cards["call-1"]?.call?.join("\n") ?? "";
		for (const line of script) expect(call).toContain(line);
		expect(call).not.toContain("to expand");
	});
});
