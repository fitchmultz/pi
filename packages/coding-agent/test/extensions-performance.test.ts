import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionContext,
	ExtensionError,
	ExtensionFactory,
	ExtensionUIContext,
} from "../src/core/extensions/types.ts";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

async function runnerFor(factories: ExtensionFactory[]) {
	const runtime = createExtensionRuntime();
	const extensions = await Promise.all(
		factories.map((factory, index) =>
			loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime, `extension-${index}`),
		),
	);
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
						await Promise.resolve();
						now += duration;
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
		},
	);

	it("retains fail-closed errors even when a handler exceeds its budget", async () => {
		let now = 0;
		const runner = await runnerFor([
			(pi) => {
				pi.on("tool_call", () => {
					now += 101;
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
				expect(disposed).toEqual(["first", "first"]);
				expect(invalidated).toEqual(["first", "first", "second"]);
			} finally {
				footer?.dispose?.();
				footerData.dispose();
			}
		},
	);
});
