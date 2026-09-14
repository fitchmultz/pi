import { execFileSync } from "node:child_process";
import { applyPatch } from "diff";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";
import * as shellModule from "../src/utils/shell.ts";

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("literal Unicode-space paths", () => {
		it.each(["\u00a0", "\u2009", "\u202f"])("reads, writes and edits the exact %j filename", async (space) => {
			const exact = join(testDir, `report${space}final.txt`);
			const other = join(testDir, "report final.txt");
			writeFileSync(exact, "intended");
			writeFileSync(other, "unrelated");

			expect.soft(getTextOutput(await readTool.execute("read-exact", { path: exact }))).toBe("intended");
			await writeTool.execute("write-exact", { path: exact, content: "replacement" });
			expect.soft(readFileSync(exact, "utf-8")).toBe("replacement");
			expect.soft(readFileSync(other, "utf-8")).toBe("unrelated");

			const edits = [{ oldText: "replacement", newText: "edited" }];
			expect.soft(await computeEditsDiff(exact, edits, testDir)).toMatchObject({
				diff: expect.stringContaining("+1 edited"),
			});
			await editTool.execute("edit-exact", { path: exact, edits });
			expect.soft(readFileSync(exact, "utf-8")).toBe("edited");
			expect.soft(readFileSync(other, "utf-8")).toBe("unrelated");
		});

		it("creates a new Unicode-space filename without overwriting its ASCII neighbor", async () => {
			const exact = join(testDir, "new\u00a0file.txt");
			const other = join(testDir, "new file.txt");
			writeFileSync(other, "unrelated");
			await writeTool.execute("create-exact", { path: exact, content: "created" });
			expect.soft(readFileSync(other, "utf-8")).toBe("unrelated");
			expect(readFileSync(exact, "utf-8")).toBe("created");
		});

		it("does not edit an ASCII neighbor when the Unicode-space filename is missing", async () => {
			const exact = join(testDir, "missing\u00a0file.txt");
			const other = join(testDir, "missing file.txt");
			writeFileSync(other, "unrelated");
			await expect
				.soft(
					editTool.execute("missing-exact", {
						path: exact,
						edits: [{ oldText: "unrelated", newText: "changed" }],
					}),
				)
				.rejects.toThrow(/ENOENT/);
			expect(readFileSync(other, "utf-8")).toBe("unrelated");
		});
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should read BMP files from disk as PNG image attachments", async () => {
			const testFile = join(testDir, "image.bmp");
			writeFileSync(testFile, createTinyBmp1x1Red24bpp());

			const result = await readTool.execute("test-call-img-bmp", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");
			expect(getTextOutput(result)).toContain("[Image converted from image/bmp to image/png.]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(Buffer.from(imageBlock?.data ?? "", "base64")[0]).toBe(0x89);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toBe(`Successfully wrote to ${testFile}`);
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
			expect(result.details.patch).toContain("--- ");
			expect(result.details.patch).toContain("+++ ");
			expect(result.details.patch).toContain("@@");
			expect(result.details.patch).toContain("-Hello, world!");
			expect(result.details.patch).toContain("+Hello, testing!");
			expect(applyPatch(originalContent, result.details.patch)).toBe("Hello, testing!");
		});

		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
		});

		it("should include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await expect(
				editTool.execute("test-call-6b", {
					path: missingFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${missingFile}. Error code: ENOENT.`);
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it.each(["ababa", "ａｂａｂａ"])("should reject overlapping anchor occurrences in %s", async (content) => {
			const testFile = join(testDir, "overlapping-anchor.txt");
			writeFileSync(testFile, content);
			const edits = [{ oldText: "aba", newText: "X" }];

			expect.soft(await computeEditsDiff(testFile, edits, testDir)).toEqual({
				error: expect.stringContaining("Found 2 occurrences"),
			});
			await expect(editTool.execute("test-overlapping-anchor", { path: testFile, edits })).rejects.toThrow(
				/Found 2 occurrences/,
			);
			expect(readFileSync(testFile, "utf-8")).toBe(content);
		});

		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 2 block(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ oldText: "line 100\n", newText: "LINE 100\n" },
					{ oldText: "line 300\n", newText: "LINE 300\n" },
					{ oldText: "line 500\n", newText: "LINE 500\n" },
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits must contain at least one replacement/);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
			).rejects.toThrow(/Could not find/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await expect(
				editTool.execute("test-call-14", {
					path: testFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${testFile}. Error code: EACCES.`);
		});

		it("should include the original error message for unknown edit access errors", async () => {
			const genericFailureTool = createEditTool(testDir, {
				operations: {
					access: async () => {
						throw new Error("disk offline");
					},
					readFile: async () => Buffer.from("hello\n", "utf-8"),
					writeFile: async () => {},
				},
			});

			await expect(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("Could not edit file: broken.txt. Error: disk offline.");
		});

		it("should include ENOENT in diff preview for missing files", async () => {
			const missingFile = join(testDir, "missing-preview.txt");
			const result = await computeEditsDiff(missingFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${missingFile}. Error code: ENOENT.` });
		});

		it("should include EACCES in diff preview for unreadable files", async () => {
			const unreadableFile = join(testDir, "unreadable-preview.txt");
			writeFileSync(unreadableFile, "hello\n");
			chmodSync(unreadableFile, 0o222);

			const result = await computeEditsDiff(unreadableFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${unreadableFile}. Error code: EACCES.` });
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it.skipIf(process.platform === "win32")("should fail with captured output when the shell is killed", async () => {
			await expect(
				bashTool.execute("test-shell-signal", {
					command: "printf 'before signal\\n'; kill -TERM $$; printf 'unreachable\\n'",
				}),
			).rejects.toThrow("before signal\n\n\nCommand terminated by signal");
		});

		it("should respect timeout", async () => {
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
			await expect(bashTool.execute("test-call-10", { command, timeout: 0.05 })).rejects.toThrow(/timed out/i);
		});

		it("should include full output path for truncated timeout and abort errors", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "Command timed out after 5 seconds" },
				{ error: "aborted", expected: "Command aborted" },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"));
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				let error: unknown;
				try {
					await bash.execute(`test-call-${testCase.error}`, { command: "chatty-fail" });
				} catch (err) {
					error = err;
				}

				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain(testCase.expected);
				expect(message).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
				expect(message).not.toContain("Full output: undefined");
				const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should send commands over stdin when shell resolution requires it", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: [
					"-e",
					'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { process.stdout.write(input); });',
				],
				commandTransport: "stdin",
			});
			const chunks: Buffer[] = [];
			const ops = createLocalBashOperations({ shellPath: "C:\\Windows\\System32\\bash.exe" });
			const nameExpansion = "$" + "{name}";
			const countExpansion = "$" + "{count}";
			const iExpansion = "$" + "{i}";
			const command = `name='World'; echo "Hello, ${nameExpansion}!"; count=3; for i in $(seq 1 ${countExpansion}); do echo "Iteration ${iExpansion} of ${countExpansion}"; done`;

			const result = await ops.exec(command, testDir, {
				onData: (data) => chunks.push(data),
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8")).toBe(command);
		});

		it("should resolve legacy WSL bash.exe to stdin command transport", () => {
			if (process.platform === "win32") return;
			const originalCwd = process.cwd();
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			const shellPath = "C:\\Windows\\System32\\bash.exe";
			writeFileSync(join(testDir, shellPath), "");
			try {
				process.chdir(testDir);
				Object.defineProperty(process, "platform", {
					configurable: true,
					value: "win32",
				});

				expect(shellModule.getShellConfig(shellPath)).toEqual({
					shell: shellPath,
					args: ["-s"],
					commandTransport: "stdin",
				});
			} finally {
				process.chdir(originalCwd);
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
			}
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("should coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-chatty-updates", { command: "chatty" }, undefined, (update) =>
				updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		it("should not count a trailing newline as an extra truncated bash output line", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 1; i <= 4000; i++) {
						onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-trailing-newline-line-count", { command: "many-lines" });
			const output = getTextOutput(result);

			expect(result.details?.truncation?.totalLines).toBe(4000);
			expect(result.details?.truncation?.outputLines).toBe(2000);
			expect(output).toContain("line-2001");
			expect(output).toContain("line-4000");
			expect(output).toMatch(/\[Showing lines 2001-4000 of 4000\. Full output: /);
			expect(output).not.toContain("4001");
		});

		it("should decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", { command: "split-utf8" });

			expect(getTextOutput(result).trim()).toBe("€");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it.each(["success", "abort", "error"] as const)(
			"executeBash flushes full output before returning after %s",
			async (outcome) => {
				const outputDir = mkdtempSync(join(tmpdir(), "pi-bash-flush-"));
				vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", outputDir);
				const controller = new AbortController();
				const failure = new Error("execution failed");
				const output = "retained output\n".repeat(10000);
				try {
					const execution = executeBashWithOperations(
						"chatty",
						testDir,
						{
							exec: async (_command, _cwd, { onData }) => {
								onData(Buffer.from(output));
								if (outcome === "abort") controller.abort();
								if (outcome !== "success") throw failure;
								return { exitCode: 0 };
							},
						},
						{ signal: controller.signal },
					);
					if (outcome === "error") {
						await expect(execution).rejects.toBe(failure);
					} else {
						expect(await execution).toMatchObject({ truncated: true, cancelled: outcome === "abort" });
					}
					const files = readdirSync(outputDir);
					expect(files).toHaveLength(1);
					expect(readFileSync(join(outputDir, files[0]), "utf-8")).toBe(output);
					rmSync(outputDir, { recursive: true, force: true });
				} finally {
					vi.unstubAllEnvs();
				}
			},
		);

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	describe("grep tool", () => {
		it("respects .gitignore outside Git, including nested overrides and explicit files", async () => {
			mkdirSync(join(testDir, "nested"));
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "nested", ".gitignore"), "!ignored.txt\n");
			for (const file of ["ignored.txt", "kept.txt", "nested/ignored.txt"]) {
				writeFileSync(join(testDir, file), "needle");
			}
			const result = await createGrepTool(testDir).execute("ignore-outside-git", { pattern: "needle" });
			expect(getTextOutput(result).split("\n").sort()).toEqual([
				"kept.txt:1: needle",
				"nested/ignored.txt:1: needle",
			]);
			const explicit = await createGrepTool(testDir).execute("explicit-ignored-file", {
				pattern: "needle",
				path: "ignored.txt",
			});
			expect(getTextOutput(explicit)).toBe("ignored.txt:1: needle");
		});

		it("keeps parent .gitignore rules outside nested Git repositories", async () => {
			// Native fd/rg defaults must retain the nested-repo boundary (upstream #5960).
			execFileSync("git", ["init", "--quiet", testDir]);
			const nested = join(testDir, "nested");
			execFileSync("git", ["init", "--quiet", nested]);
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "needle");
			writeFileSync(join(nested, "ignored.txt"), "needle");
			for (const searchPath of [testDir, nested]) {
				const prefix = searchPath === testDir ? "nested/" : "";
				const grep = await createGrepTool(searchPath).execute("nested-git-grep", { pattern: "needle" });
				expect(getTextOutput(grep)).toBe(`${prefix}ignored.txt:1: needle`);
				const find = await createFindTool(searchPath).execute("nested-git-find", { pattern: "*.txt" });
				expect(getTextOutput(find)).toBe(`${prefix}ignored.txt`);
			}
		});

		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it.each(["\n", "\r\n"])("should keep ripgrep line numbers with bare CR and %j endings", async (ending) => {
			const testFile = join(testDir, "progress.log");
			writeFileSync(
				testFile,
				["progress 0%\rprogress 50%\rprogress 100%", "ready", "ERROR failure", "after", ""].join(ending),
			);

			const result = await grepTool.execute("test-grep-bare-cr", {
				pattern: "ERROR",
				path: testFile,
				context: 1,
			});

			expect(getTextOutput(result)).toBe(
				"progress.log-2- ready\nprogress.log:3: ERROR failure\nprogress.log-4- after",
			);
		});

		it.each(["utf16le", "utf16be"])("should decode %s context consistently with matches", async (encoding) => {
			const file = join(testDir, "utf16.txt");
			const bytes = Buffer.from("\uFEFFbefore\nneedle\nafter\n", "utf16le");
			if (encoding === "utf16be") bytes.swap16();
			writeFileSync(file, bytes);
			const match = await grepTool.execute("utf16-match", { pattern: "needle", path: file });
			expect(getTextOutput(match)).toBe("utf16.txt:2: needle");
			const context = await grepTool.execute("utf16-context", { pattern: "needle", path: file, context: 1 });
			expect(getTextOutput(context)).toBe("utf16.txt-1- before\nutf16.txt:2: needle\nutf16.txt-3- after");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});

		it("should treat flag-like patterns as search text", async () => {
			const marker = join(testDir, "grep-injection-marker");
			const payload = join(testDir, "payload.sh");
			const testFile = join(testDir, "target.txt");
			writeFileSync(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
			chmodSync(payload, 0o755);
			writeFileSync(testFile, "target\n");

			const result = await grepTool.execute("test-call-grep-injection", {
				pattern: `--pre=${payload}`,
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No matches found");
			expect(existsSync(marker)).toBe(false);
		});
	});

	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it.skipIf(process.platform === "win32")("should preserve trailing spaces in filenames", async () => {
			writeFileSync(join(testDir, "report.txt "), "trailing space filename");

			const result = await findTool.execute("test-find-trailing-space", { pattern: "report*", path: testDir });

			expect(getTextOutput(result)).toBe("report.txt ");
			expect(existsSync(join(testDir, getTextOutput(result)))).toBe(true);
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should surface fd glob parse errors", async () => {
			await expect(
				findTool.execute("test-call-15", {
					pattern: "[",
					path: testDir,
				}),
			).rejects.toThrow(/error parsing glob|fd exited with code 1|fd error/i);
		});

		it("should treat flag-like patterns as search text", async () => {
			const result = await findTool.execute("test-call-find-flag-pattern", {
				pattern: "--help",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No files found matching pattern");
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

describe("tool cwd resolution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-cwd-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("read uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-read.txt");
		writeFileSync(testFile, "hello from ctx.cwd");
		const tool = createReadToolDefinition("/");
		const result = await tool.execute(
			"test-read-ctx-cwd",
			{ path: "ctx-cwd-read.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("hello from ctx.cwd");
	});

	it("write uses ctx.cwd when provided", async () => {
		const tool = createWriteToolDefinition("/");
		await tool.execute(
			"test-write-ctx-cwd",
			{ path: "ctx-cwd-write.txt", content: "written via ctx.cwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(join(testDir, "ctx-cwd-write.txt"), "utf-8");
		expect(content).toBe("written via ctx.cwd");
	});

	it("edit uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-edit.txt");
		writeFileSync(testFile, "old text");
		const tool = createEditToolDefinition("/");
		await tool.execute(
			"test-edit-ctx-cwd",
			{ path: "ctx-cwd-edit.txt", edits: [{ oldText: "old text", newText: "new text" }] },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("new text");
	});

	it("grep uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-grep.txt");
		writeFileSync(testFile, "match in ctx.cwd");
		const tool = createGrepToolDefinition("/");
		const result = await tool.execute(
			"test-grep-ctx-cwd",
			{ pattern: "match" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-grep.txt");
	});

	it("find uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-find.txt"), "find me");
		const tool = createFindToolDefinition("/");
		const result = await tool.execute(
			"test-find-ctx-cwd",
			{ pattern: "ctx-cwd-find.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-find.txt");
	});

	it("ls uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-ls.txt"), "list me");
		const tool = createLsToolDefinition("/");
		const result = await tool.execute("test-ls-ctx-cwd", {}, undefined, undefined, fakeCtx(testDir));
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-ls.txt");
	});

	it("bash uses ctx.cwd when provided", async () => {
		const tool = createBashToolDefinition("/", { exposeSessionEnvironment: false });
		const result = await tool.execute(
			"test-bash-ctx-cwd",
			{ command: "pwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain(testDir);
	});
});

describe("edit tool fuzzy matching", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match text with trailing whitespace stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		// File has trailing spaces on lines
		writeFileSync(testFile, "line one   \nline two  \nline three\n");

		// oldText without trailing whitespace should still match
		const result = await editTool.execute("test-fuzzy-1", {
			path: testFile,
			edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("replaced\nline three\n");
	});

	it.each([
		{ content: "a ", expected: "aX" },
		{ content: "hello world", expected: "helloXworld" },
	])("should replace a unique whitespace-only anchor in $content", async ({ content, expected }) => {
		const testFile = join(testDir, "whitespace-anchor.txt");
		writeFileSync(testFile, content);

		await editTool.execute("test-whitespace-anchor", {
			path: testFile,
			edits: [{ oldText: " ", newText: "X" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(expected);
	});

	it("should reject a missing whitespace-only anchor without changing the file", async () => {
		const testFile = join(testDir, "missing-whitespace-anchor.txt");
		writeFileSync(testFile, "ab");
		const edits = [{ oldText: " ", newText: "X" }];

		expect.soft(await computeEditsDiff(testFile, edits, testDir)).toEqual({
			error: expect.stringContaining("Could not find"),
		});
		await expect(editTool.execute("test-missing-whitespace-anchor", { path: testFile, edits })).rejects.toThrow(
			/Could not find/,
		);
		expect(readFileSync(testFile, "utf-8")).toBe("ab");
	});

	it("should count overlapping whitespace-only anchors in the original text", async () => {
		const testFile = join(testDir, "duplicate-whitespace-anchor.txt");
		writeFileSync(testFile, "a   b");

		await expect(
			editTool.execute("test-duplicate-whitespace-anchor", {
				path: testFile,
				edits: [{ oldText: "  ", newText: "X" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
		expect(readFileSync(testFile, "utf-8")).toBe("a   b");
	});

	it("should match fullwidth punctuation in Chinese text", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		writeFileSync(testFile, "你好，世界\n你好（世界）\n");

		const result = await editTool.execute("test-fuzzy-chinese", {
			path: testFile,
			edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("你好，pi\n你好(pi)\n");
	});

	it("should match compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		writeFileSync(testFile, "ＡＢＣ１２３\ncafe\u0301\n");

		const result = await editTool.execute("test-fuzzy-unicode", {
			path: testFile,
			edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("XYZ789\ncoffee\n");
	});

	it("should match smart single quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		// File has smart/curly single quotes (U+2018, U+2019)
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-2", {
			path: testFile,
			edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("world");
	});

	it("should match smart double quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		// File has smart/curly double quotes (U+201C, U+201D)
		writeFileSync(testFile, "const msg = \u201CHello World\u201D;\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-3", {
			path: testFile,
			edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("Goodbye");
	});

	it("should match Unicode dashes to ASCII hyphen", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		// File has en-dash (U+2013) and em-dash (U+2014)
		writeFileSync(testFile, "range: 1\u20135\nbreak\u2014here\n");

		// oldText with ASCII hyphens should match
		const result = await editTool.execute("test-fuzzy-4", {
			path: testFile,
			edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("10-50");
	});

	it("should match non-breaking space to regular space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		// File has non-breaking space (U+00A0)
		writeFileSync(testFile, "hello\u00A0world\n");

		// oldText with regular space should match
		const result = await editTool.execute("test-fuzzy-5", {
			path: testFile,
			edits: [{ oldText: "hello world", newText: "hello universe" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("universe");
	});

	it("should prefer exact match over fuzzy match", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		// File has both exact and fuzzy-matchable content
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-fuzzy-6", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	it("should still fail when text is not found even with fuzzy matching", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await expect(
			editTool.execute("test-fuzzy-7", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
	});

	it("should detect duplicates after fuzzy normalization", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		// Two lines that are identical after trailing whitespace is stripped
		writeFileSync(testFile, "hello world   \nhello world\n");

		await expect(
			editTool.execute("test-fuzzy-8", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should support fuzzy matching in multi-edit mode", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\nhello\u00A0world\n");

		await editTool.execute("test-fuzzy-9", {
			path: testFile,
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
	});

	it("should preserve the correct occurrence when fuzzy replacement equals a nearby line", async () => {
		const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
		const originalContent = ["replace me\u0020\u0020\u0020", "after\u0020\u0020\u0020", ""].join("\n");
		writeFileSync(testFile, originalContent);

		const result = await editTool.execute("test-fuzzy-preserve-duplicate-line", {
			path: testFile,
			edits: [{ oldText: "replace me\n", newText: "after\n" }],
		});

		const expectedContent = ["after", "after\u0020\u0020\u0020", ""].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
		expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
	});

	it("should preserve untouched lines and produce an applicable patch for fuzzy multi-edits", async () => {
		const testFile = join(testDir, "fuzzy-preserve-multi.txt");
		const originalContent = [
			"keep before\u0020\u0020",
			"first target\u0020\u0020",
			"first after",
			"keep middle\u0020\u0020\u0020",
			"second target\u0020\u0020",
			"second after",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		writeFileSync(testFile, originalContent);

		const result = await editTool.execute("test-fuzzy-preserve-multi", {
			path: testFile,
			edits: [
				{ oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
				{ oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
			],
		});

		const expectedContent = [
			"keep before\u0020\u0020",
			"FIRST",
			"FIRST2",
			"keep middle\u0020\u0020\u0020",
			"SECOND",
			"SECOND2",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
		expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
