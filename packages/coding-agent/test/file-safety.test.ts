import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(join(tmpdir(), "pi-file-safety-"));
});
afterEach(() => {
	vi.mocked(fs.writeFileSync).mockReset();
	fs.rmSync(dir, { recursive: true, force: true });
});

function failNextWrite(): void {
	const write = vi.mocked(fs.writeFileSync).getMockImplementation()!;
	vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
		write(file, "partial");
		throw new Error("simulated disk full");
	});
}

describe("file save safety", () => {
	it.each(["sync", "async"] as const)("keeps old credentials on a failed %s write", async (mode) => {
		const path = join(dir, "auth.json");
		fs.writeFileSync(path, '{"old":"secret"}');
		const backend = new FileAuthStorageBackend(path);
		failNextWrite();
		const mutate = () => ({ result: undefined, next: '{"new":"secret"}' });
		if (mode === "sync") expect(() => backend.withLock(mutate)).toThrow("simulated disk full");
		else await expect(backend.withLockAsync(async () => mutate())).rejects.toThrow("simulated disk full");
		expect(fs.readFileSync(path, "utf8")).toBe('{"old":"secret"}');
		expect(fs.readdirSync(dir)).toEqual(["auth.json"]);
	});

	it.each(["auth", "settings"] as const)("saves %s through a symlink and retains its target's mode", (kind) => {
		const target = join(dir, "target.json");
		const alias = join(dir, kind === "auth" ? "auth.json" : "settings.json");
		fs.writeFileSync(target, "{}", { mode: 0o640 });
		fs.symlinkSync(target, alias);
		if (kind === "auth")
			new FileAuthStorageBackend(alias).withLock(() => ({ result: undefined, next: '{"saved":true}' }));
		else new FileSettingsStorage(dir, dir).withLock("global", () => '{"saved":true}');
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe('{"saved":true}');
		expect(fs.statSync(target).mode & 0o777).toBe(0o640);
	});

	it.each(["auth", "settings"] as const)("saves %s through a dangling symlink without replacing it", (kind) => {
		const target = join(dir, "target.json");
		const alias = join(dir, kind === "auth" ? "auth.json" : "settings.json");
		fs.symlinkSync(target, alias);
		if (kind === "auth") new FileAuthStorageBackend(alias).withLock(() => ({ result: undefined, next: "{}" }));
		else new FileSettingsStorage(dir, dir).withLock("global", () => "{}");
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe("{}");
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
	});

	it("serializes credential mutations through two symlink aliases", async () => {
		const target = join(dir, "auth.json");
		const a = join(dir, "a.json");
		const b = join(dir, "b.json");
		fs.writeFileSync(target, "{}");
		fs.symlinkSync(target, a);
		fs.symlinkSync(target, b);
		await new FileAuthStorageBackend(a).withLockAsync(async () => {
			expect(() => new FileAuthStorageBackend(b).withLock(() => ({ result: undefined }))).toThrow(/lock/i);
			return { result: undefined };
		});
	});

	it("keeps old settings on a failed write", () => {
		const path = join(dir, "settings.json");
		fs.writeFileSync(path, '{"theme":"dark"}');
		failNextWrite();
		expect(() => new FileSettingsStorage(dir, dir).withLock("global", () => '{"theme":"light"}')).toThrow(
			"simulated disk full",
		);
		expect(fs.readFileSync(path, "utf8")).toBe('{"theme":"dark"}');
		expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
	});

	it("locks missing settings before invoking a mutation", () => {
		const path = join(dir, "settings.json");
		const release = lockfile.lockSync(path, { realpath: false });
		let mutated = false;
		try {
			expect(() =>
				new FileSettingsStorage(dir, dir).withLock("global", () => {
					mutated = true;
					return "{}";
				}),
			).toThrow(/lock/i);
			expect(mutated).toBe(false);
		} finally {
			release();
		}
	});

	it("preserves runtime overrides when global and project setters change other fields", async () => {
		const manager = SettingsManager.create(dir, dir);
		manager.applyOverrides({ defaultModel: "runtime", terminal: { imageWidthCells: 42 } });
		manager.setTheme("light");
		manager.setShowImages(false);
		manager.setProjectExtensionPaths(["local.ts"]);
		await manager.flush();
		expect(manager.getDefaultModel()).toBe("runtime");
		expect(manager.getImageWidthCells()).toBe(42);
		expect(manager.getShowImages()).toBe(false);
		expect(manager.getExtensionPaths()).toEqual(["local.ts"]);
	});

	it("preserves other processes' model keys when setting and removing a key", async () => {
		const path = join(dir, "settings.json");
		fs.writeFileSync(path, JSON.stringify({ modelThinkingLevels: { "p/a": "low" } }));
		const manager = SettingsManager.create(dir, dir);
		fs.writeFileSync(path, JSON.stringify({ modelThinkingLevels: { "p/a": "low", "p/b": "high" } }));
		manager.setModelThinkingLevel("p", "a", "medium");
		await manager.flush();
		expect(JSON.parse(fs.readFileSync(path, "utf8")).modelThinkingLevels).toEqual({ "p/a": "medium", "p/b": "high" });
		manager.removeModelThinkingLevel("p", "a");
		await manager.flush();
		expect(JSON.parse(fs.readFileSync(path, "utf8")).modelThinkingLevels).toEqual({ "p/b": "high" });
		manager.removeModelThinkingLevel("p", "b");
		await manager.flush();
		expect(JSON.parse(fs.readFileSync(path, "utf8")).modelThinkingLevels).toBeUndefined();
	});

	it("keeps the legacy journal intact when migration rewriting fails", () => {
		const path = join(dir, "session.jsonl");
		const original = `${JSON.stringify({ type: "session", id: "legacy", version: 2, cwd: dir, timestamp: new Date().toISOString() })}\n`;
		fs.writeFileSync(path, original);
		failNextWrite();
		expect(() => SessionManager.open(path)).toThrow("simulated disk full");
		expect(fs.readFileSync(path, "utf8")).toBe(original);
		expect(fs.readdirSync(dir)).toEqual(["session.jsonl"]);
	});
});

describe("HTML export journal guard", () => {
	it.each(["same", "symlink", "hardlink"] as const)(
		"rejects %s output for both export entry points",
		async (alias) => {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage({ role: "user", content: "keep me", timestamp: 1 });
			const path = manager.getSessionFile()!;
			const output = alias === "same" ? path : join(dir, "alias.html");
			if (alias === "symlink") fs.symlinkSync(path, output);
			if (alias === "hardlink") fs.linkSync(path, output);
			const original = fs.readFileSync(path);
			await expect(exportSessionToHtml(manager, undefined, output)).rejects.toThrow(/session/i);
			expect(fs.readFileSync(path)).toEqual(original);
			await expect(exportFromFile(path, output)).rejects.toThrow(/session/i);
			expect(fs.readFileSync(path)).toEqual(original);
		},
	);
});
