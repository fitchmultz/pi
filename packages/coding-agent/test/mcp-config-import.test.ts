import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { importAdapter } from "../src/extensions/mcp/adapter-import.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../src/extensions/mcp/config.ts";
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
		vi.unstubAllEnvs();
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
		updateMcpServerConfig(inherited, { enabled: false, connection: "eager" }, loaded.sharedConfigPath);
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

	it("dry-runs then imports through a relative dotfiles link, preserving sources, target settings and the link", async () => {
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
		const destination = join(paths.agentDir, "mcp.json");
		const target = join(paths.root, "dotfiles.json");
		writeFileSync(target, `${JSON.stringify({ unrelated: "keep", mcpServers: {} }, null, "\t")}\n`);
		chmodSync(target, 0o640);
		const link = "../dotfiles.json";
		symlinkSync(link, destination);
		const targetBefore = readFileSync(target, "utf8");
		const before = [source, override, credentialFile].map((path) => readFileSync(path, "utf8"));
		const options = { ...paths, configPaths: [source, override], credentialFile, adapterStopped: true };
		expect(await importAdapter({ ...options, dryRun: true })).toEqual({
			servers: ["work", "personal", "local"],
			grants: ["work", "personal"],
			dryRun: true,
		});
		expect(read(join(paths.agentDir, "mcp.json"))).toEqual({ unrelated: "keep", mcpServers: {} });
		expect(readFileSync(target, "utf8")).toBe(targetBefore);
		expect(readlinkSync(destination)).toBe(link);
		const result = await importAdapter(options);
		expect(result.grants).toEqual(["work", "personal"]);
		expect(readlinkSync(destination)).toBe(link);
		expect(read(target).mcpServers.local).toMatchObject({ command: "node", connection: "eager", timeout: 2.5 });
		expect(readFileSync(target, "utf8")).toContain('\n\t"unrelated": "keep"');
		expect(statSync(target).mode & 0o777).toBe(0o640);
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

	it.each(["add", "remove", "update"])(
		"%s writes through a relative dotfiles link without detaching it",
		(mutation) => {
			const paths = setup();
			write(paths.sharedConfigPath, { sharedContent: "unchanged", mcpServers: {} });
			const sharedBefore = readFileSync(paths.sharedConfigPath, "utf8");
			const target = join(paths.root, "dotfiles.json");
			writeFileSync(target, '{\n\t"unrelated": {"keep": true},\n\t"mcpServers": {"old": {"command": "old"}}\n}\n');
			chmodSync(target, 0o660);
			const path = join(paths.agentDir, "mcp.json");
			const link = "../dotfiles.json";
			symlinkSync(link, path);
			const loaded = loadMcpConfig({ ...paths, projectTrusted: false });
			const entry = loaded.servers.find((server) => server.name === "old");
			if (!entry) throw new Error("missing symlinked config");
			expect(entry).toMatchObject({ source: path, writableSource: path, scope: "global" });
			// A restrictive umask must not narrow the existing managed file's permissions.
			const umask = process.umask(0o077);
			try {
				if (mutation === "add")
					expect(addMcpServerConfig(path, "new", { command: "new" }, loaded.sharedConfigPath)).toBe(false);
				else if (mutation === "remove")
					expect(removeMcpServerConfig(path, "old", loaded.sharedConfigPath)).toBe(true);
				else updateMcpServerConfig(entry, { enabled: false }, loaded.sharedConfigPath);
			} finally {
				process.umask(umask);
			}
			expect(readlinkSync(path)).toBe(link);
			expect(read(target).unrelated).toEqual({ keep: true });
			if (mutation === "add") expect(read(target).mcpServers.new).toEqual({ command: "new" });
			else if (mutation === "remove") expect(read(target).mcpServers.old).toBeUndefined();
			else expect(read(target).mcpServers.old).toEqual({ command: "old", enabled: false });
			expect(readFileSync(target, "utf8")).toContain('\n\t"unrelated": {');
			expect(statSync(target).mode & 0o777).toBe(0o660);
			expect(readFileSync(paths.sharedConfigPath, "utf8")).toBe(sharedBefore);
		},
	);

	it.each(["dangling", "directory", "readonly"])(
		"refuses a %s target without replacing its relative link",
		async (kind) => {
			const paths = setup();
			const target = join(paths.root, "target.json");
			if (kind === "directory") mkdirSync(target);
			else if (kind === "readonly") {
				write(target, { mcpServers: { old: { command: "old" } } });
				chmodSync(target, 0o444);
			}
			const path = join(paths.agentDir, "mcp.json");
			const link = "../target.json";
			symlinkSync(link, path);
			const before = kind === "readonly" ? readFileSync(target, "utf8") : undefined;
			const refusal = kind === "dangling" ? /ENOENT/ : kind === "directory" ? /regular file/ : /not writable/;
			const entry = {
				name: "old",
				config: { command: "old" },
				source: path,
				writableSource: path,
				scope: "global" as const,
			};
			for (const mutate of [
				() => addMcpServerConfig(path, "new", { command: "new" }, paths.sharedConfigPath),
				() => removeMcpServerConfig(path, "old", paths.sharedConfigPath),
				() => updateMcpServerConfig(entry, { enabled: false }, paths.sharedConfigPath),
			])
				expect(mutate).toThrow(refusal);
			const source = join(paths.root, "adapter.json");
			write(source, { mcpServers: { new: { command: "do-not-run" } } });
			const sourceBefore = readFileSync(source, "utf8");
			for (const dryRun of [true, false])
				await expect(importAdapter({ ...paths, configPaths: [source], dryRun })).rejects.toThrow(refusal);
			expect(readlinkSync(path)).toBe(link);
			if (kind === "readonly") {
				expect(readFileSync(target, "utf8")).toBe(before);
				expect(statSync(target).mode & 0o777).toBe(0o444);
			} else if (kind === "directory") expect(lstatSync(target).isDirectory()).toBe(true);
			else expect(existsSync(target)).toBe(false);
			expect(readFileSync(source, "utf8")).toBe(sourceBefore);
		},
	);

	it.each([
		["default", "global"],
		["default", "project"],
		["custom", "global"],
		["custom", "project"],
	])("refuses %s shared-source aliases in %s settings and CLI writes", async (sourceKind, scope) => {
		const paths = setup();
		vi.stubEnv("HOME", paths.root);
		vi.stubEnv("USERPROFILE", paths.root);
		const sharedConfigPath = sourceKind === "default" ? undefined : paths.sharedConfigPath;
		const shared = sharedConfigPath ?? join(paths.root, ".config", "mcp", "mcp.json");
		mkdirSync(dirname(shared), { recursive: true });
		write(shared, { unrelated: "shared", mcpServers: { old: { command: "old" } } });
		const before = readFileSync(shared, "utf8");
		const path = scope === "global" ? join(paths.agentDir, "mcp.json") : join(paths.cwd, ".pi", "mcp.json");
		const link = relative(dirname(path), shared);
		symlinkSync(link, path);
		const options = { ...paths, sharedConfigPath, log: () => {}, error: () => {} };
		const loaded = loadMcpConfig({ ...options, projectTrusted: true });
		const entry = loaded.servers.find((server) => server.name === "old");
		if (!entry) throw new Error("missing aliased shared entry");
		expect(entry).toMatchObject({ source: path, writableSource: path, scope });
		expect(() => updateMcpServerConfig(entry, { enabled: false }, loaded.sharedConfigPath)).toThrow(
			"read-only shared source",
		);
		const local = scope === "project" ? ["--local"] : [];
		expect(await runMcpCommand(["add", ...local, "new", "--", "do-not-run"], options)).toBe(1);
		expect(await runMcpCommand(["remove", ...local, "old"], options)).toBe(1);
		if (scope === "global") {
			const source = join(paths.root, "adapter.json");
			write(source, { mcpServers: { new: { command: "do-not-run" } } });
			const sourceBefore = readFileSync(source, "utf8");
			expect(await runMcpCommand(["import-adapter", "--config", source], options)).toBe(1);
			expect(readFileSync(source, "utf8")).toBe(sourceBefore);
		}
		expect(readlinkSync(path)).toBe(link);
		expect(readFileSync(shared, "utf8")).toBe(before);
	});

	it("serializes config mutations through different relative aliases of the same canonical target", () => {
		const paths = setup();
		const target = join(paths.root, "dotfiles.json");
		write(target, { mcpServers: {} });
		const first = join(paths.agentDir, "mcp.json");
		const second = join(paths.cwd, ".pi", "mcp.json");
		const firstLink = relative(dirname(first), target);
		const secondLink = relative(dirname(second), target);
		symlinkSync(firstLink, first);
		symlinkSync(secondLink, second);
		const before = readFileSync(target, "utf8");
		const release = lockfile.lockSync(first);
		try {
			expect(() => addMcpServerConfig(second, "new", { command: "new" }, paths.sharedConfigPath)).toThrow(
				"already being held",
			);
			expect(readlinkSync(second)).toBe(secondLink);
			expect(readFileSync(target, "utf8")).toBe(before);
		} finally {
			release();
		}
		expect(addMcpServerConfig(second, "new", { command: "new" }, paths.sharedConfigPath)).toBe(false);
		expect(readlinkSync(first)).toBe(firstLink);
		expect(readlinkSync(second)).toBe(secondLink);
		expect(read(target).mcpServers.new).toEqual({ command: "new" });
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
			const source = join(paths.root, "adapter.json");
			const credentialFile = join(paths.root, "grants.json");
			write(source, { mcpServers: { work: { url: endpoint, oauth: { clientId: "client" } } } });
			write(credentialFile, { work: authEntry("work") });
			const link = relative(dirname(nativePath), kind === "config" ? source : credentialFile);
			symlinkSync(link, nativePath);
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
			expect(readlinkSync(nativePath)).toBe(link);
			expect([source, credentialFile].map((path) => readFileSync(path, "utf8"))).toEqual(before);
		},
	);

	it("refuses a config-destination link to its adapter source before any writes", async () => {
		const paths = setup();
		const source = join(paths.root, "adapter.json");
		write(source, { mcpServers: { local: { command: "do-not-run" } } });
		const before = readFileSync(source, "utf8");
		const destination = join(paths.agentDir, "mcp.json");
		const link = "../adapter.json";
		symlinkSync(link, destination);
		await expect(importAdapter({ ...paths, configPaths: [source] })).rejects.toThrow(
			"source and destination must differ",
		);
		expect(readlinkSync(destination)).toBe(link);
		expect(readFileSync(source, "utf8")).toBe(before);
	});

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
