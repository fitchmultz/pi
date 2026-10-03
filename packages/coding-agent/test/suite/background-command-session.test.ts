import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import backgroundCommand, { BACKGROUND_COMMAND_NOTICE } from "../../src/extensions/background-command/index.ts";
import {
	type BackgroundCommandJob,
	backgroundCommandDirectory,
	backgroundCommandFinished,
	cancelBackgroundCommand,
	listBackgroundCommands,
	readBackgroundCommand,
	startBackgroundCommand,
} from "../../src/extensions/background-command/jobs.ts";
import { getShellEnv } from "../../src/utils/shell.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
async function until(condition: () => boolean) {
	for (let i = 0; i < 240; i++) {
		if (condition()) return;
		await delay(25);
	}
	throw new Error("Timed out waiting for background completion");
}
const notices = (h: Harness) =>
	h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === BACKGROUND_COMMAND_NOTICE);
const jobFrom = (h: Harness) =>
	JSON.parse(getMessageText(getToolResult(h, "background_command"))) as BackgroundCommandJob;

describe("background command extension delivery", () => {
	const harnesses: Harness[] = [];
	const roots: string[] = [];
	async function harness(owner?: SessionManager, extensions: NonNullable<HarnessOptions["extensionFactories"]> = []) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-background-session-")));
		roots.push(root);
		const h = await createHarness({
			extensionFactories: [backgroundCommand, ...extensions],
			sessionManager: owner ?? SessionManager.create(root, join(root, "sessions")),
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		await h.session.bindExtensions({ mode: "rpc" });
		return h;
	}
	async function finish(h: Harness, release: string) {
		writeFileSync(release, "go");
		await until(() =>
			backgroundCommandFinished(readBackgroundCommand(backgroundCommandDirectory(h.sessionManager), jobFrom(h).id)),
		);
	}
	const held = (h: Harness, suffix = "") => {
		const release = join(h.tempDir, `release${suffix}`);
		return {
			release,
			command: `while [ ! -f ${quote(release)} ]; do sleep 0.02; done; printf 'background result\\n'; exit 7`,
		};
	};
	afterEach(async () => {
		const failures = harnesses.flatMap((h) =>
			h.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
		);
		for (const h of harnesses.splice(0)) {
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			for (const job of listBackgroundCommands(backgroundCommandDirectory(h.sessionManager)))
				if (!backgroundCommandFinished(job))
					await cancelBackgroundCommand(backgroundCommandDirectory(h.sessionManager), job.id);
			h.cleanup();
		}
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		expect(failures).toEqual([]);
	});

	it("reads the journal once per delivery lease, not on later turns or idle writes", async () => {
		const h = await harness();
		h.sessionManager.appendCustomEntry("large-history", "history ".repeat(16_384));
		const read = vi.spyOn(fs, "readFileSync");
		syncBuiltinESMExports();
		const reads = () => read.mock.calls.filter(([file]) => file === h.sessionManager.getSessionFile()).length;
		const { command, release } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Launched"),
		]);
		await h.session.prompt("Start");
		expect(reads()).toBe(1);
		h.sessionManager.appendCustomEntry("unrelated", { value: true });
		await delay(1100);
		h.setResponses([fauxAssistantMessage("Another turn")]);
		await h.session.prompt("Continue");
		expect(reads()).toBe(1);
		h.setResponses([fauxAssistantMessage("Completion consumed")]);
		await finish(h, release);
		await until(() => notices(h).length === 1 && h.session.isIdle);
		expect(reads()).toBe(1);
	});
	it("delivers after the whole foreground batch, once across reload", async () => {
		const h = await harness();
		const { command, release } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			async () => {
				expect(jobFrom(h).cwd).toBe(h.tempDir);
				await finish(h, release);
				return fauxAssistantMessage(
					[fauxToolCall("bash", { command: "printf first" }), fauxToolCall("bash", { command: "printf second" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const index = context.messages.findIndex((message) =>
					getMessageText(message).startsWith("Background commands finished:"),
				);
				expect(context.messages.slice(index - 2, index).map((message) => message.role)).toEqual([
					"toolResult",
					"toolResult",
				]);
				expect(getMessageText(context.messages[index])).toContain('"exitCode":7');
				return fauxAssistantMessage("Consumed");
			},
		]);
		await h.session.prompt("Start");
		expect(h.faux.state.callCount).toBe(3);
		expect(notices(h)).toHaveLength(1);
		await h.session.reload();
		await delay(1100);
		expect(notices(h)).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(3);
	});
	it.each([
		{ name: "success", exitCode: 0, output: "successful output\n".repeat(200) },
		{ name: "failure lines", exitCode: 7, output: "diagnostic line\n".repeat(200) },
		{ name: "failure bytes", exitCode: 7, output: `${"😀".repeat(5000)}\n` },
	])("keeps automatic $name compact and raw logs intact", async ({ exitCode, output }) => {
		const h = await harness();
		const release = join(h.tempDir, "release");
		const source = join(h.tempDir, "output");
		writeFileSync(source, output);
		const command = `while [ ! -f ${quote(release)} ]; do sleep 0.02; done; cat ${quote(source)}; exit ${exitCode}`;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			async () => {
				await finish(h, release);
				return fauxAssistantMessage(fauxToolCall("bash", { command: "printf foreground" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const text = getMessageText(context.messages.at(-1));
				expect(text).toMatch(/^Background commands finished:\n/);
				const [summary, excerpt] = text.slice("Background commands finished:\n".length).split("\nOutput tail:\n");
				const job = jobFrom(h);
				expect(JSON.parse(summary)).toEqual({
					id: job.id,
					status: exitCode === 0 ? "succeeded" : "failed",
					exitCode,
					commandPreview: command.slice(0, 160),
					logFile: job.logFile,
				});
				if (exitCode === 0) expect(excerpt).toBeUndefined();
				else {
					expect(excerpt.length).toBeGreaterThan(0);
					expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(2048);
					expect(excerpt.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
					expect(excerpt).not.toContain("\uFFFD");
					expect(output.trimEnd().endsWith(excerpt.trimEnd())).toBe(true);
				}
				expect(readFileSync(job.logFile, "utf8")).toBe(output);
				return fauxAssistantMessage("Consumed");
			},
		]);
		await h.session.prompt("Start");
		expect(notices(h)).toHaveLength(1);
	});
	it("wakes an idle session and resumes finished work without replay or duplicate delivery", async () => {
		const h = await harness();
		const { command, release } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Launched"),
			fauxAssistantMessage("Idle completion consumed"),
		]);
		await h.session.prompt("Start");
		await finish(h, release);
		await until(() => notices(h).length === 1 && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(3);
		const second = held(h, "second");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: second.command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Launched second"),
		]);
		await h.session.prompt("Another");
		const job = jobFrom(h);
		h.session.dispose();
		writeFileSync(second.release, "go");
		const root = backgroundCommandDirectory(h.sessionManager);
		await until(() => backgroundCommandFinished(readBackgroundCommand(root, job.id)));
		const resumed = await harness(SessionManager.open(h.sessionManager.getSessionFile()!));
		resumed.setResponses([fauxAssistantMessage("Recovered completion")]);
		await until(() => notices(resumed).length === 2 && resumed.session.isIdle);
		expect(resumed.faux.state.callCount).toBe(1);
		expect(readBackgroundCommand(root, job.id).pid).toBe(job.pid);
		expect(listBackgroundCommands(root)).toHaveLength(2);
		const other = await harness(SessionManager.open(h.sessionManager.getSessionFile()!));
		await delay(1100);
		expect(other.faux.state.callCount).toBe(0);
		expect(notices(other)).toHaveLength(2);
	});
	it("retains compute for an idle detached job and pauses completion delivery until save release", async () => {
		const h = await harness();
		const { command, release } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Launched"),
			fauxAssistantMessage("Completion consumed after release"),
		]);
		await h.session.prompt("Start");
		const hold = await h.session.acquireWorkingSession();
		expect(hold.sleepReady).toBe(false);
		expect(hold.blockers).toEqual(
			expect.arrayContaining([expect.stringMatching(/Background command .* is (starting|running)/)]),
		);
		await finish(h, release);
		await delay(1100);
		expect(notices(h)).toHaveLength(0);
		expect(h.faux.state.callCount).toBe(2);
		expect(hold.invalidated.aborted).toBe(false);
		await hold.release();
		await until(() => notices(h).length === 1 && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(3);
	});
	it("retains completions after agent cancellation without waking until user input", async () => {
		const h = await harness();
		const { command, release } = held(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command }), {
				stopReason: "toolUse",
			}),
			async () => {
				void h.session.abort();
				return fauxAssistantMessage("Cancelled");
			},
		]);
		await h.session.prompt("Start");
		await finish(h, release);
		await until(() => notices(h).length === 1);
		expect(h.faux.state.callCount).toBe(2);
		h.setResponses([fauxAssistantMessage("Continued")]);
		await h.session.prompt("Continue");
		expect(notices(h)).toHaveLength(1);
	});
	it.skipIf(process.platform === "win32")(
		"uses effective shell settings, relative cwd, and session metadata",
		async () => {
			const h = await harness();
			const shell = join(h.tempDir, "shell");
			writeFileSync(shell, '#!/bin/sh\nexport BACKGROUND_SHELL=effective\nexec /bin/bash "$@"\n', { mode: 0o755 });
			mkdirSync(join(h.tempDir, "child"));
			h.settingsManager.setShellPath(shell);
			h.settingsManager.setShellCommandPrefix("export BACKGROUND_PREFIX=effective");
			h.setResponses([
				fauxAssistantMessage(
					fauxToolCall("background_command", {
						action: "start",
						cwd: "child",
						command:
							'pwd; printf "%s %s %s %s" "$BACKGROUND_SHELL" "$BACKGROUND_PREFIX" "$PI_SESSION_ID" "$PI_MODEL"',
					}),
					{ stopReason: "toolUse" },
				),
				async () => {
					const job = jobFrom(h);
					await until(() =>
						backgroundCommandFinished(
							readBackgroundCommand(backgroundCommandDirectory(h.sessionManager), job.id),
						),
					);
					expect(readFileSync(job.logFile, "utf8")).toBe(
						`${realpathSync(join(h.tempDir, "child"))}\neffective effective ${h.sessionManager.getSessionId()} ${h.getModel().id}`,
					);
					return fauxAssistantMessage(fauxToolCall("background_command", { action: "status", id: job.id }), {
						stopReason: "toolUse",
					});
				},
				fauxAssistantMessage("Inspected"),
			]);
			await h.session.prompt("Start");
			expect(notices(h)).toHaveLength(0);
		},
	);
	it("captures the directory owner's reply before awaiting worker admission", async () => {
		let manager: ExtensionContext["sessionManager"] | undefined;
		let current = "";
		let directoryA = "";
		let directoryB = "";
		let switched = false;
		const owner: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				manager = ctx.sessionManager;
				directoryA = join(ctx.cwd, "A");
				directoryB = join(ctx.cwd, "B");
				mkdirSync(join(directoryA, "child"), { recursive: true });
				mkdirSync(directoryB);
				current = directoryA;
			});
			pi.events.on("pi-change-working-dir:resolve-execution-cwd", (value) => {
				const request = value as { sessionManager: ExtensionContext["sessionManager"]; result?: unknown };
				if (request.sessionManager !== manager) return;
				request.result = { cwd: current };
				if (!switched) {
					switched = true;
					queueMicrotask(() => {
						current = directoryB;
					});
				}
			});
		};
		const h = await harness(undefined, [owner]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: "pwd", cwd: "child" }), {
				stopReason: "toolUse",
			}),
			async () => {
				const job = jobFrom(h);
				expect(current).toBe(directoryB);
				expect(job.cwd).toBe(join(directoryA, "child"));
				await until(() =>
					backgroundCommandFinished(readBackgroundCommand(backgroundCommandDirectory(h.sessionManager), job.id)),
				);
				expect(readFileSync(job.logFile, "utf8")).toBe(`${realpathSync(join(directoryA, "child"))}\n`);
				return fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: "pwd" }), {
					stopReason: "toolUse",
				});
			},
			async () => {
				const job = jobFrom(h);
				expect(job.cwd).toBe(directoryB);
				await until(() =>
					backgroundCommandFinished(readBackgroundCommand(backgroundCommandDirectory(h.sessionManager), job.id)),
				);
				expect(readFileSync(job.logFile, "utf8")).toBe(`${realpathSync(directoryB)}\n`);
				return fauxAssistantMessage(fauxToolCall("background_command", { action: "status", id: job.id }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Inspected"),
		]);
		await h.session.prompt("Start in the owner's directory");
	});
	it.each([
		{ result: { error: "Selected directory is unavailable" }, message: "Selected directory is unavailable" },
		{ result: { cwd: "/unused", error: 42 }, message: "invalid execution directory" },
		{ result: { cwd: "relative" }, message: "invalid execution directory" },
		{ result: { cwd: "/nul\0" }, message: "invalid execution directory" },
		{ result: null, message: "invalid execution directory" },
		{ result: [], message: "invalid execution directory" },
	])("fails closed on an invalid/error directory-owner reply: $result", async ({ result, message }) => {
		let manager: ExtensionContext["sessionManager"] | undefined;
		const owner: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				manager = ctx.sessionManager;
			});
			pi.events.on("pi-change-working-dir:resolve-execution-cwd", (value) => {
				const request = value as { sessionManager: ExtensionContext["sessionManager"]; result?: unknown };
				if (request.sessionManager === manager) request.result = result;
			});
		};
		const h = await harness(undefined, [owner]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: "pwd" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Rejected"),
		]);
		await h.session.prompt("Start");
		expect(getToolResult(h, "background_command").isError).toBe(true);
		expect(getMessageText(getToolResult(h, "background_command"))).toContain(message);
		expect(listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))).toEqual([]);
	});
	it.each([
		{ route: "tool", identifiable: true },
		{ route: "command", identifiable: true },
		{ route: "tool", identifiable: false },
		{ route: "command", identifiable: false },
	])(
		"checks silent directory-owner provenance via $route (identifiable=$identifiable)",
		async ({ route, identifiable }) => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cwd-owner-")));
			roots.push(root);
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ name: identifiable ? "pi-change-working-dir" : "unrelated-extension" }),
			);
			const owner: ExtensionFactory = (pi) => {
				if (route === "tool") {
					pi.registerTool({
						name: "change_dir",
						label: "Change directory",
						description: "Legacy directory owner",
						parameters: Type.Object({}),
						defaultActive: false,
						execute: async () => ({ content: [], details: undefined }),
					});
				} else {
					pi.registerCommand("cwd", { description: "Legacy directory owner", handler: async () => {} });
				}
			};
			const h = await harness(undefined, [{ factory: owner, path: join(root, "index.ts") }]);
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("background_command", { action: "start", command: "printf safe" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done"),
			]);
			await h.session.prompt("Start");
			const result = getToolResult(h, "background_command");
			expect(result.isError).toBe(identifiable);
			if (identifiable) {
				expect(getMessageText(result)).toContain("Update pi-change-working-dir and restart Pi");
				expect(listBackgroundCommands(backgroundCommandDirectory(h.sessionManager))).toEqual([]);
			} else {
				expect(jobFrom(h).cwd).toBe(h.tempDir);
			}
		},
	);
	it("lists newest first with capped pagination and activeOnly filtering", async () => {
		const h = await harness();
		const root = backgroundCommandDirectory(h.sessionManager);
		const snapshots: { jobs: { commandPreview: string }[]; total: number; nextOffset: number | null }[] = [];
		h.setResponses([
			async () => {
				// Seed completed jobs during the run, not while idle delivery can wake the session.
				for (let i = 0; i < 23; i++) {
					const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
					const directory = join(root, id);
					mkdirSync(directory, { recursive: true });
					writeFileSync(
						join(directory, "job.json"),
						JSON.stringify({
							job: {
								id,
								command: `job ${i}`,
								cwd: h.tempDir,
								createdAt: new Date(i * 1000).toISOString(),
								logFile: join(directory, "output.log"),
								status: "succeeded",
								exitCode: 0,
							},
						}),
					);
				}
				await startBackgroundCommand(root, "sleep 600", {
					command: "sleep 600",
					cwd: h.tempDir,
					env: getShellEnv(),
				});
				return fauxAssistantMessage(fauxToolCall("background_command", { action: "status" }), {
					stopReason: "toolUse",
				});
			},
			() => {
				snapshots.push(JSON.parse(getMessageText(getToolResult(h, "background_command"))));
				return fauxAssistantMessage(fauxToolCall("background_command", { action: "status", offset: 20 }), {
					stopReason: "toolUse",
				});
			},
			() => {
				snapshots.push(JSON.parse(getMessageText(getToolResult(h, "background_command"))));
				return fauxAssistantMessage(fauxToolCall("background_command", { action: "status", activeOnly: true }), {
					stopReason: "toolUse",
				});
			},
			() => {
				snapshots.push(JSON.parse(getMessageText(getToolResult(h, "background_command"))));
				return fauxAssistantMessage("Listed");
			},
		]);
		await h.session.prompt("List");
		expect(snapshots[0]).toMatchObject({ total: 24, nextOffset: 20 });
		expect(snapshots[0].jobs.map((job) => job.commandPreview)).toEqual([
			"sleep 600",
			...Array.from({ length: 19 }, (_, i) => `job ${22 - i}`),
		]);
		expect(snapshots[1]).toMatchObject({ total: 24, nextOffset: null });
		expect(snapshots[1].jobs.map((job) => job.commandPreview)).toEqual(["job 3", "job 2", "job 1", "job 0"]);
		expect(snapshots[2]).toMatchObject({ total: 1, nextOffset: null });
		expect(snapshots[2].jobs.map((job) => job.commandPreview)).toEqual(["sleep 600"]);
	});
});
