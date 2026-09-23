import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage } from "../src/core/settings-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

describe("settings file publication", () => {
	let directory: string;
	let storage: FileSettingsStorage;

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-settings-persistence-"));
		fs.mkdirSync(join(directory, ".pi"));
		storage = new FileSettingsStorage(directory, directory);
	});

	afterEach(() => {
		vi.mocked(fs.writeFileSync).mockRestore();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it.each(["global", "project"] as const)("keeps previous %s settings after a partial write", async (scope) => {
		const path = join(directory, scope === "project" ? ".pi/settings.json" : "settings.json");
		const original = JSON.stringify({ theme: "dark", packages: ["npm:keep-me"] });
		fs.writeFileSync(path, original);
		const realFs = await vi.importActual<typeof fs>("fs");
		vi.mocked(fs.writeFileSync).mockImplementationOnce((file, _data, options) => {
			realFs.writeFileSync(file, '{"theme":', options);
			throw Object.assign(new Error("file too large"), { code: "EFBIG" });
		});

		expect(() => storage.withLock(scope, () => '{"theme":"light"}')).toThrow("file too large");
		expect(fs.readFileSync(path, "utf8")).toBe(original);
		expect(fs.readdirSync(join(path, ".."))).toEqual(
			scope === "global" ? [".pi", "settings.json"] : ["settings.json"],
		);
		storage.withLock(scope, (current) => JSON.stringify({ ...JSON.parse(current!), theme: "light" }));
		expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ theme: "light", packages: ["npm:keep-me"] });
	});

	it.skipIf(process.platform === "win32")("creates the missing target of a settings symlink", () => {
		const target = join(directory, "missing.json");
		const path = join(directory, "settings.json");
		fs.symlinkSync("missing.json", path);

		storage.withLock("global", () => '{"theme":"light"}');

		expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe('{"theme":"light"}');
	});

	it.skipIf(process.platform === "win32")("writes through settings symlinks and preserves file permissions", () => {
		const target = join(directory, "shared.json");
		fs.writeFileSync(target, '{"theme":"dark"}', { mode: 0o600 });
		const path = join(directory, "settings.json");
		fs.symlinkSync(target, path);

		storage.withLock("global", () => '{"theme":"light"}');

		expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe('{"theme":"light"}');
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
	});
});
