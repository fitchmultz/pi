import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestRestart } from "../src/cli/restart-protocol.ts";
import { findNodePackageDir } from "../src/config.ts";
import { readSessionCheckpoint } from "../src/core/checkpoint.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const packageDir = resolve(__dirname, "..");
const sourceResolver = join(packageDir, "src", "experimental", "source-resolver.ts");
const sourceLauncher = join(packageDir, "src", "cli-launcher.ts");
const bundledLauncher = join(packageDir, "dist", "bundle", "cli.js");
const resources: Array<{ root: string; socket: string }> = [];
const stagedRuntimes: string[] = [];

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function stageBundledRuntime(version: string): string {
	const scratch = resolve(packageDir, "../..", ".artifacts");
	mkdirSync(scratch, { recursive: true });
	const runtime = mkdtempSync(join(scratch, "restart-runtime-"));
	stagedRuntimes.push(runtime);
	cpSync(join(packageDir, "dist"), join(runtime, "dist"), { recursive: true });
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
	writeFileSync(join(runtime, "package.json"), JSON.stringify({ ...manifest, version }));
	return runtime;
}

function terminalFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-"));
	const socket = `pi-restart-${root.split("-").at(-1)}`;
	resources.push({ root, socket });
	const home = join(root, "home");
	const agentDir = join(home, "agent");
	const cwd = join(root, "work");
	const temporary = join(root, "tmp");
	const status = join(root, "exit-code");
	for (const path of [agentDir, cwd, temporary]) mkdirSync(path, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ quietStartup: true, enableInstallTelemetry: false }),
	);
	return {
		root,
		socket,
		agentDir,
		temporary,
		status,
		start(args: string[], env: string[] = [], discoverExtensions = false, managed = true) {
			const launch = join(root, "launch.sh");
			const launcherArgs =
				managed && process.env.PI_TEST_CLI
					? [process.env.PI_TEST_CLI]
					: ["--import", sourceResolver, managed ? sourceLauncher : join(packageDir, "src", "cli.ts")];
			const command = [
				"env",
				"-i",
				`PATH=${process.env.PATH}`,
				`HOME=${home}`,
				`PI_CODING_AGENT_DIR=${agentDir}`,
				`TMPDIR=${temporary}`,
				"PI_OFFLINE=1",
				"PI_TELEMETRY=0",
				"JITI_FS_CACHE=0",
				"TERM=xterm-256color",
				...env,
				process.execPath,
				...launcherArgs,
				"--offline",
				...(discoverExtensions ? [] : ["-ne"]),
				"-ns",
				"-np",
				"-nc",
				"--no-themes",
				"--no-approve",
				...(args.includes("--checkpoint") ? [] : ["--provider", "faux", "--model", "faux-1"]),
				...args,
			];
			writeFileSync(
				launch,
				`${command.map(quote).join(" ")}\nprintf '%s\\n' "$?" > ${quote(`${status}.tmp`)}\nmv ${quote(`${status}.tmp`)} ${quote(status)}\nsleep 60\n`,
			);
			execFileSync("tmux", [
				"-L",
				socket,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				"test",
				"-x",
				"100",
				"-y",
				"30",
				"-c",
				cwd,
				"sh",
				launch,
			]);
		},
		screen() {
			return execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-200", "-t", "test"], {
				encoding: "utf8",
			});
		},
	};
}

afterEach(() => {
	for (const { root, socket } of resources.splice(0)) {
		spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
		rmSync(root, { recursive: true, force: true });
	}
	for (const path of stagedRuntimes.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

// Uses a private tmux server, isolated config and the faux provider: no credentials, network or paid model calls.
describe.skipIf(!hasTmux)("managed Pi in a real terminal", () => {
	// PR #29: the native control endpoint must not keep a stopped startup benchmark alive.
	it("exits naturally after the managed startup benchmark stops the TUI", async () => {
		const terminal = terminalFixture();
		const { root, temporary, status } = terminal;
		const beforeExit = join(root, "before-exit.json");
		const shutdown = join(root, "shutdown");
		const extension = join(root, "benchmark.ts");
		writeFileSync(
			extension,
			`
import { writeFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
export default function(pi) {
	const faux = fauxProvider();
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "faux-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	let timer;
	pi.on("session_start", () => { timer = setInterval(() => {}, 1000); });
	pi.on("session_shutdown", () => {
		clearInterval(timer);
		writeFileSync(${JSON.stringify(shutdown)}, "shutdown");
	});
	process.once("beforeExit", () => writeFileSync(${JSON.stringify(beforeExit)}, JSON.stringify({
		calls: faux.state.callCount, managed: process.env.PI_MANAGED_CLI, restartEnabled: process.env.PI_RESTART_SOCKET !== undefined,
		stdinRaw: process.stdin.isRaw, stdinPaused: process.stdin.isPaused()
	})));
}
`,
		);
		terminal.start(["--no-session", "-e", extension], ["PI_STARTUP_BENCHMARK=1", "PI_TIMING=1"]);
		try {
			await vi.waitFor(() => expect(existsSync(status)).toBe(true), { timeout: 8_000, interval: 100 });
		} catch (error) {
			throw new Error(`Startup benchmark did not exit naturally.\n${terminal.screen()}`, { cause: error });
		}
		const screen = terminal.screen();
		expect(readFileSync(status, "utf8").trim(), screen).toBe("0");
		expect(screen).toContain("interactiveMode.init:");
		expect(readdirSync(temporary).filter((name) => name.startsWith("pi-restart-"))).toEqual([]);
		expect(readFileSync(shutdown, "utf8")).toBe("shutdown");
		expect(JSON.parse(readFileSync(beforeExit, "utf8"))).toEqual({
			calls: 0,
			managed: "1",
			restartEnabled: false,
			stdinRaw: false,
			stdinPaused: true,
		});
	});

	it.each([true, false])(
		"includes awaited startup handlers in normal timing totals (managed: %s)",
		async (managed) => {
			const terminal = terminalFixture();
			const timingLog = join(terminal.root, "timings.log");
			const extension = join(terminal.root, "slow-startup.ts");
			writeFileSync(
				extension,
				`
import { appendFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
export default function(pi) {
	const original = console.error;
	console.error = (...args) => {
		appendFileSync(${JSON.stringify(timingLog)}, args.join(" ") + "\\n");
		original(...args);
	};
	const faux = fauxProvider();
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "faux-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.on("session_start", async () => {
		await new Promise(resolve => setTimeout(resolve, 120));
		console.error("startup handler complete");
	});
}
`,
			);
			terminal.start(["--no-session", "-e", extension], ["PI_TIMING=1"], false, managed);
			await vi.waitFor(
				() => expect(readFileSync(timingLog, "utf8")).toContain("--- Startup Timings: extensions ---"),
				{
					timeout: 8_000,
				},
			);
			const log = readFileSync(timingLog, "utf8");
			expect(log).toContain("startup handler complete");
			expect(log).toContain("interactiveMode.ready:");
			expect(log.indexOf("startup handler complete")).toBeLessThan(log.indexOf("--- Startup Timings: main ---"));
			const init = Number(log.match(/interactiveMode\.init: ([\d.]+)ms/)?.[1]);
			const total = Number(log.match(/TOTAL: ([\d.]+)ms/)?.[1]);
			expect(init).toBeGreaterThanOrEqual(100);
			expect(total).toBeGreaterThanOrEqual(init);
			expect(log).toContain("--- Startup Timings: extensions ---");
			expect(log).not.toContain("PI_STARTUP_READY");
			execFileSync("tmux", ["-L", terminal.socket, "send-keys", "-t", "test", "C-d"]);
			await vi.waitFor(() => expect(existsSync(terminal.status)).toBe(true));
			expect(readFileSync(terminal.status, "utf8").trim(), terminal.screen()).toBe("0");
		},
	);

	// PR #29: Ctrl+G's asynchronous editor owns input until its result returns to the TUI.
	it.each(["Unsent external draft", ""])(
		"waits for the external editor before restarting (returned text: %j)",
		async (draft) => {
			const terminal = terminalFixture();
			const { root, socket, agentDir, status } = terminal;
			const opened = join(root, "editor-opened.json");
			const released = join(root, "release-editor");
			const editor = join(root, "editor.mjs");
			writeFileSync(
				editor,
				`
import { existsSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, ${JSON.stringify(draft)});
writeFileSync(${JSON.stringify(opened)}, JSON.stringify({ pid: process.pid, parent: process.ppid, file }));
process.stdin.resume();
const timer = setInterval(() => {
	if (!existsSync(${JSON.stringify(released)})) return;
	clearInterval(timer);
	process.stdin.pause();
}, 20);
`,
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					quietStartup: true,
					enableInstallTelemetry: false,
					externalEditor: `${process.execPath} ${editor}`,
				}),
			);
			const trace = join(root, "trace.jsonl");
			const stateFile = join(root, "state.json");
			const extension = join(root, "observe.ts");
			writeFileSync(
				extension,
				`
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
export default function(pi) {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("Saved seed response")]);
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "faux-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	let timer;
	pi.on("session_start", (_event, ctx) => {
		appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }) + "\\n");
		timer = setInterval(() => {
			// Publish complete snapshots while the parent reads this file.
			const pending = ${JSON.stringify(`${stateFile}.tmp`)};
			writeFileSync(pending, JSON.stringify({
				pid: process.pid, socket: process.env.PI_RESTART_SOCKET, editor: ctx.ui.getEditorText(),
				paused: process.stdin.isPaused(), idle: ctx.isIdle(), calls: faux.state.callCount
			}));
			renameSync(pending, ${JSON.stringify(stateFile)});
		}, 20);
		timer.unref();
	});
	pi.on("session_shutdown", () => clearInterval(timer));
}
`,
			);
			terminal.start(["-e", extension, "Save a session before opening the external editor"]);
			const state = () =>
				JSON.parse(readFileSync(stateFile, "utf8")) as {
					pid: number;
					socket: string;
					editor: string;
					paused: boolean;
					idle: boolean;
					calls: number;
				};
			const starts = () =>
				readFileSync(trace, "utf8")
					.trim()
					.split("\n")
					.map(
						(line) =>
							JSON.parse(line) as {
								pid: number;
								sessionId: string;
								sessionFile: string;
							},
					);
			await vi.waitFor(() => expect(state()).toMatchObject({ idle: true, calls: 1, paused: false }), {
				timeout: 8_000,
			});
			const initial = starts()[0];
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", "test", "C-g"]);
			await vi.waitFor(() => expect(existsSync(opened)).toBe(true));
			const editorProcess = JSON.parse(readFileSync(opened, "utf8")) as {
				pid: number;
				parent: number;
				file: string;
			};
			try {
				await vi.waitFor(() =>
					expect(state()).toMatchObject({ pid: initial.pid, paused: true, editor: "", idle: true }),
				);
				expect(editorProcess.parent).toBe(initial.pid);
				expect(await requestRestart(state().socket, { sessionId: initial.sessionId })).toContain("Restart queued");
				// Hold the real editor across multiple 100ms restart checks before letting it return.
				await new Promise((resolve) => setTimeout(resolve, 500));
				expect(
					() => process.kill(initial.pid, 0),
					"Pi must not exit while the external editor owns input",
				).not.toThrow();
				expect(starts()).toHaveLength(1);
				expect(() => process.kill(editorProcess.pid, 0)).not.toThrow();
				writeFileSync(released, "");
				await vi.waitFor(() => expect(() => process.kill(editorProcess.pid, 0)).toThrow());
				if (draft) {
					await vi.waitFor(() =>
						expect(state()).toMatchObject({ pid: initial.pid, editor: draft, paused: false }),
					);
					await vi.waitFor(() => expect(terminal.screen()).toContain("Restart cancelled"));
					expect(starts()).toHaveLength(1);
					execFileSync("tmux", ["-L", socket, "send-keys", "-t", "test", "C-c"]);
					await vi.waitFor(() => expect(state().editor).toBe(""));
				} else {
					await vi.waitFor(() => expect(starts()).toHaveLength(2), { timeout: 8_000 });
					const resumed = starts()[1];
					expect(resumed.pid).not.toBe(initial.pid);
					expect(resumed.sessionId).toBe(initial.sessionId);
					expect(resumed.sessionFile).toBe(initial.sessionFile);
					await vi.waitFor(() =>
						expect(state()).toMatchObject({ pid: resumed.pid, paused: false, editor: "", calls: 0 }),
					);
				}
				expect(existsSync(editorProcess.file)).toBe(false);
				execFileSync("tmux", ["-L", socket, "send-keys", "-t", "test", "C-d"]);
				await vi.waitFor(() => expect(existsSync(status)).toBe(true));
				expect(readFileSync(status, "utf8").trim()).toBe("0");
			} finally {
				writeFileSync(released, "");
				await vi.waitFor(() => expect(() => process.kill(editorProcess.pid, 0)).toThrow());
			}
		},
	);

	it.each([
		{
			name: "defaults",
			args: [],
			initialTools: ["read", "bash", "background_command", "edit", "write"],
			todo: true,
			cold: false,
		},
		{
			name: "cold checkpoint without builtin defaults",
			args: ["--no-builtin-tools"],
			initialTools: [],
			todo: true,
			cold: true,
		},
		{
			name: "cold checkpoint registry restrictions",
			args: ["--tools", "read,todo,known_disabled", "--exclude-tools", "todo"],
			initialTools: ["read"],
			todo: false,
			cold: true,
		},
	])(
		"activates newly installed tools after restarting a used session ($name)",
		async ({ args, initialTools, todo, cold }) => {
			const terminal = terminalFixture();
			const { root, socket, agentDir, status } = terminal;
			const trace = join(root, "selection.jsonl");
			const checkpointPath = join(root, "checkpoint.json");
			const finalCheckpointPath = join(root, "final-checkpoint.json");
			const send = (text: string) => execFileSync("tmux", ["-L", socket, "send-keys", "-t", "test", text, "Enter"]);
			const extension = join(root, "observe-selection.ts");
			writeFileSync(
				extension,
				`
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export default function(pi) {
	const faux = fauxProvider();
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "faux-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	pi.registerTool({ name: "known_disabled", label: "Known disabled", description: "Deliberately inactive", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
	let resumed = false;
	const record = (event, ctx) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ event, pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), leafId: ctx.sessionManager.getLeafId(), cwd: ctx.cwd, model: ctx.model.id, active: pi.getActiveTools(), known: pi.getAllTools().map(tool => tool.name) }) + "\\n");
	pi.on("session_start", (_event, ctx) => {
		resumed = ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "system");
		if (!resumed) pi.setActiveTools(pi.getActiveTools().filter(name => name !== "known_disabled"));
		record("start", ctx);
		faux.setResponses(resumed && ${todo} ? [
			fauxAssistantMessage(fauxToolCall("todo", { action: "add", text: "Native restart works" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { action: "list" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Todo verified")
		] : [fauxAssistantMessage("Saved seed response"), fauxAssistantMessage("Unselected branch response")]);
	});
	pi.registerCommand("select-seed", { handler: async (_args, ctx) => {
		const first = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
		await ctx.navigateTree(first.id, { summarize: false });
		record("selected", ctx);
	} });
	pi.registerCommand("inspect-selection", { handler: async (_args, ctx) => record("inspect", ctx) });
	pi.on("before_agent_start", (_event, ctx) => record("prompt", ctx));
	pi.on("agent_settled", (_event, ctx) => { record("settled", ctx); if (resumed && !${cold}) ctx.shutdown(); });
}
`,
			);
			terminal.start(
				[...args, "-e", extension, "Save the initial tool declarations"],
				cold ? [`PI_CHECKPOINT_EXIT_PATH=${checkpointPath}`] : [],
				true,
			);
			const events = () =>
				readFileSync(trace, "utf8")
					.trim()
					.split("\n")
					.map(
						(line) =>
							JSON.parse(line) as {
								event: string;
								pid: number;
								sessionId: string;
								sessionFile: string;
								leafId: string;
								cwd: string;
								model: string;
								active: string[];
								known: string[];
							},
					);
			try {
				await vi.waitFor(() => expect(events().some((event) => event.event === "settled")).toBe(true), {
					timeout: 8_000,
				});
			} catch (error) {
				throw new Error(`Seed session did not settle.\n${terminal.screen()}`, { cause: error });
			}
			const initial = events().find((event) => event.event === "settled")!;
			expect(initial.active).toEqual(initialTools);
			expect(initial.known).toContain("known_disabled");
			const saved = SessionManager.open(initial.sessionFile);
			const declarations = saved.buildSessionContext().messages.find((message) => message.role === "system");
			expect(declarations?.role).toBe("system");
			expect(declarations?.role === "system" && (declarations.toolsAdded ?? []).map((tool) => tool.name)).toEqual(
				initial.active,
			);
			if (cold) {
				send("Create an unselected branch");
				await vi.waitFor(() => expect(events().filter((event) => event.event === "settled")).toHaveLength(2));
				send("/select-seed");
				await vi.waitFor(() => expect(events().at(-1)?.event).toBe("selected"));
				expect(events().at(-1)?.leafId).toBe(initial.leafId);
				send("/quit");
				await vi.waitFor(() => expect(existsSync(status), terminal.screen()).toBe(true));
				expect(readFileSync(status, "utf8").trim(), terminal.screen()).toBe("0");
				const checkpoint = readSessionCheckpoint(checkpointPath);
				expect(checkpoint.selection.leafId).toBe(initial.leafId);
				expect(checkpoint.entries.at(-1)?.id).not.toBe(initial.leafId);
				expect(checkpoint.toolConfiguration).toEqual(
					todo
						? { noBuiltinTools: true }
						: {
								allowedToolNames: ["read", "todo", "known_disabled"],
								excludedToolNames: ["todo"],
							},
				);
				spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
				rmSync(status);
				// Cold restore must get configuration ONLY from the native artifact, never CLI tool overrides.
				terminal.start(
					["--checkpoint", checkpointPath, "-e", extension],
					[`PI_CHECKPOINT_EXIT_PATH=${finalCheckpointPath}`],
					true,
				);
				await vi.waitFor(() => expect(events().filter((event) => event.event === "start")).toHaveLength(2), {
					timeout: 8_000,
				});
				send("/inspect-selection");
				await vi.waitFor(() => expect(events().at(-1)?.event).toBe("inspect"));
				expect(events().at(-1)).toMatchObject({
					sessionId: initial.sessionId,
					leafId: initial.leafId,
					active: initial.active,
					known: initial.known,
				});
				expect(events().filter((event) => event.event === "prompt")).toHaveLength(2);
			}
			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir);
			copyFileSync(join(packageDir, "examples/extensions/todo.ts"), join(extensionsDir, "todo.ts"));
			writeFileSync(
				join(extensionsDir, "hidden.ts"),
				`
import { Type } from "typebox";
export default function(pi) {
	pi.registerTool({ name: "new_hidden", label: "Hidden", description: "Startup-disabled tool", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
	pi.on("session_start", () => pi.setActiveTools(pi.getActiveTools().filter(name => name !== "new_hidden")));
}
`,
			);
			send("/restart Use todo to add and list");
			await vi.waitFor(
				() => expect(events().filter((event) => event.event === "settled")).toHaveLength(cold ? 3 : 2),
				{ timeout: 12_000 },
			);
			const resumed = events().filter((event) => event.event === "start")[cold ? 2 : 1];
			expect(resumed).toMatchObject({
				sessionId: initial.sessionId,
				sessionFile: initial.sessionFile,
				leafId: initial.leafId,
				cwd: initial.cwd,
				model: initial.model,
			});
			expect(resumed.pid).not.toBe(events().filter((event) => event.event === "start")[cold ? 1 : 0].pid);
			const final = events().at(-1)!;
			expect(events().filter((event) => event.event === "prompt")).toHaveLength(cold ? 3 : 2);
			if (todo) {
				expect(final.known).toEqual(expect.arrayContaining(["todo", "new_hidden", "known_disabled"]));
			} else {
				expect.soft(final.known).toEqual(["read", "known_disabled"]);
			}
			expect.soft(final.active).toEqual([...initial.active, ...(todo ? ["todo"] : [])]);
			const results = SessionManager.open(initial.sessionFile)
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(todo ? 2 : 0);
			for (const result of results) {
				expect.soft(result.isError).toBe(false);
				expect
					.soft(result.details)
					.toMatchObject({ todos: [{ id: 1, text: "Native restart works", done: false }] });
			}
			if (cold) {
				// Defaults must survive not just restart's saved selection, but later native /new too.
				send("/new");
				await vi.waitFor(() => expect(events().filter((event) => event.event === "start")).toHaveLength(4));
				send("/inspect-selection");
				await vi.waitFor(() => expect(events().at(-1)?.event).toBe("inspect"));
				expect.soft(events().at(-1)?.active).toEqual(todo ? ["todo"] : ["read"]);
				send("/quit");
			}
			await vi.waitFor(() => expect(existsSync(status), terminal.screen()).toBe(true));
			expect
				.soft(readFileSync(status, "utf8").trim(), `${terminal.screen()}\n${readFileSync(trace, "utf8")}`)
				.toBe("0");
			if (cold) {
				expect
					.soft(readSessionCheckpoint(finalCheckpointPath).toolConfiguration)
					.toEqual(readSessionCheckpoint(checkpointPath).toolConfiguration);
			}
		},
		25_000,
	);

	it("loads the newly selected package on an ordinary restart without replaying the prior turn", async () => {
		expect(existsSync(bundledLauncher), "Build the coding-agent bundle before this terminal test").toBe(true);
		const firstRuntime = stageBundledRuntime("1.0.0-selector-test");
		const secondRuntime = stageBundledRuntime("2.0.0-selector-test");
		const terminal = terminalFixture();
		const { root, socket, status } = terminal;
		const selector = join(root, "selected");
		const bin = join(root, "bin");
		mkdirSync(bin);
		symlinkSync(firstRuntime, selector);
		const cli = join(bin, "pi");
		symlinkSync("../selected/dist/bundle/cli.js", cli);
		const trace = join(root, "trace.jsonl");
		const extension = join(root, "identity.ts");
		writeFileSync(
			extension,
			`
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, getPackageDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const record = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({pid:process.pid,version:VERSION,packageDir:getPackageDir(),...value}) + "\\n");
record({event:"factory"});
export default function(pi) {
	const faux = fauxProvider();
	pi.registerProvider("faux", { api:faux.api, baseUrl:faux.getModel().baseUrl, apiKey:"faux-key", models:faux.models, streamSimple:faux.provider.streamSimple });
	pi.registerTool({ name:"runtime_probe", label:"Runtime probe", description:"Record the loaded runtime", parameters:Type.Object({}),
		execute:async () => { record({event:"probe"}); return {content:[{type:"text",text:VERSION}],details:{}}; }
	});
	pi.on("session_start", (_event,ctx) => {
		const resumed = VERSION === "2.0.0-selector-test";
		record({event:"start",sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),
			leafId:ctx.sessionManager.getLeafId(),model:ctx.model && [ctx.model.provider,ctx.model.id],active:pi.getActiveTools()});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("runtime_probe",{}),{stopReason:"toolUse"}),
			fauxAssistantMessage(resumed ? "Selected runtime resumed" : "Seed saved")
		]);
	});
	pi.on("before_agent_start", event => record({event:"prompt",text:event.prompt}));
	pi.on("agent_settled", (_event,ctx) => {
		record({event:"settled",leafId:ctx.sessionManager.getLeafId(),active:pi.getActiveTools()});
		if (VERSION === "2.0.0-selector-test") ctx.shutdown();
	});
	pi.on("session_shutdown", (_event,ctx) => record({event:"shutdown",leafId:ctx.sessionManager.getLeafId(),calls:faux.state.callCount}));
}
`,
		);
		const events = () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							event: string;
							pid: number;
							version: string;
							packageDir: string;
							sessionId?: string;
							sessionFile?: string;
							leafId?: string;
							model?: [string, string];
							active?: string[];
							text?: string;
							calls?: number;
						},
				);
		vi.stubEnv("PI_TEST_CLI", cli);
		terminal.start(["-e", extension, "Save the initial prompt once"]);
		try {
			await vi.waitFor(() => expect(events().filter((event) => event.event === "settled")).toHaveLength(1), {
				timeout: 12_000,
			});
			symlinkSync(secondRuntime, `${selector}.next`);
			renameSync(`${selector}.next`, selector);
			execFileSync("tmux", [
				"-L",
				socket,
				"send-keys",
				"-t",
				"test",
				"/restart Inspect the selected runtime",
				"Enter",
			]);
			await vi.waitFor(() => expect(existsSync(status)).toBe(true), { timeout: 20_000 });
		} catch (error) {
			throw new Error(
				`Selected runtime did not resume.\n${terminal.screen()}\n${existsSync(trace) ? readFileSync(trace, "utf8") : ""}`,
				{ cause: error },
			);
		}
		expect(readFileSync(status, "utf8").trim(), terminal.screen()).toBe("0");
		const observed = events();
		const starts = observed.filter((event) => event.event === "start");
		const settled = observed.filter((event) => event.event === "settled");
		expect(starts).toHaveLength(2);
		expect(starts.map((event) => event.version)).toEqual(["1.0.0-selector-test", "2.0.0-selector-test"]);
		expect(starts.map((event) => realpathSync(event.packageDir))).toEqual([
			realpathSync(firstRuntime),
			realpathSync(secondRuntime),
		]);
		expect(starts[1].pid).not.toBe(starts[0].pid);
		expect(starts[1]).toMatchObject({
			sessionId: starts[0].sessionId,
			sessionFile: starts[0].sessionFile,
			leafId: settled[0].leafId,
			model: ["faux", "faux-1"],
			active: settled[0].active,
		});
		expect(starts[0].active).toContain("runtime_probe");
		expect(observed.filter((event) => event.event === "factory")).toHaveLength(2);
		expect(observed.filter((event) => event.event === "probe").map((event) => event.version)).toEqual([
			"1.0.0-selector-test",
			"2.0.0-selector-test",
		]);
		expect(observed.filter((event) => event.event === "prompt").map((event) => event.text)).toEqual([
			"Save the initial prompt once",
			"[Pi restart continuation]\nInspect the selected runtime",
		]);
		expect(observed.filter((event) => event.event === "shutdown").map((event) => event.calls)).toEqual([2, 2]);
		const journal = readFileSync(starts[0].sessionFile!, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(journal.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
	});

	it.each([
		{ failCandidate: false, externalCli: false },
		{ failCandidate: true, externalCli: false },
		{ failCandidate: false, externalCli: true },
	])(
		"resumes automatically after a staged extension/runtime update (failed candidate: $failCandidate, external CLI: $externalCli)",
		async ({ failCandidate, externalCli }) => {
			expect(existsSync(bundledLauncher), "Build the coding-agent bundle before this terminal test").toBe(true);
			if (externalCli) {
				vi.stubEnv("PI_TEST_CLI", join(stageBundledRuntime("98.0.0-external-test"), "dist", "bundle", "cli.js"));
			}
			const initialPackageDir = findNodePackageDir(dirname(realpathSync(process.env.PI_TEST_CLI ?? sourceLauncher)));
			const originalVersion = (
				JSON.parse(readFileSync(join(initialPackageDir, "package.json"), "utf8")) as {
					version: string;
				}
			).version;
			const candidateVersion = "99.0.0-restart-test";
			const candidateRuntime = stageBundledRuntime(candidateVersion);
			const terminal = terminalFixture();
			const { root, status } = terminal;
			const trace = join(root, "trace.jsonl");
			const first = join(root, "v1.ts");
			const second = join(root, "v2.ts");
			const command = [
				process.execPath,
				bundledLauncher,
				"restart",
				"--runtime",
				candidateRuntime,
				"-e",
				second,
				"--message",
				"Verify the activated capability",
			]
				.map(quote)
				.join(" ");
			const extension = (version: string) => `
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, getPackageDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const record = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({version:${JSON.stringify(version)},runtimeVersion:VERSION,packageDir:getPackageDir(),pid:process.pid,...value}) + "\\n");
record({event:"factory"});
${failCandidate && version === "v2" ? 'throw new Error("Deliberately broken candidate");' : ""}
export default function(pi) {
	const faux = fauxProvider();
	let resumed = false;
	pi.registerProvider("faux", { api: faux.api, baseUrl:faux.getModel().baseUrl, apiKey:"faux-key", models:faux.models, streamSimple:faux.provider.streamSimple });
	pi.registerTool({ name:"version_probe",label:"Version probe",description:"Report the activated fixture version",parameters:Type.Object({}),
		execute:async () => { record({event:"probe"}); return {content:[{type:"text",text:${JSON.stringify(version)}}],details:{}}; }
	});
	pi.on("session_start", (_event,ctx) => {
		resumed = ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bash");
		record({event:"start",resumed,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),leafId:ctx.sessionManager.getLeafId(),cwd:ctx.cwd,model:ctx.model && [ctx.model.provider,ctx.model.id],activeTools:pi.getActiveTools()});
		faux.setResponses(resumed ? [
			fauxAssistantMessage(fauxToolCall("version_probe",{}),{stopReason:"toolUse"}),
			fauxAssistantMessage("Verified resumed capability")
		] : [
			fauxAssistantMessage([fauxToolCall("version_probe",{}),fauxToolCall("bash",{command:${JSON.stringify(command)}})],{stopReason:"toolUse"}),
			fauxAssistantMessage("Update requested"),
			fauxAssistantMessage("Second startup prompt completed")
		]);
	});
	pi.on("before_agent_start", event => { record({event:"prompt",text:event.prompt}); });
	pi.on("agent_settled", (_event,ctx) => {
		record({event:"settled",pendingInputs:ctx.getPendingInputCount()});
		if(resumed) ctx.shutdown();
	});
	pi.on("session_shutdown", (_event,ctx) => { record({event:"shutdown",sessionFile:ctx.sessionManager.getSessionFile(),leafId:ctx.sessionManager.getLeafId(),activeTools:pi.getActiveTools(),calls:faux.state.callCount}); });
}
`;
			writeFileSync(first, extension("v1"));
			writeFileSync(second, extension("v2"));
			terminal.start([
				"--thinking",
				"off",
				"-e",
				first,
				"Exercise the update path once",
				"Finish the second startup prompt before restarting",
			]);
			let screen = "";
			try {
				await vi.waitFor(() => expect(existsSync(status)).toBe(true), { timeout: 25_000, interval: 100 });
			} catch (error) {
				screen = terminal.screen();
				throw new Error(
					`Pi terminal did not exit.\n${screen}\nTrace:\n${existsSync(trace) ? readFileSync(trace, "utf8") : "none"}`,
					{ cause: error },
				);
			}
			screen = terminal.screen();
			expect(readFileSync(status, "utf8").trim(), screen).toBe("0");
			expect(screen).toContain("Restarting Pi;");
			expect(screen).toContain("Verified resumed capability");
			const events = readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							event: string;
							version: string;
							runtimeVersion: string;
							packageDir: string;
							pid: number;
							sessionId?: string;
							sessionFile?: string;
							leafId?: string;
							model?: [string, string];
							activeTools?: string[];
							text?: string;
							cwd?: string;
							pendingInputs?: number;
						},
				);
			const starts = events.filter((event) => event.event === "start");
			expect(starts).toHaveLength(2);
			expect(starts[1].sessionId).toBe(starts[0].sessionId);
			expect(starts[1].sessionFile).toBe(starts[0].sessionFile);
			expect(starts[1].pid).not.toBe(starts[0].pid);
			expect(starts[1].version).toBe(failCandidate ? "v1" : "v2");
			expect(starts[1].cwd).toBe(starts[0].cwd);
			expect(starts[0].runtimeVersion).toBe(originalVersion);
			expect(realpathSync(starts[0].packageDir)).toBe(realpathSync(initialPackageDir));
			const candidateFactory = events.find((event) => event.event === "factory" && event.version === "v2");
			expect(candidateFactory?.runtimeVersion).toBe(candidateVersion);
			expect(realpathSync(candidateFactory!.packageDir)).toBe(realpathSync(candidateRuntime));
			expect(starts[1].runtimeVersion).toBe(failCandidate ? originalVersion : candidateVersion);
			expect(realpathSync(starts[1].packageDir)).toBe(
				realpathSync(failCandidate ? initialPackageDir : candidateRuntime),
			);
			const firstShutdown = events.find((event) => event.event === "shutdown" && event.version === "v1");
			expect(starts[1].leafId).toBe(firstShutdown?.leafId);
			expect(starts[1].model).toEqual(starts[0].model);
			expect(starts[1].activeTools).toEqual(firstShutdown?.activeTools);
			const prompts = events.filter((event) => event.event === "prompt");
			expect(prompts).toHaveLength(3);
			expect(prompts[0].text).toBe("Exercise the update path once");
			expect(prompts[1].text).toBe("Finish the second startup prompt before restarting");
			expect(prompts[2].text).toContain("[Pi restart continuation]");
			expect(prompts[2].text).toContain("Verify the activated capability");
			if (failCandidate) expect(prompts[2].text).toContain("failed during startup");
			expect(events.filter((event) => event.event === "settled").map((event) => event.pendingInputs)).toEqual([
				1, 0, 0,
			]);
			expect(events.filter((event) => event.event === "probe").map((event) => event.version)).toEqual([
				"v1",
				failCandidate ? "v1" : "v2",
			]);
			const entries = readFileSync(starts[0].sessionFile!, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
			expect(
				messages.filter((message) => message.role === "toolResult" && message.toolName === "bash"),
			).toHaveLength(1);
			const calls = new Set<string>();
			for (const message of messages) {
				if (message.role === "assistant")
					for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
				if (message.role === "toolResult") {
					expect(calls.delete(message.toolCallId), `Unmatched tool result: ${message.toolCallId}`).toBe(true);
				}
			}
			expect(calls.size).toBe(0);
		},
		30_000,
	);
});
