import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpCatalogStore } from "../src/extensions/mcp/catalog.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { loadMcpConfig } from "../src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/oauth.ts";

const FIXTURE = resolve(import.meta.dirname, "../../mcp/test/fixtures/stdio-server.mjs");

describe("pi mcp", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	async function run(args: string[], servers: Record<string, unknown> | undefined, dir?: string) {
		const agentDir = dir ?? mkdtempSync(join(tmpdir(), "pi-mcp-command-"));
		if (!dir) dirs.push(agentDir);
		if (servers) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
		const output: string[] = [];
		const exitCode = await runMcpCommand(args, {
			cwd: agentDir,
			agentDir,
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		return { exitCode, output: output.join("\n"), agentDir };
	}

	const readConfig = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

	const servers = {
		fixture: { command: process.execPath, args: [FIXTURE] },
		broken: { command: "pi-test-missing-mcp-server" },
		parked: { command: process.execPath, args: [FIXTURE], enabled: false },
		bad: { args: ["no command"] },
	};

	it("lists servers with their state, tools, and errors, and fails while anything is wrong", async () => {
		const { exitCode, output } = await run(["list", "--connect"], servers);
		expect(exitCode).toBe(1);
		expect(output).toContain("fixture: connected, 1 tool (codemode, global)\n");
		expect(output).toContain("  tools: echo");
		expect(output).toContain(
			"broken: failed (codemode, global)\n  pi-test-missing-mcp-server\n  spawn pi-test-missing-mcp-server ENOENT",
		);
		expect(output).toContain("parked: disabled (codemode, global)");
		expect(output).toContain("config error: ");
		expect(output).toContain('server "bad" needs either "command"');

		const ok = await run(["list", "--connect"], { fixture: servers.fixture });
		expect(ok.exitCode).toBe(0);
	});

	it("prints JSON for scripts", async () => {
		const { exitCode, output, agentDir } = await run(["list", "--json", "--connect"], {
			fixture: servers.fixture,
			parked: servers.parked,
		});
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(output) as { servers: { name: string; state: string; tools: string[] }[] };
		expect(parsed.servers.map(({ name, state, tools }) => ({ name, state, tools }))).toEqual([
			{ name: "fixture", state: "connected", tools: ["echo"] },
			{ name: "parked", state: "disabled", tools: [] },
		]);
		const cached = await run(["list", "--json"], undefined, agentDir);
		expect(cached.exitCode).toBe(0);
		expect(JSON.parse(cached.output).servers[0]).toMatchObject({ state: "cached", tools: ["echo"] });
	});

	it("lists configuration without spawning a server or resolving secrets, and reads cached tools when available", async () => {
		const result = await run(["list", "--json"], {
			cold: { command: "pi-test-missing-mcp-server", env: { TOKEN: "!must-not-run" }, exposure: "direct" },
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output).servers[0]).toMatchObject({
			state: "configured",
			connection: "lazy",
			tools: [],
		});
		expect(existsSync(join(result.agentDir, "mcp-auth.json"))).toBe(false);
		expect(existsSync(join(result.agentDir, "mcp-catalog.json"))).toBe(false);
	});

	it("lists persisted catalogs for valid profile names and rejects malformed or old-account metadata", async () => {
		const configured = await run(["list", "--json"], {
			["__proto__"]: { url: "http://unused.invalid/mcp", toolExposure: { echo: "direct" } },
		});
		const credentials = new McpOAuthCredentialStore(undefined, configured.agentDir);
		const profile = loadMcpConfig({
			agentDir: configured.agentDir,
			cwd: configured.agentDir,
			projectTrusted: false,
		}).servers[0];
		new McpCatalogStore({ agentDir: configured.agentDir }).save(
			profile,
			configured.agentDir,
			credentials.catalogIdentity(profile),
			{
				tools: [{ name: "echo", inputSchema: { type: "object" } }],
				hasResources: false,
				resources: [],
				resourceTemplates: [],
				prompts: [{ name: "brief" }],
			},
		);
		const cached = await run(["list", "--json"], undefined, configured.agentDir);
		expect(JSON.parse(cached.output).servers[0]).toMatchObject({
			state: "cached",
			tools: ["echo"],
			toolExposure: { echo: "direct" },
			prompts: 1,
		});
		const catalogPath = join(configured.agentDir, "mcp-catalog.json");
		const before = readFileSync(catalogPath, "utf8");
		const malformed = JSON.parse(before) as { servers: Record<string, { prompts: { title?: unknown }[] }[]> };
		malformed.servers.__proto__[0].prompts[0].title = 7;
		writeFileSync(catalogPath, JSON.stringify(malformed));
		const rejected = await run(["list", "--json"], undefined, configured.agentDir);
		expect(JSON.parse(rejected.output).servers[0]).toMatchObject({ state: "configured", tools: [] });
		writeFileSync(catalogPath, before);
		await credentials.importGrant(profile, {
			serverUrl: "http://unused.invalid/mcp",
			tokens: { access_token: "replacement-account", token_type: "Bearer" },
		});
		const replaced = await run(["list", "--json"], undefined, configured.agentDir);
		expect(JSON.parse(replaced.output).servers[0]).toMatchObject({ state: "configured", tools: [] });
	});

	it("retains eight recent catalog identities and preserves same-identity collision names when saving descriptors", async () => {
		const configured = await run(["list", "--json"], {
			docs: { url: "http://unused.invalid/mcp" },
		});
		const profile = loadMcpConfig({
			agentDir: configured.agentDir,
			cwd: configured.agentDir,
			projectTrusted: false,
		}).servers[0];
		const catalog = new McpCatalogStore({ agentDir: configured.agentDir });
		for (let i = 0; i < 9; i++) {
			catalog.save(profile, configured.agentDir, `grant-${i}`, {
				tools: [{ name: `tool-${i}`, inputSchema: { type: "object" } }],
				hasResources: false,
				resources: [],
				resourceTemplates: [],
				prompts: [],
				names: { [`tool-${i}`]: `mcp__docs__tool_${i}` },
			});
		}
		const reopened = new McpCatalogStore({ agentDir: configured.agentDir });
		expect(reopened.load(profile, configured.agentDir, "grant-0")).toBeUndefined();
		for (let i = 1; i < 9; i++) {
			expect(reopened.load(profile, configured.agentDir, `grant-${i}`)?.tools[0].name).toBe(`tool-${i}`);
		}
		const latest = reopened.load(profile, configured.agentDir, "grant-8")!;
		delete latest.names;
		reopened.save(profile, configured.agentDir, "grant-8", latest);
		expect(reopened.load(profile, configured.agentDir, "grant-8")?.names).toEqual({
			"tool-8": "mcp__docs__tool_8",
		});
		expect(reopened.load(profile, configured.agentDir, "unknown-account")).toBeUndefined();
	});

	it("rejects unknown servers and servers without OAuth for login and logout", async () => {
		expect(await run(["login", "nope"], servers)).toMatchObject({
			exitCode: 1,
			output: 'No MCP server named "nope". Configured: fixture, broken, parked.',
		});
		expect(await run(["logout", "fixture"], servers)).toMatchObject({
			exitCode: 1,
			output: 'MCP server "fixture" does not use OAuth. Only HTTP servers without an Authorization header do.',
		});
		expect((await run(["frobnicate"], servers)).exitCode).toBe(1);
	});

	it("adds stdio servers and passes options after the command through", async () => {
		const added = await run(
			["add", "--env", "A=1", "--env", "B=x=y", "files", "--", "npx", "-y", "server", "--root", "."],
			undefined,
		);
		expect(added.exitCode).toBe(0);
		expect(added.output).toContain('Added global MCP server "files"');
		expect(readConfig(join(added.agentDir, "mcp.json"))).toEqual({
			mcpServers: {
				files: { command: "npx", args: ["-y", "server", "--root", "."], env: { A: "1", B: "x=y" } },
			},
		});

		// Without `--`, options after the command belong to the command too.
		const replaced = await run(["add", "files", "node", "server.js", "--port", "1"], undefined, added.agentDir);
		expect(replaced.output).toContain('Replaced global MCP server "files"');
		expect(readConfig(join(added.agentDir, "mcp.json"))).toEqual({
			mcpServers: { files: { command: "node", args: ["server.js", "--port", "1"] } },
		});
	});

	it("persists every valid profile name without treating inherited object properties as existing servers", async () => {
		const added = await run(["add", "__proto__", "--", "node"], undefined);
		expect(added.exitCode).toBe(0);
		expect(added.output).toContain("Added global");
		expect(readConfig(join(added.agentDir, "mcp.json"))).toEqual({
			mcpServers: { ["__proto__"]: { command: "node" } },
		});
		expect((await run(["remove", "constructor"], undefined, added.agentDir)).exitCode).toBe(1);
		expect((await run(["remove", "__proto__"], undefined, added.agentDir)).exitCode).toBe(0);
		expect(readConfig(join(added.agentDir, "mcp.json"))).toEqual({ mcpServers: {} });
	});

	it("adds HTTP servers and keeps other content of the file", async () => {
		const { exitCode, output, agentDir } = await run(
			[
				"add",
				"docs",
				"--url",
				"https://example.com/mcp",
				"--bearer-token-env-var",
				"DOCS_TOKEN",
				"--header",
				"X-Team=core",
				"--exposure",
				"direct",
				"--connection",
				"eager",
			],
			{ fixture: servers.fixture },
		);
		expect(exitCode).toBe(0);
		expect(output).not.toContain("mcp login");
		expect(readConfig(join(agentDir, "mcp.json"))).toEqual({
			mcpServers: {
				fixture: servers.fixture,
				docs: {
					url: "https://example.com/mcp",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
					headers: { "X-Team": "core", Authorization: "Bearer ${DOCS_TOKEN}" },
					exposure: "direct",
					connection: "eager",
				},
			},
		});

		const oauth = await run(
			["add", "sentry", "--url", "https://mcp.sentry.dev/mcp", "--oauth-client-id", "pi"],
			undefined,
			agentDir,
		);
		expect(oauth.output).toContain("If it requires sign-in: pi mcp login sentry");
		expect(readConfig(join(agentDir, "mcp.json")).mcpServers).toMatchObject({
			sentry: { url: "https://mcp.sentry.dev/mcp", oauth: { clientId: "pi" } },
		});
	});

	it("rejects invalid add invocations without writing", async () => {
		const cases = [
			["add", "x"],
			["add", "x", "--url", "https://example.com", "--", "cmd"],
			["add", "bad name", "--", "cmd"],
			["add", "x", "--url", "ftp://example.com"],
			["add", "x", "--env", "A=1", "--url", "https://example.com"],
			["add", "x", "--header", "A=1", "--", "cmd"],
			["add", "x", "--env", "NOVALUE", "--", "cmd"],
			["add", "x", "--exposure", "loud", "--", "cmd"],
			["add", "x", "--connection", "soon", "--", "cmd"],
		];
		for (const args of cases) {
			const result = await run(args, undefined);
			expect(result.exitCode, args.join(" ")).toBe(1);
			expect(existsSync(join(result.agentDir, "mcp.json"))).toBe(false);
		}
	});

	it("adds and removes project servers", async () => {
		const added = await run(["add", "-l", "local", "--", "node", "server.js"], undefined);
		expect(added.output).toContain("The project is not trusted");
		const projectConfig = join(added.agentDir, ".pi", "mcp.json");
		expect(readConfig(projectConfig)).toEqual({ mcpServers: { local: { command: "node", args: ["server.js"] } } });

		const wrongScope = await run(["remove", "local"], undefined, added.agentDir);
		expect(wrongScope.exitCode).toBe(1);
		expect(wrongScope.output).toContain(`It is defined in ${projectConfig}; use --local.`);

		const removed = await run(["remove", "local", "--local"], undefined, added.agentDir);
		expect(removed.exitCode).toBe(0);
		expect(removed.output).toContain('Removed project MCP server "local"');
		expect(readConfig(projectConfig)).toEqual({ mcpServers: {} });
	});

	it("removes global servers", async () => {
		const { exitCode, agentDir } = await run(["remove", "broken"], servers);
		expect(exitCode).toBe(0);
		expect(Object.keys(readConfig(join(agentDir, "mcp.json")).mcpServers as object)).toEqual([
			"fixture",
			"parked",
			"bad",
		]);
		const missing = await run(["remove", "broken"], undefined, agentDir);
		expect(missing).toMatchObject({ exitCode: 1 });
		expect(missing.output).toContain('No global MCP server named "broken"');
	});
});
