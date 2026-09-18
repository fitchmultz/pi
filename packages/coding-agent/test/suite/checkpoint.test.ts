import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { openSessionCheckpoint, readSessionCheckpoint, writeSessionCheckpoint } from "../../src/core/checkpoint.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const restored: AgentSession[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const session of restored.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
						pi.on("turn_end", async () => {
							await Promise.resolve();
							pi.appendEntry("extension-state", { saved: true });
							pi.sendMessage(
								{ customType: "aside", content: "turn aside", display: true },
								{ triggerTurn: false },
							);
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
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "aGVsbG8=",
		};
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
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("turn aside");
		expect(hold.checkpoint.queues.steering).toHaveLength(2);
		expect(hold.checkpoint.queues.followUp).toHaveLength(1);
		expect(hold.checkpoint.queues.nextTurn).toHaveLength(1);
		expect(hold.checkpoint.queues.persistOnCancel).toEqual([1]);
		expect(h.getPendingResponseCount()).toBe(3);
		await expect(h.session.steer("not accepted while held")).rejects.toThrow("held");
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
		await h.session.steer("steer", [{ type: "image", mimeType: "image/png", data: "aGk=" }]);
		await h.session.steer("", [{ type: "image", mimeType: "image/png", data: "aGk=" }]);
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
		expect(JSON.stringify(session.messages)).toContain('"data":"aGk="');
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
		h.sessionManager.appendCustomEntry("state", { beforeFirstTurn: true });
		await h.session.steer("accepted", [{ type: "image", mimeType: "image/png", data: "aGk=" }]);
		expect(existsSync(h.session.sessionFile!)).toBe(false);
		const hold = await h.session.acquireCheckpoint();
		const manager = openSessionCheckpoint(hold.checkpoint);
		expect(manager.getSessionId()).toBe(h.session.sessionId);
		expect(manager.getEntries()).toEqual(hold.checkpoint.entries);
		expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain("beforeFirstTurn");
		hold.release();
	});

	it("rejects differing or empty existing journals without modifying their bytes", async () => {
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
	});

	it("does not capture between awaited settlement handlers even though isIdle is true", async () => {
		const entered = deferred();
		const release = deferred();
		const h = await setup({
			extensionFactories: [
				{
					name: "settlement",
					factory(pi) {
						pi.on("agent_settled", async () => {
							entered.resolve();
							await release.promise;
							pi.appendEntry("settled-write", { done: true });
						});
					},
				},
			],
		});
		h.setResponses([fauxAssistantMessage("done")]);
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
		const hold = await pending;
		expect(hold.checkpoint.settled).toBe(true);
		expect(JSON.stringify(hold.checkpoint.entries)).toContain("settled-write");
		hold.release();
		await running;
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
