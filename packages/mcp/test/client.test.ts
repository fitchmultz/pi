import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpClient,
	McpError,
	McpTimeoutError,
	type ServerCapabilities,
} from "../src/index.ts";
import { createInMemoryTransportPair, type InMemoryTransport } from "../src/testing/index.ts";

interface TestServer {
	transport: InMemoryTransport;
	messages: JsonRpcMessage[];
	setHandler(method: string, handler: (request: JsonRpcRequest) => unknown | Promise<unknown>): void;
}

async function createServer(
	capabilities: ServerCapabilities = { tools: { listChanged: true } },
): Promise<{ clientTransport: InMemoryTransport; server: TestServer }> {
	const pair = createInMemoryTransportPair();
	const handlers = new Map<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>();
	const messages: JsonRpcMessage[] = [];
	pair.server.onMessage((message) => {
		messages.push(message);
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const handler = handlers.get(request.method);
		queueMicrotask(async () => {
			try {
				if (!handler) throw new McpError(-32601, `Method not found: ${request.method}`);
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
			} catch (error) {
				const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
				await pair.server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: mcpError.code, message: mcpError.message, data: mcpError.data },
				});
			}
		});
	});
	await pair.server.start();
	const server: TestServer = {
		transport: pair.server,
		messages,
		setHandler(method, handler) {
			handlers.set(method, handler);
		},
	};
	server.setHandler("initialize", () => ({
		protocolVersion: LATEST_PROTOCOL_VERSION,
		capabilities,
		serverInfo: { name: "test-server", version: "1.0.0" },
		instructions: "Use test tools.",
	}));
	return { clientTransport: pair.client, server };
}

async function connect(capabilities?: ServerCapabilities): Promise<{ client: McpClient; server: TestServer }> {
	const { clientTransport, server } = await createServer(capabilities);
	const client = new McpClient({ name: "test-client", version: "2.0.0" });
	await client.connect(clientTransport);
	return { client, server };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("McpClient", () => {
	it("initializes the connection before exposing server information", async () => {
		const { client, server } = await connect();
		expect(client.connectionState).toBe("connected");
		expect(client.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
		expect(client.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
		expect(client.serverCapabilities).toEqual({ tools: { listChanged: true } });
		expect(client.instructions).toBe("Use test tools.");
		expect(server.messages).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "test-client", version: "2.0.0" },
				},
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
		]);
		await client.close();
	});

	it("paginates tools and preserves protocol tool definitions", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/list", (request) => {
			const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
			return cursor === undefined
				? {
						tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
						nextCursor: "page-2",
					}
				: {
						tools: [
							{
								name: "read",
								inputSchema: { type: "object" },
								outputSchema: { type: "object" },
								annotations: { readOnlyHint: true },
							},
						],
					};
		});
		expect(await client.listTools()).toEqual([
			{ name: "search", description: "Search", inputSchema: { type: "object" } },
			{
				name: "read",
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
				annotations: { readOnlyHint: true },
			},
		]);
		await client.close();
	});

	it("paginates prompt definitions and sends string arguments unchanged to prompts/get", async () => {
		const { client, server } = await connect({ prompts: { listChanged: true } });
		server.setHandler("prompts/list", (request) =>
			(request.params as { cursor?: string } | undefined)?.cursor === undefined
				? {
						prompts: [
							{
								name: "brief",
								title: "Brief",
								description: "Summarize a subject",
								arguments: [
									{ name: "subject", description: "Subject to summarize", required: true },
									{ name: "detail", required: false },
								],
							},
						],
						nextCursor: "page-2",
					}
				: { prompts: [{ name: "welcome" }] },
		);
		expect(await client.listPrompts()).toEqual([
			{
				name: "brief",
				title: "Brief",
				description: "Summarize a subject",
				arguments: [
					{ name: "subject", description: "Subject to summarize", required: true },
					{ name: "detail", required: false },
				],
			},
			{ name: "welcome" },
		]);
		expect(server.messages.filter((message) => "method" in message && message.method === "prompts/list")).toEqual([
			{ jsonrpc: "2.0", id: 2, method: "prompts/list" },
			{ jsonrpc: "2.0", id: 3, method: "prompts/list", params: { cursor: "page-2" } },
		]);
		server.setHandler("prompts/get", () => ({
			description: "Prepared brief",
			messages: [
				{ role: "user", content: { type: "text", text: "Summarize the subject" } },
				{
					role: "assistant",
					content: { type: "resource", resource: { uri: "docs://brief", text: "Reference notes" } },
				},
			],
		}));
		const args = Object.fromEntries([
			["subject", "a=b 日本語"],
			["detail", ""],
			["__proto__", "safe"],
		]);
		expect(await client.getPrompt("brief", args)).toEqual({
			description: "Prepared brief",
			messages: [
				{ role: "user", content: { type: "text", text: "Summarize the subject" } },
				{
					role: "assistant",
					content: { type: "resource", resource: { uri: "docs://brief", text: "Reference notes" } },
				},
			],
		});
		await client.getPrompt("welcome");
		expect(server.messages.filter((message) => "method" in message && message.method === "prompts/get")).toEqual([
			{
				jsonrpc: "2.0",
				id: 4,
				method: "prompts/get",
				params: { name: "brief", arguments: { subject: "a=b 日本語", detail: "", ["__proto__"]: "safe" } },
			},
			{ jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "welcome" } },
		]);
		await client.close();
	});

	it.each([
		{ label: "missing name", prompt: {} },
		{ label: "non-string title", prompt: { name: "brief", title: 7 } },
		{ label: "non-string description", prompt: { name: "brief", description: 7 } },
		{ label: "non-array arguments", prompt: { name: "brief", arguments: {} } },
		{ label: "null argument", prompt: { name: "brief", arguments: [null] } },
		{ label: "non-string argument name", prompt: { name: "brief", arguments: [{ name: 7 }] } },
		{ label: "non-boolean required", prompt: { name: "brief", arguments: [{ name: "subject", required: "yes" }] } },
		{
			label: "non-string argument description",
			prompt: { name: "brief", arguments: [{ name: "subject", description: 7 }] },
		},
	])("rejects prompt definitions with $label at the wire boundary", async ({ prompt }) => {
		const { client, server } = await connect({ prompts: {} });
		server.setHandler("prompts/list", () => ({ prompts: [prompt] }));
		try {
			await expect(client.listPrompts()).rejects.toMatchObject({
				name: "McpError",
				code: -32600,
				message: "Invalid entry in MCP prompts/list result",
			});
		} finally {
			await client.close();
		}
	});

	it("accepts the protocol content variants in prompt messages", async () => {
		const { client, server } = await connect({ prompts: {} });
		server.setHandler("prompts/get", () => ({
			messages: [
				{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
				{ role: "assistant", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } },
				{ role: "user", content: { type: "resource_link", uri: "docs://brief", name: "brief" } },
				{
					role: "assistant",
					content: {
						type: "resource",
						resource: { uri: "docs://pdf", blob: "JVBERg==", mimeType: "application/pdf" },
					},
				},
			],
		}));
		expect(await client.getPrompt("media")).toEqual({
			messages: [
				{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
				{ role: "assistant", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } },
				{ role: "user", content: { type: "resource_link", uri: "docs://brief", name: "brief" } },
				{
					role: "assistant",
					content: {
						type: "resource",
						resource: { uri: "docs://pdf", blob: "JVBERg==", mimeType: "application/pdf" },
					},
				},
			],
		});
		await client.close();
	});

	// PromptMessage and ContentBlock require valid roles and payloads, not just a string `type`.
	it.each([
		{ label: "system role", message: { role: "system", content: { type: "text", text: "unsafe" } } },
		{ label: "missing role", message: { content: { type: "text", text: "unsafe" } } },
		{ label: "null content", message: { role: "user", content: null } },
		{ label: "unknown content type", message: { role: "user", content: { type: "unknown" } } },
		{ label: "missing text", message: { role: "user", content: { type: "text" } } },
		{ label: "non-string text", message: { role: "user", content: { type: "text", text: 7 } } },
		{ label: "missing image data", message: { role: "user", content: { type: "image", mimeType: "image/png" } } },
		{ label: "missing image MIME type", message: { role: "user", content: { type: "image", data: "AAAA" } } },
		{
			label: "non-string audio data",
			message: { role: "assistant", content: { type: "audio", data: 7, mimeType: "audio/wav" } },
		},
		{ label: "missing audio MIME type", message: { role: "assistant", content: { type: "audio", data: "AAAA" } } },
		{
			label: "missing resource link URI",
			message: { role: "user", content: { type: "resource_link", name: "brief" } },
		},
		{
			label: "missing resource link name",
			message: { role: "user", content: { type: "resource_link", uri: "docs://brief" } },
		},
		{ label: "missing embedded resource", message: { role: "user", content: { type: "resource" } } },
		{
			label: "missing embedded resource contents",
			message: { role: "user", content: { type: "resource", resource: { uri: "docs://brief" } } },
		},
		{
			label: "missing embedded resource URI",
			message: { role: "user", content: { type: "resource", resource: { text: "notes" } } },
		},
		{
			label: "non-string embedded blob",
			message: { role: "user", content: { type: "resource", resource: { uri: "docs://brief", blob: 7 } } },
		},
	])("rejects prompt messages with $label at the wire boundary", async ({ message }) => {
		const { client, server } = await connect({ prompts: {} });
		server.setHandler("prompts/get", () => ({ messages: [message] }));
		try {
			await expect(client.getPrompt("broken")).rejects.toMatchObject({
				name: "McpError",
				code: -32600,
				message: "Invalid MCP prompts/get result",
			});
		} finally {
			await client.close();
		}
	});

	it("lists and reads resources", async () => {
		const { client, server } = await connect();
		server.setHandler("resources/list", (request) =>
			(request.params as { cursor?: string } | undefined)?.cursor === undefined
				? { resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }], nextCursor: "2" }
				: { resources: [{ uri: "file:///b" }] },
		);
		server.setHandler("resources/templates/list", () => ({
			resourceTemplates: [{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }],
		}));
		server.setHandler("resources/read", (request) => ({
			contents: [{ uri: (request.params as { uri: string }).uri, text: "hello" }],
		}));
		// A missing name falls back to the URI.
		expect(await client.listResources()).toEqual([
			{ uri: "file:///a", name: "a", mimeType: "text/plain" },
			{ uri: "file:///b", name: "file:///b" },
		]);
		expect(await client.listResourceTemplates()).toEqual([{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }]);
		// Single pages pass the cursor through.
		expect(await client.listResourcesPage()).toEqual({
			resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }],
			nextCursor: "2",
		});
		expect(await client.listResourcesPage("2")).toEqual({ resources: [{ uri: "file:///b", name: "file:///b" }] });
		expect(await client.readResource("file:///a")).toEqual({ contents: [{ uri: "file:///a", text: "hello" }] });

		server.setHandler("resources/read", () => ({ contents: [{ uri: "file:///a" }] }));
		await expect(client.readResource("file:///a")).rejects.toThrow("Invalid contents in MCP resources/read result");
		server.setHandler("resources/list", () => ({ resources: [{ name: "no uri" }] }));
		await expect(client.listResources()).rejects.toThrow("Invalid entry in MCP resources/list result");
		await client.close();
	});

	it("returns structured tool content and surfaces JSON-RPC errors", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", (request) => {
			const params = request.params as { name: string; arguments?: Record<string, unknown> };
			if (params.name === "fail") throw new McpError(1234, "tool failed", { retryable: false });
			return {
				content: [{ type: "text", text: "ok" }],
				structuredContent: { count: params.arguments?.count },
			};
		});
		expect(await client.callTool("count", { count: 3 })).toEqual({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { count: 3 },
		});
		await expect(client.callTool("fail")).rejects.toMatchObject({
			name: "McpError",
			code: 1234,
			message: "tool failed",
			data: { retryable: false },
		});
		await client.close();
	});

	it("renews the timeout on progress", async () => {
		vi.useFakeTimers();
		const { client, server } = await connect();
		server.setHandler("tools/call", async (request) => {
			const token = ((request.params as Record<string, unknown>)._meta as Record<string, unknown>)
				.progressToken as number;
			setTimeout(() => {
				void server.transport.send({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: token, progress: 1, total: 2 },
				});
			}, 40);
			await new Promise((resolve) => setTimeout(resolve, 80));
			return { content: [{ type: "text", text: "done" }] };
		});
		const progress = vi.fn();
		const result = client.callTool("slow", {}, { timeoutMs: 50, onProgress: progress });
		await vi.advanceTimersByTimeAsync(40);
		await vi.advanceTimersByTimeAsync(40);
		expect(await result).toEqual({ content: [{ type: "text", text: "done" }] });
		expect(progress).toHaveBeenCalledWith({ progressToken: 2, progress: 1, total: 2 });
		await client.close();
	});

	it("cancels aborted and timed-out requests", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => new Promise(() => {}));
		const controller = new AbortController();
		const aborted = client.callTool("wait", {}, { signal: controller.signal });
		controller.abort("stop");
		await expect(aborted).rejects.toBeInstanceOf(McpAbortError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.messages).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 2, reason: "stop" },
		});

		await expect(client.callTool("wait", {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(McpTimeoutError);
		await client.close();
	});

	it("reports transport errors without failing pending requests", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		let respond = () => {};
		server.setHandler(
			"tools/call",
			() =>
				new Promise((resolve) => {
					respond = () => resolve({ content: [] });
				}),
		);
		const call = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		clientTransport.emitError(new Error("stray log line"));
		respond();
		expect(await call).toEqual({ content: [] });
		expect(errors.map((error) => error.message)).toEqual(["stray log line"]);
		await client.close();
	});

	it("accepts servers that answer with an older protocol version", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => ({
			protocolVersion: "2024-11-05",
			capabilities: {},
			serverInfo: { name: "old-server", version: "0.1.0" },
		}));
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		expect(client.protocolVersion).toBe("2024-11-05");
		await client.close();

		const unsupported = await createServer();
		unsupported.server.setHandler("initialize", () => ({
			protocolVersion: "1999-01-01",
			capabilities: {},
			serverInfo: { name: "ancient-server", version: "0.1.0" },
		}));
		const rejected = new McpClient({ name: "test-client", version: "1.0.0" });
		await expect(rejected.connect(unsupported.clientTransport)).rejects.toThrow("unsupported protocol version");
		expect(rejected.connectionState).toBe("closed");
	});

	it("defaults omitted tool content but rejects malformed result payloads", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => ({ structuredContent: { ok: true } }));
		expect(await client.callTool("structured")).toEqual({ content: [], structuredContent: { ok: true } });
		for (const result of [
			{ content: "not a list" },
			{ content: [{ type: "text", text: 7 }] },
			{ content: [{ type: "resource", resource: { uri: "docs://broken" } }] },
			{ content: [], isError: "true" },
		]) {
			server.setHandler("tools/call", () => result);
			await expect(client.callTool("broken")).rejects.toMatchObject({
				name: "McpError",
				code: -32600,
				message: "Invalid MCP tools/call result",
			});
		}
		await client.close();
	});

	it("does not send notifications/cancelled for a timed-out initialize", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => new Promise(() => {}));
		const client = new McpClient({ name: "test-client", version: "1.0.0", requestTimeoutMs: 5 });
		await expect(client.connect(clientTransport)).rejects.toBeInstanceOf(McpTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
		).toBe(false);
	});

	it("notifies close listeners once when the transport drops", async () => {
		const { client, server } = await connect();
		const closed = vi.fn();
		client.onClose(closed);
		server.setHandler("tools/call", () => new Promise(() => {}));
		const pending = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await server.transport.close();
		await expect(pending).rejects.toThrow("MCP connection closed");
		expect(client.connectionState).toBe("closed");
		await client.close();
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("answers roots/list and dispatches notifications", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({
			name: "test-client",
			version: "1.0.0",
			roots: [{ uri: "file:///workspace", name: "workspace" }],
		});
		await client.connect(clientTransport);
		const changed = vi.fn();
		client.onNotification("notifications/tools/list_changed", changed);
		await server.transport.send({ jsonrpc: "2.0", id: "roots", method: "roots/list" });
		await server.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.messages).toContainEqual({
			jsonrpc: "2.0",
			id: "roots",
			result: { roots: [{ uri: "file:///workspace", name: "workspace" }] },
		});
		expect(changed).toHaveBeenCalledWith(undefined);
		await client.close();
	});
});
