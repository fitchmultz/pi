import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFindTool, type FindOperations } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createLsTool, type LsOperations } from "../src/core/tools/ls.ts";
import { createReadTool, type ReadOperations } from "../src/core/tools/read.ts";

async function errorOf(run: Promise<unknown>): Promise<string> {
	try {
		await run;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("the call did not fail");
}

describe("missing path errors", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-missing-path-")));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	// 16 entries. By case-insensitive edit distance to "reprot.txt": REPORT.txt 2, the next three 3, the rest 26.
	const many = join(root, "many");
	mkdirSync(many);
	const unrelated = Array.from(
		{ length: 12 },
		(_, i) => `zz-unrelated-file-name-${String(i + 1).padStart(2, "0")}.log`,
	);
	for (const name of ["REPORT.txt", "report.tx", "reports.txt", "reprot.md", ...unrelated]) {
		writeFileSync(join(many, name), "x");
	}
	const closestOfMany = `Nearest existing parent: ${many}. Closest of its 16 entries to "reprot.txt": REPORT.txt, report.tx, reports.txt, reprot.md, ${unrelated.slice(0, 8).join(", ")}.`;

	const few = join(root, "few");
	mkdirSync(join(few, "source"), { recursive: true });
	writeFileSync(join(few, "notes.md"), "x");
	const empty = join(root, "empty");
	mkdirSync(empty);

	const read = createReadTool(root);
	const ls = createLsTool(root);
	const grep = createGrepTool(root);
	const find = createFindTool(root);

	it("read names the nearest existing parent and its 12 closest entries", async () => {
		const path = join(many, "reprot.txt");
		expect(await errorOf(read.execute("call", { path }))).toBe(
			`ENOENT: no such file or directory, access '${path}'\n${closestOfMany}`,
		);
	});

	it("names the first missing directory when several levels are missing", async () => {
		const path = join(few, "src", "core", "tools.ts");
		expect(await errorOf(read.execute("call", { path }))).toBe(
			`ENOENT: no such file or directory, access '${path}'\nNearest existing parent: ${few}. Its entries: source, notes.md.`,
		);
	});

	it("says when the parent has no entries or cannot be listed", async () => {
		expect(await errorOf(ls.execute("call", { path: join(empty, "missing") }))).toBe(
			`Path not found: ${join(empty, "missing")}\nNearest existing parent: ${empty}. It has no entries.`,
		);
		// The nearest existing parent is a file.
		const below = join(few, "notes.md", "section");
		expect(await errorOf(ls.execute("call", { path: below }))).toBe(
			`Path not found: ${below}\nNearest existing parent: ${join(few, "notes.md")}.`,
		);
	});

	it("ls, grep and find add the same line", async () => {
		const path = join(many, "reprot.txt");
		expect(await errorOf(ls.execute("call", { path }))).toBe(`Path not found: ${path}\n${closestOfMany}`);
		expect(await errorOf(grep.execute("call", { pattern: "x", path }))).toBe(
			`Path not found: ${path}\n${closestOfMany}`,
		);
		const findError = await errorOf(find.execute("call", { pattern: "*.txt", path }));
		expect(findError).toContain("[fd error]");
		expect(findError.endsWith(`\n${closestOfMany}`)).toBe(true);
	});

	it("leaves the error of an existing path alone", async () => {
		const file = join(few, "notes.md");
		expect(await errorOf(find.execute("call", { pattern: "*.txt", path: file }))).not.toContain("Nearest existing");
		expect(await errorOf(read.execute("call", { path: few }))).not.toContain("Nearest existing");
	});

	it("uses custom operations where they can look up, and keeps their error where they cannot", async () => {
		const remoteEntries: Record<string, string[]> = { "/": ["srv"], "/srv": ["app", "logs"] };
		const exists = (path: string) => path in remoteEntries;
		const lsOperations: LsOperations = {
			exists,
			stat: () => ({ isDirectory: () => true }),
			readdir: (path) => remoteEntries[path],
		};
		expect(
			await errorOf(createLsTool("/", { operations: lsOperations }).execute("call", { path: "/srv/lgos/today" })),
		).toBe("Path not found: /srv/lgos/today\nNearest existing parent: /srv. Its entries: logs, app.");

		// FindOperations has no directory listing: the parent alone.
		const findOperations: FindOperations = { exists, glob: () => [] };
		expect(
			await errorOf(
				createFindTool("/", { operations: findOperations }).execute("call", {
					pattern: "*",
					path: "/srv/lgos/today",
				}),
			),
		).toBe("Path not found: /srv/lgos/today\nNearest existing parent: /srv.");

		// ReadOperations and GrepOperations can only fail: their error is unchanged.
		const readOperations: ReadOperations = {
			readFile: async () => Buffer.from(""),
			access: async () => {
				throw new Error("remote: no such file");
			},
		};
		const path = join(many, "reprot.txt");
		expect(await errorOf(createReadTool(root, { operations: readOperations }).execute("call", { path }))).toBe(
			"remote: no such file",
		);
		const grepOperations = {
			isDirectory: () => {
				throw new Error("remote: no such file");
			},
		};
		expect(
			await errorOf(createGrepTool(root, { operations: grepOperations }).execute("call", { pattern: "x", path })),
		).toBe(`Path not found: ${path}`);
	});
});
