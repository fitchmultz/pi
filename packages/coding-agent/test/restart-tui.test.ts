import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requestRestart } from "../src/cli/restart-protocol.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.env.PI_TEST_CLI ?? join(packageDir, "dist", "bundle", "cli.js");
const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const resources: Array<{ root: string; socket: string }> = [];

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

interface Receipt {
	event: string;
	pid: number;
	version: string;
	sessionId: string;
	sessionFile: string;
	endpoint: string;
	text?: string;
	calls?: number;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-restart-tui-"));
	const socket = `restart-${root.split("-").at(-1)}`;
	resources.push({ root, socket });
	const home = join(root, "home");
	const agentDir = join(home, "agent");
	const cwd = join(root, "work");
	for (const path of [home, agentDir, cwd]) mkdirSync(path, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ quietStartup: true, enableInstallTelemetry: false, experimental: { firstTimeSetup: false } }),
	);
	const log = join(root, "receipts.jsonl");
	const status = join(root, "exit-code");
	return {
		root,
		log,
		status,
		extension(version: string, restartCommand?: string, holdWork = false) {
			const path = join(root, `${version}.ts`);
			writeFileSync(
				path,
				`
import { appendFileSync, existsSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
export default function(pi) {
 const faux = fauxProvider();
 pi.registerProvider('faux', { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: 'faux-key', models: faux.models, streamSimple: faux.provider.streamSimple });
 const record = (event, ctx, extra = {}) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({event, pid:process.pid, version:${JSON.stringify(version)}, sessionId:ctx.sessionManager.getSessionId(), sessionFile:ctx.sessionManager.getSessionFile(), endpoint:process.env.PI_RESTART_SOCKET, ...extra}) + '\\n');
 pi.registerTool({ name:'completed_work', label:'Completed work', description:'Records one completed side effect', parameters:Type.Object({}), async execute(_id,_args,signal,_update,ctx) { record('work',ctx); ${holdWork ? `while (!existsSync(${JSON.stringify(join(root, "release-work"))}) && !signal?.aborted) await new Promise(r=>setTimeout(r,10));` : ""} return {content:[{type:'text',text:'Completed'}],details:{}}; } });
 pi.on('session_start', (_event,ctx) => { record('start',ctx); });
 pi.on('before_agent_start', (event,ctx) => {
  const resumed = event.prompt.startsWith('[Restart continuation]');
  record('prompt',ctx,{text:event.prompt});
  faux.setResponses(resumed ? [fauxAssistantMessage('Continuation handled')] : [
   fauxAssistantMessage([fauxToolCall('completed_work',{}), ${restartCommand ? `fauxToolCall('bash',{command:${JSON.stringify(restartCommand)}})` : "fauxToolCall('completed_work',{})"}],{stopReason:'toolUse'}),
   fauxAssistantMessage('Seed completed')
  ]);
 });
 pi.on('agent_settled', (_event,ctx) => record('settled',ctx,{calls:faux.state.callCount}));
 pi.on('session_shutdown', async (_event,ctx) => { await new Promise(r=>setTimeout(r,50)); record('shutdown',ctx); });
}
`,
			);
			return path;
		},
		start(extension: string) {
			if (!existsSync(cli)) throw new Error(`Build the coding-agent package first: missing ${cli}`);
			const script = join(root, "launch.sh");
			const command = [
				"env",
				"-i",
				`PATH=${process.env.PATH}`,
				`HOME=${home}`,
				`PI_CODING_AGENT_DIR=${agentDir}`,
				"PI_OFFLINE=1",
				"PI_TELEMETRY=0",
				"TERM=xterm-256color",
				"JITI_FS_CACHE=0",
				process.execPath,
				cli,
				"--offline",
				"-ne",
				"-ns",
				"-np",
				"-nc",
				"--no-themes",
				"--no-approve",
				"--tui-mode",
				"regular",
				"--provider",
				"faux",
				"--model",
				"faux-1",
				"-e",
				extension,
				"Seed prompt",
			];
			writeFileSync(script, `${command.map(quote).join(" ")}\nprintf '%s\\n' "$?" > ${quote(status)}\nsleep 60\n`);
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
				script,
			]);
		},
		read(): Receipt[] {
			return existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as Receipt)
				: [];
		},
		screen() {
			return execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-200", "-t", "test"], {
				encoding: "utf8",
			});
		},
		keys(...keys: string[]) {
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", "test", ...keys]);
		},
		async wait(predicate: (receipts: Receipt[]) => boolean) {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (predicate(this.read())) return;
				if (existsSync(status)) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			throw new Error(
				`Terminal did not reach expected state:\n${this.screen()}\n${existsSync(log) ? readFileSync(log, "utf8") : "No receipts"}`,
			);
		},
	};
}

afterEach(async () => {
	for (const { root, socket } of resources.splice(0)) {
		const log = join(root, "receipts.jsonl");
		const pid = existsSync(log)
			? readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Receipt)
					.findLast((r) => r.event === "start")?.pid
			: undefined;
		if (pid && !existsSync(join(root, "exit-code"))) {
			try {
				process.kill(pid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			const deadline = Date.now() + 3000;
			while (!existsSync(join(root, "exit-code")) && Date.now() < deadline)
				await new Promise((r) => setTimeout(r, 25));
		}
		spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
		rmSync(root, { recursive: true, force: true });
	}
});

// Real terminal, private tmux socket, isolated HOME and faux provider: no network or paid requests.
describe.skipIf(!hasTmux)("managed restart in a real TUI (also supports PI_TEST_CLI)", () => {
	it.each([false, true])(
		"starts a replacement on the same session, continuation once, completed work never replayed; rollback=%s",
		async (rollback) => {
			const f = fixture();
			const v2 = f.extension("v2");
			const candidate = join(f.root, "candidate");
			if (rollback) {
				mkdirSync(join(candidate, "dist", "bundle"), { recursive: true });
				writeFileSync(
					join(candidate, "dist", "bundle", "cli-worker.js"),
					`import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(join(f.root, "candidate-starts"))}, 'started\\n'); process.exit(17);`,
				);
			} else symlinkSync(resolve(dirname(cli), "../.."), candidate, "dir");
			const command = `${quote(process.execPath)} ${quote(cli)} restart --runtime ${quote(candidate)} -e ${quote(v2)} --message 'Continue the task once'`;
			const v1 = f.extension("v1", command);
			f.start(v1);
			await f.wait((r) => r.filter((x) => x.event === "settled").length === 2);
			const receipts = f.read();
			const starts = receipts.filter((r) => r.event === "start");
			expect(starts).toHaveLength(2);
			expect(starts[1].pid).not.toBe(starts[0].pid);
			expect(starts[1].sessionId).toBe(starts[0].sessionId);
			expect(starts[1].sessionFile).toBe(starts[0].sessionFile);
			expect(starts[1].version).toBe(rollback ? "v1" : "v2");
			const prompts = receipts.filter((r) => r.event === "prompt");
			expect(prompts).toHaveLength(2);
			expect(prompts[1].text).toContain("[Restart continuation]");
			expect(prompts[1].text).toContain("Continue the task once");
			expect(receipts.filter((r) => r.event === "work")).toHaveLength(1);
			expect(receipts.findIndex((r) => r.event === "shutdown")).toBeLessThan(
				receipts.findIndex((r) => r.pid === starts[1].pid),
			);
			const journal = readFileSync(starts[1].sessionFile, "utf8");
			expect(journal).toContain("Restart queued.");
			const users = journal
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							type: string;
							message?: { role: string; content: Array<{ type: string; text?: string }> };
						},
				)
				.filter((entry) => entry.type === "message" && entry.message?.role === "user");
			expect(users).toHaveLength(2);
			if (rollback) {
				expect(prompts[1].text).toContain("exited before becoming ready");
				expect(readFileSync(join(f.root, "candidate-starts"), "utf8").trim().split("\n")).toHaveLength(1);
			}
			f.keys("/quit", "Enter");
			await f.wait(() => existsSync(f.status));
			expect(readFileSync(f.status, "utf8").trim()).toBe("0");
			expect(f.read().filter((r) => r.event === "start")).toHaveLength(2);
		},
		60_000,
	);

	it("/restart works and refuses an unsent draft through the control socket", async () => {
		const f = fixture();
		f.start(f.extension("v1"));
		await f.wait((r) => r.some((x) => x.event === "settled"));
		const endpoint = f.read().find((r) => r.event === "prompt")!.endpoint;
		f.keys("draft must survive");
		await new Promise((r) => setTimeout(r, 150));
		await expect(requestRestart(endpoint, {})).rejects.toThrow("unsent editor text");
		expect(f.screen()).toContain("draft must survive");
		f.keys("C-c");
		f.keys("/restart Slash continuation", "Enter");
		await f.wait((r) => r.filter((x) => x.event === "settled").length === 2);
		expect(
			f
				.read()
				.filter((r) => r.event === "prompt")
				.at(-1)?.text,
		).toBe("[Restart continuation]\nSlash continuation");
		expect(f.read().filter((r) => r.event === "work")).toHaveLength(2);
	}, 60_000);

	it.each(["interrupt", "draft"])(
		"waits for running work and cancels a queued restart on %s",
		async (action) => {
			const f = fixture();
			f.start(f.extension("v1", undefined, true));
			await f.wait((r) => r.some((x) => x.event === "work"));
			const endpoint = f.read().find((r) => r.event === "prompt")!.endpoint;
			expect(await requestRestart(endpoint, { message: "Must not run" })).toContain("Restart queued");
			await new Promise((r) => setTimeout(r, 200));
			expect(f.read().filter((r) => r.event === "start")).toHaveLength(1);
			expect(f.read().filter((r) => r.event === "shutdown")).toHaveLength(0);
			if (action === "interrupt") f.keys("Escape");
			else {
				f.keys("preserve this draft");
				writeFileSync(join(f.root, "release-work"), "");
			}
			await f.wait((r) => r.some((x) => x.event === "settled"));
			await new Promise((r) => setTimeout(r, 200));
			expect(f.screen()).toContain("Restart cancelled");
			if (action === "draft") expect(f.screen()).toContain("preserve this draft");
			expect(f.read().filter((r) => r.event === "start")).toHaveLength(1);
			expect(f.read().filter((r) => r.event === "prompt")).toHaveLength(1);
		},
		60_000,
	);
});
