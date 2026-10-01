import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { computeEditDiff } from "../src/core/tools/edit-diff.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-edit-byte-safety-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("edit byte safety", () => {
	it("rejects Latin-1 in execution and preview without altering the file", async () => {
		const path = join(dir, "latin1.txt");
		const bytes = Buffer.from([0x61, 0x3d, 0x31, 0x0a, 0xe9, 0x0a]);
		writeFileSync(path, bytes);
		expect(await computeEditDiff(path, "a=1", "a=2", dir)).toHaveProperty("error", expect.stringMatching(/UTF-8/i));
		await expect(
			createEditTool(dir).execute("edit", { path, edits: [{ oldText: "a=1", newText: "a=2" }] }),
		).rejects.toThrow(/UTF-8/i);
		expect(readFileSync(path)).toEqual(bytes);
	});

	it.each(["\n", "\r\n"])(
		"preserves untouched fullwidth text, trailing spaces and literal CR with %j endings",
		async (ending) => {
			const path = join(dir, "unicode.txt");
			const original = `ＡＢＣ “old” tail   ${ending}keep\rCR  ${ending}`;
			writeFileSync(path, original);
			await createEditTool(dir).execute("edit", { path, edits: [{ oldText: '"old"', newText: '"new"' }] });
			expect(readFileSync(path, "utf8")).toBe(`ＡＢＣ "new" tail   ${ending}keep\rCR  ${ending}`);
		},
	);

	it.each([
		["xﬃy", "fi"],
		["x\u{1D400}y", "\uD835"],
	])("rejects ambiguous Unicode boundaries in %s", async (text, oldText) => {
		const path = join(dir, "ambiguous.txt");
		writeFileSync(path, text);
		await expect(createEditTool(dir).execute("edit", { path, edits: [{ oldText, newText: "new" }] })).rejects.toThrow(
			/Unicode|boundary/,
		);
		expect(readFileSync(path, "utf8")).toBe(text);
	});
});
