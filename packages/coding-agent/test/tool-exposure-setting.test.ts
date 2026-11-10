import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { openWorkingSession, parseWorkingSession } from "../src/core/working-session.ts";

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools">;

/** Registers `lookup_weather` as a `direct` tool, active by default. */
const weatherExtension: InlineExtension = (pi) => {
	pi.registerTool({
		name: "lookup_weather",
		label: "Lookup Weather",
		description: "Look up the current weather for a city",
		parameters: Type.Object({ city: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "sunny" }], details: {} }),
	});
};

const DEFERRED: Settings = { toolExposure: { lookup_weather: "deferred" } };

describe("toolExposure setting through the SDK", () => {
	let tempDir: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-exposure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(tempDir, ".pi"));
	});

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const model = () => getModel("anthropic", "claude-sonnet-4-5")!;
	const writeGlobal = (settings: Settings) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	const writeProject = (settings: Settings) =>
		writeFileSync(join(tempDir, ".pi", "settings.json"), JSON.stringify(settings));
	const exposureOf = (session: AgentSession) =>
		session.getAllTools().find((tool) => tool.name === "lookup_weather")?.exposure;

	async function createSession(settingsManager: SettingsManager, options: ToolOptions = {}) {
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [weatherExtension],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: model(),
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			...options,
		});
		sessions.push(session);
		return session;
	}

	const createFileSession = (options?: ToolOptions) =>
		createSession(SettingsManager.create(tempDir, agentDir), options);
	const createMemorySession = (settings: Settings, options?: ToolOptions) =>
		createSession(SettingsManager.inMemory(settings), options);

	it("reads the setting from the global and the project settings file", async () => {
		writeGlobal(DEFERRED);
		const global = await createFileSession();
		expect(global.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expect(exposureOf(global)).toBe("deferred");

		// A project entry replaces the user-level entry with the same key.
		writeProject({ toolExposure: { lookup_weather: "direct" } });
		const project = await createFileSession();
		expect(project.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "lookup_weather"]);
	});

	it("declares a deferred tool that defaultTools or the tools option names", async () => {
		const plus = await createMemorySession({ ...DEFERRED, defaultTools: ["+lookup_weather"] });
		expect(plus.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "lookup_weather"]);

		const plain = await createMemorySession({ ...DEFERRED, defaultTools: ["read", "lookup_weather"] });
		expect(plain.getActiveToolNames()).toEqual(["read", "lookup_weather"]);

		const allowlist = await createMemorySession(DEFERRED, { tools: ["read", "lookup_weather"] });
		expect(allowlist.getActiveToolNames()).toEqual(["read", "lookup_weather"]);

		const modifier = await createMemorySession(DEFERRED, { tools: ["+lookup_weather"] });
		expect(modifier.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "lookup_weather"]);
	});

	it("leaves a deferred tool undeclared but registered when no selection names it", async () => {
		for (const session of [
			await createMemorySession(DEFERRED),
			await createMemorySession({ ...DEFERRED, defaultTools: ["-lookup_weather"] }),
			await createMemorySession({ ...DEFERRED, defaultTools: ["read", "bash", "edit", "write"] }),
			await createMemorySession(DEFERRED, { tools: ["-lookup_weather"] }),
		]) {
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
			expect(session.getCallableToolNames()).toContain("lookup_weather");
		}
	});

	it("keeps a default built-in tool declared until defaultTools removes it", async () => {
		// The default selection names `edit`, and a named tool is declared.
		const named = await createMemorySession({ toolExposure: { edit: "deferred" } });
		expect(named.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "lookup_weather"]);

		const removed = await createMemorySession({ toolExposure: { edit: "deferred" }, defaultTools: ["-edit"] });
		expect(removed.getActiveToolNames()).toEqual(["read", "bash", "write", "lookup_weather"]);
		expect(removed.getCallableToolNames()).toContain("edit");
	});

	it("removes a deferred tool that the tools or excludeTools option removes", async () => {
		const unlisted = await createMemorySession(DEFERRED, { tools: ["read"] });
		expect(exposureOf(unlisted)).toBeUndefined();

		const excluded = await createMemorySession(DEFERRED, { excludeTools: ["lookup_*"] });
		expect(exposureOf(excluded)).toBeUndefined();
	});

	describe("reload", () => {
		it("keeps a declared tool declared when the setting defers it", async () => {
			const session = await createFileSession();
			expect(session.getActiveToolNames()).toContain("lookup_weather");

			writeGlobal(DEFERRED);
			await session.reload();
			// Extensions and tool_search see the new exposure at once.
			expect(exposureOf(session)).toBe("deferred");
			expect(session.getActiveToolNames()).toContain("lookup_weather");

			// `hidden` is the exception: a hidden tool cannot be declared.
			writeGlobal({ toolExposure: { lookup_weather: "hidden" } });
			await session.reload();
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		});

		it.each(["deferred", "hidden"] as const)("declares a tool whose %s entry was removed", async (exposure) => {
			writeGlobal({ toolExposure: { lookup_weather: exposure } });
			const session = await createFileSession();
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

			// Left undeclared, the tool would be direct and inactive, which nothing can reach.
			writeGlobal({});
			await session.reload();
			expect(exposureOf(session)).toBe("direct");
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "lookup_weather"]);
		});

		it("follows defaultTools for built-in tools whose entry was removed", async () => {
			writeGlobal({ toolExposure: { edit: "hidden", grep: "deferred" } });
			const session = await createFileSession();
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "write", "lookup_weather"]);

			// `edit` is a default tool; `grep` is not.
			writeGlobal({});
			await session.reload();
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "write", "lookup_weather", "edit"]);
		});

		it("keeps a tool off that was turned off during the session", async () => {
			writeGlobal({ toolExposure: { other_tool: "deferred" } });
			const session = await createFileSession();
			session.setActiveToolsByName(["read"]);

			writeGlobal({});
			await session.reload();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		});
	});

	// A launcher such as pi-subagents builds a child from the user's settings files and gives it its
	// own value. Creating the services reloads the settings, so overrides apply after it.
	describe("session services", () => {
		const createServices = (workingSession?: CreateAgentSessionOptions["workingSession"]) =>
			createAgentSessionServices({
				cwd: tempDir,
				agentDir,
				settingsManager: SettingsManager.create(tempDir, agentDir),
				workingSession,
				resourceLoaderOptions: { extensionFactories: [weatherExtension] },
			});

		async function createChild() {
			const services = await createServices();
			services.settingsManager.applyOverrides(DEFERRED);
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(tempDir),
				model: model(),
			});
			sessions.push(session);
			return session;
		}

		it("applies overrides set on the services' settings manager before the session is created", async () => {
			writeGlobal({ toolExposure: { edit: "hidden" } });
			const session = await createChild();

			// The override adds to the entries of the settings files.
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "write"]);
			expect(exposureOf(session)).toBe("deferred");
		});

		it("declares the tool when a reload drops the override", async () => {
			// A file-backed manager drops overrides when it reloads. The tool must not be left direct
			// and inactive, which nothing can reach.
			const session = await createChild();
			await session.reload();

			expect(exposureOf(session)).toBe("direct");
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "lookup_weather"]);
		});

		it("restores a saved working session with the overrides it was saved with", async () => {
			const initial = await createChild();
			const hold = await initial.acquireWorkingSession();
			const saved = parseWorkingSession(JSON.stringify(hold.state));
			await hold.release();
			expect(saved.settings.toolExposure).toEqual({ lookup_weather: "deferred" });

			const { session } = await createAgentSessionFromServices({
				services: await createServices(saved),
				sessionManager: openWorkingSession(saved),
				workingSession: saved,
			});
			sessions.push(session);
			expect(exposureOf(session)).toBe("deferred");
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		});
	});
});
