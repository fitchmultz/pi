import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import type { SettingsSelectorComponent } from "../../../src/modes/interactive/components/settings-selector.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

type View = {
	isInitialized: boolean;
	defaultEditor: CustomEditor;
	chatContainer: Container;
	editorContainer: Container;
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	subscribeToAgent(): void;
};

async function createView(harness: Harness) {
	initTheme("dark");
	let rebind = async () => {};
	const mode = new InteractiveMode(
		{
			session: harness.session,
			setBeforeSessionInvalidate() {},
			setRebindSession(callback: () => Promise<void>) {
				rebind = callback;
			},
		} as unknown as AgentSessionRuntime,
		{ terminal: new VirtualTerminal(100, 40) },
	);
	const view = mode as unknown as View;
	view.isInitialized = true;
	view.setupKeyHandlers();
	view.setupEditorSubmitHandler();
	await view.bindCurrentSessionExtensions();
	view.subscribeToAgent();
	onTestFinished(() => mode.stop("resume-hint"));
	const submit = async (text: string) => {
		await view.defaultEditor.onSubmit?.(text);
	};
	return {
		rebind: () => rebind(),
		submit,
		rows: () => view.chatContainer.children.filter((child) => child instanceof ToolExecutionComponent),
		text: () => stripAnsi(view.chatContainer.render(100).join("\n")),
		/** Trimmed transcript lines. An output line equals the printed text; the command's `$ ...` line only contains it. */
		lines: () =>
			stripAnsi(view.chatContainer.render(100).join("\n"))
				.split("\n")
				.map((line) => line.trim()),
		/** Toggle cache miss notices in /settings, which rebuilds the transcript from the saved session. */
		toggleCacheMissNotices: async () => {
			await submit("/settings");
			const selector = view.editorContainer.children[0] as SettingsSelectorComponent;
			selector.getSettingsList().selectItem("cache-miss-notices");
			selector.getSettingsList().handleInput("\r");
			selector.getSettingsList().handleInput("\x1b");
		},
	};
}

async function harnessWith(options: HarnessOptions): Promise<Harness> {
	const harness = await createHarness({
		...options,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, ...options.settings },
	});
	onTestFinished(() => harness.cleanup());
	return harness;
}

/** A shell command that prints `start`, waits until the returned release file exists, then prints `end`. */
function heldCommand(start: string, end: string) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-transcript-rows-")));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const release = join(root, "release");
	const quoted = `'${release.split(sep).join("/").replaceAll("'", "'\\''")}'`;
	return {
		command: `printf '${start}\\n'; while [ ! -f ${quoted} ]; do sleep 0.01; done; printf '${end}\\n'`,
		release: () => writeFileSync(release, ""),
	};
}

describe("transcript rebuilds keep what the session has not saved yet", () => {
	test("a finished parallel row and a running row keep their output and timer, and a ! command started meanwhile shows once", async () => {
		const harness = await harnessWith({});
		const { lines, rows, submit, text, toggleCacheMissNotices } = await createView(harness);
		const slow = heldCommand("slow-start", "slow-end");
		const user = heldCommand("user-start", "user-end");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "printf 'quick-out\\n'" }, { id: "quick" }),
					fauxToolCall("bash", { command: slow.command }, { id: "slow" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Both done"),
		]);
		const run = harness.session.prompt("go");
		let command: Promise<void> | undefined;
		try {
			await vi.waitFor(() => {
				expect(rows().map((row) => row.getActivityStatus())).toEqual(["complete", "running"]);
				expect(lines()).toContain("slow-start");
			});
			// Parallel results are saved together when the round ends, so neither row is in the saved session.
			expect(harness.session.messages.map((message) => message.role)).not.toContain("toolResult");
			// A command started while the agent works waits in the pending area until the run settles.
			command = submit(`!${user.command}`);
			await vi.waitFor(() => expect(harness.session.isBashRunning).toBe(true));
			const [quick, running] = rows();
			await toggleCacheMissNotices();
			expect(rows()[0]).toBe(quick);
			expect(rows()[1]).toBe(running);
			expect(lines()).toContain("quick-out");
			expect(lines()).toContain("slow-start");
			expect(text()).toContain("Elapsed");
		} finally {
			user.release();
			await command;
			slow.release();
			await run;
		}
		expect(rows().map((row) => row.getActivityStatus())).toEqual(["complete", "complete"]);
		expect(lines()).toContain("slow-end");
		expect(lines().filter((line) => line.startsWith("$ printf 'user-start"))).toHaveLength(1);
	});

	test("the response that is still streaming stays shown with its tool row", async () => {
		const harness = await harnessWith({});
		const { lines, rows, text, toggleCacheMissNotices } = await createView(harness);
		let releaseResponse!: () => void;
		const responseReleased = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let markHeld!: () => void;
		const held = new Promise<void>((resolve) => {
			markHeld = resolve;
		});
		// Hold the tool-calling response's final event, so it is still streaming during the rebuild.
		const streamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = async (model, context, options) => {
			const source = await streamFunction(model, context, options);
			const stream = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					if (event.type === "done" && event.reason === "toolUse") {
						markHeld();
						await responseReleased;
					}
					stream.push(event);
				}
				stream.end();
			})();
			return stream;
		};
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: "Streaming answer" },
					fauxToolCall("bash", { command: "printf 'tool-out\\n'" }, { id: "after-stream" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Wrapped up"),
		]);
		const run = harness.session.prompt("go");
		try {
			await held;
			await vi.waitFor(() => {
				expect(text()).toContain("Streaming answer");
				expect(rows()).toHaveLength(1);
			});
			await toggleCacheMissNotices();
			expect(text()).toContain("Streaming answer");
			expect(rows()).toHaveLength(1);
		} finally {
			releaseResponse();
			await run;
		}
		expect(text().match(/Streaming answer/g)).toHaveLength(1);
		expect(rows()).toHaveLength(1);
		expect(lines()).toContain("tool-out");
		expect(text()).toContain("Wrapped up");
	});

	test("/compact keeps a running ! command", async () => {
		const harness = await harnessWith({ settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
		const { lines, submit, text } = await createView(harness);
		harness.setResponses([
			fauxAssistantMessage("First answer"),
			fauxAssistantMessage("Second answer"),
			fauxAssistantMessage("History summary"),
			fauxAssistantMessage("Turn prefix summary"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const user = heldCommand("user-start", "user-end");
		const command = submit(`!${user.command}`);
		try {
			await vi.waitFor(() => expect(lines()).toContain("user-start"));
			await submit("/compact");
			expect(text()).toContain("[compaction]");
			expect(lines()).toContain("user-start");
		} finally {
			user.release();
			await command;
		}
		expect(lines()).toContain("user-end");
	});
});

describe("tool rows after their result is saved", () => {
	test("a finished row keeps its result when a later response in the run fails", async () => {
		const harness = await harnessWith({});
		const { lines, rows } = await createView(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'kept-out\\n'" }, { id: "kept" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
		]);
		await harness.session.prompt("go");
		expect(rows().map((row) => row.getActivityStatus())).toEqual(["complete"]);
		expect(lines()).toContain("kept-out");
	});
});

describe("saved tool calls without a result", () => {
	test("a call left running by an ordinary quit shows the model's error after resume", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-transcript-rows-")));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		const sessionManager = SessionManager.create(root, join(root, "sessions"));
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let finish!: () => void;
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Finishes when the test releases it, ignoring cancellation",
			parameters: Type.Object({}),
			execute: () =>
				new Promise<AgentToolResult<unknown>>((resolve) => {
					finish = () => resolve({ content: [{ type: "text", text: "late result" }], details: undefined });
					markStarted();
				}),
		};
		const harness = await harnessWith({ tools: [tool], sessionManager });
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("runtime replacement is not used in this test");
			},
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}, { id: "interrupted" }), { stopReason: "toolUse" }),
		]);
		const run = runtime.session.prompt("start");
		await started;
		// Ordinary quit does not wait for running tools, so the saved session keeps the call without its result.
		await runtime.dispose();
		finish();
		await run.catch(() => undefined);

		const resumed = await harnessWith({
			tools: [tool],
			sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
		});
		expect(resumed.session.messages.map((message) => message.role)).not.toContain("toolResult");
		const { rebind, rows, text } = await createView(resumed);
		await rebind();
		expect(rows().map((row) => row.getActivityStatus())).toEqual(["error"]);
		expect(text()).toContain("No result provided");
	});
});
