import type { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { EditorFactory, ExtensionUIContext } from "../src/core/extensions/index.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcSessionState } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	restoreStdout: vi.fn(),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			if (rpcIo.lineHandler === onLine) rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP", "SIGUSR2"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function parseOutput(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line.replace(/^\x1e[^\x1e]+\x1e/, "")) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		setBeforeSessionInvalidate: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

async function startNativeRpc(harness: Harness) {
	const listeners = takeListenerSnapshot();
	const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	initTheme("dark");
	const runtime = createRuntimeHost(harness);
	const interactiveMode = new InteractiveMode(runtime);
	const view = interactiveMode as unknown as {
		renderer: ReturnType<typeof createInteractiveTui>;
		chatContainer: Container;
		editorContainer: Container;
	};
	const terminal = new VirtualTerminal(100, 30);
	view.renderer = createInteractiveTui({
		tuiMode: "regular",
		terminal,
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
	});
	onTestFinished(() => {
		interactiveMode.stop();
		harness.cleanup();
		restoreListeners(listeners);
		if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
		else delete (process.stdin as { isTTY?: boolean }).isTTY;
		if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
		else delete (process.stdout as { isTTY?: boolean }).isTTY;
	});
	void runRpcMode(runtime, { interactiveMode });
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	const detach = (process.listeners("SIGUSR2") as NodeListener[]).find(
		(listener) => !(listeners.signals.get("SIGUSR2") ?? []).includes(listener),
	);
	expect(detach).toBeDefined();
	return { interactiveMode, view, terminal, detach };
}

describe("RPC TUI handoff", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	// https://github.com/fitchmultz/pi/pull/1: RPC-owned editor factories must compose before attachment.
	it("returns the configured editor factory while RPC owns the frontend", async () => {
		const listeners = takeListenerSnapshot();
		const harness = await createHarness();
		const previousFactory: EditorFactory = () => {
			throw new Error("The hidden TUI must not instantiate editors");
		};
		const interactiveUI: ExtensionUIContext = {
			...harness.session.extensionRunner.getUIContext(),
			getEditorComponent: () => previousFactory,
		};
		const interactiveMode = {
			host: vi.fn(),
			getQueuedInputCount: () => 0,
			getExtensionUIContext: () => interactiveUI,
			rebindHostedSession: vi.fn(async () => {}),
		} as unknown as InteractiveMode;
		try {
			void runRpcMode(createRuntimeHost(harness), { interactiveMode });
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			const ui = harness.session.extensionRunner.getUIContext();
			ui.setEditorComponent(previousFactory);
			const parent = ui.getEditorComponent();
			expect(parent).toBe(previousFactory);
			const composed: EditorFactory = (...args) => {
				if (!parent) throw new Error("Missing parent editor");
				return parent(...args);
			};
			ui.setEditorComponent(composed);
			expect(ui.getEditorComponent()).toBe(composed);
			ui.setEditorComponent(undefined);
			expect(ui.getEditorComponent()).toBeUndefined();
		} finally {
			harness.cleanup();
			restoreListeners(listeners);
		}
	});

	it("keeps pipe RPC usable after rejecting attachment", async () => {
		const listeners = takeListenerSnapshot();
		const harness = await createHarness();
		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(JSON.stringify({ id: "pipe-attach", type: "attach_tui" }));
			await vi.waitFor(() =>
				expect(parseOutput().find((record) => record.id === "pipe-attach")).toMatchObject({
					success: false,
					error: "TUI handoff requires a PTY",
				}),
			);
			rpcIo.lineHandler?.(JSON.stringify({ id: "pipe-state", type: "get_state" }));
			await vi.waitFor(() =>
				expect(parseOutput().find((record) => record.id === "pipe-state")).toMatchObject({ success: true }),
			);
			expect(harness.session.extensionRunner.createContext().mode).toBe("rpc");
			await expect(
				harness.session.extensionRunner.getUIContext().custom(() => {
					throw new Error("Pipe RPC must not create terminal components");
				}),
			).resolves.toBeUndefined();
		} finally {
			harness.cleanup();
			restoreListeners(listeners);
		}
	});

	it("renders extension command errors in the active frontend", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("broken", {
						handler: async () => {
							throw new Error("VISIBLE-EXTENSION-ERROR");
						},
					});
				},
			],
		});
		const { interactiveMode, view, detach } = await startNativeRpc(harness);
		await harness.session.prompt("/broken");
		expect(parseOutput().filter((record) => record.type === "extension_error")).toMatchObject([
			{ extensionPath: "command:broken", event: "command", error: "VISIBLE-EXTENSION-ERROR" },
		]);
		rpcIo.lineHandler?.(JSON.stringify({ type: "attach_tui" }));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeUndefined());
		await interactiveMode.init();
		await harness.session.prompt("/broken");
		expect(view.chatContainer.render(100).join("\n")).toContain("VISIBLE-EXTENSION-ERROR");
		expect(parseOutput().filter((record) => record.type === "extension_error")).toHaveLength(1);
		detach?.("SIGUSR2");
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		await harness.session.prompt("/broken");
		expect(parseOutput().filter((record) => record.type === "extension_error")).toHaveLength(2);
	});

	it("preserves frontend mode across reload without starting extensions on handoff", async () => {
		const starts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						starts.push(ctx.mode);
					});
				},
			],
		});
		const { interactiveMode, detach } = await startNativeRpc(harness);
		expect(starts).toEqual(["rpc"]);
		rpcIo.lineHandler?.(JSON.stringify({ type: "attach_tui" }));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeUndefined());
		await interactiveMode.init();
		expect(harness.session.extensionRunner.createContext().mode).toBe("tui");
		expect(starts).toEqual(["rpc"]);
		await harness.session.reload();
		expect(harness.session.extensionRunner.createContext().mode).toBe("tui");
		expect(starts).toEqual(["rpc", "tui"]);
		detach?.("SIGUSR2");
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		await harness.session.reload();
		expect(harness.session.extensionRunner.createContext().mode).toBe("rpc");
		expect(starts).toEqual(["rpc", "tui", "rpc"]);
	});

	// PR #1: RPC answers must dismiss the actual native multiline editor, not just its pending request.
	it("keeps unanswered native editors across detach and dismisses an RPC-answered editor", async () => {
		const harness = await createHarness({ settings: { quietStartup: true, theme: "dark" } });
		const { interactiveMode, view, terminal, detach } = await startNativeRpc(harness);
		const renderedEditor = () => view.editorContainer.render(100).join("\n");
		const settled = vi.fn();
		const answer = harness.session.extensionRunner.getUIContext().editor("NATIVE-EDITOR", "draft");
		void answer.then(settled);
		const request = parseOutput().find((record) => record.method === "editor");
		expect(request?.id).toEqual(expect.any(String));
		rpcIo.lineHandler?.(JSON.stringify({ type: "attach_tui" }));
		await vi.waitFor(() => expect(renderedEditor()).toContain("NATIVE-EDITOR"));
		detach?.("SIGUSR2");
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		expect(settled).not.toHaveBeenCalled();
		expect(renderedEditor()).toContain("NATIVE-EDITOR");
		rpcIo.lineHandler?.(JSON.stringify({ type: "extension_ui_response", id: request?.id, value: "rpc answer" }));
		await expect(answer).resolves.toBe("rpc answer");
		expect(renderedEditor()).not.toContain("NATIVE-EDITOR");
		rpcIo.lineHandler?.(JSON.stringify({ type: "extension_ui_response", id: request?.id, value: "duplicate" }));
		expect(settled).toHaveBeenCalledExactlyOnceWith("rpc answer");
		rpcIo.lineHandler?.(JSON.stringify({ type: "attach_tui" }));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeUndefined());
		expect(renderedEditor()).not.toContain("NATIVE-EDITOR");
		const directAnswer = interactiveMode.getExtensionUIContext().editor("DIRECT-EDITOR", "local answer");
		terminal.sendInput("\r");
		await expect(directAnswer).resolves.toBe("local answer");
		expect(renderedEditor()).not.toContain("DIRECT-EDITOR");
		const controller = new AbortController();
		const cancelled = harness.session.extensionRunner.getUIContext().editor("CANCELLED-EDITOR", "", {
			signal: controller.signal,
		});
		expect(renderedEditor()).toContain("CANCELLED-EDITOR");
		controller.abort();
		await vi.waitFor(() => expect(renderedEditor()).not.toContain("CANCELLED-EDITOR"));
		await expect(cancelled).resolves.toBeUndefined();
	});

	it("moves dialogs both ways and serializes a return during attach", async () => {
		const listeners = takeListenerSnapshot();
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const harness = await createHarness();
		let tuiInputSignal: AbortSignal | undefined;
		const tuiInput = vi.fn((_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => {
			tuiInputSignal = opts?.signal;
			return new Promise<string | undefined>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		});
		const interactiveUI: ExtensionUIContext = {
			...harness.session.extensionRunner.getUIContext(),
			input: tuiInput,
		};
		const activateHosted = vi.fn(async () => {});
		let queuedInputCount = 1;
		const interactiveMode = {
			host: vi.fn(),
			getQueuedInputCount: () => queuedInputCount,
			getExtensionUIContext: vi.fn(() => interactiveUI),
			rebindHostedSession: vi.fn(async () => {}),
			activateHosted,
			deactivateHosted: vi.fn(async () => {}),
			runHosted: vi.fn(() => new Promise<never>(() => {})),
		} as unknown as InteractiveMode;

		try {
			void runRpcMode(createRuntimeHost(harness), { interactiveMode });
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			// Hosted TUI input stays visible to extensions even while RPC owns the frontend.
			expect(harness.session.extensionRunner.createContext().getPendingInputCount()).toBe(1);
			queuedInputCount = 0;
			expect(harness.session.extensionRunner.createContext().getPendingInputCount()).toBe(0);

			const inputPromise = harness.session.extensionRunner.getUIContext().input("Question", "Answer");
			await vi.waitFor(() => expect(parseOutput().some((record) => record.method === "input")).toBe(true));
			const request = parseOutput().find((record) => record.method === "input");
			expect(request?.id).toEqual(expect.any(String));

			rpcIo.lineHandler?.(JSON.stringify({ id: "state", type: "get_state" }));
			await vi.waitFor(() => expect(parseOutput().some((record) => record.id === "state")).toBe(true));
			const state = parseOutput().find((record) => record.id === "state")?.data as RpcSessionState;
			expect(state.pendingExtensionUIRequests).toEqual([request]);

			rpcIo.lineHandler?.(JSON.stringify({ id: "invalid-attach", type: "attach_tui", token: "known" }));
			await vi.waitFor(() => expect(parseOutput().some((record) => record.id === "invalid-attach")).toBe(true));
			expect(parseOutput().find((record) => record.id === "invalid-attach")?.success).toBe(false);
			expect(interactiveMode.activateHosted).not.toHaveBeenCalled();

			for (const stream of [process.stdin, process.stdout]) {
				Object.defineProperty(stream, "isTTY", { configurable: true, value: false });
				const id = `non-pty-${stream.fd}`;
				rpcIo.lineHandler?.(JSON.stringify({ id, type: "attach_tui" }));
				await vi.waitFor(() =>
					expect(parseOutput().find((record) => record.id === id)).toMatchObject({
						success: false,
						error: "TUI handoff requires a PTY",
					}),
				);
				expect(interactiveMode.activateHosted).not.toHaveBeenCalled();
				Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
			}

			const token = "01234567-89ab-cdef-0123-456789abcdef";
			rpcIo.lineHandler?.(JSON.stringify({ id: "attach", type: "attach_tui", token }));
			await vi.waitFor(() => expect(interactiveMode.activateHosted).toHaveBeenCalledOnce());
			expect(parseOutput().find((record) => record.id === "attach")?.data).toEqual({ token });
			expect(tuiInput).toHaveBeenCalledWith(
				"Question",
				"Answer",
				expect.objectContaining({ signal: expect.anything() }),
			);

			const usr2 = (process.listeners("SIGUSR2") as NodeListener[]).find(
				(listener) => !(listeners.signals.get("SIGUSR2") ?? []).includes(listener),
			);
			expect(usr2).toBeDefined();
			usr2?.("SIGUSR2");
			await vi.waitFor(() => expect(parseOutput().some((record) => record.type === "tui_detached")).toBe(true));
			expect(rpcIo.outputLines.some((line) => line.startsWith(`\x1e${token}\x1e{"type":"tui_detached"`))).toBe(true);
			expect(parseOutput().filter((record) => record.id === request?.id)).toHaveLength(2);

			rpcIo.lineHandler?.(
				JSON.stringify({ type: "extension_ui_response", id: request?.id, value: "native answer" }),
			);
			await expect(inputPromise).resolves.toBe("native answer");
			expect(tuiInputSignal?.aborted).toBe(true);
			expect(interactiveMode.deactivateHosted).toHaveBeenCalledOnce();

			rpcIo.lineHandler?.(JSON.stringify({ id: "attach-tui-dialog", type: "attach_tui" }));
			await vi.waitFor(() => expect(activateHosted).toHaveBeenCalledTimes(2));
			const tuiOriginPromise = harness.session.extensionRunner.getUIContext().input("TUI question", "TUI answer");
			await vi.waitFor(() => expect(tuiInput).toHaveBeenCalledTimes(2));
			usr2?.("SIGUSR2");
			await vi.waitFor(() =>
				expect(parseOutput().filter((record) => record.type === "tui_detached")).toHaveLength(2),
			);
			const tuiOriginRequest = parseOutput().find(
				(record) => record.method === "input" && record.id !== request?.id,
			);
			expect(tuiOriginRequest?.id).toEqual(expect.any(String));
			rpcIo.lineHandler?.(
				JSON.stringify({ type: "extension_ui_response", id: tuiOriginRequest?.id, value: "second answer" }),
			);
			await expect(tuiOriginPromise).resolves.toBe("second answer");
			expect(interactiveMode.deactivateHosted).toHaveBeenCalledTimes(2);

			// https://github.com/fitchmultz/pi/pull/1: a duplicate detach must not poison the next attach.
			usr2?.("SIGUSR2");
			rpcIo.lineHandler?.(JSON.stringify({ id: "attach-after-duplicate", type: "attach_tui" }));
			await vi.waitFor(() => expect(activateHosted).toHaveBeenCalledTimes(3));
			expect(harness.session.extensionRunner.createContext().mode).toBe("tui");
			expect(interactiveMode.deactivateHosted).toHaveBeenCalledTimes(2);
			usr2?.("SIGUSR2");
			await vi.waitFor(() =>
				expect(parseOutput().filter((record) => record.type === "tui_detached")).toHaveLength(3),
			);

			let finishActivation: (() => void) | undefined;
			activateHosted.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishActivation = resolve;
					}),
			);
			rpcIo.lineHandler?.(JSON.stringify({ id: "attach-race", type: "attach_tui" }));
			await vi.waitFor(() => expect(activateHosted).toHaveBeenCalledTimes(4));
			usr2?.("SIGUSR2");
			expect(interactiveMode.deactivateHosted).toHaveBeenCalledTimes(3);
			finishActivation?.();
			await vi.waitFor(() => expect(interactiveMode.deactivateHosted).toHaveBeenCalledTimes(4));
			await vi.waitFor(() =>
				expect(parseOutput().filter((record) => record.type === "tui_detached")).toHaveLength(4),
			);
		} finally {
			harness.cleanup();
			restoreListeners(listeners);
			if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
			else delete (process.stdin as { isTTY?: boolean }).isTTY;
			if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
			else delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	});
});
