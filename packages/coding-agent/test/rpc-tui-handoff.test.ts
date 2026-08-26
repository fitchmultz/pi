import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import type { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
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

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

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
	} as unknown as AgentSessionRuntime;
}

describe("RPC TUI handoff", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
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
		const interactiveUI = { input: tuiInput } as unknown as ExtensionUIContext;
		const activateHosted = vi.fn(async () => {});
		const interactiveMode = {
			host: vi.fn(),
			getExtensionUIContext: vi.fn(() => interactiveUI),
			rebindHostedSession: vi.fn(async () => {}),
			activateHosted,
			deactivateHosted: vi.fn(async () => {}),
			runHosted: vi.fn(() => new Promise<never>(() => {})),
		} as unknown as InteractiveMode;

		try {
			void runRpcMode(createRuntimeHost(harness), { interactiveMode });
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			const inputPromise = harness.session.extensionRunner.getUIContext().input("Question", "Answer");
			await vi.waitFor(() => expect(parseOutput().some((record) => record.method === "input")).toBe(true));
			const request = parseOutput().find((record) => record.method === "input");
			expect(request?.id).toEqual(expect.any(String));

			rpcIo.lineHandler?.(JSON.stringify({ id: "attach", type: "attach_tui" }));
			await vi.waitFor(() => expect(interactiveMode.activateHosted).toHaveBeenCalledOnce());
			const token = (parseOutput().find((record) => record.id === "attach")?.data as { token: string }).token;
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

			let finishActivation: (() => void) | undefined;
			activateHosted.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishActivation = resolve;
					}),
			);
			rpcIo.lineHandler?.(JSON.stringify({ id: "attach-race", type: "attach_tui" }));
			await vi.waitFor(() => expect(activateHosted).toHaveBeenCalledTimes(3));
			usr2?.("SIGUSR2");
			expect(interactiveMode.deactivateHosted).toHaveBeenCalledTimes(2);
			finishActivation?.();
			await vi.waitFor(() => expect(interactiveMode.deactivateHosted).toHaveBeenCalledTimes(3));
			await vi.waitFor(() =>
				expect(parseOutput().filter((record) => record.type === "tui_detached")).toHaveLength(3),
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
