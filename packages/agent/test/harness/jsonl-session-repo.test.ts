import { promises as nativeFs } from "node:fs";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JSONL_STORAGE_VERSION, JsonlSessionRepo } from "../../src/harness/session/jsonl/index.ts";
import { sessionName, setValue, value } from "../../src/harness/session/values.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

vi.mock("node:fs/promises", { spy: true });

afterEach(() => vi.restoreAllMocks());

const NOW = 1_700_000_000_000;

class AtomicPublicationNodeExecutionEnv extends NodeExecutionEnv {
	publication:
		| { sourcePath: string; destinationPath: string; destinationExisted: boolean; stagedContent: string }
		| undefined;

	override async renameFile(sourcePath: string, destinationPath: string, context: Context) {
		const destinationExists = await super.exists(destinationPath, context);
		const stagedContent = await super.readTextFile(sourcePath, context);
		if (destinationExists.ok && stagedContent.ok) {
			this.publication = {
				sourcePath,
				destinationPath,
				destinationExisted: destinationExists.value,
				stagedContent: stagedContent.value,
			};
		}
		return super.renameFile(sourcePath, destinationPath, context);
	}
}

describe("JsonlSessionRepo cwd-scoped lifecycle", () => {
	it("retains a successful append despite late cancellation and reopens after another write", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const session = await repo.create({ id: "late-abort", cwd: "/workspace" }, BACKGROUND_CONTEXT);
		const address = value<string>("test", "payload");
		await session.setName("before", BACKGROUND_CONTEXT);
		const controller = new AbortController();
		vi.mocked(fs.appendFile).mockImplementationOnce(async (...args) => {
			await nativeFs.appendFile(...args);
			controller.abort();
		});

		await session.setValue(address, "retained", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		expect(controller.signal.aborted).toBe(true);
		expect(await session.getValue(address, BACKGROUND_CONTEXT)).toMatchObject({ value: "retained", seq: 2 });
		await session.setName("after", BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);

		const lines = (await nativeFs.readFile(session.metadata.path, "utf8")).trimEnd().split("\n");
		expect(lines.slice(1).map((line) => JSON.parse(line).seq)).toEqual([1, 2, 3]);
		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		expect(await reopened.getValue(address, BACKGROUND_CONTEXT)).toMatchObject({ value: "retained", seq: 2 });
		expect(await reopened.getName(BACKGROUND_CONTEXT)).toBe("after");
		await reopened.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("persists metadata and filters discovery by cwd", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const session = await repo.create(
			{ id: "child", cwd: "/workspace", parentSessionId: "parent" },
			BACKGROUND_CONTEXT,
		);
		const metadata = session.metadata;

		expect(metadata).toMatchObject({
			id: "child",
			createdAt: NOW,
			storageVersion: JSONL_STORAGE_VERSION,
			cwd: "/workspace",
			parentSessionId: "parent",
		});
		expect(metadata.path).toContain("/sessions/--workspace--/");
		expect(metadata.path.endsWith("_child.jsonl")).toBe(true);
		expect(Number.isFinite(metadata.modifiedAt)).toBe(true);
		await session.close(BACKGROUND_CONTEXT);

		expect(await repo.list({ cwd: "/other" }, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT)).toEqual([metadata]);
		const firstLine = getOrThrow(
			await fileSystem.readTextLines(metadata.path, { maxLines: 1 }, BACKGROUND_CONTEXT),
		)[0];
		expect(JSON.parse(firstLine!)).toEqual({
			v: 4,
			kind: "header",
			id: "child",
			storageVersion: JSONL_STORAGE_VERSION,
			createdAt: NOW,
			cwd: "/workspace",
			parentSessionId: "parent",
		});
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("atomically publishes a branchless session header", async () => {
		const fileSystem = new AtomicPublicationNodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const session = await repo.create({ id: "session", cwd: "/workspace" }, BACKGROUND_CONTEXT);

		const publication = fileSystem.publication;
		if (publication === undefined) throw new Error("Expected atomic session publication");
		expect(publication.destinationPath).toBe(session.metadata.path);
		expect(publication.destinationExisted).toBe(false);
		const lines = publication.stagedContent.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "header", id: "session" });
		expect(getOrThrow(await fileSystem.readTextFile(session.metadata.path, BACKGROUND_CONTEXT))).toBe(
			publication.stagedContent,
		);
		expect(getOrThrow(await fileSystem.exists(publication.sourcePath, BACKGROUND_CONTEXT))).toBe(false);

		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("keeps an explicit Session mutation through commit until end", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const session = await repo.create({ id: "session", cwd: "/workspace" }, BACKGROUND_CONTEXT);
		const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
		let queuedStarted = false;
		const queued = session.mutate(() => {
			queuedStarted = true;
		}, BACKGROUND_CONTEXT);

		const result = await mutation.commit([setValue(sessionName, "explicit")], BACKGROUND_CONTEXT);
		expect(result.seqs).toHaveLength(1);
		expect(queuedStarted).toBe(false);
		expect(await mutation.getValue(sessionName, BACKGROUND_CONTEXT)).toMatchObject({ value: "explicit" });
		await mutation.end(BACKGROUND_CONTEXT);
		await queued;
		expect(queuedStarted).toBe(true);

		await session.close(BACKGROUND_CONTEXT);
		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		expect(await reopened.getName(BACKGROUND_CONTEXT)).toBe("explicit");
		await reopened.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("rejects unsupported storage versions without repairing a torn tail", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const session = await repo.create({ id: "future", cwd: "/workspace" }, BACKGROUND_CONTEXT);
		const metadata = session.metadata;
		await session.close(BACKGROUND_CONTEXT);

		const lines = getOrThrow(await fileSystem.readTextFile(metadata.path, BACKGROUND_CONTEXT))
			.trimEnd()
			.split("\n");
		const unsupportedVersion = JSONL_STORAGE_VERSION + 1;
		lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), storageVersion: unsupportedVersion });
		const unsupportedContent = `${lines.join("\n")}\n{"kind":"entry"`;
		getOrThrow(await fileSystem.writeFile(metadata.path, unsupportedContent, BACKGROUND_CONTEXT));

		await expect(repo.open(metadata, BACKGROUND_CONTEXT)).rejects.toThrow(
			`unsupported storage version ${unsupportedVersion}`,
		);
		expect(getOrThrow(await fileSystem.readTextFile(metadata.path, BACKGROUND_CONTEXT))).toBe(unsupportedContent);

		await repo.close(BACKGROUND_CONTEXT);
	});

	it("keeps fork destinations claimed until close and rejects deleting open sessions", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const source = await repo.create({ id: "source", cwd: "/workspace" }, BACKGROUND_CONTEXT);
		const fork = await repo.fork(source.metadata, { id: "fork", scope: "tree" }, BACKGROUND_CONTEXT);

		await expect(repo.open(fork.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already open");
		await expect(repo.delete(fork.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("open");
		await fork.close(BACKGROUND_CONTEXT);

		const reopened = await repo.open(fork.metadata, BACKGROUND_CONTEXT);
		await reopened.close(BACKGROUND_CONTEXT);
		await repo.delete(fork.metadata, BACKGROUND_CONTEXT);
		await expect(repo.open(fork.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("does not exist");

		await source.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("rejects concurrent creates for the same working-directory id", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });

		const results = await Promise.allSettled([
			repo.create({ id: "session", cwd: "/workspace" }, BACKGROUND_CONTEXT),
			repo.create({ id: "session", cwd: "/workspace" }, BACKGROUND_CONTEXT),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT)).toHaveLength(1);
		for (const result of results) {
			if (result.status === "fulfilled") await result.value.close(BACKGROUND_CONTEXT);
		}
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("allows the same id to be active in different working directories", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
		const first = await repo.create({ id: "shared", cwd: "/workspace-a" }, BACKGROUND_CONTEXT);
		const second = await repo.create({ id: "shared", cwd: "/workspace-b" }, BACKGROUND_CONTEXT);

		expect(first.metadata.path).not.toBe(second.metadata.path);
		await expect(repo.create({ id: "shared", cwd: "/workspace-a" }, BACKGROUND_CONTEXT)).rejects.toThrow(
			"already exists",
		);
		expect((await repo.list(undefined, BACKGROUND_CONTEXT)).map(({ cwd, id }) => ({ cwd, id }))).toEqual([
			{ cwd: "/workspace-a", id: "shared" },
			{ cwd: "/workspace-b", id: "shared" },
		]);

		await Promise.all([first.close(BACKGROUND_CONTEXT), second.close(BACKGROUND_CONTEXT)]);
		const reopened = await Promise.all([
			repo.open(first.metadata, BACKGROUND_CONTEXT),
			repo.open(second.metadata, BACKGROUND_CONTEXT),
		]);
		await Promise.all(reopened.map((session) => session.close(BACKGROUND_CONTEXT)));
		await repo.close(BACKGROUND_CONTEXT);
	});
});
