import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import {
	BACKGROUND_COMMAND_NOTICE,
	BACKGROUND_COMMAND_RUN_STATE,
	type BackgroundCommandJob,
	backgroundCommandDirectory,
	backgroundCommandFinished,
	cancelBackgroundCommand,
	listBackgroundCommands,
	readBackgroundCommand,
	startBackgroundCommand,
} from "../../src/core/background-command.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { getShellEnv } from "../../src/utils/shell.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
async function until(condition: () => boolean) {
	for (let i = 0; i < 240; i++) {
		if (condition()) return;
		await delay(25);
	}
	throw new Error("Timed out waiting for native background completion");
}
function jobFrom(messages: AgentMessage[]): BackgroundCommandJob {
	const result = [...messages]
		.reverse()
		.find((message) => message.role === "toolResult" && message.toolName === "background_command");
	if (!result || result.role !== "toolResult" || result.isError) throw new Error(JSON.stringify(result));
	return JSON.parse(getMessageText(result));
}
function notices(session: AgentSession) {
	return session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_COMMAND_NOTICE);
}

describe("session-owned background completion", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	const roots: string[] = [];
	async function harness(options: HarnessOptions = {}) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-session-")));
		roots.push(root);
		const h = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			sessionManager: SessionManager.create(root, join(root, "sessions")),
			...options,
		});
		harnesses.push(h);
		return h;
	}
	function held(h: Harness) {
		const release = join(h.tempDir, "release");
		return {
			release,
			command: `while [ ! -f ${quote(release)} ]; do sleep 0.02; done; printf 'background result\\n'; exit 7`,
		};
	}
	async function finish(h: Harness, job: BackgroundCommandJob, release: string) {
		writeFileSync(release, "go");
		await until(() =>
			backgroundCommandFinished(readBackgroundCommand(backgroundCommandDirectory(h.sessionManager), job.id)),
		);
	}
	afterEach(async () => {
		// Faux callbacks surface thrown assertions as provider errors; fail the test after cleanup.
		const failures = [...sessions, ...harnesses.map((h) => h.session)].flatMap((session) =>
			session.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === "error" &&
					entry.message.errorMessage !== "503 Service Unavailable"
						? [entry.message.errorMessage]
						: [],
				),
		);
		for (const session of sessions.splice(0)) session.dispose();
		for (const h of harnesses.splice(0)) {
			h.session.dispose();
			for (const job of listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))) {
				if (!backgroundCommandFinished(job))
					await cancelBackgroundCommand(backgroundCommandDirectory(h.sessionManager), job.id);
			}
			h.cleanup();
			unregisterApiProviders(h.faux.api);
		}
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
		expect(failures).toEqual([]);
	});

	it("delivers after the whole foreground batch without extension binding", async () => {
		const h = await harness();
		const { release, command } = held(h);
		expect(h.session.getActiveToolNames()).toContain("background_command");
		expect(h.session.getAllTools().find((tool) => tool.name === "background_command")?.sourceInfo.source).toBe(
			"builtin",
		);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			async (context) => {
				const job = jobFrom(context.messages);
				expect(job.status).toBe("running");
				await finish(h, job, release);
				return fauxAssistantMessage(
					[fauxToolCall("bash", { command: "printf first" }), fauxToolCall("bash", { command: "printf second" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const notice = context.messages.findIndex(
					(message) => message.role === "user" && JSON.stringify(message).includes("Background commands finished"),
				);
				expect(notice).toBeGreaterThan(2);
				expect(context.messages.slice(notice - 2, notice).map((message) => message.role)).toEqual([
					"toolResult",
					"toolResult",
				]);
				expect(getMessageText(context.messages[notice])).toContain('"exitCode": 7');
				return fauxAssistantMessage("Completion consumed");
			},
		]);
		await h.session.prompt("Run a long check");
		expect(h.faux.state.callCount).toBe(3);
		expect(notices(h.session)).toHaveLength(1);
		await h.session.reload();
		await delay(1100);
		expect(notices(h.session)).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(3);
	});

	it("lets user steering run before a completed command", async () => {
		const h = await harness();
		const { release, command } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			async (context) => {
				await finish(h, jobFrom(context.messages), release);
				await h.session.steer("User amendment");
				return fauxAssistantMessage(fauxToolCall("bash", { command: "printf first" }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("User amendment");
				expect(notices(h.session)).toHaveLength(0);
				return fauxAssistantMessage(fauxToolCall("bash", { command: "printf amendment" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("Background commands finished");
				return fauxAssistantMessage("Done");
			},
		]);
		await h.session.prompt("Start");
		expect(h.faux.state.callCount).toBe(4);
	});

	it("delivers later jobs at tool boundaries inside an idle completion wakeup", async () => {
		const h = await harness();
		const first = held(h);
		const secondRelease = join(h.tempDir, "second-release");
		const secondCommand = `while [ ! -f ${quote(secondRelease)} ]; do sleep 0.02; done; printf 'second completion\\n'`;
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("background_command", { action: "start", command: first.command }),
					fauxToolCall("background_command", { action: "start", command: secondCommand }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Launched both jobs"),
			async () => {
				const second = listBackgroundCommands(backgroundCommandDirectory(h.sessionManager)).find(
					(job) => job.command === secondCommand,
				)!;
				await finish(h, second, secondRelease);
				return fauxAssistantMessage(fauxToolCall("bash", { command: "printf foreground" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(notices(h.session)).toHaveLength(2);
				expect(JSON.stringify(context.messages.at(-1))).toContain("second completion");
				return fauxAssistantMessage("Both consumed");
			},
		]);
		await h.session.prompt("Start");
		const firstJob = listBackgroundCommands(backgroundCommandDirectory(h.sessionManager)).find(
			(job) => job.command === first.command,
		)!;
		await finish(h, firstJob, first.release);
		await until(() => h.faux.state.callCount === 4 && h.session.isIdle);
		expect(notices(h.session)).toHaveLength(2);
	});

	it("plain SDK resume discovers existing work without replay or widening saved tools", async () => {
		const oldTools = ["read", "bash", "edit", "write"];
		const h = await harness({ initialActiveToolNames: oldTools });
		h.setResponses([fauxAssistantMessage("Saved before the tool was enabled")]);
		await h.session.prompt("Seed");
		const { release, command } = held(h);
		const job = await startBackgroundCommand(backgroundCommandDirectory(h.sessionManager), command, {
			command,
			cwd: h.tempDir,
			env: getShellEnv(),
		});
		h.session.dispose();
		await finish(h, job, release);
		h.setResponses([fauxAssistantMessage("Recovered completion")]);
		const { session } = await createAgentSession({
			sessionManager: SessionManager.open(h.session.sessionFile!),
			modelRuntime: h.session.modelRuntime,
			model: h.getModel(),
			settingsManager: h.settingsManager,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		await until(() => notices(session).length === 1 && session.isIdle);
		expect(h.faux.state.callCount).toBe(2); // One seed response and one completion response.
		expect(session.getActiveToolNames()).toEqual(oldTools);
		expect(readBackgroundCommand(backgroundCommandDirectory(session.sessionManager), job.id).pid).toBe(job.pid);
		expect(listBackgroundCommands(backgroundCommandDirectory(session.sessionManager))).toHaveLength(1);
	});

	it.each(["status", "activeOnly"])(
		"terminal %s acknowledgement does not swallow a later completion",
		async (selection) => {
			const h = await harness();
			const { release, command } = held(h);
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("background_command", { action: "status", activeOnly: true }), {
					stopReason: "toolUse",
				}),
				async () => {
					const job = listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))[0];
					await finish(h, job, release);
					return fauxAssistantMessage(
						fauxToolCall("background_command", { action: "status", activeOnly: selection === "activeOnly" }),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("Done"),
			]);
			await h.session.prompt("Start");
			await delay(1100);
			expect(notices(h.session)).toHaveLength(selection === "status" ? 0 : 1);
			expect(h.faux.state.callCount).toBe(4);
		},
	);

	it.each(["agent", "retry", "boundary"])(
		"persists %s cancellation across reload and resume without waking",
		async (phase) => {
			const h = await harness({
				settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
			});
			const { release, command } = held(h);
			let queuedAtCancellation = 0;
			if (phase === "boundary")
				h.session.subscribe((event) => {
					if (event.type === "turn_end" && h.faux.state.callCount === 2) {
						queuedAtCancellation = h.session.pendingCustomMessageCount;
						void h.session.abort();
					}
				});
			if (phase === "retry")
				h.session.subscribe((event) => {
					if (event.type === "auto_retry_start") void h.session.abort();
				});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
					stopReason: "toolUse",
				}),
				async (context) => {
					if (phase === "boundary") await finish(h, jobFrom(context.messages), release);
					if (phase === "agent") void h.session.abort();
					return phase === "retry"
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" })
						: fauxAssistantMessage("Cancelled");
				},
			]);
			await h.session.prompt("Start");
			if (phase === "boundary") expect(queuedAtCancellation).toBe(1);
			expect(h.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ type: "custom", customType: BACKGROUND_COMMAND_RUN_STATE, data: true }),
			);
			const provider = getApiProvider(h.faux.api)!;
			await h.session.reload();
			registerApiProvider(provider, h.faux.api);
			h.session.dispose();
			const { session } = await createAgentSession({
				sessionManager: SessionManager.open(h.session.sessionFile!),
				modelRuntime: h.session.modelRuntime,
				model: h.getModel(),
				settingsManager: h.settingsManager,
				resourceLoader: createTestResourceLoader(),
			});
			sessions.push(session);
			const job = listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))[0];
			await finish(h, job, release);
			await until(() => notices(session).length === 1);
			expect(h.faux.state.callCount).toBe(2);
			h.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("Background commands finished");
					expect(JSON.stringify(context.messages.at(-1))).toContain("Continue");
					return fauxAssistantMessage("Continued by user");
				},
			]);
			await session.prompt("Continue");
			expect(notices(session)).toHaveLength(1);
		},
	);

	it.each(["print", "rpc"] as const)(
		"defers %s resume until mode binding and queued startup input is consumed",
		async (mode) => {
			const h = await harness();
			const { release, command } = held(h);
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Launched"),
			]);
			await h.session.prompt("Start");
			h.session.dispose();
			const job = listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))[0];
			await finish(h, job, release);
			const { session } = await createAgentSession({
				sessionManager: SessionManager.open(h.session.sessionFile!),
				modelRuntime: h.session.modelRuntime,
				model: h.getModel(),
				settingsManager: h.settingsManager,
				resourceLoader: createTestResourceLoader(),
				deferBackgroundCommandNotifications: true,
			});
			sessions.push(session);
			await delay(1100);
			expect(notices(session)).toHaveLength(0);
			let queued = 1;
			await session.bindExtensions({ mode, getQueuedInputCount: () => queued });
			await delay(1100);
			expect(notices(session)).toHaveLength(0);
			h.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages.at(-1))).toContain("Startup input");
					expect(notices(session)).toHaveLength(0);
					return fauxAssistantMessage("Startup consumed");
				},
				fauxAssistantMessage("Completion consumed"),
			]);
			queued--;
			await session.prompt("Startup input");
			expect(notices(session)).toHaveLength(1);
		},
	);

	it.each(["text", "json"] as const)("native %s print consumes startup input before completions", async (mode) => {
		const h = await harness();
		const { command, release } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			async (context) => {
				await finish(h, jobFrom(context.messages), release);
				return fauxAssistantMessage("First prompt done");
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("Second prompt");
				expect(notices(h.session)).toHaveLength(0);
				return fauxAssistantMessage("Second prompt done");
			},
			fauxAssistantMessage("Completion consumed"),
		]);
		const runtime = new AgentSessionRuntime(
			h.session,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.session.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("Session replacement was not requested");
			},
		);
		const output: string[] = [];
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(
				(
					chunk: string | Uint8Array,
					encoding?: BufferEncoding | ((error?: Error | null) => void),
					callback?: (error?: Error | null) => void,
				) => {
					output.push(String(chunk));
					if (typeof encoding === "function") encoding();
					else callback?.();
					return true;
				},
			);
		try {
			expect(
				await runPrintMode(runtime, { mode, initialMessage: "First prompt", messages: ["Second prompt"] }),
			).toBe(0);
		} finally {
			stdout.mockRestore();
		}
		expect(output.join("")).toContain("Completion consumed");
		expect(h.faux.state.callCount).toBe(4);
		expect(notices(h.session)).toHaveLength(1);
	});

	it("waits for user Bash and includes its persisted result in the idle wakeup", async () => {
		const h = await harness();
		const { release, command } = held(h);
		const bashRelease = join(h.tempDir, "bash-release");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Launched"),
			(context) => {
				expect(h.session.isBashRunning).toBe(false);
				expect(JSON.stringify(context.messages)).toContain("User shell result");
				return fauxAssistantMessage("Completion consumed");
			},
		]);
		await h.session.prompt("Start");
		const bash = h.session.executeBash(
			`while [ ! -f ${quote(bashRelease)} ]; do sleep 0.02; done; printf 'User shell result'`,
		);
		await finish(h, listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))[0], release);
		await delay(1100);
		expect(notices(h.session)).toHaveLength(0);
		writeFileSync(bashRelease, "go");
		await bash;
		await until(() => notices(h.session).length === 1 && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(3);
	});

	it("pauses native notifications while checkpoint-held and waits for input after checkpoint restore", async () => {
		const h = await harness();
		const { release, command } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Launched"),
		]);
		await h.session.prompt("Start");
		const hold = await h.session.acquireCheckpoint({ quiesce: () => () => {} });
		const revision = h.sessionManager.getEntriesRevision();
		await finish(h, listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))[0], release);
		await delay(1100);
		expect(hold.sleepBlockers.some((reason) => reason.includes("background"))).toBe(false);
		expect(h.sessionManager.getEntriesRevision()).toBe(revision);
		hold.release();
		h.session.dispose();
		const { session } = await createAgentSession({
			checkpoint: hold.checkpoint,
			modelRuntime: h.session.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		await delay(1100);
		expect(notices(session)).toHaveLength(0);
		h.setResponses([fauxAssistantMessage("User resumed"), fauxAssistantMessage("Completion consumed")]);
		await session.prompt("Continue");
		expect(notices(session)).toHaveLength(1);
	});

	it("uses effective settings, native cwd hooks, and current Bash metadata", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-settings-")));
		roots.push(root);
		const selected = join(root, "selected");
		mkdirSync(selected);
		const shell = join(root, "shell");
		writeFileSync(shell, '#!/bin/sh\nexport BACKGROUND_SHELL=effective\nexec /bin/bash "$@"\n', { mode: 0o755 });
		const h = await harness({
			settingsManager: SettingsManager.inMemory({
				shellPath: shell,
				shellCommandPrefix: "export BACKGROUND_PREFIX=effective",
				compaction: { enabled: false },
			}),
			extensionFactories: [(pi) => pi.registerBashCwdHook(() => selected)],
		});
		const session = h.session;
		const command =
			'pwd; printf \'%s %s %s %s\' "$BACKGROUND_SHELL" "$BACKGROUND_PREFIX" "$PI_SESSION_ID" "$PI_MODEL"';
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			async (context) => {
				const job = jobFrom(context.messages);
				await until(() =>
					backgroundCommandFinished(readBackgroundCommand(backgroundCommandDirectory(h.sessionManager), job.id)),
				);
				expect(readFileSync(job.logFile, "utf8")).toBe(
					`${selected}\neffective effective ${session.sessionId} ${h.getModel().id}`,
				);
				return fauxAssistantMessage(fauxToolCall("background_command", { action: "status", id: job.id }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Done"),
		]);
		await session.prompt("Start");
	});
});
