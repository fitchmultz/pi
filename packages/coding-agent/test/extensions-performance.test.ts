import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner, emitProjectTrustEvent } from "../src/core/extensions/runner.ts";
import type {
	ExtensionContext,
	ExtensionError,
	ExtensionFactory,
	ExtensionUIContext,
} from "../src/core/extensions/types.ts";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

async function extensionsFor(factories: ExtensionFactory[]) {
	const runtime = createExtensionRuntime();
	const extensions = await Promise.all(
		factories.map((factory, index) =>
			loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime, `extension-${index}`),
		),
	);
	return { extensions, runtime, errors: [] };
}

async function runnerFor(factories: ExtensionFactory[]) {
	const { extensions, runtime } = await extensionsFor(factories);
	return new ExtensionRunner(
		extensions,
		runtime,
		process.cwd(),
		SessionManager.inMemory(),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
}

afterEach(() => vi.restoreAllMocks());

describe("extension performance warnings", () => {
	it.each(["print", "rpc", "tui"] as const)(
		"warns once per extension and event without changing results in %s mode",
		async (mode) => {
			let now = 0;
			let duration = 100;
			const runner = await runnerFor(
				["first", "second"].map((name) => (pi) => {
					pi.on("input", async (event) => {
						now += duration;
						await Promise.resolve();
						return { action: "transform", text: `${event.text}/${name}` };
					});
					pi.on("agent_start", () => {
						now += duration;
					});
				}),
			);
			runner.setUIContext(undefined, mode);
			const warnings: ExtensionError[] = [];
			runner.onError((warning) => warnings.push(warning));
			runner.onError(() => {
				throw new Error("broken diagnostic listener");
			});
			vi.spyOn(performance, "now").mockImplementation(() => now);
			expect(await runner.emitInput("hello", undefined, "interactive")).toMatchObject({
				action: "transform",
				text: "hello/first/second",
			});
			expect(warnings).toEqual([]);
			duration = 101;
			for (let i = 0; i < 2; i++) {
				expect(await runner.emitInput("hello", undefined, "interactive")).toMatchObject({
					text: "hello/first/second",
				});
				await runner.emit({ type: "agent_start" });
			}
			expect(warnings.map(({ extensionPath, event }) => [extensionPath, event])).toEqual([
				["extension-0", "input"],
				["extension-1", "input"],
				["extension-0", "agent_start"],
				["extension-1", "agent_start"],
			]);
			expect(warnings.every((warning) => warning.error.startsWith("Non-fatal performance warning:"))).toBe(true);
			expect(warnings[0].error).toContain("blocked the event loop for 101.0 ms before returning or awaiting");
		},
	);

	it.each(["I/O", "UI prompt"])("does not warn for an awaited %s wait or work after await", async (wait) => {
		let now = 0;
		const pending = Promise.withResolvers<boolean>();
		const confirm = vi.fn(() => pending.promise);
		const runner = await runnerFor([
			(pi) => {
				pi.on("tool_call", async (_event, ctx) => {
					const allowed = await (wait === "I/O" ? pending.promise : ctx.ui.confirm("Allow?", "Run tool?"));
					now += 1000;
					return { block: !allowed };
				});
			},
		]);
		runner.setUIContext({ ...runner.getUIContext(), confirm }, "tui");
		const warnings: ExtensionError[] = [];
		runner.onError((warning) => warnings.push(warning));
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const result = runner.emitToolCall({ type: "tool_call", toolCallId: "call", toolName: "test", input: {} });
		expect(confirm).toHaveBeenCalledTimes(wait === "I/O" ? 0 : 1);
		now += 1000;
		pending.resolve(true);
		expect(await result).toEqual({ block: false });
		expect(warnings).toEqual([]);
	});

	it.each(["throw", "reject"])(
		"retains fail-closed %s errors even when a handler exceeds its budget",
		async (failure) => {
			let now = 0;
			const runner = await runnerFor([
				(pi) => {
					pi.on("tool_call", () => {
						now += 101;
						if (failure === "reject") {
							return Promise.resolve().then(() => {
								now += 1000;
								throw new Error("denied");
							});
						}
						throw new Error("denied");
					});
				},
			]);
			const warnings: ExtensionError[] = [];
			runner.onError((warning) => warnings.push(warning));
			runner.onError(() => {
				throw new Error("broken diagnostic listener");
			});
			vi.spyOn(performance, "now").mockImplementation(() => now);
			await expect(
				runner.emitToolCall({ type: "tool_call", toolCallId: "call", toolName: "test", input: {} }),
			).rejects.toThrow("denied");
			expect(warnings).toMatchObject([{ event: "tool_call" }]);
		},
	);

	it("times only synchronous project trust work without changing errors or the first decision", async () => {
		let now = 0;
		let duration = 100;
		const later = vi.fn(() => ({ trusted: "yes" as const }));
		const extensions = await extensionsFor([
			(pi) => {
				pi.on("project_trust", async () => {
					now += duration;
					await Promise.resolve();
					now += 1000;
					return { trusted: "undecided" };
				});
				pi.on("project_trust", () => {
					now += duration;
					throw new Error("sync failure");
				});
				pi.on("project_trust", async () => {
					await Promise.resolve();
					now += 1000;
					throw new Error("rejection");
				});
			},
			(pi) => {
				pi.on("project_trust", async (_event, ctx) => ({
					trusted: (await ctx.ui.confirm("Trust?", "Load project?")) ? "yes" : "no",
					remember: true,
				}));
				pi.on("project_trust", later);
			},
		]);
		const confirm = vi.fn(async () => {
			await Promise.resolve();
			now += 1000;
			return false;
		});
		vi.spyOn(performance, "now").mockImplementation(() => now);
		for (const expectedWarnings of [0, 1, 0]) {
			const result = await emitProjectTrustEvent(
				extensions,
				{ type: "project_trust", cwd: process.cwd() },
				{
					cwd: process.cwd(),
					mode: "tui",
					hasUI: true,
					ui: { confirm, select: async () => undefined, input: async () => undefined, notify: () => {} },
				},
			);
			expect(result.result).toEqual({ trusted: "no", remember: true });
			const warnings = result.errors.filter((error) => error.error.startsWith("Non-fatal performance warning:"));
			expect(warnings).toHaveLength(expectedWarnings);
			if (expectedWarnings) {
				expect(warnings[0]).toMatchObject({ extensionPath: "extension-0", event: "project_trust" });
				expect(warnings[0].error).toContain("101.0 ms before returning or awaiting");
			}
			expect(result.errors.filter((error) => !warnings.includes(error)).map((error) => error.error)).toEqual([
				"sync failure",
				"rejection",
			]);
			duration = 101;
		}
		expect(confirm).toHaveBeenCalledTimes(3);
		expect(later).not.toHaveBeenCalled();
	});

	it.each(["event", "command"] as const)(
		"times %s-owned footer renders, defers warnings, and preserves component lifecycle",
		async (owner) => {
			let now = 0;
			let duration = 16;
			const disposed: string[] = [];
			const invalidated: string[] = [];
			const runner = await runnerFor(
				["first", "second"].map((name) => (pi) => {
					const install = (ctx: ExtensionContext) => {
						ctx.ui.setFooter(() =>
							Object.freeze({
								render: (width: number) => {
									now += duration;
									return [`${name}:${width}`];
								},
								invalidate: () => invalidated.push(name),
								dispose: () => disposed.push(name),
							}),
						);
					};
					pi.on("input", (event, ctx) => {
						if (event.text === name) install(ctx);
					});
					pi.registerCommand(name, { handler: async (_args, ctx) => install(ctx) });
				}),
			);
			let footer: ReturnType<NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>> | undefined;
			const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
			const footerData = new FooterDataProvider(process.cwd());
			initTheme("dark");
			runner.setUIContext(
				{
					...runner.getUIContext(),
					setFooter: (factory) => {
						footer?.dispose?.();
						footer = factory?.(tui, theme, footerData);
					},
				},
				"tui",
			);
			const warnings: ExtensionError[] = [];
			runner.onError((warning) => warnings.push(warning));
			vi.spyOn(performance, "now").mockImplementation(() => now);
			try {
				for (const name of ["first", "first", "second"]) {
					if (owner === "command") await runner.getCommand(name)!.handler("", runner.createCommandContext());
					else await runner.emitInput(name, undefined, "interactive");
					duration = 16;
					expect(footer!.render(80)).toEqual([`${name}:80`]);
					const count = warnings.length;
					duration = 17;
					footer!.render(40);
					footer!.render(20);
					expect(warnings).toHaveLength(count);
					await Promise.resolve();
					footer!.invalidate();
				}
				expect(warnings.map(({ extensionPath, event }) => [extensionPath, event])).toEqual([
					["extension-0", "footer"],
					["extension-1", "footer"],
				]);
				expect(warnings[0].error).toContain("blocked the event loop for 17.0 ms during render");
				expect(disposed).toEqual(["first", "first"]);
				expect(invalidated).toEqual(["first", "first", "second"]);
			} finally {
				footer?.dispose?.();
				footerData.dispose();
			}
		},
	);

	it("keeps shortcut UI separate from the prompt-tracked runner UI", async () => {
		const prompts: (string | undefined)[] = [];
		const runner = await runnerFor([
			(pi) => {
				pi.registerShortcut("ctrl+shift+u", {
					handler: async (ctx) => void (await ctx.ui.confirm("Shortcut?", "")),
				});
				pi.on("tool_call", async (_event, ctx) => {
					expect(ctx.ui).toBe(ctx.ui);
					return { block: !(await ctx.ui.confirm("Allow?", "")) };
				});
				pi.on("ui_prompt_start", (event) => void prompts.push(event.title));
			},
		]);
		const runnerConfirm = vi.fn(async () => true);
		const shortcutConfirm = vi.fn(async () => true);
		runner.setUIContext({ ...runner.getUIContext(), confirm: runnerConfirm }, "tui");
		const shortcut = runner.getShortcuts(new KeybindingsManager().getEffectiveConfig()).get("ctrl+shift+u")!;
		// Interactive mode creates a fresh, untracked UI for each shortcut invocation.
		const pressShortcut = () =>
			shortcut.handler(
				Object.defineProperty(runner.createContext(), "ui", {
					value: { ...runner.getUIContext(), confirm: shortcutConfirm },
				}),
			);

		await pressShortcut();
		const result = await runner.emitToolCall({ type: "tool_call", toolCallId: "call", toolName: "test", input: {} });
		await pressShortcut();
		await new Promise((resolve) => setImmediate(resolve));
		expect(result).toEqual({ block: false });
		expect(runnerConfirm).toHaveBeenCalledTimes(1);
		expect(shortcutConfirm).toHaveBeenCalledTimes(2);
		expect(prompts).toEqual(["Allow?"]);
	});
});
