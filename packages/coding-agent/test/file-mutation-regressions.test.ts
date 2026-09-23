import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../agent/src/harness/env/nodejs.ts";
import { createEditTool as createHarnessEditTool } from "../../agent/src/harness/tools/edit.ts";
import { applyEditsToNormalizedContent as applyHarnessEdits } from "../../agent/src/harness/tools/edit-diff.ts";
import { withFileMutationQueue as withHarnessQueue } from "../../agent/src/harness/tools/file-mutation-queue.ts";
import { createWriteTool as createHarnessWriteTool } from "../../agent/src/harness/tools/write.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, computeEditsDiff, type Edit } from "../src/core/tools/edit-diff.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const invocation = {
	invocationId: "test-result",
	operationId: "test-operation",
	turnId: "test-turn",
	getMemo: async () => undefined,
	setMemo: async () => {},
};
const noUpdate = () => {};
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup(kind: "coding-agent" | "harness", beforeWrite = async (_content: string) => {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mutation-regression-"));
	directories.push(cwd);
	if (kind === "harness") {
		const env = new NodeExecutionEnv({ cwd });
		const nativeWrite = env.writeFile.bind(env);
		vi.spyOn(env, "writeFile").mockImplementation(async (path, content, context) => {
			if (typeof content === "string") await beforeWrite(content);
			return nativeWrite(path, content, context);
		});
		return {
			cwd,
			edit: (edits: Edit[]) =>
				createHarnessEditTool().execute(
					"edit",
					{ path: "file.txt", edits },
					noUpdate,
					{ env },
					invocation,
					BACKGROUND_CONTEXT,
				),
			write: (path: string, content: string) =>
				createHarnessWriteTool().execute(
					"write",
					{ path, content },
					noUpdate,
					{ env },
					invocation,
					BACKGROUND_CONTEXT,
				),
			barrier: () => withHarnessQueue(env, join(cwd, "barrier"), async () => {}, BACKGROUND_CONTEXT),
		};
	}
	const writeTool = createWriteTool(cwd, {
		operations: {
			// Hold directory creation with the write so every missing ancestor is
			// still absent when the second call registers its queue key.
			mkdir: async () => {},
			writeFile: async (path, content) => {
				await beforeWrite(content);
				mkdirSync(dirname(path), { recursive: true });
				await writeFile(path, content);
			},
		},
	});
	return {
		cwd,
		edit: (edits: Edit[]) => createEditTool(cwd).execute("edit", { path: "file.txt", edits }),
		write: (path: string, content: string) => writeTool.execute("write", { path, content }),
		barrier: () => withFileMutationQueue(join(cwd, "barrier"), async () => {}),
	};
}

describe.each([
	{ kind: "coding-agent", apply: applyEditsToNormalizedContent },
	{ kind: "harness", apply: applyHarnessEdits },
])("$kind normalization boundaries", ({ apply }) => {
	it.each([
		"ㄱㅏ",
		"ㄱㅏ\u11A8",
		"\u1100ㅏ",
		"ㄱ\u1161",
		"a\u0315\u0300",
		"a\u0300\u0315",
		"x\u0338",
		"\u0344",
		"ﬃ",
		"Ⅳ㍱",
		"Å\u1F82",
		"𝔸👩‍💻",
		"ㄱㅏx\u0338ﬃa\u0315\u0300",
	])("checks every boundary against independently normalized sides: %s", (body) => {
		// Fullwidth delimiters force fuzzy matching and make each anchor unique.
		// This corpus needs only NFKC, with no quote/dash folding or trailing spaces.
		const original = `＜${body}＞`;
		const normalized = original.normalize("NFKC");
		const boundaries = [0];
		for (const char of original) boundaries.push(boundaries[boundaries.length - 1] + char.length);
		for (let offset = 0; offset <= normalized.length; offset++) {
			// Brute-force oracle deliberately does not use decomposition lengths.
			const boundary = boundaries.find(
				(index) =>
					original.slice(0, index).normalize("NFKC") === normalized.slice(0, offset) &&
					original.slice(index).normalize("NFKC") === normalized.slice(offset),
			);
			for (const side of ["start", "end"] as const) {
				const oldText = side === "start" ? normalized.slice(offset) : normalized.slice(0, offset);
				if (!oldText) continue;
				const run = () => apply(original, [{ oldText, newText: "changed" }], "fixture.txt");
				if (boundary === undefined) {
					expect(run).toThrow(/normalization expansion/);
				} else {
					expect(run().newContent).toBe(
						side === "start" ? `${original.slice(0, boundary)}changed` : `changed${original.slice(boundary)}`,
					);
				}
			}
		}
	});

	it.each([1000, 10000, 30000])("bounds normalization work with cross-cluster Hangul after %i characters", (size) => {
		const original = `${"x".repeat(size)} ㄱㅏ hello—world Ａ`;
		const nativeNormalize = String.prototype.normalize;
		let normalizedUnits = 0;
		const spy = vi.spyOn(String.prototype, "normalize").mockImplementation(function (this: string, form) {
			normalizedUnits += this.length;
			return nativeNormalize.call(this, form);
		});
		let result: ReturnType<typeof apply>;
		try {
			result = apply(original, [{ oldText: "hello-world", newText: "changed" }], "fixture.txt");
		} finally {
			spy.mockRestore();
		}
		expect(result.newContent).toBe(`${"x".repeat(size)} ㄱㅏ changed Ａ`);
		// Count input volume rather than wall time: a whole-line normalization per
		// boundary violates this linear bound regardless of machine speed.
		expect(normalizedUnits).toBeLessThan(16 * original.length);
	});
});

describe.each(["coding-agent", "harness"] as const)("%s file mutation regressions", (kind) => {
	it("rejects non-UTF-8 edits without changing unrelated bytes", async () => {
		const tools = await setup(kind);
		const path = join(tools.cwd, "file.txt");
		const original = Buffer.from("name=caf\xe9\nmode=old\n", "latin1");
		const edits = [{ oldText: "mode=old", newText: "mode=new" }];
		await writeFile(path, original);

		await expect(tools.edit(edits)).rejects.toThrow(/utf-8/i);
		expect(await readFile(path)).toEqual(original);
		expect(await computeEditsDiff("file.txt", edits, tools.cwd)).toMatchObject({
			error: expect.stringMatching(/utf-8/i),
		});
	});

	it("preserves valid UTF-8, BOM, and CRLF when editing", async () => {
		const tools = await setup(kind);
		const path = join(tools.cwd, "file.txt");
		await writeFile(path, "\uFEFFname=café\r\nmode=old\r\n");
		await tools.edit([{ oldText: "mode=old", newText: "mode=new" }]);
		expect(await readFile(path)).toEqual(Buffer.from("\uFEFFname=café\r\nmode=new\r\n"));
	});

	it.each(["new.txt", "missing/nested/new.txt"])(
		"serializes writes through a symlinked ancestor to %s",
		async (suffix) => {
			const started = deferred();
			const finish = deferred();
			const order: string[] = [];
			const tools = await setup(kind, async (content) => {
				order.push(content);
				if (content === "first") {
					started.resolve();
					await finish.promise;
				}
			});
			await mkdir(join(tools.cwd, "real"));
			await symlink("real", join(tools.cwd, "alias"), "dir");
			const first = tools.write(`real/${suffix}`, "first");
			await started.promise;
			const second = tools.write(`alias/${suffix}`, "second");
			try {
				// Registration is FIFO. A different file can run only after the alias
				// has registered; the held write must still prevent its I/O from starting.
				await tools.barrier();
				expect(order).toEqual(["first"]);
			} finally {
				finish.resolve();
				await Promise.all([first, second]);
			}
			expect(order).toEqual(["first", "second"]);
			expect(await readFile(join(tools.cwd, "real", suffix), "utf8")).toBe("second");
		},
	);

	it.each([
		{
			name: "same-line lookalikes",
			original: 'const label = "hello—world"; const token = "ＡＢＣ";  \n',
			oldText: "hello-world",
			expected: 'const label = "changed"; const token = "ＡＢＣ";  \n',
		},
		{
			name: "composed characters and expansions",
			original: "ﬃ cafe\u0301—end Ａ\t \n",
			oldText: "café-end",
			expected: "ﬃ changed Ａ\t \n",
		},
		{ name: "whole expansion", original: "Ａ oﬃce Ｂ\n", oldText: "office", expected: "Ａ changed Ｂ\n" },
		{
			name: "compatibility Hangul composition",
			original: "Ａ ㄱㅏ Ｂ\n",
			oldText: "가",
			expected: "Ａ changed Ｂ\n",
		},
		{
			name: "multiline trailing whitespace",
			original: "Ａ one—x \t\n two—y  \nＢ  \n",
			oldText: "one-x\n two-y",
			expected: "Ａ changed  \nＢ  \n",
		},
		{
			name: "partial grapheme at a representable boundary",
			original: "Ａ x\u0338—y Ｂ\n",
			oldText: "\u0338-y",
			expected: "Ａ xchanged Ｂ\n",
		},
	])("preserves unrelated bytes for $name", async ({ original, oldText, expected }) => {
		const tools = await setup(kind);
		await writeFile(join(tools.cwd, "file.txt"), original);
		const edits = [{ oldText, newText: "changed" }];
		const preview = await computeEditsDiff("file.txt", edits, tools.cwd);
		const result = await tools.edit(edits);
		expect(await readFile(join(tools.cwd, "file.txt"), "utf8")).toBe(expected);
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(expected);
		if (kind === "coding-agent") expect(preview).toMatchObject({ diff: result.details?.diff });
	});

	it.each([false, true])("prefers unique exact anchors with a fuzzy edit in the batch: %s", async (mixed) => {
		const tools = await setup(kind);
		await writeFile(join(tools.cwd, "file.txt"), "a—b a-b Ａ hello—world\n");
		const edits = [{ oldText: "a-b", newText: "exact" }];
		if (mixed) edits.unshift({ oldText: "hello-world", newText: "fuzzy" });
		await tools.edit(edits);
		expect(await readFile(join(tools.cwd, "file.txt"), "utf8")).toBe(
			`a—b exact Ａ ${mixed ? "fuzzy" : "hello—world"}\n`,
		);
	});

	it("keeps an exact whitespace anchor when another edit needs normalization", async () => {
		const tools = await setup(kind);
		await writeFile(join(tools.cwd, "file.txt"), "hello—world \n");
		await tools.edit([
			{ oldText: "hello-world", newText: "changed" },
			{ oldText: " ", newText: "!" },
		]);
		expect(await readFile(join(tools.cwd, "file.txt"), "utf8")).toBe("changed!\n");
	});

	it("rejects overlapping exact and fuzzy ranges before applying either edit", async () => {
		const tools = await setup(kind);
		const original = "Ａ cafe\u0301—end Ｂ\n";
		await writeFile(join(tools.cwd, "file.txt"), original);
		await expect(
			tools.edit([
				{ oldText: "café-end", newText: "fuzzy" },
				{ oldText: "e\u0301", newText: "exact" },
			]),
		).rejects.toThrow(/overlap/);
		expect(await readFile(join(tools.cwd, "file.txt"), "utf8")).toBe(original);
	});

	it.each([
		{ original: "a-b a—b a-b", oldText: "a-b" },
		{ original: "a—b a–b", oldText: "a-b" },
		{ original: "ａｂａｂａ", oldText: "aba" },
	])("rejects duplicate anchors without writing: $original", async ({ original, oldText }) => {
		const tools = await setup(kind);
		await writeFile(join(tools.cwd, "file.txt"), original);
		await expect(tools.edit([{ oldText, newText: "changed" }])).rejects.toThrow(/Found 2 occurrences/);
		expect(await readFile(join(tools.cwd, "file.txt"), "utf8")).toBe(original);
	});

	it("rejects an unsplittable normalization expansion without writing", async () => {
		const tools = await setup(kind);
		const original = "Ａ ﬃ Ｂ\n";
		await writeFile(join(tools.cwd, "file.txt"), original);
		await expect(tools.edit([{ oldText: "fi", newText: "changed" }])).rejects.toThrow(/normaliz|boundary/i);
		expect(await readFile(join(tools.cwd, "file.txt"), "utf8")).toBe(original);
	});
});
