import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openWorkingSession, parseWorkingSession } from "../../src/core/working-session.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// These tests own complete SDK state and the awaited native admission/turn boundary.
// The existing boundary suite protects scheduling but cannot protect a held save.
describe("Native working sessions", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	it("restores the selected leaf, abandoned branches, full queue tails, loadout and transient settings without replay", async () => {
		const h = await createHarness({ allowedToolNames: ["read", "bash"], excludedToolNames: ["bash"] });
		harnesses.push(h);
		const selected = h.sessionManager.appendMessage({ role: "user", content: "selected branch", timestamp: 10 });
		const abandoned = h.sessionManager.appendMessage({ role: "user", content: "abandoned branch", timestamp: 11 });
		h.sessionManager.branch(selected);
		h.session.refreshContext();
		h.session.setActiveToolsByName(["read"]);
		h.settingsManager.applyOverrides({ shellCommandPrefix: "native unsent setting" });
		h.session.setScopedModels([{ model: h.getModel(), thinkingLevel: "high" }]);
		const steering: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
				],
				timestamp: 20,
			},
			{
				role: "custom",
				customType: "steer-tail",
				content: "second",
				display: false,
				details: { opaque: [1, 2] },
				timestamp: 21,
			},
		];
		const followUp: AgentMessage[] = [
			{
				role: "custom",
				customType: "follow-first",
				content: "third",
				display: true,
				details: { owned: "extension" },
				timestamp: 22,
			},
			{ role: "user", content: "fourth", timestamp: 23 },
		];
		for (const message of steering) h.session.agent.steer(message);
		for (const message of followUp) h.session.agent.followUp(message);
		await h.session.sendCustomMessage(
			{ customType: "aside", content: "next prompt only", display: false, details: { nested: true } },
			{ deliverAs: "nextTurn" },
		);
		const hold = await h.session.acquireWorkingSession();
		expect(hold.sleepReady).toBe(true);
		expect(hold.state.steering).toEqual(steering);
		expect(hold.state.followUp).toEqual(followUp);
		const state = parseWorkingSession(JSON.stringify(hold.state));
		await hold.release();
		const { session } = await createAgentSession({
			workingSession: state,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: h.session.resourceLoader,
		});
		try {
			expect(session.sessionId).toBe(h.session.sessionId);
			expect(session.sessionManager.getLeafId()).toBe(selected);
			expect(session.sessionManager.getEntry(abandoned)).toMatchObject({ message: { content: "abandoned branch" } });
			expect(
				session.messages.some((message) => "content" in message && message.content === "abandoned branch"),
			).toBe(false);
			expect(session.agent.getQueuedMessages()).toEqual({ steering, followUp });
			expect(session.getActiveToolNames()).toEqual(["read"]);
			expect(session.settingsManager.getShellCommandPrefix()).toBe("native unsent setting");
			expect(session.scopedModels).toMatchObject([{ model: { id: h.getModel().id }, thinkingLevel: "high" }]);
			expect(session.hasPendingNextTurnMessages).toBe(true);
			const restored = await session.acquireWorkingSession();
			expect(restored.state.nextTurn).toEqual([
				expect.objectContaining({
					role: "custom",
					customType: "aside",
					content: "next prompt only",
					display: false,
					details: { nested: true },
				}),
			]);
			expect(restored.state.allowedTools).toEqual(["read", "bash"]);
			expect(restored.state.excludedTools).toEqual(["bash"]);
			await restored.release();
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it.each(["retain-none compaction", "root branch summary", "extracted branch summary"])(
		"restores native %s records without replay and still rejects broken journal references",
		async (kind) => {
			const h = await createHarness();
			harnesses.push(h);
			const selected = h.sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
			if (kind === "retain-none compaction") {
				h.sessionManager.appendCompaction("native summary", null, 100);
			} else if (kind === "root branch summary") {
				h.sessionManager.resetLeaf();
				h.sessionManager.branchWithSummary(null, "native summary");
			} else {
				h.sessionManager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
				const summary = h.sessionManager.branchWithSummary(selected, "native summary");
				h.sessionManager.createBranchedSession(summary);
			}
			h.session.refreshContext();
			const hold = await h.session.acquireWorkingSession();
			try {
				const invalidEntries = [
					[...hold.state.entries, hold.state.entries[0]],
					hold.state.entries.map((entry, index) => (index === 0 ? { ...entry, parentId: "missing" } : entry)),
				];
				if (kind === "retain-none compaction") {
					invalidEntries.push(
						hold.state.entries.map((entry) =>
							entry.type === "compaction" ? { ...entry, firstKeptEntryId: "missing" } : entry,
						),
					);
				}
				for (const entries of invalidEntries) {
					expect(() => parseWorkingSession(JSON.stringify({ ...hold.state, entries }))).toThrow(
						"Invalid native working session",
					);
				}
				const state = parseWorkingSession(JSON.stringify(hold.state));
				const { session } = await createAgentSession({
					workingSession: state,
					modelRuntime: h.session.modelRuntime,
					resourceLoader: h.session.resourceLoader,
				});
				try {
					expect(session.sessionManager.getEntries()).toEqual(hold.state.entries);
					expect(session.sessionManager.getLeafId()).toBe(hold.state.leafId);
					expect(session.messages).toEqual(
						expect.arrayContaining([expect.objectContaining({ summary: "native summary" })]),
					);
					expect(h.faux.state.callCount).toBe(0);
				} finally {
					session.dispose();
				}
			} finally {
				await hold.release();
			}
		},
	);

	it("holds a real completed turn before either queue is consumed and resumes on release", async () => {
		const response = deferred();
		const h = await createHarness();
		harnesses.push(h);
		h.setResponses([
			async () => {
				await response.promise;
				return fauxAssistantMessage("first response");
			},
			fauxAssistantMessage("steered"),
			fauxAssistantMessage("followed"),
		]);
		const run = h.session.prompt("start");
		await vi.waitFor(() => expect(h.faux.state.callCount).toBe(1));
		await h.session.steer("accepted steering");
		await h.session.followUp("accepted follow-up");
		const acquisition = h.session.acquireWorkingSession({ boundary: "turn" });
		response.resolve();
		const hold = await acquisition;
		expect(hold.boundary).toBe("turn");
		expect(hold.sleepReady).toBe(false);
		expect(hold.state.steeringText).toEqual(["accepted steering"]);
		expect(hold.state.followUpText).toEqual(["accepted follow-up"]);
		expect(h.faux.state.callCount).toBe(1);
		await hold.release();
		await run;
		expect(h.faux.state.callCount).toBe(3);
	});

	it("counts input preflight from invocation and waits for deferred settled work", async () => {
		const input = deferred();
		let inputStarted = false;
		let continued = false;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputStarted = true;
						await input.promise;
						return { action: "continue" };
					});
					pi.on("agent_settled", () => {
						if (continued) return;
						continued = true;
						pi.sendUserMessage("deferred work");
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("deferred complete")]);
		const run = h.session.prompt("start");
		await vi.waitFor(() => expect(inputStarted).toBe(true));
		expect(h.session.isIdle).toBe(true);
		let acquired = false;
		const acquisition = h.session.acquireWorkingSession().then((hold) => {
			acquired = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acquired).toBe(false);
		input.resolve();
		await run;
		const hold = await acquisition;
		expect(h.faux.state.callCount).toBe(2);
		expect(hold.state.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.objectContaining({ content: [{ type: "text", text: "deferred complete" }] }),
				}),
			]),
		);
		await hold.release();
	});

	it("joins asynchronous public settled notifications before granting a cut", async () => {
		const callback = deferred();
		let started = false;
		const h = await createHarness();
		harnesses.push(h);
		h.session.subscribe(async (event) => {
			if (event.type !== "agent_settled") return;
			started = true;
			await callback.promise;
			h.session.sessionManager.appendCustomEntry("host callback complete", true);
		});
		h.setResponses([fauxAssistantMessage("question")]);
		await h.session.prompt("start");
		expect(started).toBe(true);
		let acquired = false;
		const acquisition = h.session.acquireWorkingSession().then((hold) => {
			acquired = true;
			return hold;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acquired).toBe(false);
		callback.resolve();
		const hold = await acquisition;
		expect(hold.state.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ customType: "host callback complete" })]),
		);
		await hold.release();
	});

	it("counts a real asynchronous TUI factory, buffers held input and captures accepted mode queues", async () => {
		let ctx!: ExtensionContext;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, context) => {
						ctx = context;
					});
				},
			],
		});
		harnesses.push(h);
		initTheme("dark");
		const mode = new InteractiveMode(
			{
				session: h.session,
				setBeforeSessionInvalidate() {},
				setRebindSession() {},
			} as unknown as AgentSessionRuntime,
			{ terminal: new VirtualTerminal(80, 40) },
		);
		const view = mode as unknown as {
			isInitialized: boolean;
			isShuttingDown: boolean;
			defaultEditor: CustomEditor;
			ui: TUI;
			setupEditorSubmitHandler(): void;
			rebindCurrentSession(): Promise<void>;
		};
		view.isInitialized = true;
		// The fixture has no real stdin; keep actual draft/dialog checks active.
		view.isShuttingDown = true;
		view.setupEditorSubmitHandler();
		await view.rebindCurrentSession();
		try {
			const factory = deferred();
			let invoked = false;
			const dialog = ctx.ui.custom<string>(async (_ui, _theme, _keys, done) => {
				invoked = true;
				done("closed before factory settles");
				await factory.promise;
				return new Text("unused component");
			});
			await dialog;
			expect(invoked).toBe(true);
			let acquired = false;
			const acquisition = h.session.acquireWorkingSession().then((hold) => {
				acquired = true;
				return hold;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(acquired).toBe(false);
			factory.resolve();
			const hold = await acquisition;
			expect(hold.sleepReady).toBe(true);
			view.ui.setFocus(view.defaultEditor);
			view.ui.dispatchInput("preserved keystrokes");
			expect(view.defaultEditor.getText()).toBe("");
			expect(hold.invalidated.aborted).toBe(true);
			await hold.release();
			await vi.waitFor(() => expect(view.defaultEditor.getText()).toBe("preserved keystrokes"));
			const draft = await h.session.acquireWorkingSession();
			expect(draft.sleepReady).toBe(false);
			expect(draft.blockers).toContain("Unsent editor text");
			await draft.release();
			view.defaultEditor.setText("");
			await view.defaultEditor.onSubmit?.("raw accepted input");
			const queued = await h.session.acquireWorkingSession();
			expect(queued.state.mode).toMatchObject({
				kind: "tui",
				data: { pendingUserInputs: ["raw accepted input"], draft: "" },
			});
			let delivered = false;
			const input = mode.getUserInput().then((text) => {
				delivered = true;
				return text;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(delivered).toBe(false);
			await queued.release();
			expect(await input).toBe("raw accepted input");
			const { session } = await createAgentSession({
				workingSession: queued.state,
				modelRuntime: h.session.modelRuntime,
				resourceLoader: h.session.resourceLoader,
			});
			const restoredMode = new InteractiveMode(
				{
					session,
					setBeforeSessionInvalidate() {},
					setRebindSession() {},
				} as unknown as AgentSessionRuntime,
				{ terminal: new VirtualTerminal(80, 40) },
			);
			const restoredView = restoredMode as unknown as typeof view;
			restoredView.isInitialized = true;
			restoredView.isShuttingDown = true;
			restoredView.setupEditorSubmitHandler();
			try {
				await restoredView.rebindCurrentSession();
				const restored = await session.acquireWorkingSession();
				expect(restored.state.mode).toMatchObject({
					kind: "tui",
					data: { pendingUserInputs: ["raw accepted input"], draft: "" },
				});
				expect(h.faux.state.callCount).toBe(0);
				await restored.release();
			} finally {
				restoredMode.stop("resume-hint");
				session.dispose();
			}
		} finally {
			mode.stop("resume-hint");
		}
	});

	it("invalidates before synchronous mutation and keeps the reservation until explicit release", async () => {
		const lifetime: AbortSignal[] = [];
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("working_session_save", (event) => {
						lifetime.push(event.signal);
						event.appendEntry("persisted", { version: 1 });
					});
				},
			],
		});
		harnesses.push(h);
		const hold = await h.session.acquireWorkingSession();
		expect(hold.state.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ customType: "persisted", data: { version: 1 } })]),
		);
		expect(() => h.settingsManager.setShellCommandPrefix("not accepted")).toThrow("reserved");
		expect(h.settingsManager.getShellCommandPrefix()).toBeUndefined();
		expect(hold.invalidated.aborted).toBe(true);
		expect(lifetime[0]!.aborted).toBe(false);
		expect(() => h.session.sessionManager.appendCustomEntry("timer", true)).toThrow("reserved");
		expect(() => hold.assertHeld()).toThrow();
		await hold.release();
		expect(lifetime[0]!.aborted).toBe(true);
		h.session.sessionManager.appendCustomEntry("timer", true);
	});

	it("propagates save-hook failures and refuses a newer journal without writes", async () => {
		const broken = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("working_session_save", () => {
						throw new Error("private state flush failed");
					});
				},
			],
		});
		harnesses.push(broken);
		await expect(broken.session.acquireWorkingSession()).rejects.toThrow("private state flush failed");
		broken.session.sessionManager.appendCustomEntry("still usable", true);
		const dir = mkdtempSync(join(tmpdir(), "pi-working-journal-"));
		try {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			const h = await createHarness({ sessionManager: manager });
			harnesses.push(h);
			const hold = await h.session.acquireWorkingSession();
			const saved = hold.state;
			await hold.release();
			const missing = join(dir, "invalid-must-not-be-created.jsonl");
			const malformed = {
				...saved,
				sessionFile: missing,
				entries: saved.entries.map((entry) =>
					entry.type === "message" ? { ...entry, message: undefined } : entry,
				),
			};
			const malformedPath = join(dir, "malformed.json");
			writeFileSync(malformedPath, JSON.stringify(malformed), { mode: 0o600 });
			await expect(createAgentSession({ workingSession: malformedPath })).rejects.toThrow(
				"Invalid native working session",
			);
			expect(existsSync(missing)).toBe(false);
			const materialized = openWorkingSession({ ...saved, sessionFile: missing });
			expect(materialized.getLeafId()).toBe(saved.leafId);
			expect(readFileSync(missing, "utf8")).toBe(
				`${[saved.header, ...saved.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
			manager.appendCustomEntry("newer", { mustRetain: true });
			const before = readFileSync(manager.getSessionFile()!);
			expect(() => openWorkingSession(saved)).toThrow("differs");
			expect(readFileSync(manager.getSessionFile()!)).toEqual(before);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
