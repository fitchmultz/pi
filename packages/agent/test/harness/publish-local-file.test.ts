import { execFileSync } from "node:child_process";
import { promises as nativeFs } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishLocalFile } from "../../src/harness/env/publish-local-file.ts";

vi.mock("node:fs/promises", { spy: true });

let root: string;
beforeEach(async () => {
	root = await nativeFs.mkdtemp(join(tmpdir(), "pi-publication-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await nativeFs.rm(root, { recursive: true, force: true });
});

describe("publishLocalFile", () => {
	it.each([false, true])(
		"keeps the destination unchanged after a partial staging write (existing: %s)",
		async (existing) => {
			const target = join(root, "file");
			if (existing) await nativeFs.writeFile(target, "original");
			const failure = new Error("write failed");
			vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
				const file = await nativeFs.open(...args);
				vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
					await file.write("partial");
					throw failure;
				});
				return file;
			});
			await expect(publishLocalFile(target, "replacement")).rejects.toBe(failure);
			if (existing) expect(await nativeFs.readFile(target, "utf8")).toBe("original");
			else await expect(nativeFs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await nativeFs.readdir(root)).toEqual(existing ? ["file"] : []);
		},
	);

	it.each(["chmod", "chown", "close", "rename"] as const)("does not publish when %s fails", async (operation) => {
		const target = join(root, "file");
		await nativeFs.writeFile(target, "original");
		const failure = new Error(`${operation} failed`);
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await nativeFs.open(...args);
			if (operation === "chown") {
				const info = await file.stat();
				vi.spyOn(file, "stat").mockResolvedValueOnce(Object.assign(info, { uid: info.uid + 1 }));
				vi.spyOn(file, "chown").mockRejectedValueOnce(failure);
			} else if (operation === "chmod") vi.spyOn(file, "chmod").mockRejectedValueOnce(failure);
			else if (operation === "close") vi.spyOn(file, "close").mockRejectedValueOnce(failure);
			return file;
		});
		if (operation === "rename") vi.mocked(fs.rename).mockRejectedValueOnce(failure);
		await expect(publishLocalFile(target, "replacement")).rejects.toBe(failure);
		expect(await nativeFs.readFile(target, "utf8")).toBe("original");
		expect(await nativeFs.readdir(root)).toEqual(["file"]);
	});

	it("does not remove an unowned stage after exclusive open fails", async () => {
		vi.mocked(fs.open).mockImplementationOnce(async (path) => {
			await nativeFs.writeFile(path, "someone else's file");
			throw Object.assign(new Error("collision"), { code: "EEXIST" });
		});
		await expect(publishLocalFile(join(root, "file"), "replacement")).rejects.toMatchObject({ code: "EEXIST" });
		const files = await nativeFs.readdir(root);
		expect(files).toHaveLength(1);
		expect(await nativeFs.readFile(join(root, files[0]), "utf8")).toBe("someone else's file");
	});

	it("preserves the primary failure when cleanup fails", async () => {
		const failure = new Error("rename failed");
		vi.mocked(fs.rename).mockRejectedValueOnce(failure);
		vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("cleanup failed"));
		await expect(publishLocalFile(join(root, "file"), "replacement")).rejects.toBe(failure);
		await expect(nativeFs.stat(join(root, "file"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects cancellation after staging closes but before rename", async () => {
		const target = join(root, "file");
		await nativeFs.writeFile(target, "original");
		const controller = new AbortController();
		vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
			const file = await nativeFs.open(...args);
			const close = file.close.bind(file);
			vi.spyOn(file, "close").mockImplementationOnce(async () => {
				await close();
				controller.abort();
			});
			return file;
		});
		await expect(publishLocalFile(target, "replacement", controller.signal)).rejects.toMatchObject({
			code: "ABORT_ERR",
		});
		expect(await nativeFs.readFile(target, "utf8")).toBe("original");
		expect(await nativeFs.readdir(root)).toEqual(["file"]);
	});

	it.each([false, true])("awaits rename's actual result despite late cancellation (failure: %s)", async (fail) => {
		const target = join(root, "file");
		await nativeFs.writeFile(target, "original");
		const controller = new AbortController();
		const failure = new Error("rename failed");
		vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
			controller.abort();
			if (fail) throw failure;
			await nativeFs.rename(...args);
		});
		const result = publishLocalFile(target, "replacement", controller.signal);
		if (fail) await expect(result).rejects.toBe(failure);
		else await expect(result).resolves.toBeUndefined();
		expect(await nativeFs.readFile(target, "utf8")).toBe(fail ? "original" : "replacement");
		expect(await nativeFs.readdir(root)).toEqual(["file"]);
	});

	it("rejects an already-aborted signal without creating a stage", async () => {
		await expect(publishLocalFile(join(root, "file"), "new", AbortSignal.abort())).rejects.toMatchObject({
			code: "ABORT_ERR",
		});
		expect(await nativeFs.readdir(root)).toEqual([]);
	});

	it("keeps existing and dangling relative symlink chains", async () => {
		await nativeFs.mkdir(join(root, "real"));
		await nativeFs.symlink("real", join(root, "parent"), "dir");
		await nativeFs.symlink("../second", join(root, "real", "first"));
		await nativeFs.symlink("real/target", join(root, "second"));
		for (const content of ["created", "replaced"]) {
			await publishLocalFile(join(root, "parent", "first"), content);
			expect(await nativeFs.readFile(join(root, "real", "target"), "utf8")).toBe(content);
			expect(await nativeFs.readlink(join(root, "real", "first"))).toBe("../second");
			expect(await nativeFs.readlink(join(root, "second"))).toBe("real/target");
		}
	});

	it("resolves parent traversal after directory symlinks in a relative link target", async () => {
		await nativeFs.mkdir(join(root, "nested", "child"), { recursive: true });
		await nativeFs.symlink("nested/child", join(root, "directory-link"), "dir");
		await nativeFs.symlink("directory-link/../target", join(root, "link"));
		await nativeFs.writeFile(join(root, "target"), "unrelated");
		await publishLocalFile(join(root, "link"), "intended");
		expect(await nativeFs.readFile(join(root, "nested", "target"), "utf8")).toBe("intended");
		expect(await nativeFs.readFile(join(root, "target"), "utf8")).toBe("unrelated");
		expect(await nativeFs.readlink(join(root, "link"))).toBe("directory-link/../target");
	});

	it("retains the directory requirement of a symlink target ending in a separator", async () => {
		const alias = join(root, "link");
		await nativeFs.symlink("missing/", alias);
		await expect(nativeFs.writeFile(alias, "replacement")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(publishLocalFile(alias, "replacement")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(nativeFs.lstat(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await nativeFs.readlink(alias)).toBe("missing/");
	});

	it("rejects symlink cycles and missing target parents without replacing links", async () => {
		await nativeFs.symlink("second", join(root, "first"));
		await nativeFs.symlink("first", join(root, "second"));
		await expect(publishLocalFile(join(root, "first"), "new")).rejects.toMatchObject({ code: "ELOOP" });
		await nativeFs.symlink("missing/target", join(root, "dangling"));
		await expect(publishLocalFile(join(root, "dangling"), "new")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await nativeFs.readlink(join(root, "dangling"))).toBe("missing/target");
		expect((await nativeFs.readdir(root)).sort()).toEqual(["dangling", "first", "second"]);
	});

	it.skipIf(process.platform === "win32")(
		"preserves ordinary mode/owner despite umask and gives new files normal permissions",
		async () => {
			const target = join(root, "file");
			await nativeFs.writeFile(target, "original");
			await nativeFs.chmod(target, 0o764);
			const original = await nativeFs.stat(target);
			const mask = process.umask(0o077);
			try {
				await publishLocalFile(target, Uint8Array.from([0, 255, 42]));
				await publishLocalFile(join(root, "new"), "new");
			} finally {
				process.umask(mask);
			}
			const result = await nativeFs.stat(target);
			expect(result.mode & 0o777).toBe(0o764);
			expect([result.uid, result.gid]).toEqual([original.uid, original.gid]);
			expect([...(await nativeFs.readFile(target))]).toEqual([0, 255, 42]);
			expect((await nativeFs.stat(join(root, "new"))).mode & 0o777).toBe(0o600);
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"rejects a read-only file even in a writable directory",
		async () => {
			const target = join(root, "file");
			await nativeFs.writeFile(target, "original");
			await nativeFs.chmod(target, 0o444);
			await expect(publishLocalFile(target, "new")).rejects.toMatchObject({ code: "EACCES" });
			expect(await nativeFs.readFile(target, "utf8")).toBe("original");
			expect(await nativeFs.readdir(root)).toEqual(["file"]);
		},
	);

	it.skipIf(process.platform === "win32").each(["FIFO", "directory"] as const)(
		"rejects an existing %s before staging without replacing it",
		async (kind) => {
			const target = join(root, "file");
			if (kind === "FIFO") execFileSync("mkfifo", [target]);
			else await nativeFs.mkdir(target);
			const original = await nativeFs.lstat(target);
			vi.mocked(fs.open).mockClear();
			vi.mocked(fs.rename).mockClear();

			await expect(publishLocalFile(target, "replacement")).rejects.toMatchObject({
				code: kind === "FIFO" ? "EINVAL" : "EISDIR",
			});
			const result = await nativeFs.lstat(target);
			expect([result.dev, result.ino, result.mode]).toEqual([original.dev, original.ino, original.mode]);
			expect(await nativeFs.readdir(root)).toEqual(["file"]);
			expect(fs.open).not.toHaveBeenCalled();
			expect(fs.rename).not.toHaveBeenCalled();
		},
	);

	it("replaces only the named path while hardlinks and open handles retain old bytes", async () => {
		const target = join(root, "file");
		await nativeFs.writeFile(target, "original");
		await nativeFs.link(target, join(root, "hardlink"));
		const reader = await nativeFs.open(target, "r");
		try {
			await publishLocalFile(target, "replacement");
			expect(await nativeFs.readFile(target, "utf8")).toBe("replacement");
			expect(await nativeFs.readFile(join(root, "hardlink"), "utf8")).toBe("original");
			expect(await reader.readFile("utf8")).toBe("original");
		} finally {
			await reader.close();
		}
	});
});
