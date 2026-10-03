import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
					JSON.stringify({ httpProxy: diskProxy.url, httpIdleTimeoutMs: 5000 }),
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
		http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, route, timeoutCode
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
				let stderr = "";
				const child = spawn(
					process.execPath,
					["--import", resolverUrl, cliPath, "--working-session", statePath, "--help"],
					{
						cwd: h.tempDir,
						env,
						stdio: ["ignore", "ignore", "pipe"],
					},
				);
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
					const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
					child.on("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					child.on("close", (code, signal) => {
						clearTimeout(timer);
						done({ code, signal });
					});
				});
				expect({ ...result, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
				expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({
					http: explicit ? callerProxy.url : savedProxy.url,
					https: explicit ? callerProxy.url : savedProxy.url,
					route: explicit ? "caller C" : "saved A",
					timeoutCode: "UND_ERR_HEADERS_TIMEOUT",
				});
			} finally {
				h.cleanup();
				await Promise.all([savedProxy.close(), diskProxy.close(), callerProxy.close()]);
			}
		},
		15000,
	);
});
