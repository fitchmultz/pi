import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Working-session admission with stacked extension dialogs", () => {
	const harnesses: Harness[] = [];
	const modes: InteractiveMode[] = [];
	afterEach(() => {
		while (modes.length) modes.pop()!.stop("resume-hint");
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	async function setup() {
		let ctx!: ExtensionContext;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, context) => {
						ctx = context;
					});
				},
			],
		});
		harnesses.push(h);
		initTheme("dark");
		const terminal = new VirtualTerminal(80, 40);
		const status = vi.spyOn(terminal, "setProgramStatus");
		const mode = new InteractiveMode(
			{
				session: h.session,
				setBeforeSessionInvalidate() {},
				setRebindSession() {},
			} as unknown as AgentSessionRuntime,
			{ terminal, tuiMode: "regular" },
		);
		modes.push(mode);
		const view = mode as unknown as {
			isInitialized: boolean;
			isShuttingDown: boolean;
			defaultEditor: CustomEditor;
			ui: TUI;
			editorContainer: { children: Component[] };
			rebindCurrentSession(): Promise<void>;
		};
		view.isInitialized = true;
		// No process stdin in this fixture; native dialog/draft readiness remains active.
		view.isShuttingDown = true;
		await view.rebindCurrentSession();
		return { h, ctx, view, status };
	}

	// #11166: use the public extension UI wrapper, real TUI focus dispatch, and native save admission together.
	it("keeps acquisition pending after a hidden abort until every remaining dialog is answered", async () => {
		const { h, ctx, view, status } = await setup();
		const abort = new AbortController();
		const first = ctx.ui.confirm("First", "Hidden permission", { signal: abort.signal });
		const second = ctx.ui.input("Second");
		const third = ctx.ui.editor("Third", "editor answer");
		const fourth = ctx.ui.select("Fourth", ["selected answer"]);
		expect(h.session.extensionRunner.hasPendingUI).toBe(true);
		let acquired = false;
		const acquisition = h.session.acquireWorkingSession().then((hold) => {
			acquired = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acquired).toBe(false);

		abort.abort();
		await expect(first).resolves.toBe(false);
		expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", message: "Fourth" }));
		expect(acquired).toBe(false);
		view.ui.dispatchInput("\r");
		await expect(fourth).resolves.toBe("selected answer");
		expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", message: "Third" }));
		view.ui.dispatchInput("\r");
		await expect(third).resolves.toBe("editor answer");
		expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", message: "Second" }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acquired).toBe(false);
		expect(h.session.extensionRunner.hasPendingUI).toBe(true);
		view.ui.dispatchInput("input answer");
		view.ui.dispatchInput("\r");
		await expect(second).resolves.toBe("input answer");
		const hold = await acquisition;
		try {
			expect(hold.sleepReady).toBe(true);
			expect(h.session.extensionRunner.hasPendingUI).toBe(false);
			expect(view.editorContainer.children).toEqual([view.defaultEditor]);
		} finally {
			await hold.release();
		}
	});

	// #9909: closing a hidden inline component must not dismiss a confirm above it.
	it("removes a hidden custom component without granting a save or replacing the top dialog", async () => {
		const { h, ctx, view, status } = await setup();
		const dispose = vi.fn();
		let done!: (result: string) => void;
		const component = Object.assign(new Text("Custom form"), { dispose });
		const custom = ctx.ui.custom<string>((_ui, _theme, _keys, finish) => {
			done = finish;
			return component;
		});
		await vi.waitFor(() => expect(view.editorContainer.children).toEqual([component]));
		const confirm = ctx.ui.confirm("Keep waiting?", "A visible prompt");
		const top = view.editorContainer.children[0];
		let acquired = false;
		const acquisition = h.session.acquireWorkingSession().then((hold) => {
			acquired = true;
			return hold;
		});
		done("closed behind confirm");
		await expect(custom).resolves.toBe("closed behind confirm");
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(view.editorContainer.children).toEqual([top]);
		expect(status).toHaveBeenLastCalledWith(
			expect.objectContaining({ state: "blocked", kind: "permission", message: "Keep waiting?" }),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acquired).toBe(false);
		view.ui.dispatchInput("\x1b");
		await expect(confirm).resolves.toBe(false);
		const hold = await acquisition;
		try {
			expect(hold.sleepReady).toBe(true);
			expect(view.editorContainer.children).toEqual([view.defaultEditor]);
		} finally {
			await hold.release();
		}
	});
});
