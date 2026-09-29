import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("retained session lifecycle", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("captures exact idle queues and selection, refuses unquiesced sleep, and invalidates on new ingress", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-checkpoint-"));
		try {
			const harness = await createHarness({ sessionManager: SessionManager.create(dir, dir) });
			harnesses.push(harness);
			harness.session.setActiveToolsByName(["read"]);
			harness.session.setSteeringMode("all");
			await harness.session.steer("first");
			await harness.session.followUp("second");
			await harness.session.sendCustomMessage(
				{ customType: "aside", content: "third", display: false },
				{ deliverAs: "nextTurn" },
			);
			const queues = harness.session.getCheckpointQueues();
			const refused = await harness.session.acquireCheckpoint();
			expect(refused.sleepReady).toBe(false);
			expect(refused.sleepBlockers).toContain("Host input is not quiesced");
			refused.release();
			let quiesced = false;
			const held = await harness.session.acquireCheckpoint({
				quiesce: () => {
					quiesced = true;
					return () => {
						quiesced = false;
					};
				},
			});
			expect(held.sleepReady).toBe(true);
			expect(quiesced).toBe(true);
			expect(held.checkpoint.queues).toEqual(queues);
			expect(held.checkpoint.selection.activeTools).toEqual(["read"]);
			await expect(harness.session.prompt("must not enter")).rejects.toThrow(/hold invalidated/);
			expect(held.signal.aborted).toBe(true);
			expect(quiesced).toBe(false);
			expect(harness.session.getCheckpointQueues()).toEqual(queues);
			const { session: restored } = await createAgentSession({
				checkpoint: held.checkpoint,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
			});
			try {
				expect(restored.sessionId).toBe(harness.session.sessionId);
				expect(restored.getCheckpointQueues()).toEqual(queues);
				expect(restored.getActiveToolNames()).toEqual(["read"]);
				expect(restored.sessionManager.getEntries()).toEqual(held.checkpoint.entries);
			} finally {
				restored.dispose();
			}
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cancels delayed startup without admitting a request or consuming next-turn messages", async () => {
		const entered = deferred();
		const release = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "keep", display: false },
			{ deliverAs: "nextTurn" },
		);
		const prompt = harness.session.prompt("cancel me");
		const rejected = expect(prompt).rejects.toThrow();
		await entered.promise;
		const aborted = harness.session.abort();
		release.resolve();
		await Promise.all([aborted, rejected]);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.getCheckpointQueues().nextTurn.map((message) => message.content)).toEqual(["keep"]);
	});

	it("shutdown rejects input admitted by a delayed input handler", async () => {
		const entered = deferred();
		const release = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const prompt = harness.session.prompt("late");
		const rejected = expect(prompt).rejects.toThrow();
		await entered.promise;
		expect(harness.session.pendingInputCount).toBe(1);
		harness.session.beginShutdown();
		release.resolve();
		await rejected;
		expect(harness.session.pendingInputCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it.each([false, true])("offers early overflow to summary-free hooks afterReset=%s", async (afterReset) => {
		let hooks = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 100000 }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						hooks++;
						return {
							compaction: {
								summary: "",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		if (afterReset) {
			const id = harness.sessionManager.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
			harness.sessionManager.appendCompaction("", id, 1, undefined, true);
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		}
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "maximum context length exceeded",
				timestamp: afterReset ? 1 : Date.now(),
			}),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("overflow");
		expect(hooks).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "compaction")
				.at(-1),
		).toMatchObject({ summary: "" });
	});

	it("does not call a summary provider when an early-overflow hook declines", async () => {
		let hooks = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 100000 }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						hooks++;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
		]);
		await harness.session.prompt("overflow");
		expect(hooks).toBe(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
