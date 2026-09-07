import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";
import type { streamSimple } from "../src/api/openai-responses.ts";
import { createResponsesServer, replyWithOutput, textOutput } from "./responses-websocket-server.ts";

it("bundles and runs direct Responses over HTTP without Node socket dependencies", async () => {
	const bundle = await build({
		entryPoints: [fileURLToPath(new URL("../src/api/openai-responses.ts", import.meta.url))],
		bundle: true,
		platform: "browser",
		format: "iife",
		globalName: "PiResponses",
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	expect(Object.keys(bundle.metafile.inputs).join("\n")).not.toMatch(
		/node_modules\/(?:ws|http-proxy-agent|https-proxy-agent)\//,
	);
	const browser = runInNewContext(`${bundle.outputFiles[0].text}\nPiResponses;`, {
		URL,
		URLSearchParams,
		Headers,
		Request,
		Response,
		ReadableStream,
		TextEncoder,
		TextDecoder,
		FormData,
		Blob,
		File,
		crypto: globalThis.crypto,
		queueMicrotask,
		AbortController,
		AbortSignal,
		setTimeout,
		clearTimeout,
		fetch: globalThis.fetch,
		console,
	}) as { streamSimple: typeof streamSimple };
	const server = await createResponsesServer((request) =>
		replyWithOutput(request, "browser", [textOutput("browser")]),
	);
	try {
		const result = await browser
			.streamSimple(
				server.model,
				{ messages: [{ role: "user", content: "browser input", timestamp: 0 }] },
				{
					apiKey: "local-key",
					sessionId: "browser-session",
					transport: "auto",
				},
			)
			.result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.responseId).toBe("browser");
		expect(server.connections).toHaveLength(0);
		expect(server.requests.map((request) => request.transport)).toEqual(["sse"]);
		expect(server.requests[0].headers.session_id).toBe("browser-session");
		expect(server.errors).toEqual([]);
	} finally {
		await server.close();
	}
});
