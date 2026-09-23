import childProcess, { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CredentialStore, createModels, type Provider } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";

describe("AuthStorage", () => {
	const tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authJsonPath = join(tempDir, "auth.json");

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>): void {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	test("reads and resolves stored API-key credentials", async () => {
		const original = process.env.TEST_AUTH_STORAGE_KEY;
		process.env.TEST_AUTH_STORAGE_KEY = "environment-key";
		try {
			writeAuthJson({ anthropic: { type: "api_key", key: "$TEST_AUTH_STORAGE_KEY" } });
			const storage = AuthStorage.create(authJsonPath);
			expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "environment-key" });
		} finally {
			if (original === undefined) delete process.env.TEST_AUTH_STORAGE_KEY;
			else process.env.TEST_AUTH_STORAGE_KEY = original;
		}
	});

	test("resolves command-backed API-key credentials", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "!printf 'command-key'" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "command-key" });
	});

	test("returns OAuth credentials unchanged", async () => {
		const credential = {
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		const storage = AuthStorage.inMemory({ anthropic: credential });
		expect(await storage.read("anthropic")).toEqual(credential);
	});

	test("credential-scoped env takes precedence and remains inspectable", async () => {
		writeAuthJson({
			anthropic: {
				type: "api_key",
				key: "$SCOPED_KEY",
				env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
			},
		});
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toMatchObject({
			key: "scoped-value",
			env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
		});
	});

	test("coalesces file reloads across concurrent readers and storage instances", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(authJsonPath);
		const lockSpy = vi.spyOn(lockfile, "lock");

		writeAuthJson({
			anthropic: { type: "api_key", key: "new" },
			openai: { type: "api_key", key: "openai-key" },
		});

		const [anthropic, openai, credentials] = await Promise.all([
			first.read("anthropic", { signal: new AbortController().signal }),
			second.read("openai", { signal: new AbortController().signal }),
			first.list({ signal: new AbortController().signal }),
		]);
		expect(anthropic).toEqual({ type: "api_key", key: "new" });
		expect(openai).toEqual({ type: "api_key", key: "openai-key" });
		expect(credentials).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
		expect(lockSpy).toHaveBeenCalledTimes(1);

		await expect(second.read("anthropic")).resolves.toEqual({ type: "api_key", key: "new" });
		expect(lockSpy).toHaveBeenCalledTimes(1);

		const otherPath = join(tempDir, "other-auth.json");
		writeFileSync(otherPath, JSON.stringify({ other: { type: "api_key", key: "other-key" } }));
		const otherFirst = AuthStorage.create(otherPath);
		const otherSecond = AuthStorage.create(otherPath);
		await otherFirst.read("other");
		await otherSecond.read("other");
		await otherFirst.list();
		expect(lockSpy).toHaveBeenCalledTimes(1);

		const third = AuthStorage.create(authJsonPath);
		writeAuthJson({ anthropic: { type: "api_key", key: "newest" } });
		const [firstReload, thirdReload] = await Promise.all([first.read("anthropic"), third.read("anthropic")]);
		expect(firstReload).toEqual({ type: "api_key", key: "newest" });
		expect(thirdReload).toEqual({ type: "api_key", key: "newest" });
		expect(lockSpy).toHaveBeenCalledTimes(2);
	});

	test("keeps a coalesced reload alive while another credential reader is waiting", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({ anthropic: { type: "api_key", key: "new" } });
		let grantLock: (() => void) | undefined;
		const lockGranted = new Promise<void>((resolve) => {
			grantLock = resolve;
		});
		const release = vi.fn(async () => {});
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async () => {
			await lockGranted;
			return release;
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = storage.read("anthropic", { signal: firstController.signal });
		const second = storage.read("anthropic", { signal: secondController.signal });

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		grantLock?.();
		await expect(second).resolves.toEqual({ type: "api_key", key: "new" });
		expect(lockSpy).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	test.skipIf(process.platform === "win32")("creates new auth files with owner-only permissions", () => {
		AuthStorage.create(authJsonPath);

		expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
	});

	test.skipIf(process.platform === "win32")("preserves the mode of an existing auth file", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		chmodSync(authJsonPath, 0o660);
		const storage = AuthStorage.create(authJsonPath);

		await storage.modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(statSync(authJsonPath).mode & 0o777).toBe(0o660);
	});

	test("modify persists a credential while preserving unrelated external edits", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "old" },
			openai: { type: "api_key", key: "external" },
		});

		await storage.modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "new" },
			openai: { type: "api_key", key: "external" },
		});
	});

	test.skipIf(process.platform === "win32")("a failed write keeps all previously saved credentials", () => {
		const original = {
			anthropic: { type: "api_key", key: "old" },
			openai: { type: "api_key", key: "unrelated" },
		};
		writeAuthJson(original);
		const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
		const fixture = fileURLToPath(new URL("./fixtures/auth-storage-file-limit.ts", import.meta.url));
		const child = spawnSync(
			"/bin/bash",
			[
				"-c",
				'ulimit -f 2; exec "$@"',
				"auth-storage",
				process.execPath,
				"--import",
				resolver,
				fixture,
				authJsonPath,
			],
			{
				cwd: tempDir,
				env: {
					PATH: process.env.PATH,
					HOME: tempDir,
					PI_CODING_AGENT_DIR: tempDir,
					PI_OFFLINE: "1",
					PI_TELEMETRY: "0",
					NODE_DISABLE_COMPILE_CACHE: "1",
				},
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ success: false, error: expect.stringContaining("EFBIG") });
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual(original);
	});

	test.skipIf(process.platform === "win32")("keeps a symlinked parent and .. path on the original file", async () => {
		const entry = join(tempDir, "entry");
		const targetDirectory = join(tempDir, "actual");
		mkdirSync(entry);
		mkdirSync(join(targetDirectory, "child"), { recursive: true });
		symlinkSync("../actual/child", join(entry, "link"), "dir");
		const target = join(targetDirectory, "auth.json");
		const unrelated = join(entry, "auth.json");
		writeFileSync(target, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }));
		writeFileSync(unrelated, JSON.stringify({ openai: { type: "api_key", key: "unrelated" } }));

		await AuthStorage.create(`${entry}/link/../auth.json`).modify("anthropic", async () => ({
			type: "api_key",
			key: "updated",
		}));

		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ anthropic: { type: "api_key", key: "updated" } });
		expect(JSON.parse(readFileSync(unrelated, "utf8"))).toEqual({ openai: { type: "api_key", key: "unrelated" } });
	});

	test.skipIf(process.platform === "win32")("keeps a recreated auth file owner-only", async () => {
		writeFileSync(authJsonPath, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }), { mode: 0o600 });
		const storage = AuthStorage.create(authJsonPath);
		const previousUmask = process.umask(0o022);
		try {
			await storage.modify("anthropic", async () => {
				rmSync(authJsonPath);
				return { type: "api_key", key: "new" };
			});
		} finally {
			process.umask(previousUmask);
		}
		expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
	});

	test.skipIf(process.platform !== "darwin")("preserves a custom auth file ACL", async () => {
		writeFileSync(authJsonPath, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }), { mode: 0o600 });
		const grant = spawnSync("/bin/chmod", ["+a", "group:everyone allow read", authJsonPath]);
		expect(grant.status, grant.stderr.toString()).toBe(0);
		const acl = () => spawnSync("/bin/ls", ["-le", authJsonPath], { encoding: "utf8" }).stdout;
		expect(acl()).toContain("group:everyone allow read");

		await AuthStorage.create(authJsonPath).modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(acl()).toContain("group:everyone allow read");
	});

	test.skipIf(process.platform !== "darwin")("keeps inherited ACLs off temporary credentials", async () => {
		const parent = join(tempDir, "inherited-acl");
		const path = join(parent, "auth.json");
		mkdirSync(parent);
		writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }), { mode: 0o600 });
		const grant = spawnSync("/bin/chmod", [
			"+a",
			"group:everyone allow read,execute,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
			parent,
		]);
		expect(grant.status, grant.stderr.toString()).toBe(0);
		const execute = childProcess.execFileSync;
		let stageAcl: string | undefined;
		const spy = vi.spyOn(childProcess, "execFileSync").mockImplementation((command, args, options) => {
			if (command === "/bin/cp" && args) {
				const stage = args[2];
				if (typeof stage === "string") {
					stageAcl = spawnSync("/bin/ls", ["-lde", dirname(stage)], { encoding: "utf8" }).stdout;
				}
			}
			return execute(command, args, options);
		});
		syncBuiltinESMExports();
		try {
			await AuthStorage.create(path).modify("anthropic", async () => ({ type: "api_key", key: "new" }));
		} finally {
			spy.mockRestore();
			syncBuiltinESMExports();
		}
		expect(stageAcl).toBeDefined();
		expect(stageAcl).not.toContain("group:everyone");
	});

	test.skipIf(process.platform !== "linux")("keeps staged files private under a default ACL", async () => {
		const parent = join(tempDir, "acl-parent");
		const path = join(parent, "auth.json");
		mkdirSync(parent, { mode: 0o755 });
		const setAcl = (...args: string[]) => {
			const result = spawnSync("/usr/bin/setfacl", args, { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
		};
		setAcl("-m", "u:nobody:rx", parent);
		setAcl("-d", "-m", "u:nobody:rwx", parent);
		writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }), { mode: 0o640 });
		setAcl("-b", path);
		const getAcl = () => spawnSync("/usr/bin/getfacl", ["-c", path], { encoding: "utf8" }).stdout;
		expect(getAcl()).not.toContain("user:nobody:");

		await AuthStorage.create(path).modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(getAcl()).not.toContain("user:nobody:");
	});

	test.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/setfattr"))(
		"preserves an existing auth file extended attribute",
		async () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
			const set = spawnSync("/usr/bin/setfattr", ["-n", "user.pi-test", "-v", "present", authJsonPath], {
				encoding: "utf8",
			});
			expect(set.status, set.stderr).toBe(0);

			await AuthStorage.create(authJsonPath).modify("anthropic", async () => ({ type: "api_key", key: "new" }));

			const get = spawnSync("/usr/bin/getfattr", ["--only-values", "-n", "user.pi-test", authJsonPath], {
				encoding: "utf8",
			});
			expect(get.status, get.stderr).toBe(0);
			expect(get.stdout).toBe("present");
		},
	);

	test.skipIf(process.platform !== "linux")("saves when a default ACL removes staging owner write", async () => {
		const parent = join(tempDir, "restricted-default");
		const path = join(parent, "auth.json");
		mkdirSync(parent);
		writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key: "old" } }), { mode: 0o600 });
		const acl = spawnSync("/usr/bin/setfacl", ["-d", "-m", "u::r--,u:nobody:r,g::---,m::r--,o::---", parent], {
			encoding: "utf8",
		});
		expect(acl.status, acl.stderr).toBe(0);

		await AuthStorage.create(path).modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ anthropic: { type: "api_key", key: "new" } });
	});

	test.skipIf(process.platform === "win32")("does not run a project cp during credential saves", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const bin = join(tempDir, "bin");
		const marker = join(tempDir, "called");
		mkdirSync(bin);
		writeFileSync(join(bin, "cp"), '#!/bin/sh\nprintf called > "$(dirname "$0")/../called"\nexec /bin/cp "$@"\n', {
			mode: 0o755,
		});
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
		try {
			await AuthStorage.create(authJsonPath).modify("anthropic", async () => ({ type: "api_key", key: "new" }));
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		expect(existsSync(marker)).toBe(false);
	});

	test("modify with undefined leaves the current credential unchanged", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.modify("anthropic", async () => undefined)).toEqual({ type: "api_key", key: "stored" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored" });
	});

	test("serializes concurrent modifications", async () => {
		writeAuthJson({});
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(authJsonPath);
		await Promise.all([
			first.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-key" })),
			second.modify("openai", async () => ({ type: "api_key", key: "openai-key" })),
		]);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
	});

	test.skipIf(process.platform === "win32")("serializes saves through an auth file symlink", async () => {
		writeAuthJson({});
		const alias = join(tempDir, "linked-auth.json");
		symlinkSync(authJsonPath, alias);
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(alias);
		await Promise.all([
			first.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-key" })),
			second.modify("openai", async () => ({ type: "api_key", key: "openai-key" })),
		]);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
	});

	test("delete removes one credential while preserving others", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
			google: { type: "api_key", key: "external-key" },
		});
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([
			{ providerId: "openai", type: "api_key" },
			{ providerId: "google", type: "api_key" },
		]);
		expect(await storage.read("anthropic")).toBeUndefined();
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "openai-key" });
		expect(await storage.read("google")).toEqual({ type: "api_key", key: "external-key" });
	});

	test("in-memory storage implements the same credential-store behavior", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "initial" } });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "initial" });
		await storage.modify("anthropic", async () => ({ type: "api_key", key: "updated" }));
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "updated" });
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([]);
	});

	test("does not write after lock acquisition failure and recovers on retry", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		const lockSpy = vi.spyOn(lockfile, "lock").mockRejectedValueOnce(new Error("lock unavailable"));

		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow(
			"lock unavailable",
		);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});

		lockSpy.mockRestore();
		await storage.modify("openai", async () => ({ type: "api_key", key: "new" }));
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
			openai: { type: "api_key", key: "new" },
		});
	});

	test("retries a briefly contended file lock", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const release = vi.fn(async () => {});
		const lockSpy = vi
			.spyOn(lockfile, "lock")
			.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "ELOCKED" }))
			.mockResolvedValueOnce(release);
		vi.spyOn(Math, "random").mockReturnValue(0);
		const update = vi.fn(async () => ({ result: undefined }));

		await backend.withLockAsync(update);

		expect(lockSpy).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	test("surfaces a compromised file storage lock", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));
		const compromised = new Error("lock compromised");
		vi.spyOn(lockfile, "lock").mockImplementation(async (_file, options) => {
			options?.onCompromised?.(compromised);
			return async () => {};
		});

		await expect(backend.withLockAsync(update)).rejects.toThrow(compromised);
		expect(update).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});
	});

	test("pre-aborted file operations do not create the backing file or run the mutation", async () => {
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		controller.abort();
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));

		await expect(backend.withLockAsync(update, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(update).not.toHaveBeenCalled();
		expect(existsSync(authJsonPath)).toBe(false);
	});

	test("aborts while waiting for a held file lock without running the mutation later", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const release = await lockfile.lock(authJsonPath, { realpath: false });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));
		const pending = backend.withLockAsync(update, { signal: controller.signal });

		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(update).not.toHaveBeenCalled();

		await release();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(update).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});
	});

	test("releases a file lock acquired concurrently with cancellation before mutation", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		const release = vi.fn(async () => {});
		vi.spyOn(lockfile, "lock").mockImplementation(async () => {
			controller.abort();
			return release;
		});
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));

		await expect(backend.withLockAsync(update, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(update).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	test("holds the file lock until a cancelled active callback settles without committing it", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pending = backend.withLockAsync(
			async () => {
				markStarted?.();
				await blocked;
				return { result: undefined, next: JSON.stringify({ openai: { type: "api_key", key: "cancelled" } }) };
			},
			{ signal: controller.signal },
		);

		await started;
		controller.abort();
		const competingMutation = vi.fn(async () => ({
			result: undefined,
			next: JSON.stringify({ google: { type: "api_key", key: "committed" } }),
		}));
		const competing = backend.withLockAsync(competingMutation);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(competingMutation).not.toHaveBeenCalled();

		finish?.();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await competing;
		expect(competingMutation).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			google: { type: "api_key", key: "committed" },
		});
	});

	test("cancels a signalled credential read waiting for a held file lock", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({ anthropic: { type: "api_key", key: "new-value" } });
		const release = await lockfile.lock(authJsonPath, { realpath: false });
		const lockSpy = vi.spyOn(lockfile, "lock");
		const controller = new AbortController();
		const pending = storage.read("anthropic", { signal: controller.signal });

		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await release();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(lockSpy).toHaveBeenCalledTimes(1);
		await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "new-value" });
	});

	test("serializes in-memory mutations across providers", async () => {
		const storage = AuthStorage.inMemory();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = storage.modify("anthropic", async () => {
			markStarted?.();
			await blocked;
			return { type: "api_key", key: "anthropic-key" };
		});
		await started;
		const secondMutation = vi.fn(async () => ({ type: "api_key" as const, key: "openai-key" }));
		const second = storage.modify("openai", secondMutation);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(secondMutation).not.toHaveBeenCalled();

		finish?.();
		await Promise.all([first, second]);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "openai-key" });
	});

	test("cancels a queued in-memory mutation without running it later", async () => {
		const storage = AuthStorage.inMemory();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = storage.modify("anthropic", async () => {
			markStarted?.();
			await blocked;
			return { type: "api_key", key: "anthropic-key" };
		});
		await started;
		const controller = new AbortController();
		const secondMutation = vi.fn(async () => ({ type: "api_key" as const, key: "openai-key" }));
		const second = storage.modify("openai", secondMutation, { signal: controller.signal });

		controller.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(secondMutation).not.toHaveBeenCalled();
		finish?.();
		await first;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(secondMutation).not.toHaveBeenCalled();
		expect(await storage.read("openai")).toBeUndefined();
	});

	test("preserves the stored credential after cancelling an active refresh mutation", async () => {
		const previous = {
			type: "oauth" as const,
			access: "expired",
			refresh: "refresh-token",
			expires: 0,
		};
		const storage = AuthStorage.inMemory({ oauth: previous });
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pending = storage.modify(
			"oauth",
			async () => {
				markStarted?.();
				await blocked;
				return { ...previous, access: "refreshed", expires: Date.now() + 60_000 };
			},
			{ signal: controller.signal },
		);

		await started;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		const competingMutation = vi.fn(async () => ({ type: "api_key" as const, key: "other" }));
		const competing = storage.modify("other", competingMutation);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(competingMutation).not.toHaveBeenCalled();

		finish?.();
		await competing;
		expect(competingMutation).toHaveBeenCalledTimes(1);
		expect(await storage.read("oauth")).toEqual(previous);
	});

	test("translates a credential-store refresh failure and allows a later retry", async () => {
		const providerId = "oauth-provider";
		const base = AuthStorage.inMemory({
			[providerId]: {
				type: "oauth",
				access: "expired-access",
				refresh: "refresh-token",
				expires: 0,
			},
		});
		let failNextModify = true;
		const credentials: CredentialStore = {
			read: (id) => base.read(id),
			list: () => base.list(),
			modify: (id, fn) => {
				if (failNextModify) {
					failNextModify = false;
					return Promise.reject(new Error("credential store unavailable"));
				}
				return base.modify(id, fn);
			},
			delete: (id) => base.delete(id),
		};
		const provider: Provider = {
			id: providerId,
			name: "OAuth Provider",
			auth: {
				oauth: {
					name: "OAuth",
					login: async () => {
						throw new Error("not used");
					},
					refresh: async (credential) => ({
						...credential,
						access: "refreshed-access",
						expires: Date.now() + 60_000,
					}),
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		};
		const models = createModels({ credentials });
		models.setProvider(provider);

		await expect(models.getAuth(providerId)).rejects.toMatchObject({ code: "auth" });
		await expect(models.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "refreshed-access" } });
	});

	test("does not overwrite malformed auth files", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		writeFileSync(authJsonPath, "{invalid-json", "utf8");
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow();
		expect(readFileSync(authJsonPath, "utf8")).toBe("{invalid-json");
	});
});
