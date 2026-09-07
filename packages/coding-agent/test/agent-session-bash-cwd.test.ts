import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionConfig } from "../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { defineTool, type ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type BashOperations, createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { createTool } from "../src/core/tools/index.ts";
import type { BashCwdHook, ExtensionAPI } from "../src/index.ts";

const command = 'pwd -P; printf "%s\\n" "$PI_BASH_CWD_SHELL" "$PI_BASH_CWD_PREFIX" "$PI_BASH_CWD_ENV" "$PI_SESSION_ID"';
const prefix = "export PI_BASH_CWD_PREFIX=configured-prefix";

describe.skipIf(process.platform === "win32")("AgentSession Bash cwd hooks", () => {
	let root: string;
	let originalCwd: string;
	let selectedCwd: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-cwd-")));
		originalCwd = join(root, "A");
		selectedCwd = join(root, "B");
		agentDir = join(root, "agent");
		for (const path of [originalCwd, selectedCwd, agentDir]) mkdirSync(path);
		const shellPath = join(root, "configured-shell");
		writeFileSync(shellPath, '#!/bin/sh\nexport PI_BASH_CWD_SHELL=configured-shell\nexec /bin/bash "$@"\n', {
			mode: 0o755,
		});
		settingsManager = SettingsManager.inMemory({ shellPath, shellCommandPrefix: prefix });
		vi.stubEnv("PI_BASH_CWD_ENV", "inherited-env");
		vi.stubEnv("PI_SESSION_ID", "inherited-session");
	});

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		rmSync(root, { recursive: true, force: true });
	});

	async function createSession(
		extensionFactories: ExtensionFactory[] = [],
		options: Pick<AgentSessionConfig, "baseToolsOverride" | "customTools"> = {},
	) {
		const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const resourceLoader = new DefaultResourceLoader({
			cwd: originalCwd,
			agentDir,
			settingsManager,
			extensionFactories,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: getModel("anthropic", "claude-sonnet-4-5")! },
				streamFn: () => {
					throw new Error("These Bash tests must not call a model");
				},
			}),
			cwd: originalCwd,
			settingsManager,
			resourceLoader,
			modelRuntime,
			sessionManager: SessionManager.inMemory(originalCwd),
			...options,
		});
		sessions.push(session);
		return session;
	}

	it("resolves the configured native Bash cwd before checking a deleted original directory", async () => {
		let virtualCwd: string | undefined;
		const session = await createSession([
			(pi) => {
				// Let older hosts reach the native preflight failure instead of failing extension load.
				if (typeof pi.registerBashCwdHook === "function") {
					pi.registerBashCwdHook((cwd) => virtualCwd ?? cwd);
				}
			},
		]);
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const before = await bash.execute("before", { command });
		expect(before.content).toEqual([
			{
				type: "text",
				text: `${originalCwd}\nconfigured-shell\nconfigured-prefix\ninherited-env\n${session.sessionId}\n`,
			},
		]);

		virtualCwd = selectedCwd;
		rmdirSync(originalCwd);
		expect(existsSync(originalCwd)).toBe(false);
		const updates: unknown[] = [];
		const result = await bash.execute("after", { command }, undefined, (update) => updates.push(update));
		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: `${selectedCwd}\nconfigured-shell\nconfigured-prefix\ninherited-env\n${session.sessionId}\n`,
				},
			],
			details: undefined,
		});
		expect(updates[0]).toEqual({ content: [], details: undefined });
		expect(updates.at(-1)).toMatchObject({ content: result.content });
		expect(session.sessionManager.getCwd()).toBe(originalCwd);
		expect(session.extensionRunner.createContext().cwd).toBe(originalCwd);
		expect(session.getToolDefinition("bash")?.renderCall).toBeTypeOf("function");
		expect(session.getToolDefinition("bash")?.renderResult).toBeTypeOf("function");
	});

	it("resolves native user Bash cwd without changing configuration, streaming, or history", async () => {
		let virtualCwd: string | undefined;
		const session = await createSession([(pi) => pi.registerBashCwdHook((cwd) => virtualCwd ?? cwd)]);
		const baseline = await session.executeBash(command);
		expect(baseline.output).toBe(
			`${originalCwd}\nconfigured-shell\nconfigured-prefix\ninherited-env\ninherited-session\n`,
		);
		virtualCwd = selectedCwd;
		rmdirSync(originalCwd);
		const chunks: string[] = [];
		const events: Array<{ id?: string; delta: string }> = [];
		session.subscribe((event) => {
			if (event.type === "bash_execution_update") events.push(event);
		});
		const result = await session.executeBash(command, (chunk) => chunks.push(chunk), {
			id: "user-bash",
			excludeFromContext: true,
		});
		expect(result).toEqual({
			output: `${selectedCwd}\nconfigured-shell\nconfigured-prefix\ninherited-env\ninherited-session\n`,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputPath: undefined,
		});
		expect(chunks.join("")).toBe(result.output);
		expect(events.map((event) => event.delta).join("")).toBe(result.output);
		expect(events.every((event) => event.id === "user-bash")).toBe(true);
		expect(session.messages.at(-1)).toMatchObject({
			role: "bashExecution",
			command,
			output: result.output,
			excludeFromContext: true,
		});
		expect(session.isBashRunning).toBe(false);
	});

	it("passes the resolved cwd to the exact user-selected operations and preserves their remap", async () => {
		const remappedCwd = join(root, "remote");
		mkdirSync(remappedCwd);
		const local = createLocalBashOperations({ shellPath: settingsManager.getShellPath() });
		const operations = Object.freeze<BashOperations>({
			async exec(receivedCommand, cwd, options) {
				expect(this).toBe(operations);
				expect(receivedCommand).toBe(`${prefix}\n${command}`);
				expect(cwd).toBe(selectedCwd);
				expect(options.env).toBeUndefined();
				return local.exec(receivedCommand, remappedCwd, options);
			},
		});
		const session = await createSession([
			(pi) => {
				pi.registerBashCwdHook(() => selectedCwd);
				pi.on("user_bash", () => ({ operations }));
			},
		]);
		rmdirSync(originalCwd);
		const selected = await session.extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			cwd: originalCwd,
			excludeFromContext: false,
		});
		expect(selected?.operations).toBe(operations);
		const result = await session.executeBash(command, undefined, { operations: selected?.operations });
		expect(result.output).toBe(
			`${remappedCwd}\nconfigured-shell\nconfigured-prefix\ninherited-env\ninherited-session\n`,
		);
		expect(result.exitCode).toBe(0);
	});

	it("keeps unregistered sessions unchanged and does not share hooks between runners", async () => {
		const hooked = await createSession([(pi) => pi.registerBashCwdHook(() => selectedCwd)]);
		const plain = await createSession();
		const bash = plain.agent.state.tools.find((tool) => tool.name === "bash")!;
		expect((await bash.execute("plain", { command: "pwd -P" })).content).toEqual([
			{ type: "text", text: `${originalCwd}\n` },
		]);
		expect((await plain.executeBash("pwd -P")).output).toBe(`${originalCwd}\n`);
		expect((await hooked.executeBash("pwd -P")).output).toBe(`${selectedCwd}\n`);
		rmdirSync(originalCwd);
		const error = `Working directory does not exist: ${originalCwd}\nCannot execute bash commands.`;
		await expect(bash.execute("missing", { command: "pwd -P" })).rejects.toThrow(error);
		await expect(plain.executeBash("pwd -P")).rejects.toThrow(error);
		expect((await hooked.executeBash("pwd -P")).output).toBe(`${selectedCwd}\n`);
	});

	it("chains hooks in extension and registration order, including registration after startup", async () => {
		let firstAPI!: ExtensionAPI;
		const destination = join(originalCwd, "first", "second", "last");
		mkdirSync(destination, { recursive: true });
		const session = await createSession([
			(pi) => {
				firstAPI = pi;
				pi.registerBashCwdHook((cwd) => join(cwd, "first"));
			},
			(pi) => pi.registerBashCwdHook((cwd) => join(cwd, "last")),
		]);
		const lateHook: BashCwdHook = (cwd) => join(cwd, "second");
		firstAPI.registerBashCwdHook(lateHook);
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		expect((await bash.execute("chain", { command: "pwd -P" })).content).toEqual([
			{ type: "text", text: `${destination}\n` },
		]);
		expect((await session.executeBash("pwd -P")).output).toBe(`${destination}\n`);
	});

	it("stops on hook failures or a missing effective cwd and recovers when the hook selects a valid cwd", async () => {
		const hookError = new Error("cwd resolution failed");
		let fail = true;
		let effectiveCwd = join(root, "missing");
		let operationsRan = false;
		const session = await createSession([
			(pi) =>
				pi.registerBashCwdHook(() => {
					if (fail) throw hookError;
					return effectiveCwd;
				}),
		]);
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		await expect(bash.execute("hook-error", { command: "printf ran > marker" })).rejects.toBe(hookError);
		await expect(
			session.executeBash("unused", undefined, {
				operations: {
					async exec() {
						operationsRan = true;
						return { exitCode: 0 };
					},
				},
			}),
		).rejects.toBe(hookError);
		expect(operationsRan).toBe(false);
		expect(existsSync(join(originalCwd, "marker"))).toBe(false);
		expect(session.isBashRunning).toBe(false);
		expect(session.messages).toEqual([]);

		fail = false;
		const error = `Working directory does not exist: ${effectiveCwd}\nCannot execute bash commands.`;
		await expect(bash.execute("missing", { command: "pwd -P" })).rejects.toThrow(error);
		await expect(session.executeBash("pwd -P")).rejects.toThrow(error);
		expect(existsSync(effectiveCwd)).toBe(false);
		effectiveCwd = selectedCwd;
		expect((await bash.execute("recovered", { command: "pwd -P" })).content).toEqual([
			{ type: "text", text: `${selectedCwd}\n` },
		]);
		expect((await session.executeBash("pwd -P")).output).toBe(`${selectedCwd}\n`);
	});

	it.each(["extension", "sdk"] as const)(
		"leaves %s Bash definitions and their factory spawn hooks authoritative",
		async (source) => {
			let cwdHookRan = false;
			const remappedCwd = join(root, "custom");
			mkdirSync(remappedCwd);
			const definition = Object.freeze(
				defineTool(
					createBashToolDefinition(originalCwd, {
						shellPath: settingsManager.getShellPath(),
						commandPrefix: "export PI_BASH_CWD_PREFIX=custom-prefix",
						spawnHook: (context) => {
							expect(context.cwd).toBe(originalCwd);
							return { ...context, cwd: remappedCwd, env: { ...context.env, PI_BASH_CWD_ENV: "custom-env" } };
						},
					}),
				),
			);
			const session = await createSession(
				[
					(pi) => {
						pi.registerBashCwdHook(() => {
							cwdHookRan = true;
							return selectedCwd;
						});
						if (source === "extension") pi.registerTool(definition);
					},
				],
				{ customTools: source === "sdk" ? [definition] : [] },
			);
			rmdirSync(originalCwd);
			const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
			expect((await bash.execute("custom", { command })).content).toEqual([
				{
					type: "text",
					text: `${remappedCwd}\nconfigured-shell\ncustom-prefix\ncustom-env\n${session.sessionId}\n`,
				},
			]);
			expect(cwdHookRan).toBe(false);
			expect(session.getToolDefinition("bash")).toBe(definition);
		},
	);

	it("leaves baseToolsOverride Bash factories and their deliberate cwd remaps unchanged", async () => {
		let cwdHookRan = false;
		const tool = Object.freeze(
			createTool("bash", originalCwd, {
				bash: {
					shellPath: settingsManager.getShellPath(),
					commandPrefix: "export PI_BASH_CWD_PREFIX=base-prefix",
					exposeSessionEnvironment: false,
					spawnHook: (context) => {
						expect(context.cwd).toBe(originalCwd);
						return { ...context, cwd: selectedCwd };
					},
				},
			}),
		);
		const session = await createSession(
			[
				(pi) =>
					pi.registerBashCwdHook(() => {
						cwdHookRan = true;
						return join(root, "must-not-use");
					}),
			],
			{ baseToolsOverride: { bash: tool } },
		);
		rmdirSync(originalCwd);
		const bash = session.agent.state.tools.find((candidate) => candidate.name === "bash")!;
		expect((await bash.execute("base", { command })).content).toEqual([
			{ type: "text", text: `${selectedCwd}\nconfigured-shell\nbase-prefix\ninherited-env\n\n` },
		]);
		expect(cwdHookRan).toBe(false);
	});

	it("reinitializes and removes registrations on reload without retaining old callbacks", async () => {
		let loads = 0;
		let firstAPI!: ExtensionAPI;
		const calls: number[] = [];
		const factories: ExtensionFactory[] = [
			(pi) => {
				const instance = ++loads;
				if (instance === 1) firstAPI = pi;
				const destination = join(root, `load-${instance}`);
				mkdirSync(destination);
				pi.registerBashCwdHook(() => {
					calls.push(instance);
					return destination;
				});
			},
		];
		const session = await createSession(factories);
		expect((await session.executeBash("pwd -P")).output).toBe(`${join(root, "load-1")}\n`);
		await session.reload();
		expect(() => firstAPI.registerBashCwdHook((cwd) => cwd)).toThrow("stale");
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		expect((await bash.execute("reloaded", { command: "pwd -P" })).content).toEqual([
			{ type: "text", text: `${join(root, "load-2")}\n` },
		]);
		expect((await session.executeBash("pwd -P")).output).toBe(`${join(root, "load-2")}\n`);
		factories.length = 0;
		await session.reload();
		expect((await session.executeBash("pwd -P")).output).toBe(`${originalCwd}\n`);
		expect(calls).toEqual([1, 2, 2]);
	});

	it("uses only the replacement session's registrations", async () => {
		let loads = 0;
		let firstAPI!: ExtensionAPI;
		const calls: number[] = [];
		const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [
						(pi) => {
							const instance = ++loads;
							if (instance === 1) firstAPI = pi;
							const destination = join(root, `session-${instance}`);
							mkdirSync(destination);
							pi.registerBashCwdHook(() => {
								calls.push(instance);
								return destination;
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: originalCwd,
			agentDir,
			sessionManager: SessionManager.inMemory(originalCwd),
		});
		try {
			expect((await runtime.session.executeBash("pwd -P")).output).toBe(`${join(root, "session-1")}\n`);
			await runtime.newSession();
			expect(() => firstAPI.registerBashCwdHook((cwd) => cwd)).toThrow("stale");
			const bash = runtime.session.agent.state.tools.find((tool) => tool.name === "bash")!;
			expect((await bash.execute("replacement", { command: "pwd -P" })).content).toEqual([
				{ type: "text", text: `${join(root, "session-2")}\n` },
			]);
			expect((await runtime.session.executeBash("pwd -P")).output).toBe(`${join(root, "session-2")}\n`);
			expect(calls).toEqual([1, 2, 2]);
		} finally {
			await runtime.dispose();
		}
	});
});
