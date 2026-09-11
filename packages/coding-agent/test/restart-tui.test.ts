import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestRestart } from "../src/cli/restart-protocol.ts";

const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const packageDir = resolve(__dirname, "..");
const sourceResolver = join(packageDir, "src", "experimental", "source-resolver.ts");
const sourceLauncher = join(packageDir, "src", "cli-launcher.ts");
const bundledLauncher = join(packageDir, "dist", "bundle", "cli.js");
const resources: Array<{ root: string; socket: string }> = [];

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
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
		start(args: string[], env: string[] = []) {
			const launch = join(root, "launch.sh");
			const launcherArgs = process.env.PI_TEST_CLI
				? [process.env.PI_TEST_CLI]
				: ["--import", sourceResolver, sourceLauncher];
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
				"-ne",
				"-ns",
				"-np",
				"-nc",
				"--no-themes",
				"--no-approve",
				"--provider",
				"faux",
				"--model",
				"faux-1",
				...args,
			];
			writeFileSync(launch, `${command.map(quote).join(" ")}\nprintf '%s\\n' "$?" > ${quote(status)}\nsleep 60\n`);
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
	pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(shutdown)}, "shutdown"));
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
		expect(existsSync(shutdown)).toBe(false);
		expect(JSON.parse(readFileSync(beforeExit, "utf8"))).toEqual({
			calls: 0,
			managed: "1",
			restartEnabled: false,
			stdinRaw: false,
			stdinPaused: true,
		});
	});

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
import { appendFileSync, writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
export default function(pi) {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("Saved seed response")]);
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "faux-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	let timer;
	pi.on("session_start", (_event, ctx) => {
		appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }) + "\\n");
		timer = setInterval(() => writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({
			pid: process.pid, socket: process.env.PI_RESTART_SOCKET, editor: ctx.ui.getEditorText(),
			paused: process.stdin.isPaused(), idle: ctx.isIdle(), calls: faux.state.callCount
		})), 20);
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

	it.each([false, true])(
		"resumes automatically after a staged extension/runtime update (failed candidate: %s)",
		async (failCandidate) => {
			expect(existsSync(bundledLauncher), "Build the coding-agent bundle before this terminal test").toBe(true);
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
				packageDir,
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
import { Type } from "typebox";
const record = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({version:${JSON.stringify(version)},pid:process.pid,...value}) + "\\n");
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
		record({event:"start",resumed,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),cwd:ctx.cwd});
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
	pi.on("session_shutdown", (_event,ctx) => { record({event:"shutdown",sessionFile:ctx.sessionManager.getSessionFile(),calls:faux.state.callCount}); });
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
							pid: number;
							sessionId?: string;
							sessionFile?: string;
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
