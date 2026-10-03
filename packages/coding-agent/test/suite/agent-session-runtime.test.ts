import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { createInterface } from "node:readline";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkingSessionControl } from "../../src/cli/working-session-control.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { readWorkingSession } from "../../src/core/working-session.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: { cwd?: string; bootstrapModel?: boolean; bootstrapThinkingLevel?: boolean },
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	it.skipIf(process.platform === "win32")(
		"owns socket tokens, frozen guard, EOF, replacement and final control cleanup",
		async () => {
			const { runtime } = await createRuntimeForTest(() => {});
			const root = realpathSync(mkdtempSync("/tmp/pi-native-"));
			const socketPath = join(root, "native.sock");
			const statePath = join(root, "state.json");
			vi.stubEnv("PI_WORKING_SESSION_SOCKET", socketPath);
			vi.stubEnv("PI_WORKING_SESSION_EXIT_PATH", "");
			const close = await startWorkingSessionControl(runtime);
			try {
				const socket = createConnection(socketPath);
				const reader = createInterface({ input: socket });
				const replies = reader[Symbol.asyncIterator]();
				const read = async () => JSON.parse((await replies.next()).value!) as Record<string, unknown>;
				socket.write(`${JSON.stringify({ action: "acquire", path: statePath, boundary: "settled" })}\n`);
				const granted = await read();
				expect(granted).toMatchObject({
					ok: true,
					pid: process.pid,
					sleepReady: true,
					guardPath: `${socketPath}.guard`,
				});
				const guard = () => JSON.parse(readFileSync(`${socketPath}.guard`, "utf8")) as Record<string, unknown>;
				expect(guard()).toMatchObject({
					version: 1,
					token: granted.token,
					worker: granted.worker,
					pid: process.pid,
					valid: true,
				});
				expect(readWorkingSession(statePath).header.id).toBe(runtime.session.sessionId);
				socket.write(`${JSON.stringify({ action: "release", token: "wrong-token" })}\n`);
				expect(await read()).toMatchObject({ ok: false });
				expect(runtime.session.workingSessionGate.reserved).toBe(true);
				expect(() => runtime.session.settingsManager.setShellCommandPrefix("refused")).toThrow("reserved");
				// Read synchronously, without waiting for the socket invalidation notification.
				expect(guard()).toMatchObject({ token: granted.token, valid: false });
				expect(await read()).toMatchObject({ invalidated: true, token: granted.token });
				socket.destroy();
				reader.close();
				await vi.waitFor(() => expect(runtime.session.workingSessionGate.reserved).toBe(false));
				const oldId = runtime.session.sessionId;
				await runtime.newSession();
				expect(runtime.session.sessionId).not.toBe(oldId);
				const current = createConnection(socketPath);
				const currentReader = createInterface({ input: current });
				const currentReplies = currentReader[Symbol.asyncIterator]();
				current.write(`${JSON.stringify({ action: "acquire", path: statePath, boundary: "settled" })}\n`);
				const currentHold = JSON.parse((await currentReplies.next()).value!);
				expect(currentHold.ok).toBe(true);
				expect(readWorkingSession(statePath).header.id).toBe(runtime.session.sessionId);
				current.write(`${JSON.stringify({ action: "release", token: currentHold.token })}\n`);
				expect(JSON.parse((await currentReplies.next()).value!)).toEqual({ ok: true });
				expect(JSON.parse(readFileSync(`${socketPath}.guard`, "utf8"))).toMatchObject({
					valid: false,
					reason: "released",
				});
				current.destroy();
				currentReader.close();
				await vi.waitFor(() => expect(runtime.session.workingSessionGate.reserved).toBe(false));
				await runtime.dispose();
				expect(existsSync(socketPath)).toBe(false);
				expect(existsSync(`${socketPath}.guard`)).toBe(false);
			} finally {
				await close?.();
				vi.unstubAllEnvs();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("produces current-worker completion evidence only after strict shutdown and full native save", async () => {
		let shutdowns = 0;
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_shutdown", () => {
				shutdowns++;
			});
			pi.on("working_session_save", (event) => {
				event.appendEntry("final-owner-state", { shutdowns });
			});
		});
		await runtime.session.prompt("completed conversation");
		await runtime.session.steer("accepted tail");
		const sessionId = runtime.session.sessionId;
		const exitPath = join(realpathSync(tempDir), "completed.json");
		const messages: unknown[] = [];
		const descriptors = {
			send: Object.getOwnPropertyDescriptor(process, "send"),
			connected: Object.getOwnPropertyDescriptor(process, "connected"),
		};
		// Only adapt IPC transport; the native producer must generate the state and receipt.
		Object.defineProperty(process, "connected", { configurable: true, value: true });
		Object.defineProperty(process, "send", {
			configurable: true,
			value: (message: unknown, done: (error: Error | null) => void) => {
				messages.push(message);
				done(null);
				return true;
			},
		});
		vi.stubEnv("PI_WORKING_SESSION_SOCKET", "");
		vi.stubEnv("PI_WORKING_SESSION_EXIT_PATH", exitPath);
		vi.stubEnv("PI_WORKING_SESSION_LAUNCH", "current-launch");
		vi.stubEnv("PI_WORKING_SESSION_WORKER", "current-worker");
		let close: (() => Promise<void>) | undefined;
		try {
			close = await startWorkingSessionControl(runtime);
			await runtime.dispose();
			const statePath = `${exitPath}.state`;
			const state = readWorkingSession(statePath);
			expect(state.header.id).toBe(sessionId);
			expect(state.steeringText).toEqual(["accepted tail"]);
			expect(state.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ customType: "final-owner-state", data: { shutdowns: 1 } }),
				]),
			);
			expect(messages).toEqual([
				{
					type: "pi:completed",
					completed: {
						path: statePath,
						digest: createHash("sha256").update(readFileSync(statePath)).digest("hex"),
						sessionId,
						pid: process.pid,
						worker: "current-worker",
						launch: "current-launch",
					},
				},
			]);
			// The whole launcher, not a worker, owns the final attestation file.
			expect(existsSync(exitPath)).toBe(false);
		} finally {
			await close?.();
			vi.unstubAllEnvs();
			for (const key of ["send", "connected"] as const) {
				const descriptor = descriptors[key];
				if (descriptor) Object.defineProperty(process, key, descriptor);
				else Reflect.deleteProperty(process, key);
			}
		}
	});

	it.each([false, true])(
		"ordinary restart finalization retains native shutdown error handling; unready=%s",
		async (unready) => {
			const { runtime } = await createRuntimeForTest((pi) => {
				pi.on("session_shutdown", () => {
					throw new Error("ordinary shutdown error");
				});
			});
			if (unready) runtime.session.setWorkingSessionReady(false);
			vi.stubEnv("PI_WORKING_SESSION_SOCKET", "");
			vi.stubEnv("PI_WORKING_SESSION_EXIT_PATH", "");
			const finalized = vi.fn(async () => false);
			try {
				await startWorkingSessionControl(runtime, finalized);
				await expect(runtime.dispose()).resolves.toBeUndefined();
				expect(finalized).toHaveBeenCalledOnce();
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);

	it("does not await readiness or certify an unready final exit", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		runtime.session.setWorkingSessionReady(false);
		const exitPath = join(realpathSync(tempDir), "unready-exit.json");
		vi.stubEnv("PI_WORKING_SESSION_SOCKET", "");
		vi.stubEnv("PI_WORKING_SESSION_EXIT_PATH", exitPath);
		try {
			await startWorkingSessionControl(runtime);
			let finished = false;
			const disposing = runtime
				.dispose()
				.then(() => {
					finished = true;
				})
				.catch(() => {});
			await new Promise<void>((resolve) => setImmediate(resolve));
			const observed = finished;
			await runtime.session.cancelWorkingSession("test cleanup");
			await disposing;
			expect(observed).toBe(true);
			expect(existsSync(`${exitPath}.state`)).toBe(false);
		} finally {
			await runtime.session.cancelWorkingSession("test cleanup");
			vi.unstubAllEnvs();
		}
	});

	it.each(["blocker", "save failure", "shutdown failure"])(
		"withholds completed-exit evidence for %s",
		async (scenario) => {
			let failing = true;
			let veto = scenario === "blocker";
			const { runtime, tempDir } = await createRuntimeForTest((pi) => {
				pi.on("session_shutdown", () => {
					if (failing && scenario === "shutdown failure") throw new Error("shutdown persistence failed");
				});
				pi.on("working_session_save", () => {
					if (failing && scenario === "save failure") throw new Error("save persistence failed");
					return { blockers: veto ? ["Independent native owner still running"] : [] };
				});
			});
			const exitPath = join(realpathSync(tempDir), "completed.json");
			vi.stubEnv("PI_WORKING_SESSION_SOCKET", "");
			vi.stubEnv("PI_WORKING_SESSION_EXIT_PATH", exitPath);
			const close = await startWorkingSessionControl(runtime);
			try {
				if (scenario === "blocker") await runtime.dispose();
				else
					await expect(runtime.dispose()).rejects.toThrow(
						scenario === "save failure" ? "save persistence failed" : "shutdown persistence failed",
					);
				expect(existsSync(exitPath)).toBe(false);
				expect(existsSync(`${exitPath}.state`)).toBe(false);
			} finally {
				failing = false;
				veto = true;
				await close?.();
				vi.unstubAllEnvs();
			}
		},
	);

	it("pauses remaining print inputs under a settled save instead of dequeuing or failing them", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		let finish!: () => void;
		const response = new Promise<void>((resolve) => {
			finish = resolve;
		});
		faux.setResponses([
			async () => {
				await response;
				return fauxAssistantMessage("first complete");
			},
			fauxAssistantMessage("second complete"),
		]);
		const run = runPrintMode(runtime, { mode: "json", messages: ["first input", "second input"] });
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const acquisition = runtime.session.acquireWorkingSession();
		finish();
		const hold = await acquisition;
		expect(hold.sleepReady).toBe(true);
		expect(hold.state.mode).toEqual({ kind: "json", data: [{ text: "second input" }] });
		expect(faux.state.callCount).toBe(1);
		await hold.release();
		expect(await run).toBe(0);
		expect(faux.state.callCount).toBe(2);
	});

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("settles the active response before session replacement", async () => {
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						toolStarted();
						signal?.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						);
					}),
			});
		});

		await runtime.session.prompt("hello");
		const firstSessionFile = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const outgoingSession = runtime.session;
		const promptPromise = outgoingSession.prompt("start blocking tool");
		await toolStartedPromise;

		const switchResult = await runtime.switchSession(firstSessionFile);
		await promptPromise;

		expect(switchResult.cancelled).toBe(false);
		expect(runtime.session.sessionFile).toBe(firstSessionFile);
		// The outgoing session settled before replacement: the interrupted tool
		// call has a persisted tool result instead of dangling forever.
		const outgoingEntries = SessionManager.open(outgoingSession.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "message");
		expect(outgoingEntries.map((entry) => entry.message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("preserves an existing session when importing a file with the same name", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const importDir = join(tempDir, "import");
		const filename = "collision.jsonl";
		const storedPath = join(sessionDir, filename);
		const importPath = join(importDir, filename);
		const storedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "stored",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		const importedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "imported",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(importDir, { recursive: true });
		writeFileSync(storedPath, storedSession);
		writeFileSync(importPath, importedSession);

		await runtime.importFromJsonl(importPath);

		expect(readFileSync(storedPath, "utf8")).toBe(storedSession);
		expect(runtime.session.sessionFile).not.toBe(storedPath);
		expect(readFileSync(runtime.session.sessionFile!, "utf8")).toContain('"id":"imported"');
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("reports why an unflushed session cannot be forked", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);
		expect(leafId).toBeTruthy();

		await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(
			"This session has not been saved yet. Send a message before cloning or forking it.",
		);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
