import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandPath, resolveReadPath, resolveReadPathAsync, resolveToCwd } from "../src/core/tools/path-utils.ts";

describe("path-utils", () => {
	describe("expandPath", () => {
		it("should expand ~ to home directory", () => {
			const result = expandPath("~");
			expect(result).not.toContain("~");
		});

		it("should expand ~/path to home directory", () => {
			const result = expandPath("~/Documents/file.txt");
			expect(result).not.toContain("~/");
		});

		it("should keep tilde-prefixed filenames literal", () => {
			expect(expandPath("~draft.md")).toBe("~draft.md");
			expect(expandPath("@~draft.md")).toBe("~draft.md");
		});

		it("should normalize Unicode spaces", () => {
			// Non-breaking space (U+00A0) should become regular space
			const withNBSP = "file\u00A0name.txt";
			const result = expandPath(withNBSP);
			expect(result).toBe("file name.txt");
		});
	});

	describe("resolveToCwd", () => {
		it("should resolve absolute paths as-is", () => {
			const absolutePath = resolve(tmpdir(), "absolute", "path", "file.txt");
			const result = resolveToCwd(absolutePath, resolve(tmpdir(), "some", "cwd"));
			expect(result).toBe(absolutePath);
		});

		it("should resolve relative paths against cwd", () => {
			const result = resolveToCwd("relative/file.txt", "/some/cwd");
			expect(result).toBe(resolve("/some/cwd", "relative/file.txt"));
		});

		it("should resolve tilde-prefixed filenames against cwd", () => {
			const cwd = join(tmpdir(), "pi-path-utils-cwd");
			expect(resolveToCwd("~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
			expect(resolveToCwd("@~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
		});
	});

	describe.each([
		{ name: "resolveReadPath", resolveRead: resolveReadPath },
		{ name: "resolveReadPathAsync", resolveRead: resolveReadPathAsync },
	])("$name", ({ resolveRead }) => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "path-utils-test-"));
		});

		afterEach(() => {
			// Clean up temp files and directory
			try {
				const files = readdirSync(tempDir);
				for (const file of files) {
					unlinkSync(join(tempDir, file));
				}
				rmdirSync(tempDir);
			} catch {
				// Ignore cleanup errors
			}
		});

		it("prefers exact Unicode-space paths before read-only normalization fallbacks", async () => {
			const exact = "report\u00a0final.txt";
			const other = "report final.txt";
			writeFileSync(join(tempDir, exact), "intended");
			writeFileSync(join(tempDir, other), "unrelated");
			expect(await resolveRead(`@${exact}`, tempDir)).toBe(join(tempDir, exact));
			unlinkSync(join(tempDir, exact));
			expect(await resolveRead(`@${exact}`, tempDir)).toBe(join(tempDir, other));
		});

		it("keeps typography fallbacks after Unicode-space normalization", async () => {
			// Exercise the existing combined NFD + curly quote fallback separately from AM/PM.
			const curlyName = "Capture d\u2019e\u0301cran.txt";
			writeFileSync(join(tempDir, curlyName), "curly content");
			expect(readFileSync(await resolveRead("Capture\u00a0d'écran.txt", tempDir), "utf-8")).toBe("curly content");
			const screenshot = "Screenshot 10.00\u202fAM.png";
			writeFileSync(join(tempDir, screenshot), "screenshot");
			expect(await resolveRead("Screenshot\u00a010.00 AM.png", tempDir)).toBe(join(tempDir, screenshot));
		});

		it("tries AM/PM before quote fallbacks when both paths exist", async () => {
			const input = "Capture d'écran 10.00 AM.png";
			const amPm = join(tempDir, "Capture d'écran 10.00\u202fAM.png");
			const curly = join(tempDir, "Capture d\u2019écran 10.00 AM.png");
			writeFileSync(amPm, "AM/PM");
			writeFileSync(curly, "curly quote");
			expect(await resolveRead(input, tempDir)).toBe(amPm);
			unlinkSync(amPm);
			expect(await resolveRead(input, tempDir)).toBe(curly);
		});

		it("expands tilde and @ while retaining missing literal paths", async () => {
			expect(await resolveRead("@~/pi-missing\u00a0file.txt", tempDir)).toBe(
				join(homedir(), "pi-missing\u00a0file.txt"),
			);
		});

		it("should resolve existing file path", async () => {
			const fileName = "test-file.txt";
			writeFileSync(join(tempDir, fileName), "content");

			const result = await resolveRead(fileName, tempDir);
			expect(result).toBe(join(tempDir, fileName));
		});

		it("should handle NFC vs NFD Unicode normalization (macOS filenames with accents)", async () => {
			// macOS stores filenames in NFD (decomposed) form:
			//   é = e + combining acute accent (U+0301)
			// Users typically type in NFC (composed) form:
			//   é = single character (U+00E9)
			//
			// Note: macOS APFS normalizes Unicode automatically, so both paths work.
			// This test verifies the NFD variant fallback works on systems that don't.

			// NFD: e (U+0065) + combining acute accent (U+0301)
			const nfdFileName = "file\u0065\u0301.txt";
			// NFC: é as single character (U+00E9)
			const nfcFileName = "file\u00e9.txt";

			// Verify they have different byte sequences
			expect(nfdFileName).not.toBe(nfcFileName);
			expect(Buffer.from(nfdFileName)).not.toEqual(Buffer.from(nfcFileName));

			// Create file with NFD name
			writeFileSync(join(tempDir, nfdFileName), "content");

			// User provides NFC path - should find the file (via filesystem normalization or our fallback)
			const result = await resolveRead(nfcFileName, tempDir);
			// Result should contain the accented character (either NFC or NFD form)
			expect(result).toContain(tempDir);
			expect(result).toMatch(/file.+\.txt$/);
		});

		it("should handle curly quotes vs straight quotes (macOS filenames)", async () => {
			// macOS uses curly apostrophe (U+2019) in screenshot filenames:
			//   Capture d'écran (U+2019)
			// Users typically type straight apostrophe (U+0027):
			//   Capture d'ecran (U+0027)

			const curlyQuoteName = "Capture d\u2019cran.txt"; // U+2019 right single quotation mark
			const straightQuoteName = "Capture d'cran.txt"; // U+0027 apostrophe

			// Verify they are different
			expect(curlyQuoteName).not.toBe(straightQuoteName);

			// Create file with curly quote name (simulating macOS behavior)
			writeFileSync(join(tempDir, curlyQuoteName), "content");

			// User provides straight quote path - should find the curly quote file
			const result = await resolveRead(straightQuoteName, tempDir);
			expect(result).toBe(join(tempDir, curlyQuoteName));
		});

		it("should handle combined NFC + curly quote (French macOS screenshots)", async () => {
			// Full macOS screenshot filename: "Capture d'écran" with NFD é and curly quote
			// Note: macOS APFS normalizes NFD to NFC, so the actual file on disk uses NFC
			const nfcCurlyName = "Capture d\u2019\u00e9cran.txt"; // NFC + curly quote (how APFS stores it)
			const nfcStraightName = "Capture d'\u00e9cran.txt"; // NFC + straight quote (user input)

			// Verify they are different
			expect(nfcCurlyName).not.toBe(nfcStraightName);

			// Create file with macOS-style name (curly quote)
			writeFileSync(join(tempDir, nfcCurlyName), "content");

			// User provides straight quote path - should find the curly quote file
			const result = await resolveRead(nfcStraightName, tempDir);
			expect(result).toBe(join(tempDir, nfcCurlyName));
		});

		it("should handle macOS screenshot AM/PM variant with narrow no-break space", async () => {
			// macOS uses narrow no-break space (U+202F) before AM/PM in screenshot names
			const macosName = "Screenshot 2024-01-01 at 10.00.00\u202FAM.png"; // U+202F
			const userName = "Screenshot 2024-01-01 at 10.00.00 AM.png"; // regular space

			// Create file with macOS-style name
			writeFileSync(join(tempDir, macosName), "content");

			// User provides regular space path
			const result = await resolveRead(userName, tempDir);

			expect(result).toBe(join(tempDir, macosName));
		});

		it("should handle macOS screenshot lowercase am/pm variant (en_AU locale)", async () => {
			// Some locales like en_AU use lowercase am/pm in screenshot names
			const macosName = "Screenshot 2024-01-01 at 10.00.00\u202Fam.png"; // U+202F + lowercase
			const userName = "Screenshot 2024-01-01 at 10.00.00 am.png"; // regular space + lowercase

			// Create file with macOS-style name
			writeFileSync(join(tempDir, macosName), "content");

			// User provides regular space path
			const result = await resolveRead(userName, tempDir);

			expect(result).toBe(join(tempDir, macosName));
		});
	});
});
