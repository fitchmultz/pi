import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const packageDir = resolve(__dirname, "..");
const sourceResolver = join(packageDir, "src", "experimental", "source-resolver.ts");
const sourceLauncher = join(packageDir, "src", "cli-launcher.ts");
const bundledLauncher = join(packageDir, "dist", "bundle", "cli.js");
const resources: Array<{ root: string; socket: string }> = [];

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

afterEach(() => {
	for (const { root, socket } of resources.splice(0)) {
		spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
		rmSync(root, { recursive: true, force: true });
	}
});

// Uses a private tmux server, isolated config and the faux provider: no credentials, network or paid model calls.
describe.skipIf(!hasTmux)("managed Pi in a real terminal", () => {
	it.each([false, true])(
		"resumes automatically after a staged extension/runtime update (failed candidate: %s)",
		async (failCandidate) => {
			expect(existsSync(bundledLauncher), "Build the coding-agent bundle before this terminal test").toBe(true);
			const root = mkdtempSync(join(tmpdir(), "pi-restart-tui-"));
			const socket = `pi-restart-${root.split("-").at(-1)}`;
			resources.push({ root, socket });
			const home = join(root, "home");
			const agentDir = join(home, "agent");
			const cwd = join(root, "work");
			for (const path of [home, agentDir, cwd]) mkdirSync(path, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ quietStartup: true, enableInstallTelemetry: false }),
			);
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
			const status = join(root, "exit-code");
			const launch = join(root, "launch.sh");
			const launcherArgs = process.env.PI_TEST_CLI
				? [process.env.PI_TEST_CLI]
				: ["--import", sourceResolver, sourceLauncher];
			const args = [
				"env",
				"-i",
				`PATH=${process.env.PATH}`,
				`HOME=${home}`,
				`PI_CODING_AGENT_DIR=${agentDir}`,
				"PI_OFFLINE=1",
				"PI_TELEMETRY=0",
				"TERM=xterm-256color",
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
				"--thinking",
				"off",
				"-e",
				first,
				"Exercise the update path once",
				"Finish the second startup prompt before restarting",
			];
			writeFileSync(
				launch,
				`#!/bin/sh\n${args.map(quote).join(" ")}\nprintf '%s\\n' "$?" > ${quote(status)}\nsleep 60\n`,
			);
			execFileSync("tmux", [
				"-L",
				socket,
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
			let screen = "";
			try {
				await vi.waitFor(() => expect(existsSync(status)).toBe(true), { timeout: 25_000, interval: 100 });
			} catch (error) {
				screen =
					spawnSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-200", "-t", "test"], { encoding: "utf8" })
						.stdout ?? "";
				throw new Error(
					`Pi terminal did not exit.\n${screen}\nTrace:\n${existsSync(trace) ? readFileSync(trace, "utf8") : "none"}`,
					{ cause: error },
				);
			}
			screen = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-200", "-t", "test"], {
				encoding: "utf8",
			});
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
