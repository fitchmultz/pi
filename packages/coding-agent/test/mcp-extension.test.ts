import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
	McpTimeoutError,
	type ServerCapabilities,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { truncateMiddle } from "../src/core/tools/truncate.ts";
import { getMcpToolExposure, loadMcpConfig, type McpServerEntry } from "../src/extensions/mcp/config.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	McpServerLog,
} from "../src/extensions/mcp/runtime.ts";
import { convertMcpResult, createMcpToolName } from "../src/extensions/mcp/tools.ts";

// Config values are resolved at connect time, so the literal reference must survive loading.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
const TOKEN_HEADER = "Bearer ${TOKEN}";

describe("MCP config", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(global: unknown, project: unknown) {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify(project));
		return { agentDir, cwd };
	}

	it("merges global and trusted project servers and validates entries", () => {
		const paths = setup(
			{
				mcpServers: {
					shared: { command: "global-cmd" },
					remote: { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } },
					off: { command: "x", enabled: false },
					bad: { args: ["no command"] },
					legacy: { type: "sse", url: "https://example.com/sse" },
					badUrl: { url: "example.com/mcp" },
					"bad name": { command: "x" },
				},
			},
			{ mcpServers: { shared: { command: "project-cmd", exposure: "direct" } } },
		);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		// Disabled servers are kept so /mcp can enable them again.
		expect(trusted.servers.map((server) => [server.name, server.scope, server.config])).toEqual([
			["shared", "project", { command: "project-cmd", exposure: "direct" }],
			["remote", "global", { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } }],
			["off", "global", { command: "x", enabled: false }],
		]);
		expect(trusted.errors).toHaveLength(4);
		expect(trusted.errors[0]).toContain('server "bad" needs either "command"');
		expect(trusted.errors[1]).toContain("legacy SSE transport is not supported");
		expect(trusted.errors[2]).toContain('server "badUrl": url must be an http or https URL');
		expect(trusted.errors[3]).toContain('invalid server name "bad name"');

		// Untrusted projects cannot add or override servers, since stdio servers run commands.
		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(untrusted.servers.find((server) => server.name === "shared")?.config).toEqual({ command: "global-cmd" });
	});

	it("validates exposure and reads autoEnableCodemode with project precedence", () => {
		const paths = setup(
			{
				autoEnableCodemode: false,
				mcpServers: {
					later: { command: "x", exposure: "deferred" },
					scripts: { command: "x", exposure: "codemode-deferred" },
					off: { command: "x", exposure: "hidden" },
					wrong: { command: "x", exposure: "model-only" },
				},
			},
			{ autoEnableCodemode: "yes", mcpServers: {} },
		);

		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(untrusted.autoEnableCodemode).toBe(false);
		expect(untrusted.servers.map((server) => [server.name, server.config.exposure])).toEqual([
			["later", "deferred"],
			["scripts", "codemode-deferred"],
			["off", "hidden"],
		]);
		expect(untrusted.errors).toEqual([expect.stringContaining('server "wrong": exposure must be one of')]);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		expect(trusted.autoEnableCodemode).toBe(false);
		expect(trusted.errors).toContainEqual(expect.stringContaining("autoEnableCodemode must be a boolean"));
	});

	it("validates the OAuth callback URL and scope", () => {
		const paths = setup(
			{
				mcpServers: {
					ok: {
						url: "https://a.example/mcp",
						oauth: { callbackUrl: "http://localhost:8080/callback", scope: "a b" },
					},
					ipv6: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://[::1]/cb", callbackPort: 9000 } },
					same: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://127.0.0.1:2/cb", callbackPort: 2 } },
					remote: { url: "https://a.example/mcp", oauth: { callbackUrl: "https://example.com/callback" } },
					both: { url: "https://a.example/mcp", oauth: { callbackUrl: "http://127.0.0.1:1/cb", callbackPort: 2 } },
					scope: { url: "https://a.example/mcp", oauth: { scope: ["a"] } },
				},
			},
			{},
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(servers.map((server) => server.name)).toEqual(["ok", "ipv6", "same"]);
		expect(errors).toEqual([
			expect.stringContaining('server "remote": oauth.callbackUrl must be an http URI on localhost'),
			expect.stringContaining('server "both": oauth.callbackUrl and oauth.callbackPort name different ports'),
			expect.stringContaining('server "scope": oauth.scope must be a string'),
		]);
	});

	it("resolves per-tool exposure from exact names, then patterns in order", () => {
		const paths = setup(
			{
				mcpServers: {
					gh: {
						command: "x",
						exposure: "deferred",
						toolExposure: { "get_*": "codemode", get_me: "direct", "*delete*": "hidden", "get_file.*": "direct" },
					},
					bad: { command: "x", toolExposure: { a: "visible" } },
				},
			},
			{},
		);
		const { servers, errors } = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(errors).toEqual([expect.stringContaining('server "bad": toolExposure "a" must be one of')]);
		const config = servers[0].config;
		expect(getMcpToolExposure(config, "get_me")).toBe("direct");
		expect(getMcpToolExposure(config, "get_issue")).toBe("codemode");
		expect(getMcpToolExposure(config, "get_delete_hint")).toBe("codemode");
		expect(getMcpToolExposure(config, "delete_repo")).toBe("hidden");
		expect(getMcpToolExposure(config, "list_issues")).toBe("deferred");
		// Only `*` is special.
		expect(getMcpToolExposure({ command: "x", toolExposure: { "get_file.*": "direct" } }, "get_file_x")).toBe(
			"codemode",
		);
	});
});

describe("MCP tools", () => {
	it("creates provider-safe tool names", () => {
		expect(createMcpToolName("docs", "search")).toBe("mcp__docs__search");
		expect(createMcpToolName("my-server", "get.item/v2")).toBe("mcp__my-server__get_item_v2");
		const long = createMcpToolName("server", "x".repeat(100));
		expect(long).toHaveLength(64);
		expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
		expect(createMcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long);
		// Names that sanitize to one already taken by another tool get a hash suffix.
		const taken = createMcpToolName("s", "a_b");
		const second = createMcpToolName("s", "a.b", (name) => name === taken);
		expect(second).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
	});

	it("converts results, passing the CallToolResult to scripts and flagging errors", async () => {
		const blocks = [
			{ type: "resource_link" as const, uri: "file:///a", name: "a" },
			{ type: "resource" as const, resource: { uri: "file:///b", text: "b text" } },
			{ type: "audio" as const, data: "", mimeType: "audio/wav" },
		];
		expect(
			await convertMcpResult("docs", "t", {
				content: blocks,
				structuredContent: { ok: true },
				_meta: { trace: "x" },
			}),
		).toEqual({
			content: [
				{ type: "text", text: '[Resource file:///a "a"]' },
				{ type: "text", text: "b text" },
				{ type: "text", text: "[audio audio/wav omitted]" },
			],
			details: { server: "docs", tool: "t" },
			// Scripts get the server's blocks as sent, without `_meta`.
			structuredContent: { content: blocks, structuredContent: { ok: true } },
		});
		expect((await convertMcpResult("docs", "t", { content: [], structuredContent: { n: 1 } })).content).toEqual([
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		expect(await convertMcpResult("docs", "t", { content: [{ type: "text", text: "nope" }], isError: true })).toEqual(
			{
				content: [{ type: "text", text: "nope" }],
				details: { server: "docs", tool: "t" },
				structuredContent: { content: [{ type: "text", text: "nope" }], isError: true },
				isError: true,
			},
		);
		expect((await convertMcpResult("docs", "t", { content: [], isError: true })).content).toEqual([
			{ type: "text", text: "MCP tool docs/t returned an error" },
		]);
	});

	it("points resource links to read_mcp_resource and saves binary resources", async () => {
		const saved: [string | Uint8Array, string][] = [];
		const saveOutput = async (data: string | Uint8Array, extension: string) => {
			saved.push([data, extension]);
			return `/tmp/saved${extension}`;
		};
		const converted = await convertMcpResult(
			"docs",
			"t",
			{
				content: [
					{
						type: "resource_link",
						uri: "docs://guide",
						name: "guide",
						title: "The Guide",
						mimeType: "text/markdown",
						size: 2048,
						description: "How to use it",
					},
					{
						type: "resource",
						resource: { uri: "file:///r/report.pdf", mimeType: "application/pdf", blob: "JVBERg==" },
					},
					{ type: "resource", resource: { uri: "docs://logo", mimeType: "image/png", blob: "AAAA" } },
				],
			},
			{ saveOutput, readableResources: true },
		);
		expect(converted.content).toEqual([
			{
				type: "text",
				text: '[Resource docs://guide "The Guide" (text/markdown, 2.0KB): How to use it. Read it with read_mcp_resource (server "docs")]',
			},
			{ type: "text", text: "[Binary resource file:///r/report.pdf (application/pdf, 4B) saved to /tmp/saved.pdf]" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		expect(saved).toEqual([[Buffer.from("%PDF"), ".pdf"]]);
	});

	it("cuts the middle of model-facing text over 20KB and keeps the full result for scripts", async () => {
		const saved: (string | Uint8Array)[] = [];
		const saveOutput = async (data: string | Uint8Array) => {
			saved.push(data);
			return "/tmp/full.txt";
		};
		const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`);
		const full = lines.join("\n");
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const result = { content: [{ type: "text" as const, text: full }, image] };
		const converted = await convertMcpResult("docs", "snapshot", result, { saveOutput });
		expect(converted.content).toHaveLength(2);
		const text = (converted.content[0] as { text: string }).text;
		// Codex's format: a header, the start and end of the text, then the file with the full text.
		expect(text).toMatch(
			new RegExp(
				`^Warning: truncated output \\(original token count: ${Math.ceil(full.length / 4)}\\)\nTotal output lines: 3000\n\nline 1\nline 2\n`,
			),
		);
		expect(text).toMatch(/…\d+ chars truncated…/);
		expect(text.endsWith("line 3000\n\n[Full output: /tmp/full.txt (read it with offset/limit)]")).toBe(true);
		expect(Buffer.byteLength(text)).toBeLessThan(21 * 1024);
		expect(converted.content[1]).toEqual(image);
		expect(converted.details).toEqual({ server: "docs", tool: "snapshot", fullOutputPath: "/tmp/full.txt" });
		expect(saved).toEqual([full]);
		expect(converted.structuredContent).toEqual(result);

		// Text within the limit is not saved.
		await convertMcpResult("docs", "small", { content: [{ type: "text", text: "ok" }] }, { saveOutput });
		expect(saved).toHaveLength(1);
	});

	it("cuts multi-byte text only at character boundaries", () => {
		const text = `${"é".repeat(20_000)}end`;
		const result = truncateMiddle(text, 1001);
		expect(result.truncated).toBe(true);
		expect(result.content).not.toContain("\uFFFD");
		expect(result.content.endsWith("end")).toBe(true);
		const [head, tail] = result.content.split(/…\d+ chars truncated…/);
		expect(Buffer.byteLength(head)).toBeLessThanOrEqual(500);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(501);
		expect(Array.from(head).length + Array.from(tail).length + result.removedChars).toBe(Array.from(text).length);
	});
});

describe("MCP connections", () => {
	const servers: InMemoryTransport[] = [];
	const connections: McpServerConnection[] = [];
	afterEach(async () => {
		for (const connection of connections.splice(0)) await connection.close();
		for (const server of servers.splice(0)) await server.close();
		vi.useRealTimers();
	});

	/** Wire peer; the client and connection lifecycle remain real. */
	function createTransport(
		options: {
			expireFirstCall?: boolean;
			methods?: string[];
			noTools?: boolean;
			capabilities?: ServerCapabilities;
			handlers?: Record<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>;
		} = {},
	) {
		const pair = createInMemoryTransportPair();
		servers.push(pair.server);
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			options.methods?.push(message.method);
			queueMicrotask(async () => {
				let result: unknown;
				const handler = options.handlers?.[message.method];
				if (handler) result = await handler(message);
				else {
					switch (message.method) {
						case "initialize":
							result = {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: options.capabilities ?? (options.noTools ? { prompts: {} } : { tools: {} }),
								serverInfo: { name: "fake", version: "1.0.0" },
							};
							break;
						case "tools/list":
							if (options.noTools) {
								await pair.server.send({
									jsonrpc: "2.0",
									id: message.id,
									error: { code: -32601, message: "Method not found" },
								});
								return;
							}
							result = { tools: [] };
							break;
						case "prompts/list":
							result = { prompts: [{ name: "brief" }] };
							break;
						case "resources/list":
							result = { resources: [] };
							break;
						case "resources/templates/list":
							result = { resourceTemplates: [] };
							break;
						case "resources/read":
							result = { contents: [{ uri: "docs://a", text: "ok" }] };
							break;
						case "tools/call":
							result = { content: [{ type: "text", text: "ok" }] };
							break;
						default:
							await pair.server.send({
								jsonrpc: "2.0",
								id: message.id,
								error: { code: -32601, message: "Method not found" },
							});
							return;
					}
				}
				await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
			});
		});
		void pair.server.start();
		if (options.expireFirstCall) {
			const send = pair.client.send.bind(pair.client);
			// Simulates the HTTP transport's 404 for a session the server no longer knows.
			pair.client.send = async (message: JsonRpcMessage) => {
				if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
				return send(message);
			};
		}
		return pair.client;
	}

	function connect(
		entry: McpServerEntry,
		transports: (() => ReturnType<typeof createTransport>)[],
		log?: McpServerLog,
	) {
		let opened = 0;
		const connection = new McpServerConnection({
			entry,
			cwd: process.cwd(),
			createTransport: () => transports[opened++](),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			log,
			onTools: () => {},
		});
		connections.push(connection);
		return { connection, opened: () => opened };
	}

	it("closes default-lazy transports after ten idle minutes and reconnects on the next request", async () => {
		vi.useFakeTimers();
		const closed = vi.fn();
		const transport = () => {
			const client = createTransport();
			client.onClose(closed);
			return client;
		};
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			transport,
			transport,
		]);
		expect(opened()).toBe(0);
		await connection.callTool("echo", {}, {});
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
		expect(connection.state).toBe("connected");
		expect(closed).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(connection.state).toBe("idle");
		expect(closed).toHaveBeenCalledTimes(1);
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
	});

	it("retains eager transports beyond the lazy idle timeout", async () => {
		vi.useFakeTimers();
		const closed = vi.fn();
		const { connection, opened } = connect(
			{ name: "fake", config: { command: "unused", connection: "eager" }, source: "test" },
			[
				() => {
					const client = createTransport();
					client.onClose(closed);
					return client;
				},
			],
		);
		await connection.getClient();
		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
		expect(connection.state).toBe("connected");
		expect(closed).not.toHaveBeenCalled();
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(opened()).toBe(1);
		await connection.close();
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("keeps an active request connected and starts the idle period only after its response", async () => {
		vi.useFakeTimers();
		const received = Promise.withResolvers<void>();
		const response = Promise.withResolvers<unknown>();
		const transport = createTransport({
			handlers: {
				"tools/call": () => {
					received.resolve();
					return response.promise;
				},
			},
		});
		const closed = vi.fn();
		transport.onClose(closed);
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => transport,
		]);
		await connection.getClient();
		await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
		const pending = connection.callTool("slow", {}, { timeoutMs: 20 * 60 * 1000 });
		await received.promise;
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
		expect(connection.state).toBe("connected");
		expect(closed).not.toHaveBeenCalled();
		response.resolve({ content: [{ type: "text", text: "done" }] });
		expect(await pending).toEqual({ content: [{ type: "text", text: "done" }] });
		expect(opened()).toBe(1);
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
		expect(closed).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(connection.state).toBe("idle");
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ kind: "tools", method: "tools/list", items: [{ name: "new", inputSchema: { type: "object" } }] },
		{ kind: "resources", method: "resources/list", items: [{ name: "new", uri: "docs://new" }] },
		{ kind: "prompts", method: "prompts/list", items: [{ name: "new" }] },
	] as const)(
		"protects a $kind notification refresh from idle close and publishes its response",
		async ({ kind, method, items }) => {
			vi.useFakeTimers();
			const received = Promise.withResolvers<void>();
			const response = Promise.withResolvers<unknown>();
			let lists = 0;
			const transport = createTransport({
				capabilities: {
					tools: { listChanged: true },
					resources: { listChanged: true },
					prompts: { listChanged: true },
				},
				handlers: {
					[method]: () => {
						if (++lists === 1) return { [kind]: [] };
						received.resolve();
						return response.promise;
					},
				},
			});
			const closed = vi.fn();
			transport.onClose(closed);
			const { connection, opened } = connect(
				{ name: "fake", config: { command: "unused", timeout: 20 * 60 }, source: "test" },
				[() => transport],
			);
			await connection.getClient();
			await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
			await servers.at(-1)?.send({ jsonrpc: "2.0", method: `notifications/${kind}/list_changed` });
			await received.promise;
			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
			expect(connection.state).toBe("connected");
			expect(closed).not.toHaveBeenCalled();
			response.resolve({ [kind]: items });
			await vi.advanceTimersByTimeAsync(0);
			expect(connection[kind]).toEqual(items);
			expect(opened()).toBe(1);
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
			expect(closed).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(connection.state).toBe("idle");
			expect(closed).toHaveBeenCalledTimes(1);
		},
	);

	it("starts a new session and retries once when the session expired", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ expireFirstCall: true }),
			() => createTransport(),
		]);
		const results = await Promise.all([connection.callTool("echo", {}, {}), connection.callTool("echo", {}, {})]);
		expect(results).toEqual([
			{ content: [{ type: "text", text: "ok" }] },
			{ content: [{ type: "text", text: "ok" }] },
		]);
		expect(opened()).toBe(2);
		await connection.close();
	});

	it.skipIf(process.platform === "win32")(
		"expands ~ in the command, arguments, and cwd of stdio servers",
		async () => {
			const home = mkdtempSync(join(tmpdir(), "pi-mcp-home-"));
			const previousHome = process.env.HOME;
			process.env.HOME = home;
			mkdirSync(join(home, "work"));
			// Answers every tool call with its working directory.
			writeFileSync(
				join(home, "server.mjs"),
				`import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	const result = message.method === "initialize"
		? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cwd", version: "1" } }
		: message.method === "tools/list"
			? { tools: [{ name: "cwd", inputSchema: { type: "object" } }] }
			: { content: [{ type: "text", text: process.cwd() }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}`,
			);
			const connection = new McpServerConnection({
				entry: {
					name: "home",
					config: { command: process.execPath, args: ["~/server.mjs"], cwd: "~/work" },
					source: "test",
				},
				cwd: tmpdir(),
				createTransport: createDefaultTransport,
				credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
				onTools: () => {},
			});
			try {
				const result = await connection.callTool("cwd", {}, {});
				expect(realpathSync((result.content[0] as { text: string }).text)).toBe(realpathSync(join(home, "work")));
			} finally {
				await connection.close();
				process.env.HOME = previousHome;
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	it("connects to servers without the tools capability without listing tools", async () => {
		const methods: string[] = [];
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ noTools: true, methods }),
		]);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(connection.tools).toEqual([]);
		expect(connection.prompts).toEqual([{ name: "brief" }]);
		expect(methods).toEqual(["initialize", "prompts/list"]);
		await connection.close();
	});

	it("marks a dropped connection and reconnects on the next call", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport(),
			() => createTransport(),
		]);
		await connection.getClient();
		await servers.at(-1)?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(connection.state).toBe("disconnected");
		expect(connection.error).toBe("Connection closed");
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();
	});

	it("retries HTTP connections that fail with a transient error", async () => {
		const { connection, opened } = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(503, "MCP HTTP request failed with status 503");
					};
					return transport;
				},
				() => createTransport(),
			],
		);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();

		const failing = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(400, "MCP HTTP request failed with status 400: bad");
					};
					return transport;
				},
			],
		);
		await expect(failing.connection.getClient()).rejects.toThrow("status 400: bad");
		expect(failing.connection.state).toBe("failed");
		expect(failing.opened()).toBe(1);
	});

	it("retries resource reads, but not tool calls, after a transient HTTP error", async () => {
		const received = Promise.withResolvers<void>();
		let balance = 100;
		const invoices: string[] = [];
		const methods: string[] = [];
		const transport = createTransport({
			methods,
			handlers: {
				"tools/call": (request) => {
					const { invoice, amount } = (request.params as { arguments: { invoice: string; amount: number } })
						.arguments;
					balance -= amount;
					invoices.push(invoice);
					received.resolve();
					// The invoice was charged, but its response never reaches the client.
					return new Promise(() => {});
				},
			},
		});
		const send = transport.send.bind(transport);
		let reads = 0;
		let calls = 0;
		transport.send = async (message) => {
			const method = "method" in message ? message.method : "";
			if (method === "resources/read" && ++reads === 1) {
				throw new McpHttpError(502, "MCP HTTP request failed with status 502");
			}
			if (method === "tools/call") {
				calls++;
				await send(message);
				await received.promise;
				throw new McpHttpError(502, "MCP HTTP request failed with status 502");
			}
			return send(message);
		};
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => transport,
		]);
		expect(await connection.readResource("docs://a", {})).toEqual({ contents: [{ uri: "docs://a", text: "ok" }] });
		expect(reads).toBe(2);
		await expect(connection.callTool("charge", { invoice: "invoice-1", amount: 25 }, {})).rejects.toMatchObject({
			message: `MCP tool "fake/charge" did not return a confirmed result: MCP HTTP request failed with status 502. It may have run. Check the server's state before repeating it; pi did not retry the call.`,
			cause: expect.any(McpHttpError),
		});
		expect(await connection.readResource("docs://a", {})).toEqual({ contents: [{ uri: "docs://a", text: "ok" }] });
		expect(balance).toBe(75);
		expect(invoices).toEqual(["invoice-1"]);
		expect(calls).toBe(1);
		expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
		await connection.close();
	});

	it.each(["timeout", "abort"] as const)("does not replay a charged invoice after response %s", async (failure) => {
		vi.useFakeTimers();
		const received = Promise.withResolvers<void>();
		let balance = 100;
		const invoices: string[] = [];
		const methods: string[] = [];
		const transport = createTransport({
			methods,
			handlers: {
				"tools/call": (request) => {
					const { invoice, amount } = (request.params as { arguments: { invoice: string; amount: number } })
						.arguments;
					balance -= amount;
					invoices.push(invoice);
					received.resolve();
					return new Promise(() => {});
				},
			},
		});
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => transport,
		]);
		const cancelled: JsonRpcMessage[] = [];
		servers.at(-1)?.onMessage((message) => {
			if ("method" in message && message.method === "notifications/cancelled") cancelled.push(message);
		});
		const controller = new AbortController();
		const pending = connection.callTool(
			"charge",
			{ invoice: "invoice-1", amount: 25 },
			{ signal: controller.signal, timeoutMs: 50 },
		);
		const reason = failure === "timeout" ? "MCP request timed out after 50ms" : "MCP request aborted";
		const rejected = expect(pending).rejects.toMatchObject({
			message: `MCP tool "fake/charge" did not return a confirmed result: ${reason}. It may have run. Check the server's state before repeating it; pi did not retry the call.`,
			cause: failure === "timeout" ? expect.any(McpTimeoutError) : expect.any(McpAbortError),
		});
		await received.promise;
		expect(balance).toBe(75);
		expect(invoices).toEqual(["invoice-1"]);
		if (failure === "timeout") await vi.advanceTimersByTimeAsync(50);
		else controller.abort("stop");
		await rejected;
		await vi.advanceTimersByTimeAsync(1000);
		expect(cancelled).toEqual([
			{
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: 3, reason: failure === "timeout" ? "Request timed out" : "stop" },
			},
		]);
		expect(await connection.readResource("docs://a", {})).toEqual({ contents: [{ uri: "docs://a", text: "ok" }] });
		expect(balance).toBe(75);
		expect(invoices).toEqual(["invoice-1"]);
		expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
		expect(opened()).toBe(1);
	});

	it("asks OAuth servers that keep rejecting requests for a new sign-in", async () => {
		const { connection } = connect({ name: "fake", config: { url: "http://unused.invalid" }, source: "test" }, [
			() => {
				const transport = createTransport();
				transport.send = async () => {
					throw new McpAuthRequiredError(new Response(null, { status: 401 }));
				};
				return transport;
			},
		]);
		await expect(connection.getClient()).rejects.toThrow('MCP server "fake" requires sign-in. Run /mcp to sign in.');
		expect(connection.state).toBe("needs-auth");
		await connection.close();
	});

	it("appends server log messages to the log file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-log-"));
		try {
			const path = join(dir, "mcp.log");
			const { connection } = connect(
				{ name: "fake", config: { command: "unused" }, source: "test" },
				[() => createTransport()],
				new McpServerLog(path),
			);
			await connection.getClient();
			const server = servers.at(-1);
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "warning", logger: "db", data: "slow\nquery" },
			});
			await server?.send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "error", data: { code: 7 } },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			const lines = readFileSync(path, "utf8").replace(/^\S+ /gm, "");
			expect(lines).toBe('[fake] warning db: slow\n    query\n[fake] error {"code":7}\n');
			await connection.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves the OAuth client secret lazily", async () => {
		const { connection } = connect(
			{
				name: "fake",
				config: { url: "http://unused.invalid", oauth: { clientSecret: "!exit 1" } },
				source: "test",
			},
			[() => createTransport()],
		);
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(() => connection.oauthSettings()).toThrow("oauth.clientSecret");
		await connection.close();
	});
});
