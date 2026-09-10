import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompactionSettings } from "../../src/core/compaction/index.ts";
import type { ExtensionContext, ExtensionRunner } from "../../src/core/extensions/index.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "./harness.ts";

async function observeSettings(options: Parameters<typeof createHarness>[0]) {
	let seen: CompactionSettings | undefined;
	const harness = await createHarness({
		...options,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					seen = ctx.getCompactionSettings();
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		return { seen, effective: harness.settingsManager.getCompactionSettings() };
	} finally {
		harness.cleanup();
	}
}

describe("ctx.getCompactionSettings", () => {
	it.each(["event", "shortcut"] as const)("tracks active-model budgets through the %s context", async (path) => {
		let context: ExtensionContext | undefined;
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "second" }, { id: "ordinary" }],
			settings: {
				compaction: {
					enabled: false,
					reserveTokens: 5000,
					keepRecentTokens: 10000,
					modelOverrides: {
						"faux/first": { reserveTokens: 2000, keepRecentTokens: 1000 },
						"faux/second": { keepRecentTokens: 3000 },
					},
				},
			},
			extensionFactories: [
				(pi) => {
					const observe = (ctx: ExtensionContext) => {
						context = ctx;
					};
					pi.on("session_start", (_event, ctx) => observe(ctx));
					pi.registerShortcut("ctrl+shift+y", { handler: observe });
				},
			],
		});
		try {
			// Exercise native shortcut dispatch and context construction without starting a terminal.
			const view = Object.assign(Object.create(InteractiveMode.prototype), {
				runtimeHost: { session: harness.session },
				keybindings: new KeybindingsManager(),
				defaultEditor: {},
			}) as {
				setupExtensionShortcuts(runner: ExtensionRunner): void;
				defaultEditor: { onExtensionShortcut(data: string): boolean };
			};
			if (path === "event") await harness.session.bindExtensions({});
			else {
				view.setupExtensionShortcuts(harness.session.extensionRunner);
				expect(view.defaultEditor.onExtensionShortcut("\u001b[121;6u")).toBe(true);
			}
			expect(context?.getCompactionSettings()).toEqual({
				enabled: false,
				reserveTokens: 2000,
				keepRecentTokens: 1000,
			});
			await harness.session.setModel(harness.getModel("second")!);
			expect(context?.getCompactionSettings()).toEqual({
				enabled: false,
				reserveTokens: 5000,
				keepRecentTokens: 3000,
			});
			await harness.session.setModel(harness.getModel("ordinary")!);
			expect(context?.getCompactionSettings()).toEqual({
				enabled: false,
				reserveTokens: 5000,
				keepRecentTokens: 10000,
			});
			expect(harness.settingsManager.getCompactionSettings()).toEqual({
				enabled: false,
				reserveTokens: 5000,
				keepRecentTokens: 10000,
			});
		} finally {
			harness.cleanup();
		}
	});
	it("returns the session's effective compaction settings", async () => {
		const { seen, effective } = await observeSettings({
			settings: { compaction: { enabled: false, reserveTokens: 5000 } },
		});
		expect(seen).toEqual({ enabled: false, reserveTokens: 5000, keepRecentTokens: 20000 });
		expect(seen).toEqual(effective);
	});

	it("ignores untrusted project settings while global settings still apply", async () => {
		const harness = await createHarness();
		const cwd = join(harness.tempDir, "project");
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 5000 } }));
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ compaction: { enabled: false, reserveTokens: 1 } }),
		);
		try {
			const untrusted = await observeSettings({
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
			});
			expect(untrusted.seen).toEqual({ enabled: true, reserveTokens: 5000, keepRecentTokens: 20000 });
			const trusted = await observeSettings({ settingsManager: SettingsManager.create(cwd, agentDir) });
			expect(trusted.seen).toEqual({ enabled: false, reserveTokens: 1, keepRecentTokens: 20000 });
		} finally {
			harness.cleanup();
		}
	});
});
