import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSettingsStorage, InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Tests for the fix to a bug where external file changes to arrays were overwritten.
 *
 * The bug scenario was:
 * 1. Pi starts with settings.json containing packages: ["npm:some-pkg"]
 * 2. User externally edits file to packages: []
 * 3. User changes an unrelated setting (e.g., theme) via UI
 * 4. save() would overwrite packages back to ["npm:some-pkg"] from stale in-memory state
 *
 * The fix tracks which fields were explicitly modified during the session, and only
 * those fields override file values during save().
 */
describe("SettingsManager - External Edit Preservation", () => {
	const testDir = join(process.cwd(), "test-settings-bug-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("serializes concurrent first writes before reading and merging settings", async () => {
		const workerOptions = {
			execArgv: ["--import", "tsx"],
			env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)) },
		};
		const data = { cwd: projectDir, agentDir, barrier: new SharedArrayBuffer(4) };
		const workerPath = new URL("./fixtures/settings-first-write-worker.ts", import.meta.url);
		const a = new Worker(workerPath, { ...workerOptions, workerData: { ...data, first: true } });
		const b = new Worker(workerPath, { ...workerOptions, workerData: { ...data, first: false } });
		try {
			await Promise.all([once(a, "message"), once(b, "message")]);
			const computed = once(a, "message");
			a.postMessage("start");
			expect(await computed).toEqual(["computed"]);
			const finished = Promise.all([once(a, "message"), once(b, "message")]);
			b.postMessage("start");
			expect(await finished).toEqual([[{ writes: 1, errors: [] }], [{ writes: 1, errors: [] }]]);
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
				theme: "dark",
				defaultThinkingLevel: "high",
			});
		} finally {
			await Promise.all([a.terminate(), b.terminate()]);
		}
	});

	it("does not create missing settings directories for read-only callbacks", () => {
		rmSync(agentDir, { recursive: true });
		rmSync(join(projectDir, ".pi"), { recursive: true });
		const storage = new FileSettingsStorage(projectDir, agentDir);
		for (const scope of ["global", "project"] as const) {
			let calls = 0;
			storage.withLock(
				scope,
				(current) => {
					calls++;
					expect(current).toBeUndefined();
					return undefined;
				},
				{ readOnly: true },
			);
			expect(calls).toBe(1);
		}
		expect(existsSync(agentDir)).toBe(false);
		expect(existsSync(join(projectDir, ".pi"))).toBe(false);
	});

	it("does not replay an earlier queued theme change after another manager saves", async () => {
		const a = SettingsManager.create(projectDir, agentDir);
		const b = SettingsManager.create(projectDir, agentDir);
		a.setTheme("light");
		a.setDefaultThinkingLevel("high");
		b.setTheme("dark");
		await Promise.all([a.flush(), b.flush()]);
		expect(a.drainErrors()).toEqual([]);
		expect(b.drainErrors()).toEqual([]);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
			defaultThinkingLevel: "high",
		});
	});

	it("does not replay nested or project fields from earlier queued writes", async () => {
		const a = SettingsManager.create(projectDir, agentDir);
		const b = SettingsManager.create(projectDir, agentDir);
		a.setShowImages(false);
		a.setImageWidthCells(80);
		b.setShowImages(true);
		await Promise.all([a.flush(), b.flush()]);
		expect(a.drainErrors()).toEqual([]);
		expect(b.drainErrors()).toEqual([]);
		expect.soft(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
			terminal: { showImages: true, imageWidthCells: 80 },
		});
		a.setProjectExtensionPaths(["./old.ts"]);
		a.setProjectPromptTemplatePaths(["./prompt.md"]);
		b.setProjectExtensionPaths(["./new.ts"]);
		await Promise.all([a.flush(), b.flush()]);
		expect(a.drainErrors()).toEqual([]);
		expect(b.drainErrors()).toEqual([]);
		expect(JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8"))).toEqual({
			extensions: ["./new.ts"],
			prompts: ["./prompt.md"],
		});
	});

	it("retries failed fields with the next queued unrelated setter", async () => {
		const storage = new InMemorySettingsStorage();
		let failOnce = true;
		const manager = SettingsManager.fromStorage({
			withLock(scope, fn) {
				storage.withLock(scope, (current) => {
					const next = fn(current);
					if (next !== undefined && failOnce) {
						failOnce = false;
						throw new Error("write failed");
					}
					return next;
				});
			},
		});
		manager.setTheme("light");
		manager.setDefaultThinkingLevel("high");
		await manager.flush();
		expect(manager.drainErrors()).toMatchObject([{ scope: "global", error: new Error("write failed") }]);
		expect(SettingsManager.fromStorage(storage).getGlobalSettings()).toEqual({
			theme: "light",
			defaultThinkingLevel: "high",
		});
	});

	it("should preserve file changes to packages array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		// Initial state: packages has one item
		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				packages: ["npm:pi-mcp-adapter"],
			}),
		);

		// Pi starts up, loads settings into memory
		const manager = SettingsManager.create(projectDir, agentDir);

		// At this point, globalSettings.packages = ["npm:pi-mcp-adapter"]
		expect(manager.getPackages()).toEqual(["npm:pi-mcp-adapter"]);

		// User externally edits settings.json to remove the package
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.packages = []; // User wants to remove this!
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// Verify file was changed
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).packages).toEqual([]);

		// User changes an UNRELATED setting via UI (this triggers save)
		manager.setTheme("light");
		await manager.flush();

		// With the fix, packages should be preserved as [] (not reverted to startup value)
		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		expect(savedSettings.packages).toEqual([]);
		expect(savedSettings.theme).toBe("light");
	});

	it("should preserve file changes to extensions array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				extensions: ["/old/extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		// User externally updates extensions
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.extensions = ["/new/extension.ts"];
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// Change unrelated setting
		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		// With the fix, extensions should be preserved (not reverted to startup value)
		expect(savedSettings.extensions).toEqual(["/new/extension.ts"]);
	});

	it("should preserve external project settings changes when updating unrelated project field", async () => {
		const projectSettingsPath = join(projectDir, ".pi", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./old-extension.ts"],
				prompts: ["./old-prompt.md"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.prompts = ["./new-prompt.md"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./updated-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.prompts).toEqual(["./new-prompt.md"]);
		expect(savedProjectSettings.extensions).toEqual(["./updated-extension.ts"]);
	});

	it("should let in-memory project changes override external changes for the same project field", async () => {
		const projectSettingsPath = join(projectDir, ".pi", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./initial-extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.extensions = ["./external-extension.ts"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./in-memory-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.extensions).toEqual(["./in-memory-extension.ts"]);
	});
});
