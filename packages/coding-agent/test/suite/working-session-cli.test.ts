import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

// The SDK cannot exercise main's dispatcher before extension factories run.
const cliPath = resolve(import.meta.dirname, "../../src/cli.ts");
const resolverUrl = pathToFileURL(resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts")).href;

async function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const child = spawn(process.execPath, ["--import", resolverUrl, cliPath, ...args], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
		(done, reject) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				done({ code, signal, stdout, stderr });
			});
		},
	);
}

async function proxy(label: string) {
	const origin = http.createServer((request, response) => {
		if (request.url === "/timeout") {
			const timer = setTimeout(() => response.end(label), 2500);
			response.on("close", () => clearTimeout(timer));
		} else response.end(label);
	});
	await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
	const originAddress = origin.address();
	if (!originAddress || typeof originAddress === "string") throw new Error("Origin did not bind");
	const server = http.createServer();
	server.on("connect", (_request, client, head) => {
		const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream).pipe(client);
		});
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
		client.on("close", () => upstream.destroy());
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Proxy did not bind");
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			origin.closeAllConnections();
			await Promise.all([
				new Promise<void>((done) => server.close(() => done())),
				new Promise<void>((done) => origin.close(() => done())),
			]);
		},
	};
}

describe("CLI working-session bootstrap", () => {
	it.each([true, false])("restores builtin MCP selection instead of new CLI flags; disabled=%s", async (disabled) => {
		const h = await createHarness();
		try {
			const hold = await h.session.acquireWorkingSession();
			const state = hold.state;
			await hold.release();
			const model = h.session.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Native capture model missing");
			state.model = { provider: model.provider, id: model.id };
			const observation = join(h.tempDir, "commands.json");
			const extension = join(h.tempDir, "observe.ts");
			writeFileSync(
				extension,
				`import {existsSync, readFileSync, writeFileSync} from "node:fs";
export default function(pi) {
	const path = ${JSON.stringify(observation)};
	pi.on("session_start", () => {
		const observed = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
		observed.push({
			mcp: pi.getCommands().some(command => command.name === "mcp"),
			flag: pi.getFlag("saved-choice"), offline: process.env.PI_OFFLINE
		});
		writeFileSync(path, JSON.stringify(observed));
	});
	pi.registerFlag("saved-choice", {type: "string", default: "new default"});
	pi.registerCommand("replace", {handler: async (_args, ctx) => {await ctx.newSession();}});
}`,
			);
			state.launch!.extensions = ["builtin:mcp", extension];
			state.launch!.offline = true;
			state.flags = [["saved-choice", "saved selection"]];
			if (disabled) state.launch!.disabledBuiltinExtensions = ["mcp"];
			// Empty native history must not acquire synthetic model/thinking metadata on startup.
			state.entries = [];
			state.leafId = null;
			state.sessionFile = join(h.tempDir, "empty-native.jsonl");
			const statePath = join(h.tempDir, "working-session.json");
			writeFileSync(statePath, JSON.stringify(state));
			const result = await runCli(
				["--working-session", statePath, "--print", ...(disabled ? [] : ["--no-mcp"]), "/replace"],
				h.tempDir,
				{ ...process.env, [ENV_AGENT_DIR]: h.tempDir, PI_OFFLINE: "1" },
			);
			expect(result.signal).toBeNull();
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual([
				{ mcp: !disabled, flag: "saved selection", offline: "1" },
				{ mcp: !disabled, flag: "saved selection", offline: "1" },
			]);
			expect(readFileSync(state.sessionFile, "utf8")).toBe(`${JSON.stringify(state.header)}\n`);
		} finally {
			h.cleanup();
		}
	});

	it("refuses launch-less artifacts before materializing their missing journal", async () => {
		const h = await createHarness();
		try {
			const hold = await h.session.acquireWorkingSession();
			const state = hold.state;
			await hold.release();
			delete state.launch;
			state.sessionFile = join(h.tempDir, "refused.jsonl");
			const statePath = join(h.tempDir, "working-session.json");
			writeFileSync(statePath, JSON.stringify(state));
			const result = await runCli(["--working-session", statePath, "--help"], h.tempDir, {
				...process.env,
				[ENV_AGENT_DIR]: h.tempDir,
				PI_OFFLINE: "1",
			});
			expect(existsSync(state.sessionFile)).toBe(false);
			expect(result.signal).toBeNull();
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("CLI native restore requires a launch descriptor");
		} finally {
			h.cleanup();
		}
	});

	it.each([
		{ args: ["--version"], output: /^\d+\.\d+\.\d+/ },
		{ args: ["config", "--help"], output: /config/ },
		{ args: ["update", "--help"], output: /update/ },
		{ args: ["--print", "--no-extensions", "--no-session"], output: undefined },
	])(
		"keeps command routing and normal timeout validation with invalid global settings: $args",
		async ({ args, output }) => {
			const h = await createHarness();
			try {
				const agentDir = join(h.tempDir, "agent");
				mkdirSync(agentDir);
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: "5m" }));
				const result = await runCli(args, h.tempDir, {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
				});
				expect(result.signal).toBeNull();
				if (output) {
					expect(result.stderr).toBe("");
					expect(result.code).toBe(0);
					expect(result.stdout).toMatch(output);
				} else {
					expect(result.code).toBe(1);
					expect(result.stderr).toContain("Invalid httpIdleTimeoutMs setting: 5m");
				}
			} finally {
				h.cleanup();
			}
		},
	);

	it.each([false, true])(
		"restores proxy and effective idle timeout before factories; caller env=%s",
		async (explicit) => {
			const savedProxy = await proxy("saved A");
			const diskProxy = await proxy("disk B");
			const callerProxy = await proxy("caller C");
			const h = await createHarness({ settings: { httpProxy: savedProxy.url, httpIdleTimeoutMs: 5000 } });
			try {
				const agentDir = join(h.tempDir, "agent");
				mkdirSync(agentDir);
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ httpProxy: diskProxy.url, httpIdleTimeoutMs: 5000, extensions: [] }),
				);
				mkdirSync(join(h.tempDir, ".pi"));
				writeFileSync(join(h.tempDir, ".pi", "settings.json"), JSON.stringify({ extensions: [] }));
				const layerObservation = join(h.tempDir, "saved-layer-loaded");
				writeFileSync(
					join(h.tempDir, "layer.ts"),
					`import {writeFileSync} from "node:fs"; export default function() {
	writeFileSync(${JSON.stringify(layerObservation)}, "saved project origin");
}`,
				);
				const model = h.session.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
				if (!model) throw new Error("Native capture model missing");
				const observation = join(h.tempDir, "factory.json");
				const extension = join(h.tempDir, "factory.ts");
				writeFileSync(
					extension,
					`import {writeFileSync} from "node:fs";
export default async function() {
	if (!process.env.NATIVE_PROXY_PROBE) return;
	const route = await fetch("http://native-bootstrap.invalid/probe").then(response => response.text());
	let timeoutCode;
	try { await fetch("http://native-bootstrap.invalid/timeout"); }
	catch (error) { timeoutCode = error.cause?.code; }
	writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
		http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, route, timeoutCode,
		offline: process.env.PI_OFFLINE
	}));
}`,
				);
				const loader = new DefaultResourceLoader({
					cwd: h.tempDir,
					agentDir,
					settingsManager: h.settingsManager,
					additionalExtensionPaths: [extension],
					noContextFiles: true,
				});
				await loader.reload();
				h.session.modelRuntime.setOffline(true);
				const initial = await createAgentSession({
					cwd: h.tempDir,
					agentDir,
					model,
					modelRuntime: h.session.modelRuntime,
					settingsManager: h.settingsManager,
					resourceLoader: loader,
					sessionManager: SessionManager.inMemory(h.tempDir),
				});
				const statePath = join(h.tempDir, "working-session.json");
				try {
					// Capture unsent overrides after normal resource reload has read settings.
					// Proxy selection is global-only; idle timeout uses the effective value.
					h.settingsManager.applyOverrides({
						httpProxy: "http://ignored-project.invalid:4040",
						httpIdleTimeoutMs: 10,
					});
					const hold = await initial.session.acquireWorkingSession();
					expect(hold.state.settings.httpIdleTimeoutMs).toBe(10);
					expect(hold.state.settingsLayers.global.httpIdleTimeoutMs).toBe(5000);
					expect(hold.state.settingsLayers.global.httpProxy).toBe(savedProxy.url);
					hold.state.launch!.trustProject = true;
					hold.state.settingsLayers.project.extensions = ["../layer.ts"];
					hold.state.settings.extensions = ["../layer.ts"];
					writeFileSync(statePath, JSON.stringify(hold.state));
					await hold.release();
				} finally {
					initial.session.dispose();
				}
				const env: NodeJS.ProcessEnv = {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
					NATIVE_PROXY_PROBE: "1",
				};
				for (const key of [
					"HTTP_PROXY",
					"HTTPS_PROXY",
					"http_proxy",
					"https_proxy",
					"ALL_PROXY",
					"all_proxy",
					"NO_PROXY",
					"no_proxy",
				])
					delete env[key];
				if (explicit) env.HTTP_PROXY = env.HTTPS_PROXY = callerProxy.url;
				const { stdout: _stdout, ...result } = await runCli(
					["--working-session", statePath, "--help"],
					h.tempDir,
					env,
				);
				expect(result).toEqual({ code: 0, signal: null, stderr: "" });
				expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({
					http: explicit ? callerProxy.url : savedProxy.url,
					https: explicit ? callerProxy.url : savedProxy.url,
					route: explicit ? "caller C" : "saved A",
					timeoutCode: "UND_ERR_HEADERS_TIMEOUT",
					offline: "1",
				});
				expect(readFileSync(layerObservation, "utf8")).toBe("saved project origin");
			} finally {
				h.cleanup();
				await Promise.all([savedProxy.close(), diskProxy.close(), callerProxy.close()]);
			}
		},
		15000,
	);
});
