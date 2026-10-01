import type { EventEmitter } from "node:events";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcSessionState } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const io = vi.hoisted(() => ({
	lines: [] as string[],
	onLine: undefined as ((line: string) => void) | undefined,
}));
vi.mock("../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	restoreStdout: () => {},
	takeOverStdout: () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: (line: string) => io.lines.push(line),
}));
vi.mock("../src/modes/rpc/jsonl.ts", () => ({
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
	attachJsonlLineReader: (_stream: unknown, onLine: (line: string) => void) => {
		io.onLine = onLine;
		return () => {
			io.onLine = undefined;
		};
	},
}));

function records(): Array<Record<string, unknown>> {
	return io.lines.map((line) => JSON.parse(line.replace(/^\x1e[^\x1e]+\x1e/, "")) as Record<string, unknown>);
}
function send(command: object): void {
	if (!io.onLine) throw new Error("RPC does not own input");
	io.onLine(JSON.stringify(command));
}
async function start(harness: Harness, pty: boolean) {
	const streams = [process.stdin, process.stdout];
	const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
	for (const stream of streams) Object.defineProperty(stream, "isTTY", { configurable: true, value: pty });
	const sources: EventEmitter[] = [process, process.stdin, process.stdout, process.stderr];
	const snapshots = sources.map(
		(source) => new Map(source.eventNames().map((event) => [event, source.rawListeners(event)])),
	);
	const runtime = {
		session: harness.session,
		setRebindSession: () => {},
		setBeforeSessionInvalidate: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	initTheme("dark");
	const terminal = new VirtualTerminal(100, 30);
	const mode = pty ? new InteractiveMode(runtime, { terminal }) : undefined;
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	onTestFinished(() => {
		mode?.stop();
		harness.cleanup();
		for (const [index, source] of sources.entries()) {
			for (const event of source.eventNames()) {
				for (const listener of source.rawListeners(event)) {
					if (!snapshots[index]?.get(event)?.includes(listener))
						source.removeListener(event, listener as (...args: unknown[]) => void);
				}
			}
		}
		for (const [index, stream] of streams.entries()) {
			const descriptor = descriptors[index];
			if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
			else delete (stream as { isTTY?: boolean }).isTTY;
		}
	});
	void runRpcMode(runtime, { interactiveMode: mode });
	await vi.waitFor(() => expect(io.onLine).toBeDefined());
	const detach = () => {
		const listener = process.listeners("SIGUSR2").find((entry) => !snapshots[0]?.get("SIGUSR2")?.includes(entry));
		if (!listener) throw new Error("No detach signal handler");
		listener("SIGUSR2");
	};
	const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
	return { terminal, screen, detach };
}

describe("live RPC/TUI ownership", () => {
	afterEach(() => {
		io.lines = [];
		io.onLine = undefined;
		vi.restoreAllMocks();
	});

	it("answers concurrent RPC dialogs in order across detach and reattach", async () => {
		const harness = await createHarness({ settings: { quietStartup: true, theme: "dark", tuiMode: "regular" } });
		const { terminal, screen, detach } = await start(harness, true);
		const ui = harness.session.extensionRunner.getUIContext();
		const answers: string[] = [];
		const first = ui.input("FIRST-QUESTION").then((value) => {
			answers.push(`first: ${value}`);
		});
		const second = ui.input("SECOND-QUESTION").then((value) => {
			answers.push(`second: ${value}`);
		});
		const custom = ui.custom<string>((_tui, _theme, _keys, done) => ({
			render: () => ["LAST-CUSTOM"],
			invalidate: () => {},
			handleInput: () => done("custom answer"),
		}));
		send({ type: "attach_tui" });
		await vi.waitFor(async () => expect(await screen()).toContain("FIRST-QUESTION"));
		expect(await screen()).not.toContain("SECOND-QUESTION");
		expect(await screen()).not.toContain("LAST-CUSTOM");
		detach();
		await vi.waitFor(() => expect(io.onLine).toBeDefined());
		expect(answers).toEqual([]);
		send({ type: "attach_tui" });
		await vi.waitFor(async () => expect(await screen()).toContain("FIRST-QUESTION"));
		terminal.sendInput("one");
		terminal.sendInput("\r");
		await first;
		await vi.waitFor(async () => expect(await screen()).toContain("SECOND-QUESTION"));
		expect(answers).toEqual(["first: one"]);
		terminal.sendInput("two");
		terminal.sendInput("\r");
		await second;
		expect(answers).toEqual(["first: one", "second: two"]);
		await vi.waitFor(async () => expect(await screen()).toContain("LAST-CUSTOM"));
		terminal.sendInput("\r");
		await expect(custom).resolves.toBe("custom answer");
		detach();
		await vi.waitFor(() => expect(io.onLine).toBeDefined());
	});

	it("advances after dialog abort, cancellation and timeout without queueing custom overlays", async () => {
		const harness = await createHarness({ settings: { quietStartup: true, theme: "dark", tuiMode: "regular" } });
		const { terminal, screen, detach } = await start(harness, true);
		const ui = harness.session.extensionRunner.getUIContext();
		const controller = new AbortController();
		const aborted = ui.select("ABORT-ME", ["continue"], { signal: controller.signal });
		const cancelled = ui.input("CANCEL-ME");
		send({ type: "attach_tui" });
		await vi.waitFor(async () => expect(await screen()).toContain("ABORT-ME"));
		const overlay = ui.custom<string>(
			(_tui, _theme, _keys, done) => ({
				render: () => ["CUSTOM-OVERLAY"],
				invalidate: () => {},
				handleInput: () => done("overlay answer"),
			}),
			{ overlay: true },
		);
		await vi.waitFor(async () => expect(await screen()).toContain("CUSTOM-OVERLAY"));
		terminal.sendInput("\r");
		await expect(overlay).resolves.toBe("overlay answer");
		controller.abort();
		await expect(aborted).resolves.toBeUndefined();
		await vi.waitFor(async () => expect(await screen()).toContain("CANCEL-ME"));
		const timedOut = ui.confirm("TIMEOUT-ME", "not answered", { timeout: 1000 });
		const last = ui.input("AFTER-TIMEOUT");
		terminal.sendInput("\x1b");
		await expect(cancelled).resolves.toBeUndefined();
		await vi.waitFor(async () => expect(await screen()).toContain("TIMEOUT-ME"));
		await expect(timedOut).resolves.toBe(false);
		await vi.waitFor(async () => expect(await screen()).toContain("AFTER-TIMEOUT"));
		terminal.sendInput("last");
		terminal.sendInput("\r");
		await expect(last).resolves.toBe("last");
		detach();
		await vi.waitFor(() => expect(io.onLine).toBeDefined());
	});

	it("rejects pipe attachment without breaking RPC or creating custom terminal components", async () => {
		const harness = await createHarness();
		await start(harness, false);
		send({ id: "attach", type: "attach_tui" });
		await vi.waitFor(() =>
			expect(records()).toContainEqual({
				id: "attach",
				type: "response",
				command: "attach_tui",
				success: false,
				error: "TUI handoff requires a PTY",
			}),
		);
		send({ id: "state", type: "get_state" });
		await vi.waitFor(() => expect(records().find((record) => record.id === "state")?.success).toBe(true));
		await expect(
			harness.session.extensionRunner.getUIContext().custom(() => {
				throw new Error("Cannot render on pipes");
			}),
		).resolves.toBeUndefined();
		const ui = harness.session.extensionRunner.getUIContext();
		ui.setEditorComponent(() => {
			throw new Error("Cannot create an editor on pipes");
		});
		expect(ui.getEditorComponent()).toBeUndefined();
	});

	it("hands the same live session and pending UI both ways with framed reconnect state", async () => {
		const starts: string[] = [];
		let customAnswer: string | undefined;
		const factory = vi.fn((_tui: TUI, _theme: Theme, _keys: KeybindingsManager, done: (value: string) => void) => ({
			render: () => ["PENDING-CUSTOM"],
			invalidate: () => {},
			handleInput: () => done("native answer"),
		}));
		let releaseResponse: (() => void) | undefined;
		const harness = await createHarness({
			settings: { quietStartup: true, theme: "dark", tuiMode: "regular" },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						starts.push(ctx.mode);
					});
					pi.registerCommand("custom", {
						handler: async (_args, ctx) => {
							customAnswer = await ctx.ui.custom(factory);
						},
					});
					pi.registerCommand("reload-test", {
						handler: async (_args, ctx) => {
							await ctx.reload();
						},
					});
				},
			],
		});
		const { terminal, screen, detach } = await start(harness, true);
		const writes = vi.spyOn(terminal, "write");
		const titles = vi.spyOn(terminal, "setTitle");
		const ui = harness.session.extensionRunner.getUIContext();
		ui.setStatus("task", "RPC-STATUS");
		ui.setTitle("RPC-TITLE");
		const custom = harness.session.prompt("/custom");
		await vi.waitFor(() => expect(records().some((record) => record.method === "custom")).toBe(true));
		expect(factory).not.toHaveBeenCalled();
		expect(writes).not.toHaveBeenCalled();
		expect(titles).not.toHaveBeenCalled();

		for (const token of ["not-a-uuid", 42]) {
			send({ id: "invalid", type: "attach_tui", token });
			await vi.waitFor(() =>
				expect(records().filter((record) => record.id === "invalid")).toHaveLength(
					typeof token === "string" ? 1 : 2,
				),
			);
			expect(records().findLast((record) => record.id === "invalid")?.success).toBe(false);
		}
		harness.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					releaseResponse = resolve;
				});
				return fauxAssistantMessage("LIVE-RESPONSE");
			},
		]);
		const running = harness.session.prompt("live prompt");
		await vi.waitFor(() => expect(releaseResponse).toBeDefined());
		const token = "01234567-89ab-cdef-0123-456789abcdef";
		send({ id: "attach", type: "attach_tui", token });
		await vi.waitFor(async () => expect(await screen()).toContain("PENDING-CUSTOM"));
		expect(records().find((record) => record.id === "attach")?.data).toEqual({ token });
		expect(starts).toEqual(["rpc"]);
		expect(harness.session.extensionRunner.createContext().mode).toBe("tui");
		expect(titles).toHaveBeenLastCalledWith("RPC-TITLE");
		detach();
		await vi.waitFor(() => expect(io.onLine).toBeDefined());
		expect(customAnswer).toBeUndefined();
		expect(io.lines.find((line) => line.startsWith(`\x1e${token}\x1e`))).toBeDefined();
		const state = records().find((record) => record.type === "tui_detached")?.state as RpcSessionState;
		expect(state.sessionId).toBe(harness.session.sessionId);
		expect(state.isStreaming).toBe(true);
		releaseResponse?.();
		await running;
		expect(records().some((record) => record.type === "agent_settled")).toBe(true);
		expect(state.pendingExtensionUIRequests).toMatchObject([{ method: "custom" }]);
		const titleCount = titles.mock.calls.length;
		await harness.session.prompt("/reload-test");
		expect(starts).toEqual(["rpc", "rpc"]);
		expect(titles).toHaveBeenCalledTimes(titleCount);
		detach(); // A duplicate detach must not poison the next attach.
		send({ id: "reattach", type: "attach_tui" });
		await vi.waitFor(async () => expect(await screen()).toContain("PENDING-CUSTOM"));
		expect(factory).toHaveBeenCalledOnce();
		terminal.sendInput("\r");
		await custom;
		expect(customAnswer).toBe("native answer");

		const editor = harness.session.extensionRunner.getUIContext().editor("PENDING-EDITOR", "draft");
		await vi.waitFor(async () => expect(await screen()).toContain("PENDING-EDITOR"));
		detach();
		await vi.waitFor(() => expect(io.onLine).toBeDefined());
		const request = records().findLast((record) => record.method === "editor");
		send({ type: "extension_ui_response", id: request?.id, value: "rpc answer" });
		await expect(editor).resolves.toBe("rpc answer");
		send({ id: "last-attach", type: "attach_tui" });
		await vi.waitFor(() => expect(io.onLine).toBeUndefined());
		await terminal.waitForRender();
		expect(await screen()).not.toContain("PENDING-EDITOR");

		const currentUI = harness.session.extensionRunner.getUIContext();
		currentUI.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
		expect(currentUI.getEditorComponent()).toBeDefined();
		currentUI.setEditorText("/reload");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(starts).toEqual(["rpc", "rpc", "tui"]));
		expect(currentUI.getEditorComponent()).toBeUndefined();
		detach();
		await vi.waitFor(() => expect(io.onLine).toBeDefined());
		expect(currentUI.getEditorComponent()).toBeUndefined();
		send({ id: "final", type: "get_state" });
		await vi.waitFor(() =>
			expect((records().find((record) => record.id === "final")?.data as RpcSessionState)?.isStreaming).toBe(false),
		);
		expect(harness.session.getLastAssistantText()).toBe("LIVE-RESPONSE");
	});
});
