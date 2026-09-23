import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../agent/src/harness/env/nodejs.ts";
import { publishLocalFile } from "../../agent/src/harness/env/publish-local-file.ts";
import { createEditTool as harnessEdit } from "../../agent/src/harness/tools/edit.ts";
import { withFileMutationQueue as harnessQueue } from "../../agent/src/harness/tools/file-mutation-queue.ts";
import { createReadTool as harnessRead } from "../../agent/src/harness/tools/read.ts";
import { createWriteTool as harnessWrite } from "../../agent/src/harness/tools/write.ts";
import { getOrThrow } from "../../agent/src/harness/types.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { isInsideGitRepo } from "../src/core/tools/path-utils.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const roots: string[] = [];
const context = BACKGROUND_CONTEXT;
const invocation = {
	invocationId: "fs",
	operationId: "fs",
	turnId: "fs",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

it("checks ignore-policy ancestry at the native search root", async () => {
	const root = await fixture();
	await mkdir(join(root, "actual/.git"));
	expect(await isInsideGitRepo(join(root, "link"))).toBe(true);
});
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-native-fs-"));
	roots.push(root);
	await mkdir(join(root, "actual/nested"), { recursive: true });
	await writeFile(join(root, "file"), "LEXICAL");
	await writeFile(join(root, "actual/file"), "PHYSICAL");
	await symlink(join(root, "actual/nested"), join(root, "link"), "junction");
	return root;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function tools(root: string, kind: "legacy" | "harness") {
	const env = new NodeExecutionEnv({ cwd: root });
	return {
		read: (path: string) =>
			kind === "legacy"
				? createReadTool(root).execute("r", { path })
				: harnessRead().execute("r", { path }, () => {}, { env }, invocation, context),
		write: (path: string, content: string) =>
			kind === "legacy"
				? createWriteTool(root).execute("w", { path, content })
				: harnessWrite().execute("w", { path, content }, () => {}, { env }, invocation, context),
		edit: (path: string, oldText: string, newText: string) =>
			kind === "legacy"
				? createEditTool(root).execute("e", { path, edits: [{ oldText, newText }] })
				: harnessEdit().execute(
						"e",
						{ path, edits: [{ oldText, newText }] },
						() => {},
						{ env },
						invocation,
						context,
					),
	};
}

describe.each(["legacy", "harness"] as const)("%s native operation paths", (kind) => {
	it.each([false, true])("keeps leading @ literal when the target already exists: %s", async (exists) => {
		const root = await fixture();
		const api = tools(root, kind);
		await mkdir(join(root, "@scope/pkg"), { recursive: true });
		await mkdir(join(root, "scope/pkg"), { recursive: true });
		const target = "@scope/pkg/config.json";
		const neighbor = join(root, "scope/pkg/config.json");
		await writeFile(neighbor, "UNRELATED");
		if (exists) await writeFile(join(root, target), "ORIGINAL");

		await api.write(target, "WRITTEN");
		expect(await readFile(join(root, target), "utf8")).toBe("WRITTEN");
		await api.edit(target, "WRITTEN", "EDITED");
		expect((await api.read(target)).content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining("EDITED") }),
		);
		expect(await readFile(join(root, target), "utf8")).toBe("EDITED");
		expect(await readFile(neighbor, "utf8")).toBe("UNRELATED");
	});
	it("reads and edits the same target as native traversal while keeping lexical APIs", async () => {
		const root = await fixture();
		const env = new NodeExecutionEnv({ cwd: root });
		const api = tools(root, kind);
		const path = "link/../file";
		const expected = await readFile(`${root}/${path}`, "utf8");
		expect((await api.read(path)).content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining(expected) }),
		);
		await api.edit(path, expected, "EDITED");
		expect(await readFile(`${root}/${path}`, "utf8")).toBe("EDITED");
		expect(await env.absolutePath(path, context)).toEqual({ ok: true, value: resolve(root, path) });
		expect(await env.joinPath([root, path], context)).toEqual({ ok: true, value: join(root, path) });
	});
	it.each(["link/../new/nested/file", "missing/../link/../file"])(
		"writes through addressed parent: %s",
		async (path) => {
			const root = await fixture();
			const api = tools(root, kind);
			await api.write(path, "UPDATED");
			expect(await readFile(`${root}/${path}`, "utf8")).toBe("UPDATED");
			if (process.platform !== "win32") expect(await readFile(join(root, "file"), "utf8")).toBe("LEXICAL");
		},
	);
	it("retains missing-parent read/edit failure and native invalid traversal failure", async () => {
		const root = await fixture();
		const api = tools(root, kind);
		for (const path of ["missing/../file", "file/../file", "file/"]) {
			const native = await readFile(`${root}/${path}`).then(
				() => true,
				() => false,
			);
			if (!native) {
				await expect(api.read(path)).rejects.toThrow();
				await expect(api.edit(path, "LEXICAL", "WRONG")).rejects.toThrow();
			}
		}
		expect(await readFile(join(root, "file"), "utf8")).toBe("LEXICAL");
	});
	it("prefers a literal Unicode-space filename over its read convenience fallback", async () => {
		const root = await fixture();
		const api = tools(root, kind);
		await writeFile(join(root, "a b"), "ASCII");
		await writeFile(join(root, "a\u00a0b"), "LITERAL");
		await api.write("a\u00a0b", "EXACT");
		expect((await api.read("a\u00a0b")).content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining("EXACT") }),
		);
		expect(await readFile(join(root, "a b"), "utf8")).toBe("ASCII");
	});
});

it("publisher never removes native directory requirements", async () => {
	const root = await fixture();
	for (const suffix of ["file/", "file/../file", "file/."]) {
		const path = `${root}/${suffix}`;
		const native = await writeFile(path, "NATIVE").then(
			() => true,
			() => false,
		);
		if (!native) await expect(publishLocalFile(path, "WRONG")).rejects.toThrow();
	}
	if (process.platform !== "win32") expect(await readFile(join(root, "file"), "utf8")).toBe("LEXICAL");
});

it.skipIf(process.platform === "win32")("validates trailing separators on every final symlink hop", async () => {
	const root = await fixture();
	await symlink("file/", join(root, "trailing"));
	await symlink("absent/new", join(root, "dangling-parent"));
	await expect(publishLocalFile(join(root, "trailing"), "WRONG")).rejects.toThrow();
	await expect(tools(root, "legacy").write("dangling-parent", "WRONG")).rejects.toThrow();
	await expect(lstat(join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(join(root, "file"), "utf8")).toBe("LEXICAL");
});

it("shares a FIFO queue across legacy and distinct Node environments without creating parents", async () => {
	const root = await fixture();
	const a = new NodeExecutionEnv({ cwd: root });
	const b = new NodeExecutionEnv({ cwd: root });
	const path = `${root}/missing/../link/../new/nested/file`;
	const target = process.platform === "win32" ? resolve(root, path) : `${root}/actual/new/nested/file`;
	const entered = deferred();
	const release = deferred();
	const order: string[] = [];
	const first = withFileMutationQueue(target, async () => {
		order.push("legacy");
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	const second = harnessQueue(
		a,
		path,
		async () => {
			order.push("a");
		},
		context,
	);
	const third = harnessQueue(
		b,
		target,
		async () => {
			order.push("b");
		},
		context,
	);
	try {
		await harnessQueue(b, join(root, "barrier"), async () => {}, context);
		expect(order).toEqual(["legacy"]);
		await expect(lstat(dirname(target))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		release.resolve();
		await Promise.all([first, second, third]);
	}
	expect(order).toEqual(["legacy", "a", "b"]);
});

it("keeps custom callbacks usable when their namespace is invalid on the local host", async () => {
	const root = await fixture();
	let received: string | undefined;
	await createWriteTool(root, {
		operations: {
			mkdir: async () => {},
			writeFile: async (path) => {
				received = path;
			},
		},
	}).execute("w", { path: "file/remote-child", content: "REMOTE" });
	expect(received).toBe(`${root}/file/remote-child`.replaceAll("/", process.platform === "win32" ? "\\" : "/"));
});

it("preserves operation addresses in Node metadata, listings, append and line readers", async () => {
	const root = await fixture();
	const env = new NodeExecutionEnv({ cwd: root });
	const directory = await realpath(`${root}/link/..`);
	getOrThrow(await env.appendFile("link/../file", "\nAPPENDED", context));
	const expected = await readFile(join(directory, "file"), "utf8");
	expect(getOrThrow(await env.readTextFile("link/../file", context))).toBe(expected);
	expect(getOrThrow(await env.fileInfo("link/../file", context)).size).toBe(Buffer.byteLength(expected));
	const entries = getOrThrow(await env.listDir("link/..", context));
	expect(entries.find((entry) => entry.name === "file")?.size).toBe(Buffer.byteLength(expected));
	const reader = getOrThrow(await env.openTextLineReader("link/../file", context));
	try {
		expect(getOrThrow(await reader.readLine(context))).toEqual({ text: expected.split("\n")[0], terminated: true });
	} finally {
		await reader.close(context);
	}
});

it("anchors a relative Node environment cwd before publishing", async () => {
	const root = await fixture();
	const env = new NodeExecutionEnv({ cwd: relative(process.cwd(), root) });
	getOrThrow(await env.writeFile("new-file", "RELATIVE", context));
	expect(await readFile(join(root, "new-file"), "utf8")).toBe("RELATIVE");
});

it.skipIf(process.platform === "win32")(
	"renames and removes final symlink entries without touching their referent",
	async () => {
		const root = await fixture();
		const env = new NodeExecutionEnv({ cwd: root });
		await symlink("file", join(root, "actual/alias"));
		getOrThrow(await env.renameFile("link/../alias", "link/../moved", context));
		expect((await lstat(join(root, "actual/moved"))).isSymbolicLink()).toBe(true);
		getOrThrow(await env.remove("link/../moved", undefined, context));
		expect(await readFile(join(root, "actual/file"), "utf8")).toBe("PHYSICAL");
	},
);

it("preserves nested distinct-file callbacks, return values and release after callback errors", async () => {
	const root = await fixture();
	await expect(
		withFileMutationQueue(join(root, "file"), () => withFileMutationQueue(join(root, "actual/file"), async () => 42)),
	).resolves.toBe(42);
	const failure = new Error("callback failed");
	await expect(
		withFileMutationQueue(join(root, "file"), async () => {
			throw failure;
		}),
	).rejects.toBe(failure);
	await expect(withFileMutationQueue(join(root, "file"), async () => "released")).resolves.toBe("released");
});
