import { performance } from "node:perf_hooks";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionError, ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { theme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

async function createRunner(...factories: ExtensionFactory[]) {
	const runtime = createExtensionRuntime();
	const extensions = await Promise.all(
		factories.map((factory, index) =>
			loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime, `<inline:${index}>`),
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

describe("non-fatal extension performance warnings", () => {
	it("warns once per extension and event kind without changing results", async () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const factory: ExtensionFactory = (pi) => {
			pi.on("input", (event) => {
				now += 101;
				return { action: "transform", text: `${event.text}!` };
			});
			pi.on("agent_start", () => {
				now += 101;
			});
		};
		const runner = await createRunner(factory, factory);
		const warnings: ExtensionError[] = [];
		runner.onError((error) => warnings.push(error));
		for (let index = 0; index < 2; index++) {
			expect(await runner.emitInput("hi", undefined, "interactive")).toEqual({
				action: "transform",
				text: "hi!!",
				images: undefined,
			});
			await runner.emit({ type: "agent_start" });
		}
		expect(warnings.map(({ extensionPath, event }) => [extensionPath, event])).toEqual([
			["<inline:0>", "input"],
			["<inline:1>", "input"],
			["<inline:0>", "agent_start"],
			["<inline:1>", "agent_start"],
		]);
		expect(warnings.every((warning) => warning.error.includes("Non-fatal performance warning"))).toBe(true);
	});

	it("excludes awaited work and warns even when synchronous invocation throws", async () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const runner = await createRunner((pi) => {
			pi.on("input", async () => {
				await Promise.resolve();
				now += 1000;
				return { action: "handled" };
			});
			pi.on("agent_start", () => {
				now += 101;
				throw new Error("handler failure");
			});
		});
		const errors: ExtensionError[] = [];
		runner.onError((error) => errors.push(error));
		expect(await runner.emitInput("hi", undefined, "interactive")).toEqual({ action: "handled" });
		expect(errors).toEqual([]);
		await runner.emit({ type: "agent_start" });
		expect(errors).toHaveLength(2);
		expect(errors[1].error).toBe("handler failure");
	});

	it("defers a single footer warning until after rendering and preserves component methods", async () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const component = {
			value: "footer",
			render() {
				now += 17;
				return [this.value];
			},
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};
		const runner = await createRunner((pi) => {
			pi.on("session_start", (_event, ctx) => ctx.ui.setFooter(() => component));
		});
		let footer: (Component & { dispose?(): void }) | undefined;
		runner.setUIContext(
			{
				...runner.getUIContext(),
				setFooter: (factory) => {
					footer = factory?.(undefined as never, theme, undefined as never);
				},
			},
			"tui",
		);
		const warnings: ExtensionError[] = [];
		runner.onError((error) => warnings.push(error));
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(footer?.render(80)).toEqual(["footer"]);
		expect(footer?.render(80)).toEqual(["footer"]);
		expect(warnings).toEqual([]);
		await Promise.resolve();
		expect(warnings.map((warning) => warning.event)).toEqual(["footer"]);
		footer?.invalidate();
		footer?.dispose?.();
		expect(component.invalidate).toHaveBeenCalledOnce();
		expect(component.dispose).toHaveBeenCalledOnce();
	});
});
