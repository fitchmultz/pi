import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { exportSessionToJsonl } from "../src/core/session-export.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { exportSessionForShare } from "../src/modes/interactive/session-share.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("JSONL share export", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("writes the full Unicode branch and trailing entries without archive-sized writes", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-jsonl-records-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const firstId = sessionManager.appendMessage(userMsg("before the boundary: 雪 🌲\nsecond line"));
		sessionManager.appendMessage(userMsg("excluded sibling"));
		sessionManager.branch(firstId);
		sessionManager.appendContextWindow("fresh context", 123);
		const leafId = sessionManager.appendMessage(userMsg("current branch"));
		const branch = sessionManager.getBranch();
		const outputPath = join(tempDir, "nested", "export.jsonl");
		const callback = vi.fn((parentId: string | null, timestamp: string) => [
			{ type: "custom", id: "trailing", parentId, timestamp, customType: "test", data: "末尾" },
		]);
		const descriptors = new Set<number>();
		const temporaryPaths: string[] = [];
		let maxWriteCharacters = 0;
		let maxCopyBytes = 0;
		let writeCount = 0;
		const open = fs.openSync;
		const write = fs.writeFileSync;
		const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
			const fd = open(file, flags, mode);
			descriptors.add(fd);
			if (typeof file === "string" && file !== outputPath) temporaryPaths.push(file);
			return fd;
		});
		const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
			if (file === outputPath || (typeof file === "number" && descriptors.has(file))) {
				if (typeof data === "string") {
					maxWriteCharacters = Math.max(maxWriteCharacters, data.length);
					writeCount++;
				} else {
					maxCopyBytes = Math.max(maxCopyBytes, data.byteLength, data.buffer.byteLength);
				}
			}
			write(file, data, options);
		});
		syncBuiltinESMExports();
		try {
			expect(exportSessionToJsonl(sessionManager, relative(process.cwd(), outputPath), callback)).toBe(outputPath);
		} finally {
			writeSpy.mockRestore();
			openSpy.mockRestore();
			syncBuiltinESMExports();
		}
		const text = readFileSync(outputPath, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		const lines = text.trimEnd().split("\n");
		const records = lines.map((line) => JSON.parse(line));
		expect(records[0]).toEqual({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionManager.getSessionId(),
			timestamp: expect.any(String),
			cwd: tempDir,
		});
		expect(records.slice(1, -1)).toEqual(
			branch.map((entry, index) => ({
				...entry,
				parentId: index === 0 ? null : branch[index - 1].id,
			})),
		);
		expect(callback).toHaveBeenCalledExactlyOnceWith(leafId, records[0].timestamp);
		expect(records.at(-1)).toEqual(callback.mock.results[0].value[0]);
		expect(sessionManager.getBranch()).toEqual(branch);
		expect(maxWriteCharacters).toBeLessThanOrEqual(Math.max(...lines.map((line) => line.length + 1)));
		expect(writeCount).toBe(records.length);
		expect(maxCopyBytes).toBeLessThanOrEqual(64 * 1024);
		expect(temporaryPaths.every((path) => !fs.existsSync(path))).toBe(true);

		writeFileSync(outputPath, "keep existing destination");
		expect(() =>
			exportSessionToJsonl(sessionManager, outputPath, () => {
				throw new Error("trailing callback failed");
			}),
		).toThrow("trailing callback failed");
		expect(readFileSync(outputPath, "utf8")).toBe("keep existing destination");
	});

	it.each(["branch", "trailing"] as const)(
		"preserves existing destinations when %s serialization fails",
		(location) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-jsonl-error-"));
			tempDirs.push(tempDir);
			const outputPath = join(tempDir, "existing.jsonl");
			for (const data of [
				{ value: 1n },
				{
					toJSON: () => {
						throw new Error("cannot serialize");
					},
				},
			]) {
				const manager = SessionManager.inMemory(tempDir);
				if (location === "branch") manager.appendCustomEntry("invalid", data);
				const callback = vi.fn(() => (location === "trailing" ? [data] : []));
				writeFileSync(outputPath, "existing private bytes", { mode: 0o600 });
				expect(() => exportSessionToJsonl(manager, outputPath, callback)).toThrow();
				expect(readFileSync(outputPath, "utf8")).toBe("existing private bytes");
				expect(callback).toHaveBeenCalledTimes(location === "branch" ? 0 : 1);
			}
		},
	);

	it("serializes branch and trailing objects exactly once in callback order", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-jsonl-order-"));
		tempDirs.push(tempDir);
		const manager = SessionManager.inMemory(tempDir);
		const calls: string[] = [];
		manager.appendCustomEntry("stateful", {
			toJSON() {
				if (calls.includes("branch")) throw new Error("branch serialized twice");
				calls.push("branch");
				return "branch serialized once";
			},
		});
		const outputPath = join(tempDir, "export.jsonl");
		exportSessionToJsonl(manager, outputPath, (parentId, timestamp) => {
			calls.push("callback");
			return [
				{
					toJSON() {
						if (calls.includes("trailing")) throw new Error("trailing serialized twice");
						calls.push("trailing");
						return { type: "custom", id: "tail", parentId, timestamp, customType: "test" };
					},
				},
			];
		});
		expect(calls).toEqual(["branch", "callback", "trailing"]);
		const records = readFileSync(outputPath, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records[1].data).toBe("branch serialized once");
		expect(records[2].parentId).toBe(records[1].id);
	});

	it.skipIf(process.platform === "win32")("keeps destination modes, symlinks and hardlinks when overwriting", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-jsonl-links-"));
		tempDirs.push(tempDir);
		const manager = SessionManager.inMemory(tempDir);
		manager.appendMessage(userMsg("exported"));
		const destination = join(tempDir, "private.jsonl");
		writeFileSync(destination, "old private data", { mode: 0o600 });
		fs.chmodSync(destination, 0o600);
		const before = fs.statSync(destination);
		const hardlink = join(tempDir, "hardlink.jsonl");
		const symlink = join(tempDir, "symlink.jsonl");
		fs.linkSync(destination, hardlink);
		fs.symlinkSync(destination, symlink);
		expect(exportSessionToJsonl(manager, symlink)).toBe(symlink);
		expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
		expect(fs.statSync(destination).ino).toBe(before.ino);
		expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
		expect(readFileSync(hardlink, "utf8")).toBe(readFileSync(destination, "utf8"));
		const ordinary = join(tempDir, "ordinary.jsonl");
		writeFileSync(ordinary, "reference mode");
		const newPath = exportSessionToJsonl(manager, join(tempDir, "new.jsonl"));
		expect(fs.statSync(newPath).mode & 0o777).toBe(fs.statSync(ordinary).mode & 0o777);
	});

	it("adds presentation data without changing conversation IDs or links", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-jsonl-share-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			tools: ["share_tool"],
			customTools: [
				defineTool({
					name: "share_tool",
					label: "Share Tool",
					description: "Render a value for sharing",
					parameters: Type.Object({ value: Type.String({ description: "Value to render" }) }),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				}),
			],
		});

		try {
			const userId = sessionManager.appendMessage(userMsg("hello"));
			const assistant: AssistantMessage = {
				...assistantMsg(""),
				content: [{ type: "toolCall", id: "call-1", name: "share_tool", arguments: { value: "example" } }],
				stopReason: "toolUse",
			};
			const assistantId = sessionManager.appendMessage(assistant);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "share_tool",
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
				timestamp: Date.now(),
			};
			const resultId = sessionManager.appendMessage(result);
			const originalEntryIds = sessionManager.getBranch().map((entry) => entry.id);

			const normalPath = join(tempDir, "normal.jsonl");
			session.exportToJsonl(normalPath);
			const normalRecords = readFileSync(normalPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(normalRecords.some((record) => record.type === "custom" && record.customType === "pi.share")).toBe(
				false,
			);

			const sharePath = join(tempDir, "share.jsonl");
			exportSessionForShare(sharePath, session);
			const records = readFileSync(sharePath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const conversationRecords = records.slice(1, -1);
			expect(conversationRecords.map((record) => record.id)).toEqual(originalEntryIds);
			expect(conversationRecords.map((record) => record.parentId)).toEqual([null, ...originalEntryIds.slice(0, -1)]);
			expect(conversationRecords.slice(-3).map((record) => record.id)).toEqual([userId, assistantId, resultId]);

			const shareEntry = records.at(-1) as {
				id: string;
				data?: {
					systemPrompt?: string;
					tools?: Array<Record<string, unknown>>;
				};
			};
			expect(shareEntry).toMatchObject({
				type: "custom",
				customType: "pi.share",
				parentId: resultId,
				timestamp: expect.any(String),
			});
			expect(shareEntry.data?.systemPrompt).toBe(session.state.systemPrompt);
			expect(shareEntry.data?.tools).toEqual([
				expect.objectContaining({
					name: "share_tool",
					description: "Render a value for sharing",
				}),
			]);
			expect(shareEntry.data).not.toHaveProperty("renderedTools");
			expect(shareEntry.data).not.toHaveProperty("theme");
			expect(shareEntry.data).not.toHaveProperty("version");

			const imported = SessionManager.open(sharePath);
			expect(imported.getLeafId()).toBe(shareEntry.id);
			expect(imported.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
			]);
		} finally {
			session.dispose();
		}
	});
});
