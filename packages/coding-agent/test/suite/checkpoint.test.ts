import fs, {
	existsSync,
	linkSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ImageContent, Type } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	openSessionCheckpoint,
	openSessionCheckpointFile,
	readSessionCheckpoint,
	readSessionCheckpointState,
	type SessionCheckpointQueues,
	writeSessionCheckpoint,
} from "../../src/core/checkpoint.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { loadPhoton } from "../../src/utils/photon.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const restored: AgentSession[] = [];
const directories: string[] = [];
let image: ImageContent;
beforeAll(async () => {
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon is required for image fixtures");
	const png = new photon.PhotonImage(new Uint8Array(4).fill(255), 1, 1);
	try {
		image = { type: "image", mimeType: "image/png", data: Buffer.from(png.get_bytes()).toString("base64") };
	} finally {
		png.free();
	}
});
afterEach(() => {
	for (const session of restored.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup(options: Parameters<typeof createHarness>[0] = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-checkpoint-test-"));
	directories.push(directory);
	const harness = await createHarness({
		...options,
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		settings: { compaction: { enabled: false }, retry: { enabled: false }, ...options.settings },
	});
	harnesses.push(harness);
	return harness;
}

describe("native working-session checkpoint", () => {
	it("explicit object capture detaches each pending entry and queue value with native JSON normalization", async () => {
		const h = await setup();
		const date = "2026-09-22T00:00:00.000Z";
		const data = { nested: { value: "saved" }, createdAt: new Date(date), omitted: undefined };
		h.sessionManager.appendCustomEntry("detached-state", data);
		const details = { value: "queued", createdAt: new Date(date) };
		const queuedImage = { ...image };
		h.session.agent.steer({
			role: "custom",
			customType: "queued",
			content: [queuedImage],
			details,
			display: true,
			timestamp: 1,
		});
		const hold = await h.session.acquireCheckpoint();
		hold.release();
		data.nested.value = "later";
		details.value = "later";
		queuedImage.data = "later";
		expect(
			hold.checkpoint.entries.find((entry) => entry.type === "custom" && entry.customType === "detached-state"),
		).toMatchObject({
			data: { nested: { value: "saved" }, createdAt: date },
		});
		expect(hold.checkpoint.queues.steering).toMatchObject([
			{
				customType: "queued",
				content: [image],
				details: { value: "queued", createdAt: date },
			},
		]);
		expect(JSON.stringify(hold.checkpoint)).not.toContain('"omitted"');
		expect(h.session.getCheckpointQueues().steering).toMatchObject([{ details: { value: "later" } }]);
	});

	it.each([false, true])("cold file capture survives release and source loss (null leaf: %s)", async (nullLeaf) => {
		const h = await setup({ models: [{ id: "first" }, { id: "second" }], allowedToolNames: ["read"] });
		h.session.setScopedModels([{ model: h.getModel("second")!, thinkingLevel: "off" }]);
		const selected = h.sessionManager.appendMessage(fauxAssistantMessage("selected history"));
		const sibling = h.sessionManager.appendMessage(fauxAssistantMessage("unselected history"));
		if (nullLeaf) h.sessionManager.resetLeaf();
		else h.sessionManager.branch(selected);
		const queues: SessionCheckpointQueues = {
			steering: [
				{ role: "user", content: [{ type: "text", text: "accepted image" }, image], timestamp: 1 },
				{
					role: "custom",
					customType: "persistent",
					content: [image],
					details: { payload: [1, "雪"] },
					display: true,
					timestamp: 2,
				},
			],
			followUp: [{ role: "user", content: [{ type: "text", text: "accepted follow-up" }], timestamp: 3 }],
			nextTurn: [
				{
					role: "custom",
					customType: "next",
					content: "next-turn",
					details: { value: 42 },
					display: true,
					timestamp: 4,
				},
			],
			persistOnCancel: [1],
			steeringMode: "all",
			followUpMode: "one-at-a-time",
		};
		h.session.restoreCheckpointQueues(queues);
		const path = join(h.tempDir, "file-checkpoint.json");
		const hold = await h.session.acquireCheckpointFile(path, { quiesce: () => () => {} });
		expect(hold.sleepReady).toBe(true);
		expect(hold.checkpoint).not.toHaveProperty("entries");
		const bytes = readFileSync(path, "utf8");
		hold.release();
		h.sessionManager.appendCustomEntry("after-release", { newer: true });
		h.session.setScopedModels([{ model: h.getModel("first")! }]);
		await h.session.steer("after-release queue");
		rmSync(h.session.sessionFile!);
		expect(readFileSync(path, "utf8")).toBe(bytes);

		const { session } = await createAgentSession({
			checkpointFile: path,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: h.session.resourceLoader,
			settingsManager: h.settingsManager,
		});
		restored.push(session);
		expect(session.sessionId).toBe(h.session.sessionId);
		expect(session.sessionManager.getLeafId()).toBe(nullLeaf ? null : selected);
		expect(session.messages.map(getMessageText)).toEqual(nullLeaf ? [] : ["selected history"]);
		expect(session.sessionManager.getEntry(sibling)).toMatchObject({
			message: { content: [{ type: "text", text: "unselected history" }] },
		});
		expect(session.scopedModels.map((scope) => [scope.model.id, scope.thinkingLevel])).toEqual([["second", "off"]]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getCheckpointQueues()).toMatchObject({
			steering: [
				{ role: "user", content: [{ type: "text", text: "accepted image" }, image] },
				{ role: "custom", customType: "persistent", content: [image], details: { payload: [1, "雪"] } },
			],
			followUp: [{ role: "user", content: [{ type: "text", text: "accepted follow-up" }] }],
			nextTurn: [{ customType: "next", content: "next-turn", details: { value: 42 } }],
			persistOnCancel: [1],
			steeringMode: "all",
			followUpMode: "one-at-a-time",
		});
		expect(
			readSessionCheckpoint(path).entries.some(
				(entry) => entry.type === "custom" && entry.customType === "after-release",
			),
		).toBe(false);
		expect(h.faux.state.callCount).toBe(0);
		expect(readFileSync(path, "utf8")).toBe(bytes);
		await expect(
			createAgentSession({ checkpoint: readSessionCheckpoint(path), checkpointFile: path }),
		).rejects.toThrow("not both");
	});

	it("file restore validates all entries before refusing a newer or malformed journal unchanged", async () => {
		const h = await setup();
		h.sessionManager.appendMessage(fauxAssistantMessage("saved"));
		const path = join(h.tempDir, "checkpoint.json");
		const hold = await h.session.acquireCheckpointFile(path);
		hold.release();
		const duplicate = join(h.tempDir, "duplicate.json");
		writeFileSync(duplicate, readFileSync(path, "utf8").replace(/^\s*{/, '{"entries":null,'));
		expect(openSessionCheckpointFile(duplicate).sessionManager.getSessionId()).toBe(h.session.sessionId);
		h.sessionManager.appendCustomEntry("newer", { preserve: true });
		const journal = h.session.sessionFile!;
		const before = readFileSync(journal);
		expect(() => openSessionCheckpointFile(path)).toThrow("differs");
		expect(readFileSync(journal)).toEqual(before);
		const invalid = join(h.tempDir, "invalid.json");
		writeFileSync(
			invalid,
			readFileSync(path, "utf8").replace(
				/}\s*$/,
				',"entries":[{"type":"custom","id":"orphan","parentId":"missing","timestamp":"2026-09-22T00:00:00Z","customType":"orphan","data":{}}]}',
			),
		);
		rmSync(journal);
		expect(() => openSessionCheckpointFile(invalid)).toThrow("entry tree");
		expect(existsSync(journal)).toBe(false);
		expect(() => readSessionCheckpointState(invalid)).toThrow("entry tree");
	});

	it("cold restore refuses a journal appended during comparison without touching the new work", async () => {
		const h = await setup();
		const leaf = h.sessionManager.appendMessage(fauxAssistantMessage("saved"));
		const path = join(h.tempDir, "checkpoint.json");
		const hold = await h.session.acquireCheckpointFile(path);
		hold.release();
		const journal = h.session.sessionFile!;
		const before = readFileSync(journal, "utf8");
		const identity = fs.statSync(journal);
		const tail = `${JSON.stringify({
			type: "custom",
			id: "new-work",
			parentId: leaf,
			timestamp: "2026-09-22T00:00:00Z",
			customType: "late-work",
			data: { saved: true },
		})}\n`;
		let appended = false;
		const read = fs.readSync;
		vi.spyOn(fs, "readSync").mockImplementation((...args) => {
			const count = Reflect.apply(read, fs, args) as number;
			if (!appended && count > 0 && fs.fstatSync(args[0]).ino === identity.ino) {
				appended = true;
				fs.appendFileSync(journal, tail);
			}
			return count;
		});
		syncBuiltinESMExports();
		expect(() => openSessionCheckpointFile(path)).toThrow("changed during comparison");
		expect(appended).toBe(true);
		expect(readFileSync(journal, "utf8")).toBe(before + tail);
	});

	it.each(["scope", "configuration", "model", "thinking", "exit marker", "creation time"])(
		"rejects malformed %s metadata before publishing a missing journal",
		async (field) => {
			const h = await setup();
			h.sessionManager.appendMessage(fauxAssistantMessage("saved"));
			const path = join(h.tempDir, "checkpoint.json");
			const hold = await h.session.acquireCheckpointFile(path);
			hold.release();
			const saved = readSessionCheckpoint(path);
			const invalid: Record<string, unknown> = { ...saved };
			if (field === "scope") invalid.scopedModels = { provider: "invalid", id: "invalid" };
			else if (field === "configuration") invalid.toolConfiguration = { noBuiltinTools: "yes" };
			else if (field === "model") invalid.selection = { ...saved.selection, model: { provider: 99, id: "saved" } };
			else if (field === "thinking") invalid.selection = { ...saved.selection, thinkingLevel: "invalid" };
			else if (field === "exit marker") invalid.completedExit = { pid: "invalid" };
			else invalid.createdAt = 17;
			writeFileSync(path, JSON.stringify(invalid));
			rmSync(h.session.sessionFile!);
			expect(() => openSessionCheckpointFile(path)).toThrow("Invalid");
			expect(existsSync(h.session.sessionFile!)).toBe(false);
			expect(() => readSessionCheckpointState(path)).toThrow("Invalid");
		},
	);

	it("file capture includes awaited barrier appends and preserves old bytes on late failure or cancellation", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_checkpoint", async () => {
						await Promise.resolve();
						pi.appendEntry("barrier-tail", { saved: true });
						return { sleepReady: true };
					});
				},
			],
		});
		h.sessionManager.appendMessage(fauxAssistantMessage("saved"));
		await h.session.steer("retain accepted input");
		const path = join(h.tempDir, "checkpoint.json");
		const hold = await h.session.acquireCheckpointFile(path, { quiesce: () => () => {} });
		expect(readSessionCheckpoint(path).entries.at(-1)).toMatchObject({
			type: "custom",
			customType: "barrier-tail",
			data: { saved: true },
		});
		hold.release();
		const before = readFileSync(path);
		const write = fs.writeFileSync;
		const failure = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
			if (typeof file === "number" && typeof data === "string" && data.startsWith('{"type":"message"')) {
				throw new Error("checkpoint disk full");
			}
			write(file, data, options);
		});
		syncBuiltinESMExports();
		const unquiesce = vi.fn();
		await expect(h.session.acquireCheckpointFile(path, { quiesce: () => unquiesce })).rejects.toThrow(
			"checkpoint disk full",
		);
		failure.mockRestore();
		syncBuiltinESMExports();
		expect(unquiesce).toHaveBeenCalledOnce();
		expect(h.session.isCheckpointHeld).toBe(false);
		expect(readFileSync(path)).toEqual(before);
		for (const kind of ["abort", "late write"] as const) {
			const controller = new AbortController();
			await expect(
				h.session.acquireCheckpointFile(path, {
					signal: controller.signal,
					quiesce: () => {
						setImmediate(() => {
							if (kind === "abort") controller.abort();
							else expect(() => h.session.setSessionName("late write")).toThrow("held");
						});
						return () => {};
					},
				}),
			).rejects.toThrow("cancelled");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(h.session.isCheckpointHeld).toBe(false);
			expect(readFileSync(path)).toEqual(before);
		}
		expect(readdirSync(h.tempDir).some((name) => name.endsWith(".tmp"))).toBe(false);
		expect(h.session.getSteeringMessages()).toEqual(["retain accepted input"]);
		await h.session.followUp("still accepted");
	});

	it.skipIf(process.platform === "win32")(
		"file capture refuses journal aliases and unrelated destinations",
		async () => {
			const h = await setup();
			h.sessionManager.appendMessage(fauxAssistantMessage("private history"));
			const journal = h.session.sessionFile!;
			const before = readFileSync(journal);
			const hardlink = join(h.tempDir, "journal-link.json");
			linkSync(journal, hardlink);
			const symlink = join(h.tempDir, "journal-symlink.json");
			symlinkSync(journal, symlink);
			const unrelated = join(h.tempDir, "unrelated.json");
			writeFileSync(unrelated, '{"important":true}');
			for (const destination of [journal, hardlink, symlink, unrelated, "relative.json"]) {
				const release = vi.fn();
				await expect(h.session.acquireCheckpointFile(destination, { quiesce: () => release })).rejects.toThrow();
				expect(release).toHaveBeenCalledOnce();
				expect(h.session.isCheckpointHeld).toBe(false);
			}
			expect(readFileSync(journal)).toEqual(before);
			expect(readFileSync(unrelated, "utf8")).toBe('{"important":true}');
			h.session.beginShutdown();
			await expect(h.session.captureShutdownCheckpointFile(unrelated)).rejects.toThrow();
			expect(readFileSync(unrelated, "utf8")).toBe('{"important":true}');
		},
	);

	it("restores session-only model cycling scope and keeps runtime-only authentication awake", async () => {
		const h = await setup({ models: [{ id: "first" }, { id: "second" }] });
		h.session.setScopedModels([{ model: h.getModel("second")!, thinkingLevel: "off" }]);
		const hold = await h.session.acquireCheckpoint({ quiesce: () => () => {} });
		const { session } = await createAgentSession({
			checkpoint: hold.checkpoint,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: h.session.resourceLoader,
			settingsManager: h.settingsManager,
		});
		restored.push(session);
		expect(session.scopedModels.map((entry) => entry.model.id)).toEqual(["second"]);
		hold.release();
		await h.session.modelRuntime.setRuntimeApiKey(h.getModel().provider, "memory-only-key");
		const unsupported = await h.session.acquireCheckpoint({ quiesce: () => () => {} });
		expect(unsupported.sleepReady).toBe(false);
		expect(unsupported.sleepBlockers.join(" ")).toContain("runtime-only API key");
		unsupported.release();
	});

	it("joins fire-and-forget native metadata notification handlers before capturing", async () => {
		const entered = deferred();
		const finish = deferred();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_info_changed", async () => {
						entered.resolve();
						await finish.promise;
						pi.appendEntry("metadata-tail", { saved: true });
					});
				},
			],
		});
		h.session.setSessionName("held name");
		await entered.promise;
		let ready = false;
		const pending = h.session.acquireCheckpoint({ quiesce: () => () => {} }).then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		finish.resolve();
		const hold = await pending;
		expect(hold.sleepReady).toBe(true);
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("metadata-tail");
		hold.release();
	});

	it("joins idle cache-warming decision handlers before capturing", async () => {
		const entered = deferred();
		const finish = deferred();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("cache_warming_decision", async () => {
						entered.resolve();
						await finish.promise;
						pi.appendEntry("warming-tail", { saved: true });
					});
				},
			],
		});
		const decision = h.session.extensionRunner.emitCacheWarmingDecision({
			type: "cache_warming_decision",
			action: "warm",
			warmCost: 0.01,
			missCost: 1,
			continuationProbability: 0.15,
		});
		await entered.promise;
		let ready = false;
		const pending = h.session.acquireCheckpoint({ quiesce: () => () => {} }).then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		finish.resolve();
		await decision;
		const hold = await pending;
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("warming-tail");
		hold.release();
	});

	it("owns native pi.exec even when the extension does not await its returned promise", async () => {
		let api!: ExtensionAPI;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		const started = join(h.tempDir, "exec-started");
		const gate = join(h.tempDir, "exec-release");
		const saved = join(h.tempDir, "exec-saved");
		const execution = api.exec(process.execPath, [
			"-e",
			`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(gate)})) return; fs.writeFileSync(${JSON.stringify(saved)}, 'saved'); clearInterval(timer); }, 10);`,
		]);
		try {
			await vi.waitFor(() => expect(existsSync(started)).toBe(true));
			let ready = false;
			const pending = h.session.acquireCheckpoint({ quiesce: () => () => {} }).then((hold) => {
				ready = true;
				return hold;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(ready).toBe(false);
			writeFileSync(gate, "release");
			const hold = await pending;
			expect(hold.sleepReady).toBe(true);
			expect(readFileSync(saved, "utf8")).toBe("saved");
			hold.release();
		} finally {
			writeFileSync(gate, "release");
			await execution;
		}
	});

	it("a cancelled extension barrier remains owned until its continuation finishes", async () => {
		const entered = deferred();
		const finish = deferred();
		let first = true;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_checkpoint", async () => {
						if (first) {
							first = false;
							entered.resolve();
							await finish.promise;
							pi.appendEntry("cancelled-barrier-tail", { complete: true });
						}
						return { sleepReady: true };
					});
				},
			],
		});
		const controller = new AbortController();
		const cancelled = h.session.acquireCheckpoint({ signal: controller.signal, quiesce: () => () => {} });
		await entered.promise;
		controller.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		let ready = false;
		const pending = h.session.acquireCheckpoint({ quiesce: () => () => {} }).then((hold) => {
			ready = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ready).toBe(false);
		finish.resolve();
		const hold = await pending;
		expect(hold.sleepReady).toBe(true);
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("cancelled-barrier-tail");
		hold.release();
	});

	it("failed extension persistence releases the hold and retains accepted queues", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_checkpoint", async () => {
						throw new Error("extension disk full");
					});
				},
			],
		});
		await h.session.steer("accepted");
		const release = vi.fn();
		await expect(h.session.acquireCheckpoint({ quiesce: () => release })).rejects.toThrow("extension disk full");
		expect(release).toHaveBeenCalledOnce();
		expect(h.session.isCheckpointHeld).toBe(false);
		expect(h.session.getSteeringMessages()).toEqual(["accepted"]);
	});
	it("holds after later native/extension writes, restores full queues once, and never auto-replays", async () => {
		const providerEntered = deferred();
		const providerRelease = deferred();
		const laterEntered = deferred();
		const laterRelease = deferred();
		const settingsDirectory = mkdtempSync(join(tmpdir(), "pi-checkpoint-settings-"));
		directories.push(settingsDirectory);
		const h = await setup({
			settingsManager: SettingsManager.create(settingsDirectory, settingsDirectory, { projectTrusted: false }),
			extensionFactories: [
				{
					name: "late-writer",
					factory(pi) {
						pi.on("turn_end", async (event, ctx) => {
							await Promise.resolve();
							expect(ctx.sessionManager.getEntry(event.messageEntryId)).toMatchObject({ type: "message" });
							pi.appendEntry("extension-state", { saved: true });
							pi.sendMessage(
								{ customType: "aside", content: "turn aside", display: true },
								{ triggerTurn: false },
							);
							return {
								entries: [...event.entries, { type: "custom", customType: "boundary-draft", data: true }],
							};
						});
					},
				},
			],
		});
		h.session.agent.subscribe(async (event) => {
			if (event.type !== "turn_end") return;
			laterEntered.resolve();
			await laterRelease.promise;
			h.sessionManager.appendCustomEntry("later-native", { included: true });
			h.settingsManager.setTheme("light");
		});
		h.setResponses([
			async () => {
				providerEntered.resolve();
				await providerRelease.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
			fauxAssistantMessage("fourth"),
		]);
		const running = h.session.prompt("start");
		await providerEntered.promise;
		await h.session.steer("steering with image", [image]);
		await h.session.followUp("follow-up");
		await h.session.sendCustomMessage(
			{ customType: "custom", content: [image], details: { payload: [1, 2] }, display: true },
			{ persistOnCancel: true },
		);
		await h.session.sendCustomMessage(
			{ customType: "next", content: "next-turn", display: true },
			{ deliverAs: "nextTurn" },
		);
		let captured = false;
		const acquisition = h.session.acquireCheckpoint({ boundary: "turn" }).then((hold) => {
			captured = true;
			return hold;
		});
		providerRelease.resolve();
		await laterEntered.promise;
		expect(captured).toBe(false);
		laterRelease.resolve();
		const hold = await acquisition;
		expect(hold.checkpoint.boundary).toBe("turn");
		expect(hold.checkpoint.settled).toBe(false);
		expect(JSON.parse(readFileSync(join(settingsDirectory, "settings.json"), "utf8"))).toMatchObject({
			theme: "light",
		});
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("later-native");
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("extension-state");
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("boundary-draft");
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("turn aside");
		expect(hold.checkpoint.queues.steering).toHaveLength(2);
		expect(hold.checkpoint.queues.followUp).toHaveLength(1);
		expect(hold.checkpoint.queues.nextTurn).toHaveLength(1);
		expect(hold.checkpoint.queues.persistOnCancel).toEqual([1]);
		expect(h.getPendingResponseCount()).toBe(3);
		const file = join(h.tempDir, "checkpoint.json");
		writeSessionCheckpoint(file, hold.checkpoint);
		const saved = readSessionCheckpoint(file);
		expect(saved.queues).toEqual(hold.checkpoint.queues);
		const { session } = await createAgentSession({
			checkpoint: saved,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: h.session.resourceLoader,
			settingsManager: h.settingsManager,
		});
		restored.push(session);
		expect(session.sessionId).toBe(h.session.sessionId);
		expect(session.sessionManager.getLeafId()).toBe(saved.selection.leafId);
		expect(session.getCheckpointQueues()).toEqual(saved.queues);
		expect(session.getSteeringMessages()).toEqual(["steering with image"]);
		expect(session.getFollowUpMessages()).toEqual(["follow-up"]);
		expect(session.isIdle).toBe(true);
		expect(() => session.restoreCheckpointQueues(saved.queues)).toThrow("fresh idle");
		await expect(h.session.steer("not accepted while held")).rejects.toThrow("held");
		expect(hold.signal.aborted).toBe(true);
		hold.release();
		hold.release();
		await running;
		expect(h.session.messages.filter((m) => getMessageText(m) === "steering with image")).toHaveLength(1);
		expect(h.session.messages.filter((m) => getMessageText(m) === "follow-up")).toHaveLength(1);
		expect(h.session.messages.filter((m) => m.role === "custom" && m.customType === "custom")).toHaveLength(1);
	});

	it("delivers restored steering, follow-up, image and next-turn context exactly once on explicit input", async () => {
		const h = await setup();
		h.session.setSteeringMode("all");
		h.session.setFollowUpMode("all");
		await h.session.steer("steer", [image]);
		await h.session.steer("", [image]);
		await h.session.followUp("follow");
		await h.session.sendCustomMessage(
			{ customType: "next", content: "aside", display: true },
			{ deliverAs: "nextTurn" },
		);
		const hold = await h.session.acquireCheckpoint();
		const { session } = await createAgentSession({
			checkpoint: hold.checkpoint,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: h.session.resourceLoader,
			settingsManager: h.settingsManager,
		});
		restored.push(session);
		session.agent.streamFunction = h.session.agent.streamFunction;
		hold.release();
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		expect(h.getPendingResponseCount()).toBe(3);
		await session.prompt("explicit continue");
		for (const text of ["steer", "follow", "explicit continue", "aside"])
			expect(session.messages.filter((message) => getMessageText(message) === text)).toHaveLength(1);
		expect(JSON.stringify(session.messages)).toContain(`"data":${JSON.stringify(image.data)}`);
		expect(session.hasPendingMessages).toBe(false);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.steeringMode).toBe("all");
		expect(session.followUpMode).toBe("all");
		expect(session.pendingNextTurnCount).toBe(0);
	});

	it.each([false, true])("restores exact branch before context construction (null leaf: %s)", async (nullLeaf) => {
		const h = await setup();
		const selected = h.sessionManager.appendMessage(fauxAssistantMessage("selected"));
		h.sessionManager.appendMessage(fauxAssistantMessage("other branch"));
		if (nullLeaf) h.sessionManager.resetLeaf();
		else h.sessionManager.branch(selected);
		const hold = await h.session.acquireCheckpoint();
		const { session } = await createAgentSession({
			checkpoint: hold.checkpoint,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: h.session.resourceLoader,
			settingsManager: h.settingsManager,
		});
		restored.push(session);
		expect(session.sessionManager.getLeafId()).toBe(nullLeaf ? null : selected);
		expect(session.messages.map(getMessageText)).toEqual(nullLeaf ? [] : ["selected"]);
		expect(session.sessionManager.getEntries()).toEqual(hold.checkpoint.entries);
		hold.release();
	});

	it("saves an initialized session before its first assistant/file exists", async () => {
		const h = await setup();
		h.sessionManager.appendSessionInfo("beforeFirstTurn");
		await h.session.steer("accepted", [image]);
		expect(existsSync(h.session.sessionFile!)).toBe(false);
		const hold = await h.session.acquireCheckpoint();
		const manager = openSessionCheckpoint(hold.checkpoint);
		expect(manager.getSessionId()).toBe(h.session.sessionId);
		expect(manager.getEntries()).toEqual(hold.checkpoint.entries);
		expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain("beforeFirstTurn");
		hold.release();
	});

	it("rejects differing, empty, or malformed journals without modifying their bytes", async () => {
		const h = await setup();
		h.sessionManager.appendMessage(fauxAssistantMessage("saved"));
		const hold = await h.session.acquireCheckpoint();
		hold.release();
		h.sessionManager.appendCustomEntry("newer-work", {});
		const newer = readFileSync(h.session.sessionFile!, "utf8");
		expect(() => openSessionCheckpoint(hold.checkpoint)).toThrow("differs");
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe(newer);
		writeFileSync(h.session.sessionFile!, "");
		expect(() => openSessionCheckpoint(hold.checkpoint)).toThrow("differs");
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe("");
		const malformed = `${newer}\n{"type":`;
		writeFileSync(h.session.sessionFile!, malformed);
		expect(() => openSessionCheckpoint(hold.checkpoint)).toThrow(SyntaxError);
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe(malformed);
	});

	it("waits for settlement handlers and their deferred run before capturing", async () => {
		const entered = deferred();
		const release = deferred();
		const deferredEntered = deferred();
		const deferredRelease = deferred();
		let submitted = false;
		const h = await setup({
			extensionFactories: [
				{
					name: "settlement",
					factory(pi) {
						pi.on("agent_settled", async () => {
							if (submitted) return;
							submitted = true;
							entered.resolve();
							await release.promise;
							pi.appendEntry("settled-write", { done: true });
							pi.sendUserMessage("accepted deferred run");
						});
					},
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage("done"),
			async () => {
				deferredEntered.resolve();
				await deferredRelease.promise;
				return fauxAssistantMessage("deferred answer");
			},
		]);
		const running = h.session.prompt("start");
		await entered.promise;
		expect(h.session.isIdle).toBe(true);
		let captured = false;
		const pending = h.session.acquireCheckpoint().then((hold) => {
			captured = true;
			return hold;
		});
		await Promise.resolve();
		expect(captured).toBe(false);
		release.resolve();
		await deferredEntered.promise;
		expect(captured).toBe(false);
		deferredRelease.resolve();
		const hold = await pending;
		expect(hold.checkpoint.settled).toBe(true);
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("settled-write");
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("deferred answer");
		expect(h.faux.state.callCount).toBe(2);
		hold.release();
		await running;
	});

	it.each([1, 2])("allows a turn hold after admitting the last of %i deferred runs", async (count) => {
		const entered = Array.from({ length: count }, deferred);
		const release = Array.from({ length: count }, deferred);
		let submitted = false;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "noop",
						label: "Noop",
						description: "Checkpoint boundary",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
					});
					pi.on("agent_settled", () => {
						if (submitted) return;
						submitted = true;
						for (let index = 0; index < count; index++) pi.sendUserMessage(`deferred ${index}`);
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage("initial answer"),
			...entered.map((gate, index) => async () => {
				gate.resolve();
				await release[index].promise;
				return index === count - 1
					? fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })
					: fauxAssistantMessage("earlier deferred answer");
			}),
			fauxAssistantMessage("final answer"),
		]);
		const running = h.session.prompt("start");
		await entered[0].promise;
		let captured = false;
		const pending = h.session.acquireCheckpoint({ boundary: "turn" }).then((hold) => {
			captured = true;
			return hold;
		});
		for (let index = 0; index < count - 1; index++) {
			release[index].resolve();
			await entered[index + 1].promise;
			expect(captured).toBe(false);
		}
		release[count - 1].resolve();
		const hold = await pending;
		try {
			expect(hold.checkpoint.boundary).toBe("turn");
			expect(hold.checkpoint.settled).toBe(false);
			expect(h.faux.state.callCount).toBe(count + 1);
			expect(h.getPendingResponseCount()).toBe(1);
		} finally {
			hold.release();
			await running;
		}
		expect(h.session.getLastAssistantText()).toBe("final answer");
	});

	it("settings/capture failures release ingress without clearing accepted queues", async () => {
		const h = await setup();
		await h.session.steer("retain me");
		const release = vi.fn();
		const errors = vi
			.spyOn(h.settingsManager, "drainErrors")
			.mockReturnValueOnce([{ scope: "global", error: new Error("disk full") }]);
		await expect(h.session.acquireCheckpoint({ quiesce: () => release })).rejects.toThrow("disk full");
		expect(release).toHaveBeenCalledOnce();
		expect(h.session.isCheckpointHeld).toBe(false);
		expect(h.session.getSteeringMessages()).toEqual(["retain me"]);
		errors.mockRestore();
		const hold = await h.session.acquireCheckpoint();
		try {
			expect(() => writeSessionCheckpoint(join(h.tempDir, "missing", "checkpoint.json"), hold.checkpoint)).toThrow();
		} finally {
			hold.release();
		}
		await h.session.followUp("still accepting");
		expect(h.session.getFollowUpMessages()).toEqual(["still accepting"]);
	});

	it("a failed turn capture does not abort the run or drop the next queued turn", async () => {
		const entered = deferred();
		const release = deferred();
		const h = await setup();
		h.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("queued response"),
		]);
		const running = h.session.prompt("start");
		await entered.promise;
		await h.session.followUp("accepted follow-up");
		const acquisition = h.session.acquireCheckpoint({
			boundary: "turn",
			quiesce: () => {
				throw new Error("capture failed");
			},
		});
		const rejected = expect(acquisition).rejects.toThrow("capture failed");
		release.resolve();
		await rejected;
		await running;
		expect(h.session.messages.filter((message) => getMessageText(message) === "accepted follow-up")).toHaveLength(1);
		expect(h.getPendingResponseCount()).toBe(0);
		expect(h.session.isCheckpointHeld).toBe(false);
	});

	it("live independent bash cannot yield a hold; cancellation leaves it running", async () => {
		const entered = deferred();
		const release = deferred();
		const h = await setup({
			extensionFactories: [
				{
					name: "bash",
					factory(pi) {
						pi.on("user_bash", async () => {
							entered.resolve();
							await release.promise;
							return { result: { output: "finished", exitCode: 0, cancelled: false, truncated: false } };
						});
					},
				},
			],
		});
		const bash = h.session.executeBash("intercepted");
		await entered.promise;
		const controller = new AbortController();
		const pending = h.session.acquireCheckpoint({ signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow("cancelled");
		expect(h.session.isBashRunning).toBe(true);
		release.resolve();
		await bash;
	});

	it("unsupported live UI rejects rather than authorizing sleep, and reload invalidates holds", async () => {
		const h = await setup();
		await expect(
			h.session.acquireCheckpoint({
				quiesce: () => {
					throw new Error("live prompt");
				},
			}),
		).rejects.toThrow("live prompt");
		const hold = await h.session.acquireCheckpoint();
		await h.session.reload();
		expect(hold.signal.aborted).toBe(true);
		expect(h.session.isCheckpointHeld).toBe(false);
	});
});
