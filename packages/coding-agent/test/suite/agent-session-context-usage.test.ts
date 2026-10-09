import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createHarness, type Harness } from "./harness.ts";

function assistant(tokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	const message = fauxAssistantMessage("reply", { stopReason, timestamp: 1 });
	return { ...message, usage: { ...message.usage, input: tokens, totalTokens: tokens } };
}

function user(content: string) {
	return { role: "user" as const, content, timestamp: 1 };
}

describe("AgentSession context usage", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("does not rescan archived ancestry on repeated reads and isolates returned scalars", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const { session, sessionManager: manager } = h;
		for (let i = 0; i < 20_000; i++) manager.appendCustomEntry("archived", i);
		manager.appendCompaction("handoff", null, 300_000);

		// Count real native scans, not elapsed time: this guards repeated work without a timing threshold.
		const scans = [
			vi.spyOn(manager, "buildSessionProjection"),
			vi.spyOn(manager, "getEntries"),
			vi.spyOn(manager, "getBranch"),
		];
		for (const tokens of [null, 1100, 0]) {
			if (tokens === 1100) {
				manager.appendMessage(assistant(1001));
				for (let i = 0; i < 99; i++) manager.appendMessage(user("x"));
			} else if (tokens === 0) {
				manager.resetLeaf();
			}
			const expected = {
				tokens,
				contextWindow: 128_000,
				percent: tokens === null ? null : (tokens / 128_000) * 100,
			};
			const first = session.getContextUsage()!;
			expect(first).toEqual(expected);
			const initialScans = scans.map((scan) => scan.mock.calls.length);
			first.tokens = -1;
			first.contextWindow = -1;
			first.percent = -1;
			for (let i = 0; i < 9; i++) expect(session.getContextUsage()).toEqual(expected);
			expect(scans.map((scan) => scan.mock.calls.length)).toEqual(initialScans);
		}
	});

	it.each([false, true])("invalidates compaction, edits and branch selection; retain recent=%s", async (retain) => {
		const h = await createHarness();
		harnesses.push(h);
		const { session, sessionManager: manager } = h;
		const oldUser = manager.appendMessage(user("old input"));
		manager.appendMessage(assistant(1001));
		expect(session.getContextUsage()?.tokens).toBe(1001);
		const keptUser = manager.appendMessage(user("abcdefghijklmnopqrst"));
		manager.appendMessage(assistant(195_000));
		const boundary = manager.appendCompaction("handoff", retain ? keptUser : null, 195_000);
		expect(session.getContextUsage()).toEqual({ tokens: null, contextWindow: 128_000, percent: null });
		for (const [tokens, reason] of [
			[99_999, "error"],
			[99_999, "aborted"],
			[0, "stop"],
		] as const) {
			manager.appendMessage(assistant(tokens, reason));
			expect(session.getContextUsage()?.tokens).toBeNull();
		}
		const successful = manager.appendMessage(assistant(2007));
		expect(session.getContextUsage()?.tokens).toBe(2007);
		const trailing = manager.appendMessage(user("abcdefghijklmnopqrst"));
		expect(session.getContextUsage()?.tokens).toBe(2012);
		const edited = manager.appendContextEdit(trailing, { content: "x" });
		// Later edits invalidate provider usage: summary=2, successful reply=2, replacement=1,
		// three invalid-usage replies=6; the retained user/reply add another 5+2.
		expect(session.getContextUsage()?.tokens).toBe(retain ? 18 : 11);
		expect(manager.getEntry(trailing)).toMatchObject({ message: { content: "abcdefghijklmnopqrst" } });
		manager.branch(successful);
		expect(session.getContextUsage()?.tokens).toBe(2007);
		manager.branch(boundary);
		expect(session.getContextUsage()?.tokens).toBeNull();
		manager.branch(oldUser);
		expect(session.getContextUsage()?.tokens).toBe(3);
		manager.resetLeaf();
		expect(session.getContextUsage()?.tokens).toBe(0);
		manager.branch(edited);
		expect(session.getContextUsage()?.tokens).toBe(retain ? 18 : 11);
		manager.appendContextEdit(successful, null);
		expect(session.getContextUsage()?.tokens).toBeNull();
		manager.appendMessage(assistant(900));
		expect(session.getContextUsage()?.tokens).toBe(900);
	});

	it("adopts changed model limits without changing the selected leaf", async () => {
		let pi!: ExtensionAPI;
		const h = await createHarness({
			extensionFactories: [
				(api) => {
					pi = api;
				},
			],
		});
		harnesses.push(h);
		const { session, sessionManager: manager } = h;
		manager.appendMessage(assistant(1001));
		const leaf = manager.getLeafEntry();
		expect(session.getContextUsage()?.contextWindow).toBe(128_000);
		for (const contextWindow of [2000, 0, 4000]) {
			const model = h.getModel();
			pi.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				apiKey: "faux-key",
				models: [{ ...model, contextWindow }],
			});
			expect(manager.getLeafEntry()).toBe(leaf);
			expect(session.getContextUsage()).toEqual(
				contextWindow === 0
					? undefined
					: {
							tokens: 1001,
							contextWindow,
							percent: (1001 / contextWindow) * 100,
						},
			);
		}
	});

	it("recomputes same-file reloads with reused session and leaf IDs, and handles new roots", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const { session, sessionManager: manager } = h;
		manager.appendMessage(assistant(101));
		const header = manager.getHeader()!;
		const leaf = manager.getLeafEntry()!;
		expect(session.getContextUsage()?.tokens).toBe(101);
		const path = join(h.tempDir, "reload.jsonl");
		for (const tokens of [407, 809]) {
			writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify({ ...leaf, message: assistant(tokens) })}\n`);
			manager.setSessionFile(path);
			expect(manager.getSessionId()).toBe(header.id);
			expect(manager.getLeafId()).toBe(leaf.id);
			expect(session.getContextUsage()?.tokens).toBe(tokens);
		}
		// Native JSONL loading permits unvalidated entries; a missing leaf object is not a null selection.
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify({ ...leaf, id: "", message: user("abcd") })}\n`);
		manager.setSessionFile(path);
		expect(manager.getLeafId()).toBe("");
		expect(manager.getLeafEntry()).toBeUndefined();
		expect(session.getContextUsage()?.tokens).toBe(1);
		manager.resetLeaf();
		expect(session.getContextUsage()?.tokens).toBe(0);
		manager.appendMessage(user("abcd"));
		expect(session.getContextUsage()?.tokens).toBe(1);
		manager.newSession({ id: header.id });
		expect(session.getContextUsage()?.tokens).toBe(0);
		manager.branchWithSummary(null, "abcdefgh");
		expect(session.getContextUsage()?.tokens).toBe(2);
	});

	it("restores native working-session selection without reusing another session's result", async () => {
		const h = await createHarness();
		harnesses.push(h);
		const { session, sessionManager: manager } = h;
		const first = manager.appendMessage(assistant(101));
		const second = manager.appendMessage(assistant(407));
		for (const [selected, expected] of [
			[first, 101],
			[second, 407],
			[null, 0],
		] as const) {
			if (selected === null) manager.resetLeaf();
			else manager.branch(selected);
			session.refreshContext();
			expect(session.getContextUsage()?.tokens).toBe(expected);
			const hold = await session.acquireWorkingSession();
			await hold.release();
			const restored = await createAgentSession({
				workingSession: hold.state,
				modelRuntime: session.modelRuntime,
				resourceLoader: session.resourceLoader,
			});
			try {
				expect(restored.session.sessionManager.getLeafId()).toBe(selected);
				expect(restored.session.sessionManager.getEntryCount()).toBe(2);
				expect(restored.session.getContextUsage()?.tokens).toBe(expected);
			} finally {
				restored.session.dispose();
			}
		}
	});
});
