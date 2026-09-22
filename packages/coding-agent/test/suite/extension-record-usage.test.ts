import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { type ExtensionAPI, SessionManager, type UsageContribution } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function contribution(): UsageContribution {
	return {
		id: "child-1:final",
		kind: "subagent",
		provider: "child-provider",
		model: "child-model",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			reasoning: 1,
			totalTokens: 19,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		},
		note: "child finished",
	};
}

describe("extension recordUsage", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function open(sessionManager: SessionManager) {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		return { harness, api };
	}

	it("records native model-attributed usage once and rejects conflicting payloads without mutation", async () => {
		const manager = SessionManager.inMemory();
		const { harness, api } = await open(manager);
		const value = contribution();
		const before = harness.session.getSessionStats();
		expect(api.recordUsage(value)).toBeUndefined();
		const entry = manager.getLeafEntry();
		expect(entry).toMatchObject({
			type: "usage",
			contributionId: value.id,
			kind: value.kind,
			provider: value.provider,
			model: value.model,
			usage: value.usage,
			note: value.note,
		});
		const revision = manager.getEntriesRevision();
		const leaf = manager.getLeafId();
		api.recordUsage({
			...value,
			usage: { ...value.usage, cost: { total: 10, cacheWrite: 4, cacheRead: 3, output: 2, input: 1 } },
		});
		expect(manager.getEntriesRevision()).toBe(revision);
		expect(manager.getLeafId()).toBe(leaf);
		expect(harness.eventsOfType("entry_appended")).toEqual([{ type: "entry_appended", entry }]);
		for (const change of [
			{ kind: "other" },
			{ provider: "other" },
			{ model: "other" },
			{ note: "other" },
			{ usage: { ...value.usage, output: 7 } },
			{ usage: { ...value.usage, reasoning: 2 } },
			{ usage: { ...value.usage, cost: { ...value.usage.cost, total: 20 } } },
		])
			expect(() => api.recordUsage({ ...value, ...change })).toThrow(/conflict/i);
		expect(manager.getEntriesRevision()).toBe(revision);
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.getEntries()).toEqual([entry]);
		expect(manager.buildSessionContext().messages).toEqual([]);
		expect(getUsageCostBreakdown(manager.getEntries())).toEqual([
			{ key: "child-provider/child-model", cost: 10, tokens: 19 },
		]);
		expect(harness.session.getSessionStats()).toMatchObject({
			cost: before.cost + 10,
			totalMessages: before.totalMessages,
			tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, total: 19 },
		});
		value.usage.cost.total = 999;
		expect(entry).toMatchObject({ usage: { cost: { total: 10 } } });
	});

	it("preserves recorded IDs across resume, branch navigation and copied forks, but scopes them to each journal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-record-usage-"));
		directories.push(dir);
		const manager = SessionManager.create(dir, dir);
		const { api } = await open(manager);
		manager.appendMessage(fauxAssistantMessage("parent"));
		const value = contribution();
		value.usage.cacheWrite1h = undefined;
		api.recordUsage(value);
		const file = manager.getSessionFile()!;
		const bytes = readFileSync(file, "utf8");
		const resumed = SessionManager.open(file);
		const { api: resumeApi } = await open(resumed);
		resumeApi.recordUsage(structuredClone(value));
		expect(readFileSync(file, "utf8")).toBe(bytes);
		expect(() => resumeApi.recordUsage({ ...value, model: "changed" })).toThrow(/conflict/i);
		expect(readFileSync(file, "utf8")).toBe(bytes);
		const leaf = resumed.getLeafId()!;
		resumed.resetLeaf();
		resumeApi.recordUsage(value);
		expect(resumed.getLeafId()).toBeNull();
		expect(resumed.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
		const fork = SessionManager.forkFrom(file, dir, dir);
		const { api: forkApi } = await open(fork);
		forkApi.recordUsage(value);
		expect(() => forkApi.recordUsage({ ...value, kind: "changed" })).toThrow(/conflict/i);
		expect(fork.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
		const branchFile = resumed.createBranchedSession(leaf)!;
		expect(branchFile).not.toBe(file);
		resumeApi.recordUsage(value);
		expect(resumed.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
		const beforeUsage = resumed.getEntries().find((entry) => entry.type === "message")!;
		resumed.createBranchedSession(beforeUsage.id);
		resumeApi.recordUsage({ ...value, model: "not-copied" });
		expect(resumed.getLeafEntry()).toMatchObject({ contributionId: value.id, model: "not-copied" });
		const unrelated = SessionManager.inMemory();
		const { api: unrelatedApi } = await open(unrelated);
		unrelatedApi.recordUsage({ ...value, model: "independent" });
		expect(unrelated.getLeafEntry()).toMatchObject({ contributionId: value.id, model: "independent" });
	});

	it("persists late usage after boundary cancellation without starting another turn", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-late-usage-"));
		directories.push(dir);
		const manager = SessionManager.create(dir, dir);
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const value = contribution();
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async () => {
						enter();
						await released;
						pi.recordUsage(value);
						pi.recordUsage(value);
						return {
							entries: [
								{ type: "custom_message", customType: "late", content: "child finished", display: true },
							],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		const run = harness.session.prompt("start");
		await entered;
		const abort = harness.session.abort();
		release();
		await Promise.all([run, abort]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		const persisted = SessionManager.open(manager.getSessionFile()!).getEntries();
		expect(persisted.filter((entry) => entry.type === "usage")).toMatchObject([
			{ contributionId: value.id, usage: value.usage },
		]);
		expect(persisted).toContainEqual(expect.objectContaining({ type: "custom_message", customType: "late" }));
	});

	it("retains native deferred persistence and permits usage without contribution IDs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-usage-deferred-"));
		directories.push(dir);
		const manager = SessionManager.create(dir, dir);
		const { api } = await open(manager);
		const value = contribution();
		manager.appendCustomEntry("deferred", { retained: true });
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
		api.recordUsage(value);
		const file = manager.getSessionFile()!;
		expect(existsSync(file)).toBe(true);
		const bytes = readFileSync(file, "utf8");
		const resumed = SessionManager.open(file);
		expect(resumed.getEntries()).toEqual(manager.getEntries());
		expect(resumed.getLeafEntry()).toMatchObject({ type: "usage", contributionId: value.id });
		const { api: resumeApi, harness } = await open(resumed);
		const stats = harness.session.getSessionStats();
		resumeApi.recordUsage(value);
		expect(readFileSync(file, "utf8")).toBe(bytes);
		expect(harness.session.getSessionStats()).toEqual(stats);
		manager.appendUsage(value.kind, value.provider, value.model, value.usage);
		manager.appendUsage(value.kind, value.provider, value.model, value.usage);
		expect(
			SessionManager.open(manager.getSessionFile()!)
				.getEntries()
				.filter((entry) => entry.type === "usage"),
		).toHaveLength(3);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"retries failed persistence without counting an accepted contribution twice",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-usage-repair-"));
			directories.push(dir);
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage(fauxAssistantMessage("parent"));
			const file = manager.getSessionFile()!;
			const { api } = await open(manager);
			const value = contribution();
			const before = readFileSync(file, "utf8");
			chmodSync(file, 0o400);
			try {
				expect(() => api.recordUsage(value)).toThrow(/EACCES/);
				const revision = manager.getEntriesRevision();
				expect(() => api.recordUsage(value)).toThrow(/EACCES/);
				expect(manager.getEntriesRevision()).toBe(revision);
				expect(manager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
				expect(readFileSync(file, "utf8")).toBe(before);
			} finally {
				chmodSync(file, 0o600);
			}
			api.recordUsage(value);
			expect(SessionManager.open(file).getEntries()).toEqual(manager.getEntries());
		},
	);

	it("rejects malformed contributions before appending and rejects stale extension instances", async () => {
		const manager = SessionManager.inMemory();
		const { harness, api } = await open(manager);
		const value = contribution();
		for (const change of [
			{ id: "" },
			{ kind: "" },
			{ provider: "" },
			{ model: "" },
			{ usage: { ...value.usage, output: -1 } },
			{ usage: { ...value.usage, input: Number.NaN } },
			{ usage: { ...value.usage, cost: { ...value.usage.cost, total: Number.POSITIVE_INFINITY } } },
		])
			expect(() => api.recordUsage({ ...value, ...change })).toThrow();
		expect(() => Reflect.apply(api.recordUsage, undefined, [{ ...value, id: undefined }])).toThrow(/ID/);
		expect(manager.getEntries()).toEqual([]);
		harness.session.dispose();
		expect(() => api.recordUsage(value)).toThrow(/stale/i);
	});
});
