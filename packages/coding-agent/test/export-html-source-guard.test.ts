import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const exporters: Array<[string, (manager: SessionManager, output: string) => Promise<string>]> = [
	["CLI", (manager, output) => exportFromFile(manager.getSessionFile()!, output)],
	["interactive", (manager, output) => exportSessionToHtml(manager, undefined, output)],
];

describe("HTML export", () => {
	it.each(exporters)("%s refuses to overwrite its source session", async (_name, exportSession) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-export-source-"));
		try {
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			manager.appendMessage(fauxAssistantMessage("saved conversation"));
			const source = manager.getSessionFile()!;
			const before = readFileSync(source, "utf8");

			await expect(exportSession(manager, source)).rejects.toThrow(/source session file/);
			expect(readFileSync(source, "utf8")).toBe(before);

			const alias = join(dir, "same-session.jsonl");
			linkSync(source, alias);
			await expect(exportSession(manager, alias)).rejects.toThrow(/source session file/);
			expect(readFileSync(source, "utf8")).toBe(before);

			const output = join(dir, "session.html");
			await expect(exportSession(manager, output)).resolves.toBe(output);
			expect(readFileSync(output, "utf8")).toContain("<!DOCTYPE html>");
			expect(readFileSync(source, "utf8")).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a legacy hardlink before migration changes its file identity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-export-legacy-"));
		try {
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			manager.appendMessage(fauxAssistantMessage("saved conversation"));
			const source = manager.getSessionFile()!;
			const lines = readFileSync(source, "utf8").trimEnd().split("\n");
			const header = JSON.parse(lines[0]) as { version: number };
			lines[0] = JSON.stringify({ ...header, version: 2 });
			const before = `${lines.join("\n")}\n`;
			writeFileSync(source, before);
			const alias = join(dir, "legacy.jsonl");
			linkSync(source, alias);

			await expect(exportFromFile(alias, source)).rejects.toThrow(/source session file/);
			expect(readFileSync(source, "utf8")).toBe(before);
			expect(readFileSync(alias, "utf8")).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
