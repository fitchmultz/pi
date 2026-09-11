import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RESTART_SOCKET_ENV,
	type RestartHandoff,
	type RestartWorkerMessage,
	requestRestart,
} from "../../src/cli/restart-protocol.ts";
import { createRestartControl, restoreRestartSession } from "../../src/cli/restart-worker.ts";
import type { ExtensionUIContext, InlineExtension } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});

async function setup(
	options: { tools?: AgentTool[]; ephemeral?: boolean; extra?: InlineExtension[]; args?: string[] } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-restart-control-test-"));
	directories.push(root);
	const sessionManager = options.ephemeral
		? SessionManager.inMemory(root)
		: SessionManager.create(root, join(root, "sessions"));
	sessionManager.appendMessage(fauxAssistantMessage("Saved history"));
	const sent: RestartWorkerMessage[] = [];
	const shutdown = vi.fn();
	const notify = vi.fn();
	const editor = { text: "" };
	const control = createRestartControl({
		args: options.args ?? ["-ne", "original prompt"],
		send: async (message) => {
			sent.push(message);
		},
	});
	const harness = await createHarness({
		sessionManager,
		tools: options.tools,
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		extensionFactories: [...(options.extra ?? []), control.extension],
	});
	harnesses.push(harness);
	// Only the UI methods used by restart control are needed; this does not emulate terminal rendering.
	const uiContext = { notify, getEditorText: () => editor.text } as unknown as ExtensionUIContext;
	await harness.session.bindExtensions({ mode: "tui", uiContext, shutdownHandler: shutdown });
	await control.ready();
	const socket = process.env[RESTART_SOCKET_ENV]!;
	expect(socket).toBeTruthy();
	return { harness, control, socket, sent, shutdown, notify, editor, sessionManager };
}

describe("native restart control at session boundaries", () => {
	it("waits for every sibling tool, retry and follow-up; saves a complete journal before restart", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let requested = () => {};
		const queued = new Promise<void>((resolve) => {
			requested = resolve;
		});
		let writes = 0;
		const tools: AgentTool[] = [
			{
				name: "restart_request",
				label: "Request restart",
				description: "Request restart",
				parameters: Type.Object({}),
				async execute() {
					const result = await requestRestart(process.env[RESTART_SOCKET_ENV]!, {
						message: "Continue after restart",
					});
					requested();
					return { content: [{ type: "text", text: result }], details: {} };
				},
			},
			{
				name: "write_once",
				label: "Write once",
				description: "A held side effect",
				parameters: Type.Object({}),
				async execute() {
					await held;
					writes++;
					return { content: [{ type: "text", text: "written" }], details: {} };
				},
			},
		];
		let followedUp = false;
		const f = await setup({
			tools,
			extra: [
				{
					name: "follow-up",
					factory(pi) {
						pi.on("agent_end", () => {
							if (followedUp) return;
							followedUp = true;
							pi.sendUserMessage("Finish queued work", { deliverAs: "followUp" });
						});
					},
				},
			],
		});
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("restart_request", {}), fauxToolCall("write_once", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("Recovered"),
			fauxAssistantMessage("Follow-up complete"),
		]);
		const prompt = f.harness.session.prompt("Start task");
		await queued;
		expect(f.shutdown).not.toHaveBeenCalled();
		expect(f.sent.map((message) => message.type)).toEqual(["pi:ready"]);
		expect(writes).toBe(0);
		release();
		await prompt;
		await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledTimes(1));
		expect(writes).toBe(1);
		expect(f.harness.eventsOfType("agent_settled")).toHaveLength(1);
		await f.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const restart = f.sent.find((message) => message.type === "pi:restart");
		expect(restart?.type).toBe("pi:restart");
		if (restart?.type !== "pi:restart") throw new Error("Missing restart checkpoint");
		expect(restart.checkpoint).toMatchObject({
			sessionId: f.sessionManager.getSessionId(),
			leafId: f.sessionManager.getLeafId(),
			sessionFile: f.sessionManager.getSessionFile(),
		});
		expect(restart.args).toEqual(["-ne"]);
		expect(restart.request.message).toBe("Continue after restart");
		const journal = readFileSync(restart.checkpoint.sessionFile, "utf8");
		expect(journal).toContain('"toolName":"write_once"');
		expect(journal).toContain('"toolName":"restart_request"');
		expect(journal).toContain("Follow-up complete");
		expect(process.env[RESTART_SOCKET_ENV]).toBeUndefined();
	});

	it.each([false, true])(
		"only forwards a CLI key for its original provider (same provider: %s)",
		async (sameProvider) => {
			const f = await setup({ args: ["--api-key", "test-only-key", "-ne"] });
			f.control.setInitialProvider(sameProvider ? f.harness.getModel().provider : "different-provider");
			await requestRestart(f.socket, {});
			await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledTimes(1));
			await f.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			const restart = f.sent.find((message) => message.type === "pi:restart");
			expect(restart?.type === "pi:restart" && restart.args.includes("test-only-key")).toBe(sameProvider);
		},
	);

	it("cancels a queued restart when the agent is interrupted", async () => {
		const f = await setup();
		await requestRestart(f.socket, {});
		await f.harness.session.extensionRunner.emitMessageEnd({
			type: "message_end",
			message: fauxAssistantMessage("", { stopReason: "aborted" }),
		});
		await f.harness.session.extensionRunner.emit({ type: "agent_settled" });
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("interrupted"), "warning");
		expect(f.shutdown).not.toHaveBeenCalled();
	});

	it("cancels during actual retry backoff without requiring an aborted assistant message", async () => {
		let cancelRetry = () => {};
		const f = await setup({
			extra: [
				{
					name: "cancel-retry",
					factory(pi) {
						pi.on("auto_retry_start", () => cancelRetry());
					},
				},
			],
		});
		cancelRetry = () => f.harness.session.abortRetry();
		await requestRestart(f.socket, {});
		f.harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		await f.harness.session.prompt("Trigger retry cancellation");
		expect(f.harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, finalError: "Retry cancelled" },
		]);
		expect(f.shutdown).not.toHaveBeenCalled();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("retries were cancelled"), "warning");
	});

	it.each([false, true])("user quit wins before shutdown completes (already committed: %s)", async (committed) => {
		const f = await setup();
		await requestRestart(f.socket, { message: "Must not run after quit" });
		if (committed) await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledTimes(1));
		f.control.shutdownRequested("user");
		await f.harness.session.extensionRunner.emit({ type: "agent_settled" });
		await f.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(f.sent.map((message) => message.type)).toEqual(["pi:ready"]);
	});

	it("does not declare readiness after the user quits during startup", async () => {
		const sent: RestartWorkerMessage[] = [];
		const control = createRestartControl({
			args: [],
			send: async (message) => {
				sent.push(message);
			},
		});
		control.shutdownRequested("user");
		expect(await control.ready()).toBe(false);
		expect(sent).toEqual([]);
	});

	it("rejects a restart that would drop unjournaled next-turn messages", async () => {
		const f = await setup({
			extra: [
				{
					name: "next-turn",
					factory(pi) {
						pi.on("session_start", () =>
							pi.sendMessage(
								{ customType: "pending", content: "not yet journaled", display: false },
								{ deliverAs: "nextTurn" },
							),
						);
					},
				},
			],
		});
		await expect(requestRestart(f.socket, {})).rejects.toThrow("next-turn messages");
		expect(f.shutdown).not.toHaveBeenCalled();
	});

	it("rejects ephemeral sessions, mismatched session IDs, drafts, duplicates and missing runtimes", async () => {
		const ephemeral = await setup({ ephemeral: true });
		await expect(requestRestart(ephemeral.socket, {})).rejects.toThrow("saved session");
		await ephemeral.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const f = await setup();
		await expect(requestRestart(f.socket, { sessionId: "wrong-session" })).rejects.toThrow("different session");
		f.editor.text = "unsent work";
		await expect(requestRestart(f.socket, {})).rejects.toThrow("unsent editor text");
		f.editor.text = "";
		await expect(requestRestart(f.socket, { runtime: join(tmpdir(), "no-such-pi-runtime") })).rejects.toThrow();
		await requestRestart(f.socket, {});
		await expect(requestRestart(f.socket, {})).rejects.toThrow("already queued");
	});

	it("does not turn normal quit into a restart while a request is waiting on work", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const f = await setup({
			extra: [
				{
					name: "held-bash",
					factory(pi) {
						pi.on("user_bash", async () => {
							entered();
							await held;
							return { result: { output: "done", exitCode: 0, cancelled: false, truncated: false } };
						});
					},
				},
			],
		});
		const bash = f.harness.session.executeBash("test-only interception");
		await started;
		await requestRestart(f.socket, {});
		await f.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		release();
		await bash;
		expect(f.shutdown).not.toHaveBeenCalled();
		expect(f.sent.map((message) => message.type)).toEqual(["pi:ready"]);
	});

	it("cancels rather than losing text typed after the request", async () => {
		const f = await setup();
		await requestRestart(f.socket, {});
		f.editor.text = "typed before the safe point";
		await vi.waitFor(() =>
			expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("Restart cancelled"), "warning"),
		);
		expect(f.shutdown).not.toHaveBeenCalled();
	});

	it("cleans up the endpoint on reload and binds a new endpoint without replaying a queued request", async () => {
		const f = await setup();
		await requestRestart(f.socket, {});
		await f.harness.session.reload();
		expect(process.env[RESTART_SOCKET_ENV]).toBeTruthy();
		expect(process.env[RESTART_SOCKET_ENV]).not.toBe(f.socket);
		await expect(requestRestart(f.socket, {})).rejects.toThrow();
		expect(f.sent.map((message) => message.type)).toEqual(["pi:ready"]);
	});

	it("restores the selected branch instead of following a failed candidate's later entries", async () => {
		const f = await setup();
		const leafId = f.sessionManager.getLeafId();
		f.sessionManager.appendMessage(fauxAssistantMessage("Candidate startup entry"));
		const handoff: RestartHandoff = {
			checkpoint: {
				sessionFile: f.sessionManager.getSessionFile()!,
				sessionId: f.sessionManager.getSessionId(),
				cwd: f.sessionManager.getCwd(),
				leafId,
				thinkingLevel: "off",
				activeTools: [],
				knownTools: [],
			},
		};
		const reopened = SessionManager.open(handoff.checkpoint.sessionFile);
		expect(reopened.getLeafId()).not.toBe(leafId);
		restoreRestartSession(reopened, handoff);
		expect(reopened.getLeafId()).toBe(leafId);
		expect(reopened.getEntries().length).toBeGreaterThan(reopened.getBranch().length);
		expect(() =>
			restoreRestartSession(reopened, { checkpoint: { ...handoff.checkpoint, sessionId: "wrong" } }),
		).toThrow("identity mismatch");
	});
});
