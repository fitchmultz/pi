import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory, persist = true) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
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
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: persist
				? SessionManager.create(tempDir, join(tempDir, "sessions"))
				: SessionManager.inMemory(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
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

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it.each([
		{ persist: true, position: "at" as const },
		{ persist: true, position: "before" as const },
		{ persist: false, position: "at" as const },
		{ persist: false, position: "before" as const },
	])("leaves earlier-point forks usable after a source stop ($persist, $position)", async ({ persist, position }) => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {}, persist);
		const source = runtimeHost.session.sessionManager;
		const sourceId = source.getSessionId();
		source.resetLeaf();
		const firstUserId = source.appendMessage({
			role: "user",
			content: "Original request",
			timestamp: Date.now(),
		});
		const ancestorId = source.appendMessage(fauxAssistantMessage("Earlier response"));
		const blocked = {
			...fauxAssistantMessage("Partial output", { stopReason: "error", errorMessage: "Lineage review required" }),
			providerError: {
				code: "misalignment_policy_violation",
				requestId: "req_fork_blocked",
				responseId: "resp_fork_blocked",
			},
			monitoringSessionId: sourceId,
		};
		source.appendMessage(blocked);
		runtimeHost.session.refreshContext();
		const sourceFile = source.getSessionFile();
		await expect(runtimeHost.session.prompt("Continue source")).rejects.toThrow("Lineage review required");

		await runtimeHost.fork(position === "before" ? firstUserId : ancestorId, { position });

		const fork = runtimeHost.session.sessionManager;
		expect(fork.getSessionId()).not.toBe(sourceId);
		expect(
			fork
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.providerError?.requestId === "req_fork_blocked",
				),
		).toHaveLength(0);
		await runtimeHost.session.prompt("Continue fork");
		expect(faux.state.callCount).toBe(1);

		if (persist) {
			const reopenedFork = SessionManager.open(fork.getSessionFile()!);
			expect(
				reopenedFork
					.getEntries()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.providerError?.requestId === "req_fork_blocked",
					),
			).toBe(false);
			await runtimeHost.switchSession(sourceFile!);
			await expect(runtimeHost.session.prompt("Continue source after reopening")).rejects.toThrow(
				"Lineage review required",
			);
			expect(runtimeHost.session.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ message: blocked }),
			);
		}
	});

	it.each([true, false])(
		"keeps blocked history inspectable but lets a fork proceed (persist: %s)",
		async (persist) => {
			const { runtimeHost, faux } = await createRuntimeHost(() => {}, persist);
			const source = runtimeHost.session.sessionManager;
			const sourceId = source.getSessionId();
			source.appendMessage({ role: "user", content: "Original request", timestamp: Date.now() });
			const blocked = {
				...fauxAssistantMessage("Partial output", {
					stopReason: "error",
					errorMessage: "Source review required: context length exceeded",
				}),
				providerError: {
					code: "misalignment_policy_violation",
					requestId: "req_source",
					responseId: "resp_source",
				},
				monitoringSessionId: sourceId,
			};
			const blockedId = source.appendMessage(blocked);
			const sourceFile = source.getSessionFile();
			await expect(runtimeHost.session.prompt("Continue source")).rejects.toThrow("Source review required");

			await runtimeHost.fork(blockedId, { position: "at" });

			const fork = runtimeHost.session.sessionManager;
			expect(fork.getSessionId()).not.toBe(sourceId);
			expect(fork.getEntries()).toContainEqual(expect.objectContaining({ message: blocked }));
			await runtimeHost.session.prompt("New work");
			expect(faux.state.callCount).toBe(1);

			if (persist) {
				const forkFile = fork.getSessionFile()!;
				await runtimeHost.switchSession(forkFile);
				expect(runtimeHost.session.sessionManager.getEntries()).toContainEqual(
					expect.objectContaining({ message: blocked }),
				);
				await runtimeHost.session.prompt("Continue reopened fork");
				expect(faux.state.callCount).toBe(2);
				await runtimeHost.switchSession(sourceFile!);
				await expect(runtimeHost.session.prompt("Continue reopened source")).rejects.toThrow(
					"Source review required",
				);
			}
		},
	);

	it("keeps a cross-project fork usable with copied blocked history", async () => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {});
		const source = runtimeHost.session.sessionManager;
		const blocked = {
			...fauxAssistantMessage("Partial output", { stopReason: "error", errorMessage: "Source review required" }),
			providerError: { code: "misalignment_policy_violation", requestId: "req_cross_project" },
			monitoringSessionId: source.getSessionId(),
		};
		source.appendMessage(blocked);
		const sourceFile = source.getSessionFile()!;
		const targetCwd = join(runtimeHost.cwd, "other-project");
		mkdirSync(targetCwd);
		const fork = SessionManager.forkFrom(sourceFile, targetCwd, join(runtimeHost.cwd, "other-project-sessions"));

		expect(fork.getSessionId()).not.toBe(source.getSessionId());
		expect(fork.getHeader()?.parentSession).toBe(sourceFile);
		expect(fork.getEntries()).toContainEqual(expect.objectContaining({ message: blocked }));
		await runtimeHost.switchSession(fork.getSessionFile()!);
		await runtimeHost.session.prompt("New project task");
		expect(faux.state.callCount).toBe(1);
		await runtimeHost.switchSession(sourceFile);
		await expect(runtimeHost.session.prompt("Continue source")).rejects.toThrow("Source review required");
	});

	it.each([false, true])(
		"does not carry a named parent's monitoring stop into a new session (other current session: %s)",
		async (fromOtherSession) => {
			const { runtimeHost, faux } = await createRuntimeHost(() => {});
			const source = runtimeHost.session.sessionManager;
			const blocked = {
				...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Parent review required" }),
				providerError: { code: "misalignment_policy_violation", requestId: "req_parent_blocked" },
				monitoringSessionId: source.getSessionId(),
			};
			source.appendMessage(blocked);
			const parentSession = runtimeHost.session.sessionFile!;
			await expect(runtimeHost.session.prompt("Continue parent")).rejects.toThrow("Parent review required");
			if (fromOtherSession) await runtimeHost.newSession();

			await runtimeHost.newSession({ parentSession });

			expect(runtimeHost.session.sessionManager.getHeader()?.parentSession).toBe(parentSession);
			expect(runtimeHost.session.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual(
				[],
			);
			await runtimeHost.session.prompt("Continue handoff");
			expect(faux.state.callCount).toBe(1);

			await runtimeHost.switchSession(parentSession);
			await expect(runtimeHost.session.prompt("Continue parent after reopening")).rejects.toThrow(
				"Parent review required",
			);
			expect(runtimeHost.session.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ message: blocked }),
			);
		},
	);

	it("stops a related new session when its own provider request is blocked", async () => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {});
		const source = runtimeHost.session.sessionManager;
		source.appendMessage({
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Source review required" }),
			providerError: { code: "misalignment_policy_violation", requestId: "req_source" },
			monitoringSessionId: source.getSessionId(),
		});
		const sourceFile = source.getSessionFile()!;

		await runtimeHost.newSession({ parentSession: sourceFile });
		const childId = runtimeHost.session.sessionId;
		faux.setResponses([
			{
				...fauxAssistantMessage("Partial child output", {
					stopReason: "error",
					errorMessage: "Child review required",
				}),
				providerError: {
					code: "misalignment_policy_violation",
					requestId: "req_child",
					responseId: "resp_child",
				},
			},
		]);

		await runtimeHost.session.prompt("Trigger child stop");

		expect(faux.state.callCount).toBe(1);
		const childFile = runtimeHost.session.sessionFile!;
		expect(runtimeHost.session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({
					monitoringSessionId: childId,
					providerError: {
						code: "misalignment_policy_violation",
						requestId: "req_child",
						responseId: "resp_child",
					},
				}),
			}),
		);
		await expect(runtimeHost.session.prompt("Continue child")).rejects.toThrow("Child review required");
		await runtimeHost.switchSession(childFile);
		await expect(runtimeHost.session.prompt("Continue reopened child")).rejects.toThrow("Child review required");
		await runtimeHost.switchSession(sourceFile);
		await expect(runtimeHost.session.prompt("Continue reopened source")).rejects.toThrow("Source review required");
		expect(faux.state.callCount).toBe(1);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
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

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
