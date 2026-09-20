import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type OverlayHandle, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { startCheckpointControl } from "../../src/cli/checkpoint-control.ts";
import { createAgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { readSessionCheckpoint } from "../../src/core/checkpoint.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { BorderedLoader } from "../../src/modes/interactive/components/bordered-loader.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

vi.mock("../../src/utils/tools-manager.ts", () => ({ ensureTool: async () => undefined }));
const modes: InteractiveMode[] = [];
const harnesses: Harness[] = [];
const directories: string[] = [];
const sockets: Socket[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const close of closers.splice(0)) close();
	for (const mode of modes.splice(0)) mode.stop("resume-hint");
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup(options: HarnessOptions = {}) {
	vi.stubEnv("PI_OFFLINE", "1");
	vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
	const pause = vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	const resume = vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	initTheme("dark");
	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-ui-"));
	directories.push(directory);
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	const h = await createHarness({
		...options,
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		settings: { quietStartup: true, compaction: { enabled: false }, retry: { enabled: false }, ...options.settings },
	});
	harnesses.push(h);
	const runtime = await createAgentSessionRuntime(
		async () => ({
			session: h.session,
			extensionsResult: h.session.resourceLoader.getExtensions(),
			services: {
				cwd: h.tempDir,
				agentDir: directory,
				modelRuntime: h.session.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		}),
		{ cwd: h.tempDir, agentDir: directory, sessionManager: h.sessionManager },
	);
	const terminal = new VirtualTerminal(100, 30);
	const mode = new InteractiveMode(runtime, { terminal });
	modes.push(mode);
	await mode.init();
	return {
		h,
		mode,
		terminal,
		pause,
		resume,
		directory,
		acquire: (boundary: "turn" | "settled" = "settled") =>
			h.session.acquireCheckpoint({
				boundary,
				canQuiesce: () => mode.canQuiesceForCheckpoint(),
				quiesce: () => mode.quiesceForCheckpoint(),
			}),
	};
}

async function control(f: Awaited<ReturnType<typeof setup>>) {
	const socketPath = join(f.directory, "s");
	closers.push(
		await startCheckpointControl({
			path: socketPath,
			getSession: () => f.h.session,
			quiesce: () => f.mode.quiesceForCheckpoint(),
			canQuiesce: () => f.mode.canQuiesceForCheckpoint(),
		}),
	);
	const socket = connect(socketPath);
	sockets.push(socket);
	socket.setEncoding("utf8");
	let buffer = "";
	const lines: Array<Record<string, unknown>> = [];
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop()!;
		for (const part of parts) lines.push(JSON.parse(part) as Record<string, unknown>);
	});
	return {
		send: (request: object) => socket.write(`${JSON.stringify(request)}\n`),
		next: async () => {
			await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
			return lines.shift()!;
		},
	};
}

describe("native checkpoint TUI boundary", () => {
	it.skipIf(process.platform === "win32").each(["Task complete.", "Which approach should I use?"])(
		"publishes positive native readiness for %s",
		async (answer) => {
			const f = await setup();
			f.h.setResponses([fauxAssistantMessage(answer)]);
			await f.h.session.prompt("Work naturally");
			await f.h.session.steer("accepted for Monday");
			const selected = f.h.sessionManager.getLeafId();
			f.h.sessionManager.appendMessage(fauxAssistantMessage("other branch"));
			f.h.sessionManager.branch(selected!);
			const client = await control(f);
			const path = join(f.directory, "checkpoint.json");
			client.send({ action: "acquire", boundary: "turn", path });
			expect(await client.next()).toMatchObject({ ok: true, boundary: "settled", settled: true, sleepReady: true });
			const saved = readSessionCheckpoint(path);
			expect(saved.selection.leafId).toBe(selected);
			expect(saved.queues.steering).toHaveLength(1);
			await f.terminal.waitForRender();
			expect(f.terminal.getViewport().join("\n")).toContain(answer);
			f.terminal.sendInput("x");
			expect(await client.next()).toMatchObject({ ok: false, invalidated: true });
			expect(f.mode.getExtensionUIContext().getEditorText()).toBe("x");
		},
	);

	it("waits for a model selector callback even after Escape dismisses the selector", async () => {
		const entered = deferred();
		const finish = deferred();
		const f = await setup({
			models: [{ id: "first" }, { id: "second" }],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						entered.resolve();
						await finish.promise;
						pi.appendEntry("model-tail", { saved: true });
					});
				},
			],
		});
		f.terminal.sendInput("\x0c"); // configured native Ctrl+L
		f.terminal.sendInput("\x1b[B");
		f.terminal.sendInput("\r");
		await entered.promise;
		f.terminal.sendInput("\x1b");
		let ready = false;
		const acquisition = f.acquire().then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.mode.canQuiesceForCheckpoint()).toBe(false);
		expect(ready).toBe(false);
		finish.resolve();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("model-tail");
		hold.release();
	});

	it("owns login after the auth dialog closes through its detached catalog continuation", async () => {
		const f = await setup();
		const login = deferred();
		const catalog = deferred();
		const catalogEntered = deferred();
		vi.spyOn(f.h.session.modelRuntime, "login").mockImplementation(async () => {
			await login.promise;
			return { type: "oauth", access: "test", refresh: "test", expires: Date.now() + 100000 };
		});
		vi.spyOn(f.h.session.modelRuntime, "refresh").mockImplementation(async () => {
			catalogEntered.resolve();
			await catalog.promise;
			return { aborted: false, errors: new Map() };
		});
		// Invoke the native selector's continuation; dialog rendering/auth dispatch remain real.
		const mode = f.mode as unknown as {
			startProviderLogin(option: { id: string; name: string; authType: "oauth" }): Promise<void>;
		};
		const loggingIn = mode.startProviderLogin({ id: "test", name: "Test OAuth", authType: "oauth" });
		let ready = false;
		const acquisition = f.acquire().then((hold) => {
			ready = true;
			return hold;
		});
		expect(f.mode.canQuiesceForCheckpoint()).toBe(false);
		login.resolve();
		await catalogEntered.promise;
		await loggingIn;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		expect(f.mode.canQuiesceForCheckpoint()).toBe(false);
		catalog.resolve();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		hold.release();
	});

	it.each(["command", "shortcut"])("owns an asynchronous extension %s after its dialog closes", async (kind) => {
		const entered = deferred();
		const finish = deferred();
		const f = await setup({
			extensionFactories: [
				(pi) => {
					const handler = async (ctx: ExtensionContext) => {
						await ctx.ui.select("Extension callback dialog", ["Continue"]);
						entered.resolve();
						await finish.promise;
						pi.appendEntry("callback-tail", { saved: true });
					};
					pi.registerCommand("held", { handler: (_args, ctx) => handler(ctx) });
					pi.registerShortcut("ctrl+shift+y", { handler });
				},
			],
		});
		if (kind === "command") {
			// Native prompt loop consumes the text submitted through the real editor.
			const submitted = f.mode.getUserInput().then((text) => f.h.session.prompt(text));
			f.terminal.sendInput("/held");
			f.terminal.sendInput("\r");
			void submitted;
		} else f.terminal.sendInput("\x1b[121;6u");
		await vi.waitFor(() => expect(f.terminal.getViewport().join("\n")).toContain("Extension callback dialog"));
		f.terminal.sendInput("\r");
		await entered.promise;
		let ready = false;
		const acquisition = f.acquire().then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		finish.resolve();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("callback-tail");
		hold.release();
	});

	it("waits for an actual question tool and its asynchronous custom UI factory", async () => {
		const factory = deferred();
		const entered = deferred();
		let close!: () => void;
		const f = await setup({
			extensionFactories: [
				(pi) =>
					pi.registerTool({
						name: "question",
						label: "Question",
						description: "Ask a question",
						parameters: Type.Object({}),
						async execute(_id, _args, _signal, _update, ctx) {
							await ctx.ui.custom(async (_tui, _theme, _keys, done) => {
								close = () => done(undefined);
								entered.resolve();
								await factory.promise;
								return new Text("Live question tool");
							});
							return { content: [{ type: "text", text: "answered" }], details: {} };
						},
					}),
			],
		});
		f.h.setResponses([
			fauxAssistantMessage([fauxToolCall("question", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Question answered. Task complete."),
		]);
		const running = f.h.session.prompt("Ask");
		await entered.promise;
		let ready = false;
		const acquisition = f.acquire().then((hold) => {
			ready = true;
			return hold;
		});
		factory.resolve();
		await f.terminal.waitForRender();
		expect(f.terminal.getViewport().join("\n")).toContain("Live question tool");
		expect(ready).toBe(false);
		close();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		hold.release();
		await running;
	});

	it("resolves overlay options after the async factory initializes its component", async () => {
		const f = await setup();
		let component!: Text & { width: number };
		let close!: () => void;
		const overlayOptions = vi.fn(() => ({ width: component.width }));
		await expect(
			f.mode.getExtensionUIContext().custom(
				async (_tui, _theme, _keys, done) => {
					close = () => done(undefined);
					await Promise.resolve();
					component = Object.assign(new Text("Factory initialized"), { width: 37 });
					return component;
				},
				{ overlay: true, overlayOptions, onHandle: () => close() },
			),
		).resolves.toBeUndefined();
		expect(overlayOptions).toHaveBeenCalledTimes(1);
	});

	it("does not focus a resolved passive parent after its child closes", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const factory = deferred();
		const parentInputs: string[] = [];
		let closeParent!: () => void;
		let child!: OverlayHandle;
		let ready!: OverlayHandle;
		const parent = ui.custom(
			async (tui, _theme, _keys, done) => {
				closeParent = () => done(undefined);
				child = tui.showOverlay(new Text("Child"));
				await factory.promise;
				return {
					render: () => ["Passive parent"],
					invalidate() {},
					handleInput: (data) => parentInputs.push(data),
				};
			},
			{
				overlay: true,
				overlayOptions: () => ({ nonCapturing: true }),
				onHandle: (h) => {
					ready = h;
				},
			},
		);
		await f.terminal.waitForRender();
		factory.resolve();
		await vi.waitFor(() => expect(ready).toBeDefined());
		child.hide();
		f.terminal.sendInput("x");
		closeParent();
		await parent;
		expect(parentInputs).toEqual([]);
		expect(ui.getEditorText()).toBe("x");
	});

	it("preserves the resolved options getter receiver", async () => {
		const f = await setup();
		class Options {
			#width = 37;
			get width() {
				return this.#width;
			}
		}
		let render!: () => void;
		let close!: () => void;
		await expect(
			f.mode.getExtensionUIContext().custom(
				(tui, _theme, _keys, done) => {
					render = () => tui.renderNow();
					close = () => done(undefined);
					return new Text("Getter receiver");
				},
				{
					overlay: true,
					overlayOptions: () => new Options(),
					onHandle: () => {
						render();
						close();
					},
				},
			),
		).resolves.toBeUndefined();
	});

	it("keeps resolved overlay option getters and later mutations live", async () => {
		const f = await setup();
		let close!: () => void;
		let handle!: OverlayHandle;
		let width = 37;
		let height = 2;
		const options = {
			get width() {
				return width;
			},
			get maxHeight() {
				return height;
			},
			col: 3,
		};
		const resolveOptions = vi.fn(() => options);
		const dialog = f.mode.getExtensionUIContext().custom(
			(_tui, _theme, _keys, done) => {
				close = () => done(undefined);
				return new Text("one\ntwo\nthree", 0, 0);
			},
			{
				overlay: true,
				overlayOptions: resolveOptions,
				onHandle: (h) => {
					handle = h;
				},
			},
		);
		await f.terminal.waitForRender();
		expect(handle.getBounds()).toMatchObject({ width: 37, height: 2, col: 3 });
		width = 49;
		height = 3;
		options.col = 7;
		f.terminal.sendInput("redraw");
		await f.terminal.waitForRender();
		expect(handle.getBounds()).toMatchObject({ width: 49, height: 3, col: 7 });
		expect(resolveOptions).toHaveBeenCalledTimes(1);
		close();
		await dialog;
	});

	it.each([false, true])(
		"focuses static options made visible by factory completion without stealing child focus: %s",
		async (withChild) => {
			const f = await setup();
			let visible = false;
			let close!: () => void;
			let handle!: OverlayHandle;
			let child: OverlayHandle | undefined;
			const inputs: string[] = [];
			const dialog = f.mode.getExtensionUIContext().custom(
				async (tui, _theme, _keys, done) => {
					close = () => done(undefined);
					if (withChild) child = tui.showOverlay(new Text("Child"));
					await Promise.resolve();
					visible = true;
					return { render: () => ["Visible"], invalidate() {}, handleInput: (data) => inputs.push(data) };
				},
				{
					overlay: true,
					overlayOptions: { visible: () => visible },
					onHandle: (h) => {
						handle = h;
					},
				},
			);
			await f.terminal.waitForRender();
			expect(handle.isFocused()).toBe(!withChild);
			if (child) {
				expect(child.isFocused()).toBe(true);
				f.terminal.sendInput("child input");
				expect(inputs).toEqual([]);
				child.hide();
			}
			f.terminal.sendInput("x");
			expect(handle.isFocused()).toBe(true);
			expect(inputs).toEqual(["x"]);
			expect(f.mode.getExtensionUIContext().getEditorText()).toBe("");
			close();
			await dialog;
		},
	);

	it("snapshots the default overlay width after factory completion", async () => {
		const f = await setup();
		const factory = deferred();
		const component = Object.assign(new Text("Default width"), { width: 17 });
		let close!: () => void;
		let handle!: OverlayHandle;
		const dialog = f.mode.getExtensionUIContext().custom(
			async (_tui, _theme, _keys, done) => {
				close = () => done(undefined);
				await factory.promise;
				component.width = 37;
				return component;
			},
			{
				overlay: true,
				onHandle: (h) => {
					handle = h;
				},
			},
		);
		factory.resolve();
		await f.terminal.waitForRender();
		expect(handle.getBounds()?.width).toBe(37);
		component.width = 49;
		f.terminal.sendInput("redraw");
		await f.terminal.waitForRender();
		expect(handle.getBounds()?.width).toBe(37);
		close();
		await dialog;
	});

	it.each([false, true])("reserves custom UI input before awaiting the factory (overlay: %s)", async (overlay) => {
		const factory = deferred();
		let shortcuts = 0;
		const f = await setup({
			extensionFactories: [
				(pi) =>
					pi.registerShortcut("ctrl+shift+e", {
						handler: (ctx) => {
							shortcuts++;
							ctx.ui.setEditorText("");
						},
					}),
			],
		});
		const ui = f.mode.getExtensionUIContext();
		ui.setEditorText("pending draft");
		let close!: () => void;
		const dialog = ui.custom(
			async (_tui, _theme, _keys, done) => {
				close = () => done(undefined);
				await factory.promise;
				return new Text("Pending factory mounted");
			},
			{ overlay },
		);
		f.terminal.sendInput("\x1b[101;6u");
		f.terminal.sendInput("x");
		expect(shortcuts).toBe(0);
		expect(ui.getEditorText()).toBe("pending draft");
		expect(f.mode.canQuiesceForCheckpoint()).toBe(false);
		factory.resolve();
		await f.terminal.waitForRender();
		f.terminal.sendInput("\x1b[101;6u");
		expect(shortcuts).toBe(0);
		close();
		await dialog;
		expect(ui.getEditorText()).toBe("pending draft");
		ui.setEditorText("");
		const hold = await f.acquire();
		expect(hold.sleepReady).toBe(true);
		hold.release();
		f.terminal.sendInput("\x1b[101;6u");
		await vi.waitFor(() => expect(shortcuts).toBe(1));
	});

	it.each(["passive", "invisible", "dynamic-passive", "dynamic-invisible"])(
		"preserves %s overlay input semantics after provisional ownership",
		async (kind) => {
			const f = await setup();
			const ui = f.mode.getExtensionUIContext();
			const factory = deferred();
			let close!: () => void;
			let handle!: OverlayHandle;
			const component = {
				focused: false,
				inputs: [] as string[],
				render: () => ["NONMODAL"],
				invalidate() {},
				handleInput(data: string) {
					this.inputs.push(data);
				},
			};
			const dynamic = kind.startsWith("dynamic-");
			const invisible = kind.endsWith("invisible");
			const opts = invisible ? { visible: () => false } : { nonCapturing: true };
			const dialog = ui.custom(
				async (_tui, _theme, _keys, done) => {
					close = () => done(undefined);
					await factory.promise;
					return component;
				},
				{
					overlay: true,
					overlayOptions: dynamic ? () => opts : opts,
					onHandle: (h) => {
						handle = h;
					},
				},
			);
			f.terminal.sendInput("x");
			expect(ui.getEditorText()).toBe(dynamic ? "" : "x");
			ui.setEditorText("");
			factory.resolve();
			await vi.waitFor(() => expect(handle).toBeDefined());
			handle.setHidden(true);
			handle.setHidden(false);
			f.terminal.sendInput("y");
			expect(ui.getEditorText()).toBe("y");
			if (!invisible) {
				handle.focus();
				f.terminal.sendInput("z");
				expect(component.focused).toBe(true);
				expect(component.inputs).toEqual(["z"]);
				handle.unfocus();
				f.terminal.sendInput("w");
				expect(ui.getEditorText()).toBe("yw");
			}
			close();
			await dialog;
		},
	);

	it.each([false, true])("releases rejected factories and ignores late done (overlay: %s)", async (overlay) => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const factory = deferred();
		let close!: () => void;
		const dialog = ui.custom(
			async (_tui, _theme, _keys, done) => {
				close = () => done(undefined);
				await factory.promise;
				throw new Error("factory failed");
			},
			{ overlay },
		);
		const rejection = expect(dialog).rejects.toThrow("factory failed");
		f.terminal.sendInput("lost");
		expect(ui.getEditorText()).toBe("");
		factory.resolve();
		await rejection;
		f.terminal.sendInput("restored");
		close();
		expect(ui.getEditorText()).toBe("restored");
		ui.setEditorText("");
		const hold = await f.acquire();
		expect(hold.sleepReady).toBe(true);
		hold.release();
	});

	it.each([false, true])(
		"early done releases input, not unfinished factory ownership (overlay: %s)",
		async (overlay) => {
			const f = await setup();
			const ui = f.mode.getExtensionUIContext();
			const factory = deferred();
			const dispose = vi.fn();
			const overlayOptions = vi.fn(() => ({ width: 37 }));
			await ui.custom(
				async (_tui, _theme, _keys, done) => {
					done(undefined);
					await factory.promise;
					return { render: () => ["must never mount"], invalidate() {}, dispose };
				},
				{ overlay, overlayOptions },
			);
			f.terminal.sendInput("ordinary input");
			expect(ui.getEditorText()).toBe("ordinary input");
			ui.setEditorText("");
			let ready = false;
			const acquisition = f.acquire().then((hold) => {
				ready = true;
				return hold;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(ready).toBe(false);
			expect(f.mode.canQuiesceForCheckpoint()).toBe(false);
			factory.resolve();
			const hold = await acquisition;
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(overlayOptions).not.toHaveBeenCalled();
			expect(hold.sleepReady).toBe(true);
			hold.release();
		},
	);

	it.each([false, true])("keeps nested overlay ownership (close parent first: %s)", async (parentFirst) => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const factory = deferred();
		let closeParent!: () => void;
		let closeChild!: () => void;
		let child!: Promise<void>;
		const parentInputs: string[] = [];
		const childInputs: string[] = [];
		const parent = ui.custom(
			async (_tui, _theme, _keys, done) => {
				closeParent = () => done(undefined);
				child = ui.custom(
					(_a, _b, _c, doneChild) => {
						closeChild = () => doneChild(undefined);
						return { render: () => ["CHILD"], invalidate() {}, handleInput: (data) => childInputs.push(data) };
					},
					{ overlay: true },
				);
				await factory.promise;
				return { render: () => ["PARENT"], invalidate() {}, handleInput: (data) => parentInputs.push(data) };
			},
			{ overlay: true, overlayOptions: () => ({ width: 50 }) },
		);
		await f.terminal.waitForRender();
		f.terminal.sendInput("a");
		factory.resolve();
		await f.terminal.waitForRender();
		f.terminal.sendInput("b");
		expect(parentInputs).toEqual([]);
		expect(childInputs).toEqual(["a", "b"]);
		if (parentFirst) {
			closeParent();
			await parent;
			f.terminal.sendInput("c");
			expect(childInputs).toEqual(["a", "b", "c"]);
		} else {
			closeChild();
			await child;
			f.terminal.sendInput("c");
			expect(parentInputs).toEqual(["c"]);
		}
		expect(f.mode.canQuiesceForCheckpoint()).toBe(false);
		closeParent();
		closeChild();
		await Promise.all([parent, child]);
		f.terminal.sendInput("d");
		expect(ui.getEditorText()).toBe("d");
	});

	it("restores a visible overlay after a pending replacement rejects", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const factory = deferred();
		const inputs: string[] = [];
		let close!: () => void;
		const overlay = ui.custom(
			(_a, _b, _c, done) => {
				close = () => done(undefined);
				return { render: () => ["OVERLAY"], invalidate() {}, handleInput: (data) => inputs.push(data) };
			},
			{ overlay: true },
		);
		await f.terminal.waitForRender();
		const replacement = ui.custom(async () => {
			await factory.promise;
			throw new Error("cancelled");
		});
		const rejection = expect(replacement).rejects.toThrow("cancelled");
		f.terminal.sendInput("blocked");
		expect(inputs).toEqual([]);
		factory.resolve();
		await rejection;
		f.terminal.sendInput("resumed");
		expect(inputs).toEqual(["resumed"]);
		close();
		await overlay;
	});

	it("pending cancellation releases focus while a rejected cleanup tail still blocks capture", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const finish = deferred();
		let cancel!: () => void;
		const dialog = ui.custom(
			async (_a, _b, _c, done) => {
				cancel = () => done(null);
				await finish.promise;
				throw new Error("cancelled cleanup");
			},
			{ overlay: true },
		);
		f.terminal.sendInput("blocked");
		expect(ui.getEditorText()).toBe("");
		cancel();
		expect(await dialog).toBe(null);
		f.terminal.sendInput("released");
		expect(ui.getEditorText()).toBe("released");
		ui.setEditorText("");
		let ready = false;
		const acquisition = f.acquire().then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		finish.resolve();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		hold.release();
	});

	it.each(["options", "handle"])("cleans up when the overlay %s callback throws", async (kind) => {
		const f = await setup();
		const dispose = vi.fn();
		const ui = f.mode.getExtensionUIContext();
		await expect(
			ui.custom(() => ({ render: () => ["UI"], invalidate() {}, dispose }), {
				overlay: true,
				overlayOptions: () => {
					if (kind === "options") throw new Error("options failed");
					return {};
				},
				onHandle: () => {
					throw new Error("handle failed");
				},
			}),
		).rejects.toThrow(`${kind} failed`);
		expect(dispose).toHaveBeenCalledTimes(1);
		f.terminal.sendInput("restored");
		expect(ui.getEditorText()).toBe("restored");
	});

	it("ordinary loader cancellation transfers input immediately", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		let loader!: BorderedLoader;
		const dialog = ui.custom((_tui, theme, _keys, done) => {
			loader = new BorderedLoader(_tui, theme, "Cancellable work");
			loader.onAbort = () => done(null);
			return loader;
		});
		await f.terminal.waitForRender();
		f.terminal.sendInput("\x1b");
		expect(await dialog).toBe(null);
		expect(loader.signal.aborted).toBe(true);
		f.terminal.sendInput("after cancellation");
		expect(ui.getEditorText()).toBe("after cancellation");
	});

	it("joins an async custom UI factory even when it calls done before its final write", async () => {
		const f = await setup();
		const finish = deferred();
		const dialog = f.mode.getExtensionUIContext().custom(async (_tui, _theme, _keys, done) => {
			done(undefined);
			await finish.promise;
			f.h.sessionManager.appendCustomEntry("factory-tail", { saved: true });
			return new Text("already closed");
		});
		await dialog;
		let ready = false;
		const acquisition = f.acquire().then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		finish.resolve();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("factory-tail");
		hold.release();
	});

	it("includes awaited checkpoint extension entries/files and invalidates before a late callback", async () => {
		const entered = deferred();
		const finish = deferred();
		let api!: ExtensionAPI;
		let extensionFile = "";
		const f = await setup({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("session_shutdown", () => {});
					pi.on("session_checkpoint", async () => {
						entered.resolve();
						await finish.promise;
						writeFileSync(extensionFile, "persisted extension state");
						pi.appendEntry("checkpoint-state", { complete: true });
						return { sleepReady: true };
					});
				},
			],
		});
		extensionFile = join(f.directory, "extension.json");
		const acquisition = f.acquire();
		await entered.promise;
		finish.resolve();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		expect(readFileSync(extensionFile, "utf8")).toBe("persisted extension state");
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("checkpoint-state");
		expect(() => api.appendEntry("late", {})).toThrow("hold invalidated");
		expect(hold.signal.aborted).toBe(true);
		expect(JSON.stringify(f.h.sessionManager.getEntries())).not.toContain('"customType":"late"');
	});

	it.each([false, true])(
		"keeps unsupported shutdown/memory-only state alive (explicit blocker: %s)",
		async (explicit) => {
			const f = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", () => {});
						if (explicit)
							pi.on("session_checkpoint", () => ({ sleepReady: false, reason: "memory-only callback" }));
					},
				],
			});
			const hold = await f.acquire();
			expect(hold.sleepReady).toBe(false);
			expect(hold.sleepBlockers.join(" ")).toContain(explicit ? "memory-only callback" : "requires shutdown");
			hold.release();
		},
	);

	it("defers an explicit settled request until a draft is cleared without consuming it", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		ui.setEditorText("unsent native draft");
		let ready = false;
		const acquisition = f.acquire().then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		expect(ui.getEditorText()).toBe("unsent native draft");
		ui.setEditorText("");
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		hold.release();
	});

	it("invalidates a positive cut before a captured extension UI setter applies a late draft", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const hold = await f.acquire();
		expect(hold.sleepReady).toBe(true);
		ui.setEditorText("late draft");
		expect(hold.signal.aborted).toBe(true);
		expect(ui.getEditorText()).toBe("late draft");
	});

	it.each(["steer", "followUp"])("does not drop normal %s input racing with an active-turn hold", async (kind) => {
		const entered = deferred();
		const finish = deferred();
		const f = await setup();
		f.h.setResponses([
			async () => {
				entered.resolve();
				await finish.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("continued"),
		]);
		const running = f.h.session.prompt("start");
		await entered.promise;
		const acquisition = f.acquire("turn");
		finish.resolve();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(false);
		expect(hold.checkpoint.boundary).toBe("turn");
		f.terminal.sendInput("accepted racing input");
		f.terminal.sendInput(kind === "steer" ? "\r" : "\x1b\r");
		expect(hold.signal.aborted).toBe(true);
		await running;
		expect(
			f.h.session.messages.filter(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("accepted racing input"),
			),
		).toHaveLength(1);
		await f.terminal.waitForRender();
		expect(f.terminal.getViewport().join("\n")).not.toContain("held for checkpoint");
	});
	it("holds native input and retains restored pending display without replacing the TUI", async () => {
		const f = await setup();
		await f.h.session.steer("visible accepted steering");
		await f.h.session.sendCustomMessage(
			{ customType: "next", content: "retained", display: true },
			{ deliverAs: "nextTurn" },
		);
		f.mode.renderInitialMessages();
		await f.terminal.waitForRender();
		const screen = f.terminal.getViewport().join("\n");
		expect(screen).toContain("Steering: visible accepted steering");
		expect(screen).toContain("Next-turn context: 1");
		const hold = await f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() });
		expect(f.pause).toHaveBeenCalled();
		expect(hold.sleepReady).toBe(true);
		expect(hold.checkpoint.queues.steering).toHaveLength(1);
		hold.release();
		expect(f.resume).toHaveBeenCalled();
		expect(f.h.session.getSteeringMessages()).toEqual(["visible accepted steering"]);
	});

	it("invalidates a cut before a previously decoded key reaches extension input listeners", async () => {
		const f = await setup();
		const observations: boolean[] = [];
		f.mode.getExtensionUIContext().onTerminalInput(() => {
			observations.push(f.h.session.isCheckpointHeld);
			return undefined;
		});
		const hold = await f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() });
		f.terminal.sendInput("x");
		expect(hold.signal.aborted).toBe(true);
		expect(observations).toEqual([false]);
		expect(f.mode.getExtensionUIContext().getEditorText()).toBe("x");
	});

	it("rejects real extension dialogs and draft image paths rather than losing their callbacks/files", async () => {
		const f = await setup();
		const ui = f.mode.getExtensionUIContext();
		const controller = new AbortController();
		const dialog = ui.input("Live question", undefined, { signal: controller.signal });
		await expect(f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() })).rejects.toThrow(
			"live UI",
		);
		expect(f.h.session.isCheckpointHeld).toBe(false);
		controller.abort();
		await dialog;
		ui.setEditorText("/tmp/pi-clipboard-unsubmitted.png");
		await expect(f.h.session.acquireCheckpoint({ quiesce: () => f.mode.quiesceForCheckpoint() })).rejects.toThrow(
			"unsent draft",
		);
		expect(ui.getEditorText()).toBe("/tmp/pi-clipboard-unsubmitted.png");
	});
});
