import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { clearExtensionCache } from "../../src/core/extensions/loader.ts";
import { RUNTIME_RECORD_ENTRY, type RuntimeRecordData } from "../../src/core/runtime-record.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { type CustomEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { resolveWorkingSession } from "../../src/core/working-session.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

/** Custom entry type the test extension appends in its `session_start` handler. */
const PROBE_ENTRY = "probe";

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function runtimeRecords(entries: SessionEntry[]): CustomEntry<RuntimeRecordData>[] {
	return entries.filter(
		(entry): entry is CustomEntry<RuntimeRecordData> =>
			entry.type === "custom" && entry.customType === RUNTIME_RECORD_ENTRY,
	);
}

/** Runtime records and the probe entries of `session_start` handlers, in journal order, as `type:reason`. */
function startTrail(entries: SessionEntry[]): string[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom") return [];
		if (entry.customType === RUNTIME_RECORD_ENTRY) return [`record:${(entry.data as RuntimeRecordData).trigger}`];
		return entry.customType === PROBE_ENTRY ? [`probe:${entry.data}`] : [];
	});
}

function readJournal(file: string): SessionEntry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry | { type: "session" })
		.filter((entry): entry is SessionEntry => entry.type !== "session");
}

describe("pi.runtime session record", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		clearExtensionCache();
	});

	/**
	 * A runtime with file-backed sessions and the real resource loader. Its extension appends a probe entry
	 * in `session_start` unless `probe` is `"off"`.
	 */
	async function createRuntimeForTest(probe: "on" | "off" = "on", onSessionStart?: (reason: string) => void) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-runtime-record-")));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(agentDir);
		mkdirSync(cwd);

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							const model = faux.getModel();
							pi.registerProvider(model.provider, {
								baseUrl: model.baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map(
									({ id, name, api, reasoning, input, cost, contextWindow, maxTokens }) => ({
										id,
										name,
										api,
										reasoning,
										input,
										cost,
										contextWindow,
										maxTokens,
									}),
								),
							});
							pi.on("session_start", (event) => onSessionStart?.(event.reason));
							if (probe === "on") pi.on("session_start", (event) => pi.appendEntry(PROBE_ENTRY, event.reason));
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
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
		const start = async () => {
			const runtime = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir,
				sessionManager: SessionManager.create(cwd, sessionDir),
			});
			cleanups.push(() => runtime.dispose());
			return runtime;
		};
		cleanups.push(() => {
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		});
		return { start, faux, agentDir, cwd, sessionDir, root };
	}

	/** A git package with one extension, enabled in the user settings, and a loose extension in the agent directory. */
	function installSources(root: string, agentDir: string) {
		const packageDir = join(root, "fixture-package");
		mkdirSync(packageDir);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "fixture-package", version: "1.2.3", pi: { extensions: ["./extension.ts"] } }),
		);
		writeFileSync(join(packageDir, "extension.ts"), "export default function () {}\n");
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
				cwd: packageDir,
				encoding: "utf8",
			}).trim();
		git("init", "--quiet");
		git("add", ".");
		git("commit", "--quiet", "-m", "fixture");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));

		const looseExtension = join(agentDir, "extensions", "loose.ts");
		mkdirSync(join(agentDir, "extensions"));
		writeFileSync(looseExtension, "export default function () {}\n// loose\n");
		return { packageDir, looseExtension, git };
	}

	it("writes one record ahead of the handlers' entries at startup, new, resume, fork and reload", async () => {
		const { start } = await createRuntimeForTest();
		const runtime = await start();
		// Reload starts the session again only for a bound host, which any binding makes.
		const bind = () => runtime.session.bindExtensions({ shutdownHandler: () => {} });

		await bind();
		await runtime.session.prompt("hello");
		const firstFile = runtime.session.sessionFile!;
		expect(readJournal(firstFile).map((entry) => (entry.type === "custom" ? entry.customType : entry.type))).toEqual(
			expect.arrayContaining([RUNTIME_RECORD_ENTRY, PROBE_ENTRY, "message"]),
		);
		expect(startTrail(readJournal(firstFile))).toEqual(["record:startup", "probe:startup"]);

		await runtime.newSession();
		await bind();
		expect(startTrail(runtime.session.sessionManager.getEntries())).toEqual(["record:new", "probe:new"]);

		await runtime.switchSession(firstFile);
		await bind();
		expect(startTrail(readJournal(firstFile))).toEqual([
			"record:startup",
			"probe:startup",
			"record:resume",
			"probe:resume",
		]);

		// A fork before the first message carries the entries ahead of it, including the source's record.
		await runtime.fork(runtime.session.getUserMessagesForForking()[0]!.entryId);
		await bind();
		expect(runtime.session.sessionFile).not.toBe(firstFile);
		expect(startTrail(runtime.session.sessionManager.getEntries())).toEqual([
			"record:startup",
			"probe:startup",
			"record:fork",
			"probe:fork",
		]);

		await runtime.session.reload();
		expect(startTrail(runtime.session.sessionManager.getEntries()).slice(-2)).toEqual([
			"record:reload",
			"probe:reload",
		]);
	});

	it("writes no record for a session without a journal", async () => {
		const starts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event) => void starts.push(event.reason));
				},
			],
		});
		cleanups.push(() => harness.cleanup());

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		// Both starts happened, and neither left a record.
		expect(starts).toEqual(["startup", "reload"]);
		expect(runtimeRecords(harness.sessionManager.getEntries())).toEqual([]);
	});

	it("creates no file for a new session that ends without a message", async () => {
		const { start, sessionDir } = await createRuntimeForTest();
		const runtime = await start();

		await runtime.session.bindExtensions({});
		// The record exists, so only the journal's deferral keeps the session off disk.
		expect(startTrail(runtime.session.sessionManager.getEntries())).toEqual(["record:startup", "probe:startup"]);
		await runtime.dispose();

		expect(readdirSync(sessionDir)).toEqual([]);
	});

	it("leaves a session's picker entry and position unchanged when it is resumed without activity", async () => {
		const { start, cwd, sessionDir } = await createRuntimeForTest();
		const saved = (name: string, timestamp: number) => {
			const manager = SessionManager.create(cwd, sessionDir);
			manager.appendMessage({ role: "user", content: [{ type: "text", text: `${name} question` }], timestamp });
			manager.appendMessage({ ...fauxAssistantMessage(`${name} answer`), timestamp: timestamp + 1 });
			manager.appendSessionInfo(name);
			return manager.getSessionFile()!;
		};
		const older = saved("older", Date.now() - 120_000);
		const newer = saved("newer", Date.now() - 60_000);
		const picker = async () =>
			(await SessionManager.list(cwd, sessionDir)).map(({ path, modified, messageCount, firstMessage, name }) => ({
				path,
				modified: modified.getTime(),
				messageCount,
				firstMessage,
				name,
			}));
		const before = await picker();
		expect(before.map((info) => info.path)).toEqual([newer, older]);

		const runtime = await start();
		await runtime.session.bindExtensions({});
		await runtime.switchSession(older);
		await runtime.session.bindExtensions({});
		await runtime.dispose();

		// The resume did write its record at once.
		expect(startTrail(readJournal(older))).toEqual(["record:resume", "probe:resume"]);
		expect(await picker()).toEqual(before);
	});

	it("holds a restored working session's record until its first run", async () => {
		const { start } = await createRuntimeForTest("off");
		const runtime = await start();
		await runtime.session.bindExtensions({});
		await runtime.session.prompt("before the save");
		const hold = await runtime.session.acquireWorkingSession();
		await hold.release();
		const file = hold.state.sessionFile!;
		const saved = readFileSync(file, "utf8");

		const { session } = await createAgentSession({
			workingSession: hold.state,
			modelRuntime: runtime.services.modelRuntime,
			resourceLoader: runtime.services.resourceLoader,
		});
		cleanups.push(() => session.dispose());
		await session.bindExtensions({});

		// A managed restart that rolls back, or a restore that is tried again, must find the journal it saved.
		expect(readFileSync(file, "utf8")).toBe(saved);
		expect(() => resolveWorkingSession(hold.state)).not.toThrow();

		await session.prompt("after the restore");
		const added = readJournal(file).slice(hold.state.entries.length);
		expect(added.map((entry) => (entry.type === "custom" ? entry.data : entry.type))).toEqual([
			expect.objectContaining({ trigger: "startup", process: { pid: process.pid, mode: "print" } }),
			"message",
			"message",
		]);
	});

	it("records trigger restart on a managed restart handoff while emitting session_start startup and holding until first run", async () => {
		const observedStartReasons: string[] = [];
		const { start } = await createRuntimeForTest("off", (reason) => observedStartReasons.push(reason));
		const runtime = await start();
		await runtime.session.bindExtensions({});
		await runtime.session.prompt("before restart");
		const hold = await runtime.session.acquireWorkingSession();
		await hold.release();
		const file = hold.state.sessionFile!;
		const saved = readFileSync(file, "utf8");
		observedStartReasons.length = 0;

		const { session } = await createAgentSession({
			workingSession: hold.state,
			runtimeTrigger: "restart",
			modelRuntime: runtime.services.modelRuntime,
			resourceLoader: runtime.services.resourceLoader,
		});
		cleanups.push(() => session.dispose());
		await session.bindExtensions({
			mode: "tui",
			managedHost: { owner: { pid: 5150 }, ready: Promise.resolve(true) },
		});

		expect(observedStartReasons).toEqual(["startup"]);
		expect(readFileSync(file, "utf8")).toBe(saved);
		expect(() => resolveWorkingSession(hold.state)).not.toThrow();

		await session.prompt("after restart");
		const added = readJournal(file).slice(hold.state.entries.length);
		expect(added.map((entry) => (entry.type === "custom" ? entry.data : entry.type))).toEqual([
			expect.objectContaining({
				trigger: "restart",
				process: { pid: process.pid, mode: "tui", launcherPid: 5150 },
			}),
			"message",
			"message",
		]);
	});

	it("never sends a record to the provider", async () => {
		const { start, faux, agentDir } = await createRuntimeForTest();
		const contextFile = "Unique context file text.\n";
		writeFileSync(join(agentDir, "AGENTS.md"), contextFile);
		const requests: string[] = [];
		const answer = (text: string) => (context: unknown) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage(text);
		};
		faux.setResponses([answer("one"), answer("two")]);
		const runtime = await start();

		await runtime.session.bindExtensions({});
		await runtime.session.prompt("first");
		await runtime.switchSession(runtime.session.sessionFile!);
		await runtime.session.bindExtensions({});
		await runtime.session.prompt("second");

		const records = runtimeRecords(runtime.session.sessionManager.getEntries());
		expect(records.map((record) => record.data?.trigger)).toEqual(["startup", "resume"]);
		expect(records[0]!.data?.contextFiles).toEqual([
			{ path: join(agentDir, "AGENTS.md"), bytes: contextFile.length, sha256: sha256(contextFile) },
		]);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			// The context file's text is in the prompt; its hash exists only in the record.
			expect(request).toContain("Unique context file text.");
			expect(request).not.toContain(sha256(contextFile));
			expect(request).not.toContain(RUNTIME_RECORD_ENTRY);
			expect(request).not.toContain("contextFiles");
		}
		// The record between the two turns adds nothing: the second request extends the first by one turn.
		const messages = requests.map((request) => (JSON.parse(request) as { messages: unknown[] }).messages);
		expect(messages[1]!.slice(0, messages[0]!.length)).toEqual(messages[0]);
		expect(messages[1]).toHaveLength(messages[0]!.length + 2);
	});

	it("describes the process, the loaded package, the loose extension and the context files", async () => {
		const { start, agentDir, cwd, root } = await createRuntimeForTest();
		const { packageDir, looseExtension, git } = installSources(root, agentDir);

		// A non-ASCII character makes the byte length differ from the character count.
		const userContext = "User context: café\n";
		const projectContext = "Project context\n";
		writeFileSync(join(agentDir, "AGENTS.md"), userContext);
		writeFileSync(join(cwd, "AGENTS.md"), projectContext);

		const runtime = await start();
		await runtime.session.bindExtensions({
			mode: "rpc",
			managedHost: { owner: { pid: 4242 }, ready: Promise.resolve(true) },
		});

		const [record, ...others] = runtimeRecords(runtime.session.sessionManager.getEntries());
		expect(others).toEqual([]);
		const data = record!.data!;
		expect(data.version).toBe(1);
		expect(data.trigger).toBe("startup");
		expect(data.process).toEqual({ pid: process.pid, mode: "rpc", launcherPid: 4242 });
		expect(data.build.package.name).toBe("@earendil-works/pi-coding-agent");
		expect(data.build.runtime.node).toBe(process.versions.node);
		expect(data.packages).toEqual([
			{ source: packageDir, scope: "user", path: packageDir, version: "1.2.3", commit: git("rev-parse", "HEAD") },
		]);
		expect(data.extensions).toEqual([
			{
				path: looseExtension,
				source: "auto",
				scope: "user",
				sha256: sha256(readFileSync(looseExtension)),
			},
			{ path: "<inline:1>", source: "inline", scope: "temporary" },
		]);
		expect(data.contextFiles).toEqual([
			{ path: join(agentDir, "AGENTS.md"), bytes: Buffer.byteLength(userContext), sha256: sha256(userContext) },
			{ path: join(cwd, "AGENTS.md"), bytes: Buffer.byteLength(projectContext), sha256: sha256(projectContext) },
		]);
		expect(existsSync(runtime.session.sessionFile!)).toBe(false);
	});

	it("reports loaded sources that changed on disk, and records what was loaded, until a reload imports them again", async () => {
		const { start, agentDir, root } = await createRuntimeForTest();
		const { packageDir, looseExtension, git } = installSources(root, agentDir);
		const runtime = await start();
		// Reload starts the session again only for a bound host, which any binding makes.
		const bind = () => runtime.session.bindExtensions({ shutdownHandler: () => {} });
		await bind();
		const loaded = {
			package: { version: "1.2.3", commit: git("rev-parse", "HEAD") },
			extension: { sha256: sha256(readFileSync(looseExtension)) },
		};
		expect(await runtime.session.getStaleSources()).toEqual([]);

		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "fixture-package", version: "1.2.4", pi: { extensions: ["./extension.ts"] } }),
		);
		git("commit", "--quiet", "-am", "update");
		writeFileSync(looseExtension, "export default function () {}\n// edited\n");
		const current = {
			package: { version: "1.2.4", commit: git("rev-parse", "HEAD") },
			extension: { sha256: sha256(readFileSync(looseExtension)) },
		};
		const stale = [
			{
				kind: "extension",
				path: looseExtension,
				source: "auto",
				scope: "user",
				loaded: loaded.extension,
				current: current.extension,
			},
			{
				kind: "package",
				path: packageDir,
				source: packageDir,
				scope: "user",
				loaded: loaded.package,
				current: current.package,
			},
		];
		const staleSources = async () =>
			(await runtime.session.getStaleSources()).sort((a, b) => a.kind.localeCompare(b.kind));
		const recorded = () => {
			const data = runtimeRecords(runtime.session.sessionManager.getEntries()).at(-1)!.data!;
			return { package: data.packages[0], extension: data.extensions[0] };
		};
		expect(await staleSources()).toEqual(stale);

		// A new session in the same process runs the code that is already imported.
		await runtime.newSession();
		await bind();
		expect(await staleSources()).toEqual(stale);
		expect(recorded()).toEqual({
			package: { source: packageDir, scope: "user", path: packageDir, ...loaded.package },
			extension: { path: looseExtension, source: "auto", scope: "user", ...loaded.extension },
		});

		await runtime.session.reload();
		expect(await staleSources()).toEqual([]);
		expect(recorded()).toEqual({
			package: { source: packageDir, scope: "user", path: packageDir, ...current.package },
			extension: { path: looseExtension, source: "auto", scope: "user", ...current.extension },
		});
	});

	it("compares a repaired extension with the code that was imported, not with the import that failed", async () => {
		const { start, agentDir } = await createRuntimeForTest();
		const extension = join(agentDir, "extensions", "repaired.ts");
		mkdirSync(join(agentDir, "extensions"));
		writeFileSync(extension, "export default function () {\n");
		const runtime = await start();
		const bind = () => runtime.session.bindExtensions({ shutdownHandler: () => {} });
		await bind();
		const recordedPaths = () =>
			runtimeRecords(runtime.session.sessionManager.getEntries())
				.at(-1)!
				.data!.extensions.map(({ path, sha256 }) => ({ path, sha256 }));
		expect(recordedPaths()).toEqual([{ path: "<inline:1>" }]);

		// A new session in the same process imports the file again, because no code of it was kept.
		writeFileSync(extension, "export default function () {}\n// repaired\n");
		await runtime.newSession();
		await bind();
		expect(recordedPaths()).toEqual([
			{ path: extension, sha256: sha256(readFileSync(extension)) },
			{ path: "<inline:1>" },
		]);
		expect(await runtime.session.getStaleSources()).toEqual([]);
	});
});
