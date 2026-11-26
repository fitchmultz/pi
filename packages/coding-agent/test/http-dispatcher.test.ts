import { spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	formatHttpIdleTimeoutMs,
	getSessionHttpFetch,
	HTTP_IDLE_TIMEOUT_CHOICES,
} from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;
const DISPATCHER_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("applies httpProxy to HTTP_PROXY and HTTPS_PROXY", () => {
		applyHttpProxySettings("http://127.0.0.1:7890");

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("does not override existing proxy env vars", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890");

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});

	it("updates and clears setting-owned proxy env vars without touching caller-provided ones", () => {
		process.env.HTTP_PROXY = "http://caller-http:8080";

		applyHttpProxySettings("http://settings-a:7890");
		expect(process.env.HTTP_PROXY).toBe("http://caller-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://settings-a:7890");

		applyHttpProxySettings("http://settings-b:7890");
		expect(process.env.HTTP_PROXY).toBe("http://caller-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://settings-b:7890");

		applyHttpProxySettings(undefined);
		expect(process.env.HTTP_PROXY).toBe("http://caller-http:8080");
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});
});

describe("http dispatcher", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedProxyEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedProxyEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof DISPATCHER_PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(async () => {
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedProxyEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	// #247: a caught request rejection must not leave a stream error that terminates Node.
	it("rejects malformed encoded responses without terminating the process", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`
import assert from "node:assert/strict";
import net from "node:net";
import { getGlobalDispatcher } from "undici";
import { configureHttpDispatcher } from ${JSON.stringify(new URL("../src/core/http-dispatcher.ts", import.meta.url).href)};

for (const key of ${JSON.stringify(DISPATCHER_PROXY_ENV_KEYS)}) delete process.env[key];
configureHttpDispatcher();
const server = net.createServer((socket) => {
	socket.on("error", () => {});
	socket.once("data", () => socket.end(
		"HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\\r\\nContent-Length: 10\\r\\nConnection: close\\r\\n\\r\\n",
	));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	await assert.rejects(async () => {
		const response = await fetch("http://127.0.0.1:" + server.address().port);
		await response.arrayBuffer();
	});
} finally {
	await Promise.all([getGlobalDispatcher().close(), new Promise((resolve) => server.close(resolve))]);
}
console.log("process survived");
`,
			],
			{ cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("process survived");
	});

	it("tunnels proxied HTTP origins", async () => {
		const origin = http.createServer((_request, response) => {
			response.end("origin");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const originAddress = origin.address();
		if (!originAddress || typeof originAddress === "string") {
			throw new Error("Origin did not bind to a TCP port");
		}

		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.once("data", (data) => {
				const [requestLine = ""] = data.toString().split("\r\n");
				proxyRequestLines.push(requestLine);
				if (!requestLine.startsWith("CONNECT ")) {
					client.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
					return;
				}

				const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") {
			throw new Error("Proxy did not bind to a TCP port");
		}

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		try {
			const originUrl = `http://127.0.0.1:${originAddress.port}/v1/chat/completions`;
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			expect(proxyRequestLines).not.toHaveLength(0);
			expect(proxyRequestLines).toEqual(
				expect.arrayContaining([
					expect.stringMatching(`^CONNECT 127\\.0\\.0\\.1:${originAddress.port} HTTP/1\\.1$`),
				]),
			);
		} finally {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
		}
	});

	it("allows two seconds for HTTPS connection attempts without changing the Node default", async () => {
		// Preserve a deliberate host fetch override while testing the dispatcher itself.
		globalThis.fetch = async () => {
			throw new Error("Unexpected global fetch");
		};
		const originalAttemptTimeoutMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
		const connectSpy = vi.spyOn(tls, "connect").mockImplementation(() => {
			throw new Error("Connection captured");
		});

		configureHttpDispatcher();
		await expect(undici.fetch("https://example.invalid")).rejects.toThrow();

		expect(connectSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				autoSelectFamilyAttemptTimeout: 2_000,
			}),
		);
		expect(connectSpy.mock.calls[0]?.[0]).not.toHaveProperty("autoSelectFamily");
		expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(originalAttemptTimeoutMs);
	});

	it("exposes a 20 min HTTP idle timeout choice for long reasoning requests", () => {
		expect(HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.timeoutMs)).toEqual([
			30_000, 60_000, 120_000, 300_000, 1_200_000, 0,
		]);
		expect(formatHttpIdleTimeoutMs(1_200_000)).toBe("20 min");
	});

	it("isolates per-session httpIdleTimeoutMs without mutating the global dispatcher or host overrides", async () => {
		const server = http.createServer((_request, response) => {
			setTimeout(() => {
				response.end("delayed-ok");
			}, 1_250);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Server did not bind to a TCP port");
		}
		const url = `http://127.0.0.1:${address.port}/interactions`;
		try {
			// Simulate a shorter process-wide headersTimeout than the session's configured httpIdleTimeoutMs
			// (Undici checks headersTimeout on 1-second fastTimer ticks).
			configureHttpDispatcher(100);
			const globalBefore = undici.getGlobalDispatcher();
			expect(getSessionHttpFetch({ httpIdleTimeoutMs: 100 })).toBeUndefined();

			const longFetch = getSessionHttpFetch({ httpIdleTimeoutMs: 5_000 });
			expect(longFetch).toBeDefined();
			expect(undici.getGlobalDispatcher()).toBe(globalBefore);

			// Long-timeout session succeeds without loosening the process-wide dispatcher.
			await expect(longFetch!(url).then((response) => response.text())).resolves.toBe("delayed-ok");
			await expect(undici.fetch(url)).rejects.toThrow();
			expect(getSessionHttpFetch({ httpIdleTimeoutMs: 5_000 })).toBe(longFetch);

			// A shorter-timeout session cannot narrow a longer-timeout session either.
			configureHttpDispatcher(5_000);
			const shortFetch = getSessionHttpFetch({ httpIdleTimeoutMs: 100 });
			expect(shortFetch).toBeDefined();
			await expect(shortFetch!(url)).rejects.toThrow();
			await expect(undici.fetch(url).then((response) => response.text())).resolves.toBe("delayed-ok");

			// Host overrides of globalThis.fetch or the global Undici dispatcher are preserved.
			const activeBeforeCustom = undici.getGlobalDispatcher();
			const customAgent = new undici.Agent();
			try {
				undici.setGlobalDispatcher(customAgent);
				expect(getSessionHttpFetch({ httpIdleTimeoutMs: 1_200_000 })).toBeUndefined();
			} finally {
				undici.setGlobalDispatcher(activeBeforeCustom);
				if (typeof customAgent.close === "function") await customAgent.close();
			}
			globalThis.fetch = async () => {
				throw new Error("Host fetch override");
			};
			expect(getSessionHttpFetch({ httpIdleTimeoutMs: 1_200_000 })).toBeUndefined();
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("does not replace host WebSocket or EventSource globals from getSessionHttpFetch", () => {
		const moduleUrl = new URL("../src/core/http-dispatcher.ts", import.meta.url).href;
		const script = `
			import { getSessionHttpFetch } from ${JSON.stringify(moduleUrl)};
			const customWebSocket = class CustomWebSocket {};
			const customEventSource = class CustomEventSource {};
			globalThis.WebSocket = customWebSocket;
			globalThis.EventSource = customEventSource;
			const originalFetch = globalThis.fetch;
			const sessionFetch = getSessionHttpFetch({ httpIdleTimeoutMs: 1_200_000 });
			if (typeof sessionFetch !== "function") throw new Error("expected sessionFetch");
			if (globalThis.WebSocket !== customWebSocket) throw new Error("WebSocket replaced");
			if (globalThis.EventSource !== customEventSource) throw new Error("EventSource replaced");
			if (globalThis.fetch !== originalFetch) throw new Error("global fetch replaced");
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
	});
});
