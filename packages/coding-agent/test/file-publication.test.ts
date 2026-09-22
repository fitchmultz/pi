import { spawnSync } from "node:child_process";
import { promises as nativeFs } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../agent/src/harness/env/nodejs.ts";
import { createEditTool as createHarnessEditTool } from "../../agent/src/harness/tools/edit.ts";
import { withFileMutationQueue as withHarnessQueue } from "../../agent/src/harness/tools/file-mutation-queue.ts";
import { createWriteTool as createHarnessWriteTool } from "../../agent/src/harness/tools/write.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

vi.mock("node:fs/promises", { spy: true });

let root: string;
beforeEach(async () => {
	root = await nativeFs.mkdtemp(join(tmpdir(), "pi-file-publication-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await nativeFs.rm(root, { recursive: true, force: true });
});
const invocation = {
	invocationId: "test",
	operationId: "test",
	turnId: "test",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function tools(kind: "normal" | "harness") {
	const env = new NodeExecutionEnv({ cwd: root });
	return {
		write: (path: string, content: string, signal?: AbortSignal) =>
			kind === "normal"
				? createWriteTool(root).execute("write", { path, content }, signal)
				: createHarnessWriteTool().execute(
						"write",
						{ path, content },
						() => {},
						{ env },
						invocation,
						signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
					),
		edit: (path: string, oldText: string, newText: string, signal?: AbortSignal) =>
			kind === "normal"
				? createEditTool(root).execute("edit", { path, edits: [{ oldText, newText }] }, signal)
				: createHarnessEditTool().execute(
						"edit",
						{ path, edits: [{ oldText, newText }] },
						() => {},
						{ env },
						invocation,
						signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
					),
		queue: (path: string, fn: () => Promise<void>) =>
			kind === "normal" ? withFileMutationQueue(path, fn) : withHarnessQueue(env, path, fn, BACKGROUND_CONTEXT),
	};
}

describe.each(["normal", "harness"] as const)("%s publication", (kind) => {
	it.each(["write", "edit"] as const)(
		"keeps the queue until a late-aborted %s publication settles and reports success",
		async (operation) => {
			const target = join(root, "file");
			await nativeFs.writeFile(target, "original");
			const submitted = deferred();
			const finish = deferred();
			const controller = new AbortController();
			const tool = tools(kind);
			vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
				submitted.resolve();
				await finish.promise;
				await nativeFs.rename(...args);
			});
			const first =
				operation === "write"
					? tool.write(target, "first", controller.signal)
					: tool.edit(target, "original", "first", controller.signal);
			await submitted.promise;
			controller.abort();
			let secondStarted = false;
			const second = tool.queue(target, async () => {
				secondStarted = true;
			});
			try {
				await tool.queue(join(root, "barrier"), async () => {});
				expect(secondStarted).toBe(false);
			} finally {
				finish.resolve();
			}
			await expect(first).resolves.toMatchObject({
				content: [{ type: "text", text: expect.stringContaining("Successfully") }],
			});
			await second;
			expect(await nativeFs.readFile(target, "utf8")).toBe("first");
		},
	);

	it("serializes existing case aliases on a case-insensitive filesystem", async (context) => {
		const target = join(root, "file");
		const alias = join(root, "FILE");
		await nativeFs.writeFile(target, "original");
		const aliasInfo = await nativeFs.stat(alias).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (!aliasInfo) return context.skip("The temporary filesystem is case-sensitive");
		const targetInfo = await nativeFs.stat(target);
		expect([aliasInfo.dev, aliasInfo.ino]).toEqual([targetInfo.dev, targetInfo.ino]);

		const tool = tools(kind);
		const entered = deferred();
		const finish = deferred();
		const first = tool.queue(target, async () => {
			entered.resolve();
			await finish.promise;
		});
		await entered.promise;
		let secondStarted = false;
		const second = tool.queue(alias, async () => {
			secondStarted = true;
		});
		try {
			await tool.queue(join(root, "barrier"), async () => {});
			expect(secondStarted).toBe(false);
		} finally {
			finish.resolve();
			await Promise.all([first, second]);
		}
		expect(secondStarted).toBe(true);
	});

	it("uses one queue for a dangling relative symlink chain and its target", async () => {
		await nativeFs.mkdir(join(root, "dir"));
		await nativeFs.symlink("dir/second", join(root, "first"));
		await nativeFs.symlink("../target", join(root, "dir", "second"));
		const tool = tools(kind);
		const entered = deferred();
		const finish = deferred();
		const first = tool.queue(join(root, "first"), async () => {
			entered.resolve();
			await finish.promise;
		});
		await entered.promise;
		let secondStarted = false;
		const second = tool.queue(join(root, "target"), async () => {
			secondStarted = true;
		});
		try {
			await tool.queue(join(root, "barrier"), async () => {});
			expect(secondStarted).toBe(false);
		} finally {
			finish.resolve();
		}
		await Promise.all([first, second]);
		await tool.write(join(root, "first"), "through-link");
		expect(await nativeFs.readFile(join(root, "target"), "utf8")).toBe("through-link");
		expect(await nativeFs.readlink(join(root, "first"))).toBe("dir/second");
		expect(await nativeFs.readlink(join(root, "dir", "second"))).toBe("../target");
	});
});

it("keeps injected backends on their exact two-argument completion contract", async () => {
	const controller = new AbortController();
	const writeFile = vi.fn(async (_path: string, _content: string) => {
		controller.abort();
	});
	const operations = {
		writeFile,
		mkdir: async () => {},
		access: async () => {},
		readFile: async () => Buffer.from("original"),
	};
	await createWriteTool(root, { operations }).execute("write", { path: "remote", content: "new" }, controller.signal);
	expect(writeFile).toHaveBeenLastCalledWith(join(root, "remote"), "new");
	const editController = new AbortController();
	writeFile.mockImplementationOnce(async () => {
		editController.abort();
	});
	await createEditTool(root, { operations }).execute(
		"edit",
		{ path: "remote", edits: [{ oldText: "original", newText: "changed" }] },
		editController.signal,
	);
	expect(writeFile).toHaveBeenLastCalledWith(join(root, "remote"), "changed");
	expect(await nativeFs.readdir(root)).toEqual([]);
});

describe.skipIf(process.platform === "win32")("real file-size failures", () => {
	for (const kind of ["write", "edit", "env", "harness-write", "harness-edit"]) {
		for (const existing of kind.endsWith("edit") ? [true] : [true, false]) {
			it.each(["unlimited", "handled", "unhandled"])(`${kind}, existing=${existing}, %s`, async (mode) => {
				const target = join(root, "file");
				if (existing) await nativeFs.writeFile(target, "original");
				const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
				const fixture = fileURLToPath(new URL("./fixtures/file-publication.ts", import.meta.url));
				const child = spawnSync(
					"/bin/bash",
					[
						"-c",
						`${mode === "unlimited" ? "" : "ulimit -f 2; "}exec "$@"`,
						"publication",
						process.execPath,
						"--import",
						resolver,
						fixture,
						kind,
						target,
						mode,
					],
					{
						cwd: root,
						env: {
							PATH: process.env.PATH,
							HOME: root,
							PI_CODING_AGENT_DIR: root,
							PI_OFFLINE: "1",
							PI_TELEMETRY: "0",
							NODE_DISABLE_COMPILE_CACHE: "1",
						},
						encoding: "utf8",
						timeout: 30_000,
					},
				);
				expect(child.error).toBeUndefined();
				// Signal disposition can differ between hosts; both native failure outcomes
				// must leave the addressed file unchanged.
				if (child.signal) {
					expect(mode).toBe("unhandled");
					expect(child.signal).toBe("SIGXFSZ");
				} else {
					expect(child.status, child.stderr).toBe(0);
					const result = JSON.parse(child.stdout);
					expect(result.success).toBe(mode === "unlimited");
					if (mode !== "unlimited") expect(result.error).toContain("EFBIG");
				}
				if (mode === "unlimited") expect(await nativeFs.readFile(target, "utf8")).toBe("N".repeat(8192));
				else if (existing) expect(await nativeFs.readFile(target, "utf8")).toBe("original");
				else await expect(nativeFs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
				if (mode === "handled") expect(await nativeFs.readdir(root)).toEqual(existing ? ["file"] : []);
			});
		}
	}
});
