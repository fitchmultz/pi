import { describe, expect, it } from "vitest";
import { getRestartSocketFallback } from "../src/extensions/restart/index.ts";

describe("restart control socket paths", () => {
	it.each([
		["linux", 107, "/tmp"],
		["android", 107, "/data/data/com.termux/files/usr/tmp"],
		["darwin", 103, "/tmp"],
	] as const)("uses the %s socket byte limit and short temporary root", (platform, limit, fallback) => {
		const directory = `/${"a".repeat(limit - 3)}`;
		const execPath = "/data/data/com.termux/files/usr/bin/node";
		expect(getRestartSocketFallback(directory, platform, execPath)).toBeUndefined();
		expect(getRestartSocketFallback(`${directory}a`, platform, execPath)).toBe(fallback);
	});

	it("counts UTF-8 bytes, not characters, and leaves named pipes alone", () => {
		const directory = `/${"é".repeat(53)}`;
		expect(getRestartSocketFallback(directory, "linux")).toBe("/tmp");
		expect(getRestartSocketFallback(directory, "win32")).toBeUndefined();
	});
});
