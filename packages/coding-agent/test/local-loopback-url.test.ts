import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { clearSameHostLoopbackCache, resolveSameHostLoopbackBaseUrl } from "../src/core/local-loopback-url.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function findNonInternalLocalUrlHost(): { host: string; loopback: string } | undefined {
	for (const entries of Object.values(networkInterfaces())) {
		if (!entries) continue;
		for (const entry of entries) {
			if (entry.internal) continue;
			if (entry.family === "IPv4") {
				return { host: entry.address, loopback: "127.0.0.1" };
			}
		}
	}
	return undefined;
}

afterEach(() => {
	clearSameHostLoopbackCache();
});

describe("resolveSameHostLoopbackBaseUrl", () => {
	it("rewrites same-host http tailnet URLs to 127.0.0.1 when loopback is listening and preserves path/slash shape", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const { port } = server.address() as AddressInfo;

		try {
			const localAddresses = new Set(["100.121.227.24"]);
			const resolveHost = async (host: string) =>
				host === "mitchs-m5-mbp.tail854973.ts.net" ? [{ address: "100.121.227.24", family: 4 }] : [];

			await expect(
				resolveSameHostLoopbackBaseUrl(`http://mitchs-m5-mbp.tail854973.ts.net:${port}/v1`, undefined, {
					localAddresses,
					resolveHost,
				}),
			).resolves.toBe(`http://127.0.0.1:${port}/v1`);

			await expect(
				resolveSameHostLoopbackBaseUrl(`http://100.121.227.24:${port}`, undefined, {
					localAddresses,
					resolveHost,
				}),
			).resolves.toBe(`http://127.0.0.1:${port}`);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("leaves remote hosts, https URLs, and ports without a loopback listener unchanged", async () => {
		const localAddresses = new Set(["100.121.227.24"]);
		const resolveHost = async (host: string) =>
			host === "local.tail854973.ts.net"
				? [{ address: "100.121.227.24", family: 4 }]
				: [{ address: "100.99.88.77", family: 4 }];

		await expect(
			resolveSameHostLoopbackBaseUrl("http://remote.tail854973.ts.net:8000/v1", undefined, {
				localAddresses,
				resolveHost,
				probeLoopback: async () => true,
			}),
		).resolves.toBe("http://remote.tail854973.ts.net:8000/v1");

		await expect(
			resolveSameHostLoopbackBaseUrl("https://local.tail854973.ts.net:8000/v1", undefined, {
				localAddresses,
				resolveHost,
				probeLoopback: async () => true,
			}),
		).resolves.toBe("https://local.tail854973.ts.net:8000/v1");

		await expect(
			resolveSameHostLoopbackBaseUrl("http://local.tail854973.ts.net:8000/v1", undefined, {
				localAddresses,
				resolveHost,
				probeLoopback: async () => false,
			}),
		).resolves.toBe("http://local.tail854973.ts.net:8000/v1");
	});

	it("requires explicit preferLocalLoopback opt-in and preserves configured baseUrl for custom fetch", async () => {
		const localInterface = findNonInternalLocalUrlHost();
		expect(localInterface).toBeDefined();

		const observedHosts: string[] = [];
		const server = createServer((req, res) => {
			observedHosts.push(req.headers.host ?? "");
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
		const { port } = server.address() as AddressInfo;
		const configuredBaseUrl = `http://${localInterface!.host}:${port}/v1`;

		try {
			const credentials = new InMemoryCredentialStore();
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
			const modelDef = {
				id: "test-model",
				name: "Test Model",
				reasoning: false,
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 1024,
			};

			// Default (preferLocalLoopback omitted): preserves original authority over real transport.
			runtime.registerProvider("default-provider", {
				baseUrl: configuredBaseUrl,
				apiKey: "local",
				api: "openai-completions",
				models: [modelDef],
			});
			await runtime.completeSimple(runtime.getModel("default-provider", "test-model")!, {
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			});
			expect(observedHosts).toEqual([`${localInterface!.host}:${port}`]);

			// Opt-in provider (preferLocalLoopback: true): connects via 127.0.0.1 when using default transport...
			runtime.registerProvider("opt-in-provider", {
				baseUrl: configuredBaseUrl,
				apiKey: "local",
				api: "openai-completions",
				preferLocalLoopback: true,
				models: [modelDef],
			});
			const optInModel = runtime.getModel("opt-in-provider", "test-model")!;
			const liveRes = await runtime.completeSimple(optInModel, {
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			});
			expect(liveRes.stopReason).toBe("stop");
			expect(observedHosts).toEqual([`${localInterface!.host}:${port}`, `${localInterface!.loopback}:${port}`]);

			// ...and skips rewriting on the exact same opt-in provider when caller supplies custom fetch:
			let capturedCustomFetchUrl: string | undefined;
			await runtime.completeSimple(
				optInModel,
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					fetch: async (input) => {
						capturedCustomFetchUrl = String(input);
						return new Response(
							'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						);
					},
				},
			);
			expect(capturedCustomFetchUrl).toBe(`${configuredBaseUrl}/chat/completions`);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
