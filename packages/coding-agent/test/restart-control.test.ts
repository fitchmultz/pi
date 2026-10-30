import { afterEach, describe, expect, it, vi } from "vitest";
import { getRestartSocketFallback } from "../src/extensions/restart/index.ts";

describe("restart control socket paths", () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each([
		["linux", 107, "/tmp"],
		["android", 107, "/data/data/com.termux/files/usr/tmp"],
		["darwin", 103, "/tmp"],
	] as const)("uses the %s socket byte limit and short temporary root", (platform, limit, fallback) => {
		// #297: a version-managed Node is not necessarily inside the Termux prefix.
		vi.stubEnv("PREFIX", "/data/data/com.termux/files/usr");
		const directory = `/${"a".repeat(limit - 3)}`;
		const execPath = "/home/user/.local/share/mise/installs/node/24/bin/node";
		expect(getRestartSocketFallback(directory, platform, execPath)).toBeUndefined();
		expect(getRestartSocketFallback(`${directory}a`, platform, execPath)).toBe(fallback);
	});

	it("counts UTF-8 bytes, not characters, and leaves named pipes alone", () => {
		const directory = `/${"é".repeat(53)}`;
		expect(getRestartSocketFallback(directory, "linux")).toBe("/tmp");
		expect(getRestartSocketFallback(directory, "win32")).toBeUndefined();
	});
});
