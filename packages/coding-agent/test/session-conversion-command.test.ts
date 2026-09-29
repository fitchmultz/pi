import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSessionConversionCommand } from "../src/cli/session-conversion-command.ts";

const directories: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("convert-session command", () => {
	it("documents the positional syntax and exit codes in help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = 0;
		expect(runSessionConversionCommand(["convert-session", "--help"])).toBe(true);
		expect(log.mock.calls[0][0]).toContain("convert-session <source.jsonl> <new-output.jsonl>");
		expect(log.mock.calls[0][0]).toContain(
			"Exit codes: 0 converted/help; 1 conversion refused or I/O failure; 2 invalid arguments.",
		);
		expect(process.exitCode).toBe(0);
	});

	it("returns distinct argument and conversion failure codes without publishing", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const directory = mkdtempSync(join(tmpdir(), "pi-conversion-cli-"));
		directories.push(directory);
		const output = join(directory, "new.jsonl");
		process.exitCode = 0;
		expect(runSessionConversionCommand(["convert-session", "only-source"])).toBe(true);
		expect(process.exitCode).toBe(2);
		process.exitCode = 0;
		expect(runSessionConversionCommand(["convert-session", join(directory, "missing.jsonl"), output])).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(existsSync(output)).toBe(false);
	});

	it("writes only a new destination and leaves the source bytes unchanged", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const directory = mkdtempSync(join(tmpdir(), "pi-conversion-cli-"));
		directories.push(directory);
		const source = join(directory, "old.jsonl");
		const output = join(directory, "new.jsonl");
		const timestamp = "2026-09-01T00:00:00.000Z";
		const bytes = `${JSON.stringify({ type: "session", version: 3, id: "archive", cwd: "/tmp", timestamp })}\n\n${JSON.stringify({ type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "hello", timestamp: 0 } })}\n`;
		writeFileSync(source, bytes);
		process.exitCode = 0;
		expect(runSessionConversionCommand(["convert-session", source, output])).toBe(true);
		expect(process.exitCode).toBe(0);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(existsSync(output)).toBe(true);
	});
});
