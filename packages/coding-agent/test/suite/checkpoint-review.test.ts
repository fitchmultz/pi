import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import dynamicTools from "../../examples/extensions/dynamic-tools.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	type CheckpointHold,
	prepareCheckpointExit,
	readSessionCheckpoint,
	type SessionCheckpoint,
	writeSessionCheckpoint,
} from "../../src/core/checkpoint.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { main } from "../../src/main.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import type * as TuiRenderer from "../../src/modes/interactive/tui-renderer.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("../../src/utils/tools-manager.ts", () => ({ ensureTool: async () => undefined }));
vi.mock("../../src/modes/interactive/tui-renderer.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof TuiRenderer>();
	return {
		...actual,
		createInteractiveTui: (options: Parameters<typeof actual.createInteractiveTui>[0]) =>
			actual.createInteractiveTui({ ...options, terminal: new VirtualTerminal(120, 40) }),
	};
});

const directories: string[] = [];
const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
function directory() {
	const path = mkdtempSync(join(tmpdir(), "pi-checkpoint-review-"));
	directories.push(path);
	return path;
}
async function harness(options: Parameters<typeof createHarness>[0] = {}) {
	const dir = directory();
	const h = await createHarness({ ...options, sessionManager: SessionManager.create(dir, join(dir, "sessions")) });
	harnesses.push(h);
	return h;
}
async function snapshot(session: AgentSession) {
	const hold = await session.acquireCheckpoint({ quiesce: () => () => {} });
	try {
		expect(hold.sleepReady).toBe(true);
		return hold.checkpoint;
	} finally {
		hold.release();
	}
}

// Independent review repro: draining diagnostics must not erase an unsuccessful native setter.
it.each(["global", "project"] as const)(
	"repeated live and final captures reject dirty %s settings until persistence succeeds",
	async (scope) => {
		const stored = { global: "{}", project: "{}" };
		let fail = true;
		let writes = 0;
		const settings = SettingsManager.fromStorage({
			withLock(which, fn) {
				const next = fn(stored[which]);
				if (next === undefined) return;
				writes++;
				if (fail) throw new Error("disk full");
				stored[which] = next;
			},
		});
		const h = await harness({ settingsManager: settings });
		if (scope === "global") settings.setCompactionEnabled(false);
		else settings.setProjectSkillPaths(["saved-skill"]);
		await settings.flush();
		for (let attempt = 0; attempt < 2; attempt++) {
			settings.drainErrors();
			await expect(h.session.acquireCheckpoint({ quiesce: () => () => {} })).rejects.toThrow(/settings/i);
		}
		expect(writes).toBe(1);
		h.session.beginShutdown();
		await expect(h.session.captureShutdownCheckpoint()).rejects.toThrow(/settings/i);
		fail = false;
		if (scope === "global") settings.setRetryEnabled(false);
		else settings.setProjectPromptTemplatePaths(["saved-prompt"]);
		await settings.flush();
		settings.drainErrors();
		const final = await h.session.captureShutdownCheckpoint();
		final.release();
		expect(JSON.parse(stored[scope])).toMatchObject(
			scope === "global"
				? { compaction: { enabled: false }, retry: { enabled: false } }
				: { skills: ["saved-skill"], prompts: ["saved-prompt"] },
		);
	},
);

it("fresh shipped startup-tool extension restores exact active selection after initialization", async () => {
	const h = await harness({ extensionFactories: [dynamicTools] });
	await h.session.bindExtensions({});
	h.session.setActiveToolsByName(["echo_session", "read"]);
	const checkpoint = await snapshot(h.session);
	const resourceLoader = createTestResourceLoader({
		extensionsResult: await createTestExtensionsResult([dynamicTools], h.tempDir),
	});
	const { session } = await createAgentSession({
		checkpoint,
		resourceLoader,
		settingsManager: h.settingsManager,
		modelRuntime: h.session.modelRuntime,
	});
	sessions.push(session);
	await session.bindExtensions({});
	expect(session.getActiveToolNames()).toEqual(checkpoint.selection.activeTools);
	expect(h.faux.state.callCount).toBe(0);
});

async function cli(
	dir: string,
	args: string[],
	factories: ExtensionFactory[],
	inspect: (mode: InteractiveMode, runtime: AgentSessionRuntime) => Promise<void>,
) {
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("PI_CHECKPOINT_SOCKET", "");
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_EXPERIMENTAL", "");
	vi.stubEnv("PI_MANAGED_CLI", "");
	const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(InteractiveMode.prototype, "run").mockImplementation(async function (this: InteractiveMode) {
		const view = this as unknown as { runtimeHost: AgentSessionRuntime; isShuttingDown: boolean };
		const { runtimeHost } = view;
		try {
			await this.init();
			await inspect(this, runtimeHost);
		} finally {
			this.stop("resume-hint");
			if (!view.isShuttingDown) await runtimeHost.dispose();
		}
	});
	try {
		await main([...args, "--offline", "-ne", "-ns", "-np", "--no-themes", "--no-approve"], {
			extensionFactories: factories,
		});
	} finally {
		if (input) Object.defineProperty(process.stdin, "isTTY", input);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (output) Object.defineProperty(process.stdout, "isTTY", output);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	}
}
function provider(h: Harness): ExtensionFactory {
	return (pi) => {
		pi.registerProvider(h.getModel().provider, {
			baseUrl: h.getModel().baseUrl,
			apiKey: "faux-only",
			api: h.faux.api,
			models: h.models.map((model) => ({ ...model })),
		});
	};
}

it.each([
	["unrestricted", [], ["echo_session", "read"]],
	["allowlist", ["--tools", "read,echo_session"], ["read"]],
	["denylist", ["--exclude-tools", "bash,echo_session"], ["read"]],
	["no tools", ["--no-tools"], []],
	["no builtin defaults", ["--no-builtin-tools"], ["echo_session"]],
] as const)(
	"native CLI cold restore preserves %s configuration and startup selection without replay",
	async (_name, flags, active) => {
		const h = await harness();
		const dir = directory();
		const path = join(dir, "checkpoint.json");
		let checkpoint!: SessionCheckpoint;
		let known!: string[];
		let initial!: string[];
		const factories = [provider(h), dynamicTools];
		await cli(
			dir,
			["--model", `${h.getModel().provider}/${h.getModel().id}`, ...flags],
			factories,
			async (_mode, runtime) => {
				const session = runtime.session;
				initial = session.getActiveToolNames();
				session.setActiveToolsByName([...active]);
				await session.steer("accepted, not replayed");
				known = session.getAllTools().map((tool) => tool.name);
				checkpoint = await snapshot(session);
				writeSessionCheckpoint(path, checkpoint);
			},
		);
		await cli(dir, ["--checkpoint", path], factories, async (_mode, runtime) => {
			const session = runtime.session;
			expect(session.getActiveToolNames()).toEqual(active);
			expect(session.getAllTools().map((tool) => tool.name)).toEqual(known);
			expect(session.getCheckpointQueues()).toEqual(checkpoint.queues);
			expect(h.faux.state.callCount).toBe(0);
			const before = await snapshot(session);
			expect(before.selection.activeTools).toEqual(active);
			// Native allow/exclude configuration must still filter later registry refreshes.
			await session.reload();
			session.setActiveToolsByName(["bash"]);
			expect(session.getActiveToolNames()).toEqual(known.includes("bash") ? ["bash"] : []);
			await runtime.newSession();
			expect(runtime.session.getAllTools().map((tool) => tool.name)).toEqual(known);
			expect(runtime.session.getActiveToolNames()).toEqual(initial);
			expect(h.faux.state.callCount).toBe(0);
		});
	},
);

it.each(["held", "exit"])(
	"intentional no-model %s artifact cold restores without selecting a newly available model",
	async (kind) => {
		const h = await harness();
		const dir = directory();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.create(dir, join(dir, "sessions")),
		});
		sessions.push(session);
		await session.steer("pre-login queue");
		const path = join(dir, "checkpoint.json");
		if (kind === "held") writeSessionCheckpoint(path, await snapshot(session));
		else {
			session.beginShutdown();
			const candidate = await session.captureShutdownCheckpoint();
			try {
				prepareCheckpointExit(path)(candidate.checkpoint);
			} finally {
				candidate.release();
			}
		}
		const checkpoint = readSessionCheckpoint(path);
		expect(checkpoint.selection.model).toBeUndefined();
		vi.stubEnv("PI_CHECKPOINT_EXIT_PATH", path);
		await cli(dir, ["--checkpoint", path], [provider(h)], async (mode, reopened) => {
			expect(reopened.session.model).toBeUndefined();
			expect(reopened.session.getCheckpointQueues()).toEqual(checkpoint.queues);
			expect(h.faux.state.callCount).toBe(0);
			if (kind === "exit") {
				const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
				await (mode as unknown as { shutdown(): Promise<void> }).shutdown();
				expect(exit).toHaveBeenCalledWith(0);
				const final = readSessionCheckpoint(path);
				expect(final.completedExit).toEqual({ pid: process.pid });
				expect(final.selection.model).toBeUndefined();
				expect(final.queues).toEqual(checkpoint.queues);
			}
		});
	},
);

it("missing startup tools fail after initialization, with no premature model run or positive receipt", async () => {
	const h = await harness({ extensionFactories: [dynamicTools] });
	await h.session.bindExtensions({});
	const checkpoint = await snapshot(h.session);
	const resourceLoader = createTestResourceLoader({
		extensionsResult: await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("session_start", () => {});
				},
			],
			h.tempDir,
		),
	});
	const { session } = await createAgentSession({
		checkpoint,
		resourceLoader,
		settingsManager: h.settingsManager,
		modelRuntime: h.session.modelRuntime,
	});
	sessions.push(session);
	await expect(session.prompt("must not run")).rejects.toThrow("requires extension initialization");
	await expect(session.acquireCheckpoint({ quiesce: () => () => {} })).rejects.toThrow(
		"requires extension initialization",
	);
	await expect(session.bindExtensions({})).rejects.toThrow("Checkpoint tools unavailable");
	expect(h.faux.state.callCount).toBe(0);
});

it("a real model with placeholder-like names is not silently changed into no selection", async () => {
	const h = await harness();
	h.session.agent.state.model = { ...h.getModel(), id: "unknown", provider: "unknown", api: "unknown" };
	const checkpoint = await snapshot(h.session);
	expect(checkpoint.selection.model).toEqual({ provider: "unknown", id: "unknown" });
	await expect(
		createAgentSession({
			checkpoint,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: createTestResourceLoader(),
			settingsManager: h.settingsManager,
		}),
	).rejects.toThrow("Checkpoint model unavailable");
});

it("legacy v1 active/known names are not fabricated into an allowlist", async () => {
	const h = await harness({ allowedToolNames: ["read"] });
	const checkpoint = await snapshot(h.session);
	delete checkpoint.toolConfiguration;
	const { session } = await createAgentSession({
		checkpoint,
		modelRuntime: h.session.modelRuntime,
		resourceLoader: createTestResourceLoader(),
		settingsManager: h.settingsManager,
	});
	sessions.push(session);
	expect(session.getActiveToolNames()).toEqual(["read"]);
	expect(session.getAllTools().map((tool) => tool.name)).toContain("bash");
});

it("SDK compaction failure wakes a pending settled checkpoint without a TUI callback", async () => {
	const h = await harness();
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const finish = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(h.session.modelRuntime, "getAuth").mockImplementation(async () => {
		enter();
		await finish;
		throw new Error("unavailable auth");
	});
	const failed = expect(h.session.compact()).rejects.toThrow("unavailable auth");
	await entered;
	const controller = new AbortController();
	let captured: CheckpointHold | undefined;
	const pending = h.session.acquireCheckpoint({ signal: controller.signal, quiesce: () => () => {} }).then(
		(hold) => {
			captured = hold;
			return hold;
		},
		() => undefined,
	);
	try {
		release();
		await failed;
		await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: 1000 });
		expect(captured?.sleepReady).toBe(true);
	} finally {
		controller.abort();
		(await pending)?.release();
	}
});

it("already aborted checkpoint requests reject asynchronously", async () => {
	const h = await harness();
	await expect(h.session.acquireCheckpoint({ signal: AbortSignal.abort() })).rejects.toThrow();
	h.session.beginShutdown();
	await expect(h.session.acquireCheckpoint()).rejects.toThrow();
});

it("an OAuth refresh callback failure before any credential write does not poison clean exit", async () => {
	const h = await harness();
	await h.authStorage.modify("broken-oauth", async () => ({
		type: "oauth",
		refresh: "fake-refresh",
		access: "unchanged",
		expires: 0,
	}));
	const runtime = h.session.modelRuntime;
	runtime.registerProvider("broken-oauth", {
		baseUrl: h.getModel().baseUrl,
		api: h.faux.api,
		models: h.models.map((model) => ({ ...model })),
		oauth: {
			name: "Fake OAuth",
			login: async () => {
				throw new Error("not used");
			},
			refreshToken: async () => {
				throw new Error("503 before write");
			},
			getApiKey: (credentials) => credentials.access,
		},
	});
	await expect(runtime.getAuth(runtime.getModel("broken-oauth", h.getModel().id)!)).rejects.toThrow(
		"OAuth refresh failed",
	);
	expect(await h.authStorage.read("broken-oauth")).toMatchObject({ access: "unchanged" });
	h.session.beginShutdown();
	const candidate = await h.session.captureShutdownCheckpoint();
	candidate.release();
	// A distinct storage/unlock error replacing the callback failure must still fail closed.
	const modify = h.authStorage.modify.bind(h.authStorage);
	vi.spyOn(h.authStorage, "modify").mockImplementation((...args) =>
		modify(...args).catch(() => {
			throw new Error("storage cleanup failure");
		}),
	);
	await expect(runtime.getAuth(runtime.getModel("broken-oauth", h.getModel().id)!)).rejects.toThrow();
	await expect(h.session.captureShutdownCheckpoint()).rejects.toThrow("storage cleanup failure");
});

it("checkpoint barriers retain native on() unsubscribe and dispatch snapshot semantics", async () => {
	const calls: string[] = [];
	const h = await harness({
		extensionFactories: [
			(pi) => {
				let changed = false;
				pi.on("session_checkpoint", () => {
					calls.push("first");
					if (!changed) {
						changed = true;
						removeSecond();
						removeSecond();
						pi.on("session_checkpoint", () => {
							calls.push("added");
							return { sleepReady: true };
						});
					}
					return { sleepReady: true };
				});
				const removeSecond = pi.on("session_checkpoint", () => {
					calls.push("second");
					return { sleepReady: false, reason: "current dispatch veto" };
				});
			},
		],
	});
	const hold = await h.session.acquireCheckpoint({ quiesce: () => () => {} });
	try {
		expect(calls).toEqual(["first", "second"]);
		expect(hold.sleepReady).toBe(false);
	} finally {
		hold.release();
	}
	calls.length = 0;
	await snapshot(h.session);
	expect(calls).toEqual(["first", "added"]);
});

it("failed same-path CLI restore clears completed proof but retains native data for retry", async () => {
	const h = await harness();
	const dir = directory();
	const path = join(dir, "exit.json");
	const checkpoint = await snapshot(h.session);
	writeSessionCheckpoint(path, { ...checkpoint, completedExit: { pid: process.pid } });
	vi.stubEnv("PI_CHECKPOINT_EXIT_PATH", path);
	await expect(cli(dir, ["--checkpoint", path], [], async () => {})).rejects.toThrow("Checkpoint model unavailable");
	const retained = readSessionCheckpoint(path);
	expect(retained.completedExit).toBeUndefined();
	expect(retained.selection).toEqual(checkpoint.selection);
	await cli(dir, ["--checkpoint", path], [provider(h)], async (_mode, runtime) => {
		expect(runtime.session.sessionId).toBe(checkpoint.selection.sessionId);
		expect(runtime.session.getCheckpointQueues()).toEqual(checkpoint.queues);
	});
});
