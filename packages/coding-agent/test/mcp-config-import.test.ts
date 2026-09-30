import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { importAdapter } from "../src/extensions/mcp/adapter-import.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { loadMcpConfig, updateMcpServerConfig } from "../src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/oauth.ts";

const endpoint = "https://server.example/mcp";
const issuer = "https://auth.example";
const callback = "http://localhost:19876/custom/callback";

function authEntry(token: string, expiry?: number) {
	return {
		serverUrl: endpoint,
		clientInfo: {
			clientId: "client",
			clientSecret: "registration-secret",
			clientSecretExpiresAt: 0,
			redirectUris: [callback],
			registrationType: "cimd",
			issuer,
		},
		tokens: {
			accessToken: token,
			refreshToken: `${token}-refresh`,
			issuer,
			...(expiry === undefined ? {} : { expiresAt: expiry }),
		},
		codeVerifier: "obsolete-private-verifier",
		oauthState: "obsolete-state",
	};
}

describe("MCP shared config and copy-only adapter import", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function setup() {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-import-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		return {
			root,
			agentDir,
			cwd,
			sharedConfigPath: join(root, "shared.json"),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		};
	}
	const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
	const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

	it("replaces whole entries in shared/global/trusted-project order and writes inherited settings only to Pi", () => {
		const paths = setup();
		write(paths.sharedConfigPath, {
			sharedContent: "keep",
			mcpServers: {
				inherited: { url: endpoint, headers: { Authorization: "secret" } },
				override: { url: endpoint, headers: { Authorization: "secret" } },
			},
		});
		const sharedBefore = readFileSync(paths.sharedConfigPath, "utf8");
		write(join(paths.agentDir, "mcp.json"), {
			unrelated: { keep: true },
			mcpServers: { override: { url: "https://other.example/mcp", connection: "eager" } },
		});
		write(join(paths.cwd, ".pi", "mcp.json"), { mcpServers: { override: { command: "project" } } });
		const loaded = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(loaded.servers.find((entry) => entry.name === "override")?.config).toEqual({
			url: "https://other.example/mcp",
			connection: "eager",
		});
		expect(
			loadMcpConfig({ ...paths, projectTrusted: true }).servers.find((entry) => entry.name === "override")?.config,
		).toEqual({ command: "project" });
		const inherited = loaded.servers.find((entry) => entry.name === "inherited");
		if (!inherited) throw new Error("missing inherited config");
		expect(inherited.scope).toBe("shared");
		expect(inherited.writableSource).toBe(join(paths.agentDir, "mcp.json"));
		updateMcpServerConfig(inherited, { enabled: false, connection: "eager" });
		expect(readFileSync(paths.sharedConfigPath, "utf8")).toBe(sharedBefore);
		expect(read(join(paths.agentDir, "mcp.json"))).toMatchObject({
			unrelated: { keep: true },
			mcpServers: {
				inherited: { url: endpoint, headers: { Authorization: "secret" }, enabled: false, connection: "eager" },
			},
		});
		expect(
			loadMcpConfig({ ...paths, projectTrusted: false }).servers.find((entry) => entry.name === "inherited")?.scope,
		).toBe("global");
	});

	it("rejects invalid connection, description and callback settings while keeping other entries", () => {
		const paths = setup();
		write(paths.sharedConfigPath, {
			mcpServers: {
				lazy: { command: "lazy" },
				eager: { command: "eager", connection: "eager", description: "Explicitly eager" },
				wrong: { command: "bad", connection: "startup" },
				description: { command: "bad", description: 1 },
				userinfo: { url: endpoint, oauth: { callbackUrl: "http://secret@localhost:19876/callback" } },
				zeroPort: { url: endpoint, oauth: { callbackUrl: "http://localhost:0/callback" } },
				defaultPort: { url: endpoint, oauth: { callbackUrl: "http://localhost:80/callback", callbackPort: 81 } },
			},
		});
		const loaded = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(loaded.servers.map((entry) => entry.name)).toEqual(["lazy", "eager"]);
		expect(loaded.errors).toEqual([
			expect.stringContaining('connection must be "lazy" or "eager"'),
			expect.stringContaining("description must be a string"),
			expect.stringContaining("oauth.callbackUrl must be an http URI"),
			expect.stringContaining("oauth.callbackUrl must use a nonzero port"),
			expect.stringContaining("oauth.callbackUrl and oauth.callbackPort name different ports"),
		]);
	});

	it("dry-runs then copies partial adapter overrides and verified grants, preserving source bytes and unrelated native content", async () => {
		const paths = setup();
		const source = join(paths.root, "adapter.json");
		const override = join(paths.root, "override.json");
		const credentialFile = join(paths.root, "grants.json");
		write(source, {
			mcpServers: {
				work: { url: endpoint, lifecycle: "lazy", directTools: ["whoami"], oauth: { clientId: "client" } },
				personal: { url: endpoint, oauth: { clientId: "client" } },
				local: { command: "node", lifecycle: "eager", requestTimeoutMs: 2500 },
			},
		});
		write(override, { mcpServers: { work: { description: "Work account", disabled: true } } });
		write(credentialFile, { work: authEntry("work", 1_700_000_000), personal: authEntry("personal") });
		write(join(paths.agentDir, "mcp.json"), { unrelated: "keep", mcpServers: {} });
		const before = [source, override, credentialFile].map((path) => readFileSync(path, "utf8"));
		const options = { ...paths, configPaths: [source, override], credentialFile, adapterStopped: true };
		expect(await importAdapter({ ...options, dryRun: true })).toEqual({
			servers: ["work", "personal", "local"],
			grants: ["work", "personal"],
			dryRun: true,
		});
		expect(read(join(paths.agentDir, "mcp.json"))).toEqual({ unrelated: "keep", mcpServers: {} });
		const result = await importAdapter(options);
		expect(result.grants).toEqual(["work", "personal"]);
		const loaded = loadMcpConfig({ ...paths, projectTrusted: false });
		const work = loaded.servers.find((entry) => entry.name === "work");
		const personal = loaded.servers.find((entry) => entry.name === "personal");
		if (!work || !personal) throw new Error("missing imported servers");
		expect(work.config).toMatchObject({
			connection: "lazy",
			enabled: false,
			description: "Work account",
			exposure: "codemode-deferred",
			toolExposure: { whoami: "direct" },
			oauth: { clientId: "client", callbackUrl: callback },
		});
		expect(loaded.servers.find((entry) => entry.name === "local")?.config).toMatchObject({
			connection: "eager",
			timeout: 2.5,
		});
		expect(await paths.credentials.forServer(work).load()).toMatchObject({
			tokensExpireAt: 1_700_000_000_000,
			registrationType: "cimd",
			issuer,
			clientInformation: {
				client_id: "client",
				client_secret: "registration-secret",
				client_secret_expires_at: 0,
				redirect_uris: [callback],
			},
			tokens: { access_token: "work", refresh_token: "work-refresh" },
		});
		const state = await paths.credentials.forServer(personal).load();
		expect(state?.tokens?.access_token).toBe("personal");
		expect(state?.tokens?.scope).toBeUndefined();
		expect(state?.tokensExpireAt).toBeUndefined();
		expect(state?.codeVerifier).toBeUndefined();
		expect(state?.oauthState).toBeUndefined();
		expect(read(join(paths.agentDir, "mcp.json")).unrelated).toBe("keep");
		expect([source, override, credentialFile].map((path) => readFileSync(path, "utf8"))).toEqual(before);
		const copied = readFileSync(join(paths.agentDir, "mcp.json"), "utf8");
		await expect(importAdapter(options)).rejects.toThrow("already exists");
		expect(readFileSync(join(paths.agentDir, "mcp.json"), "utf8")).toBe(copied);
	});

	it("refuses unstopped rotating grants and mismatched URL/client/issuer/callback before any writes", async () => {
		const paths = setup();
		const source = join(paths.root, "adapter.json");
		const credentialFile = join(paths.root, "grants.json");
		write(source, { mcpServers: { work: { url: endpoint, oauth: { clientId: "client", redirectUri: callback } } } });
		write(credentialFile, { work: authEntry("work") });
		const options = { ...paths, configPaths: [source], credentialFile };
		await expect(importAdapter(options)).rejects.toThrow("Stop all adapter sessions");
		const cases = [
			{ ...authEntry("work"), serverUrl: "https://other.example/mcp" },
			{ ...authEntry("work"), tokens: { ...authEntry("work").tokens, expiresAt: Number.MAX_VALUE } },
			{ ...authEntry("work"), clientInfo: { ...authEntry("work").clientInfo, clientId: "other" } },
			{ ...authEntry("work"), tokens: { ...authEntry("work").tokens, issuer: "https://other.example" } },
			{
				...authEntry("work"),
				clientInfo: { ...authEntry("work").clientInfo, redirectUris: ["http://127.0.0.1:19876/callback"] },
			},
		];
		for (const grant of cases) {
			write(credentialFile, { work: grant });
			await expect(importAdapter({ ...options, adapterStopped: true })).rejects.toThrow();
			expect(existsSync(join(paths.agentDir, "mcp.json"))).toBe(false);
		}
	});

	it.each(["config", "credentials"])(
		"refuses a %s source aliased to the native credential destination",
		async (kind) => {
			const paths = setup();
			const nativePath = join(paths.agentDir, "mcp-auth.json");
			const source = kind === "config" ? nativePath : join(paths.root, "adapter.json");
			const credentialFile = kind === "credentials" ? nativePath : join(paths.root, "grants.json");
			write(source, { mcpServers: { work: { url: endpoint, oauth: { clientId: "client" } } } });
			write(credentialFile, { work: authEntry("work") });
			const before = [source, credentialFile].map((path) => readFileSync(path, "utf8"));
			await expect(
				importAdapter({
					...paths,
					credentials: new McpOAuthCredentialStore(undefined, paths.agentDir),
					configPaths: [source],
					credentialFile,
					adapterStopped: true,
				}),
			).rejects.toThrow("source and destination must differ");
			expect(existsSync(join(paths.agentDir, "mcp.json"))).toBe(false);
			expect([source, credentialFile].map((path) => readFileSync(path, "utf8"))).toEqual(before);
		},
	);

	it("rejects ambiguous transports and auth policies that native MCP cannot preserve", async () => {
		const paths = setup();
		const source = join(paths.root, "adapter.json");
		for (const config of [
			{ url: endpoint, command: "node" },
			{ url: endpoint, auth: "bearer" },
			{ url: endpoint, auth: "oauth", headers: { Authorization: "Bearer existing" } },
			{ url: endpoint, bearerToken: "unused-in-adapter" },
		]) {
			write(source, { mcpServers: { work: config } });
			await expect(importAdapter({ ...paths, configPaths: [source], dryRun: true })).rejects.toThrow();
			expect(existsSync(join(paths.agentDir, "mcp.json"))).toBe(false);
		}
	});

	it("provides explicit CLI import with dry-run, without reading adapter Keychain or changing source config", async () => {
		const paths = setup();
		const source = join(paths.root, "adapter.json");
		write(source, { mcpServers: { local: { command: "do-not-run", lifecycle: "lazy" } } });
		const before = readFileSync(source, "utf8");
		const output: string[] = [];
		expect(
			await runMcpCommand(["import-adapter", "--config", source, "--dry-run"], {
				...paths,
				log: (line) => output.push(line),
			}),
		).toBe(0);
		expect(output[0]).toContain("Validated 1 servers and 0 grants");
		expect(existsSync(join(paths.agentDir, "mcp.json"))).toBe(false);
		expect(readFileSync(source, "utf8")).toBe(before);
	});
});
