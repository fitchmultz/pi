import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompactionSettings } from "../../src/core/compaction/index.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
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
