import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpFetch } from "@earendil-works/pi-mcp";
import { type McpOAuthState, OAuthCallbackServer } from "@earendil-works/pi-mcp/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore, McpSignInFlow } from "../src/extensions/mcp/oauth.ts";

const endpoint = "https://server.example/mcp";
const issuer = "https://auth.example";
const entry = (name = "work", clientId = "client"): McpServerEntry => ({
	name,
	source: "test",
	config: { url: endpoint, oauth: { clientId } },
});
const grant = (token = "account-one"): McpOAuthState => ({
	serverUrl: endpoint,
	issuer,
	clientInformation: { client_id: "client" },
	tokens: { access_token: token, refresh_token: "refresh-one", token_type: "Bearer", scope: "read" },
});

function authServer(
	options: {
		token?: (params: URLSearchParams) => Promise<Response>;
		requiredIssuer?: boolean;
		scope?: string;
		resourceScopes?: string[];
		cimd?: boolean;
		authMethods?: string[];
	} = {},
) {
	const requests: string[] = [];
	const fetch: McpFetch = async (input, init) => {
		const url = new URL(String(input));
		requests.push(url.pathname);
		if (url.pathname.includes("oauth-protected-resource"))
			return Response.json({
				resource: endpoint,
				authorization_servers: [issuer],
				scopes_supported: options.resourceScopes,
			});
		if (url.pathname.includes("oauth-authorization-server"))
			return Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				registration_endpoint: `${issuer}/register`,
				response_types_supported: ["code"],
				token_endpoint_auth_methods_supported: options.authMethods ?? ["none"],
				client_id_metadata_document_supported: options.cimd,
				authorization_response_iss_parameter_supported: options.requiredIssuer,
			});
		if (url.pathname === "/register")
			return Response.json({ ...JSON.parse(String(init?.body)), client_id: "dynamic" });
		if (url.pathname === "/token")
			return options.token
				? options.token(new URLSearchParams(String(init?.body)))
				: Response.json({
						access_token: "account-two",
						refresh_token: "refresh-two",
						token_type: "Bearer",
						...(options.scope === undefined ? {} : { scope: options.scope }),
					});
		return new Response(null, { status: 404 });
	};
	return { fetch, requests };
}

function redirect(start: { authorizationUrl: string; redirectUrl: string }, extra: Record<string, string> = {}) {
	const url = new URL(start.redirectUrl);
	url.searchParams.set("state", new URL(start.authorizationUrl).searchParams.get("state") ?? "");
	url.searchParams.set("code", "approved-code");
	for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
	return url.href;
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("MCP account identity and sign-in", () => {
	const cleanups: (() => Promise<void> | void)[] = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	it("separates profiles and clients at a normalized endpoint without evaluating secret commands", async () => {
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const work = entry();
		if ("url" in work.config)
			work.config.oauth = { clientId: "client", clientSecret: "!this-command-must-never-run" };
		await credentials.importGrant(work, grant());
		expect(credentials.tokens(work)?.access_token).toBe("account-one");
		expect(credentials.tokens(entry("personal"))).toBeUndefined();
		expect(credentials.tokens(entry("work", "other-client"))).toBeUndefined();
		const equivalent = structuredClone(work);
		if ("url" in equivalent.config) equivalent.config.url = "https://SERVER.example:443/mcp";
		expect(credentials.catalogIdentity(equivalent)).toBe(credentials.catalogIdentity(work));
	});

	it("keeps a grant identity stable through refresh and serializes logout with rotating tokens in-process", async () => {
		const backend = new InMemoryAuthStorageBackend();
		const credentials = new McpOAuthCredentialStore(backend);
		const otherProcess = new McpOAuthCredentialStore(backend);
		const work = entry();
		await credentials.importGrant(work, grant());
		const identity = credentials.catalogIdentity(work);
		const entered = deferred();
		const release = deferred();
		const server = authServer({
			token: async () => {
				entered.resolve();
				await release.promise;
				return Response.json({ access_token: "rotated", token_type: "Bearer" });
			},
		});
		const provider = createMcpAuthProvider({
			serverUrl: endpoint,
			store: credentials.forServer(work),
			settings: () => ({}),
			onChallenge: () => {},
		});
		const refresh = provider.onUnauthorized?.({
			serverUrl: new URL(endpoint),
			response: new Response(null, { status: 401 }),
			token: "account-one",
			fetch: server.fetch,
		});
		await entered.promise;
		let loggedOut = false;
		const logout = otherProcess.remove(work).then(() => {
			loggedOut = true;
		});
		await Promise.resolve();
		expect(loggedOut).toBe(false);
		release.resolve();
		await refresh;
		await logout;
		expect(credentials.tokens(work)).toBeUndefined();
		expect(credentials.catalogIdentity(work)).not.toBe(identity);
		await expect(
			provider.onUnauthorized?.({
				serverUrl: new URL(endpoint),
				response: new Response(null, { status: 401 }),
				token: "account-one",
				fetch: server.fetch,
			}),
		).rejects.toThrow("changed accounts");
		expect(server.requests.filter((path) => path === "/token")).toHaveLength(1);
		expect(credentials.tokens(work)).toBeUndefined();
	});

	it.each([undefined, "read"])(
		"refresh preserves the actual %s scope grant without requiring optional scopes",
		async (scope) => {
			const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
			const work = entry();
			const saved = grant();
			if (scope !== undefined && saved.tokens) saved.tokens.scope = "read write";
			await credentials.importGrant(work, saved);
			const identity = credentials.catalogIdentity(work);
			const provider = createMcpAuthProvider({
				serverUrl: endpoint,
				store: credentials.forServer(work),
				settings: () => ({ scope: "read write optional" }),
				onChallenge: () => {},
			});
			const server = authServer({ resourceScopes: ["read", "optional"], scope });
			await provider.onUnauthorized?.({
				serverUrl: new URL(endpoint),
				response: new Response(null, { status: 401 }),
				token: "account-one",
				fetch: server.fetch,
			});
			expect(credentials.catalogIdentity(work)).toBe(identity);
			expect(credentials.tokens(work)?.scope).toBe("read");
			expect((await credentials.forServer(work).load())?.tokensExpireAt).toBeUndefined();
			expect(server.requests).not.toContain("/register");
			expect(server.requests).not.toContain("/authorize");
		},
	);

	it("keeps pending flows private and cancellation preserves the existing grant and registration", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-private-auth-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const credentials = new McpOAuthCredentialStore(undefined, root);
		const work = entry();
		expect(credentials.tokens(work)).toBeUndefined();
		credentials.catalogIdentity(work);
		expect(existsSync(join(root, "mcp-auth.json"))).toBe(false);
		await credentials.importGrant(work, grant());
		const before = readFileSync(join(root, "mcp-auth.json"), "utf8");
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const started = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: {},
			fetch: authServer().fetch,
		});
		expect(readFileSync(join(root, "mcp-auth.json"), "utf8")).toBe(before);
		await flow.cancel(started.id);
		expect(readFileSync(join(root, "mcp-auth.json"), "utf8")).toBe(before);
		await expect(new McpSignInFlow().complete(started.id)).rejects.toThrow("Unknown or expired");
	});

	it("rejects stale sign-in completion after logout instead of resurrecting the account", async () => {
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const work = entry();
		await credentials.importGrant(work, grant());
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const started = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: {},
			fetch: authServer().fetch,
		});
		await credentials.remove(work);
		await expect(flow.complete(started.id, redirect(started))).rejects.toThrow("grant changed");
		expect(credentials.tokens(work)).toBeUndefined();
	});

	it("checks callback, state and issuer before committing the actual narrower grant or inferred scope", async () => {
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const work = entry();
		await credentials.importGrant(work, grant());
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const server = authServer({ requiredIssuer: true, scope: "read" });
		const started = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: { scope: "read write" },
			fetch: server.fetch,
		});
		await expect(flow.complete(started.id, redirect(started).replace("/callback?", "/wrong?"))).rejects.toThrow(
			"registered callback",
		);
		await expect(flow.complete(started.id, redirect(started, { state: "wrong" }))).rejects.toThrow(
			"different sign-in",
		);
		await expect(flow.complete(started.id, redirect(started, { iss: "https://attacker.example" }))).rejects.toThrow(
			"issuer",
		);
		expect(server.requests).not.toContain("/token");
		expect(credentials.tokens(work)?.access_token).toBe("account-one");
		const missingIssuer = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: {},
			fetch: server.fetch,
		});
		await expect(flow.complete(missingIssuer.id, redirect(missingIssuer))).rejects.toThrow("issuer");
		const narrowed = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: { scope: "read write" },
			fetch: server.fetch,
		});
		const originalEpoch = credentials.catalogIdentity(work);
		await flow.complete(narrowed.id, redirect(narrowed, { iss: issuer }));
		expect(credentials.tokens(work)).toMatchObject({ access_token: "account-two", scope: "read" });
		expect(credentials.catalogIdentity(work)).not.toBe(originalEpoch);
		const success = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: { scope: "read write" },
			fetch: authServer().fetch,
		});
		const epoch = credentials.catalogIdentity(work);
		await flow.complete(success.id, redirect(success, { iss: issuer }));
		expect(credentials.tokens(work)).toMatchObject({ access_token: "account-two", scope: "read write" });
		expect(credentials.catalogIdentity(work)).not.toBe(epoch);
		expect((await credentials.forServer(work).load())?.codeVerifier).toBeUndefined();
	});

	it.each([true, false])(
		"compares any present callback issuer exactly when support is advertised as %s",
		async (requiredIssuer) => {
			const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
			const work = entry();
			await credentials.importGrant(work, grant());
			const epoch = credentials.catalogIdentity(work);
			const flow = new McpSignInFlow();
			cleanups.push(() => flow.close());
			const server = authServer({ requiredIssuer });
			for (const iss of [`${issuer}/`, ""]) {
				const started = await flow.begin({
					entry: work,
					store: credentials.forServer(work),
					settings: {},
					fetch: server.fetch,
				});
				await expect(flow.complete(started.id, redirect(started, { iss }))).rejects.toThrow("issuer");
				expect(server.requests).not.toContain("/token");
				expect(credentials.catalogIdentity(work)).toBe(epoch);
				expect(credentials.tokens(work)?.access_token).toBe("account-one");
			}
		},
	);

	it("renews an expired dynamic client registration before asking for browser consent", async () => {
		const probe = await OAuthCallbackServer.listen();
		const callback = probe.redirectUrl;
		await probe.close();
		const work: McpServerEntry = { name: "expired-client", source: "test", config: { url: endpoint } };
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await credentials.importGrant(work, {
			...grant(),
			clientInformation: {
				client_id: "expired",
				client_secret: "old-secret",
				client_secret_expires_at: 1,
				redirect_uris: [callback],
			},
		});
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const server = authServer();
		const started = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: {},
			fetch: server.fetch,
		});
		expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("dynamic");
		expect(server.requests).toContain("/register");
		expect(credentials.tokens(work)?.access_token).toBe("account-one");
	});

	it("new CIMD registration retains its exact callback across later browser sign-ins", async () => {
		const document = "https://client.example/metadata.json";
		const work: McpServerEntry = {
			name: "new-cimd",
			source: "test",
			config: { url: endpoint, oauth: { clientMetadataUrl: document } },
		};
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const server = authServer({ cimd: true });
		const settings = { clientMetadataUrl: document };
		const first = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings,
			fetch: server.fetch,
		});
		await flow.complete(first.id, redirect(first));
		const second = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings,
			fetch: server.fetch,
		});
		expect(second.redirectUrl).toBe(first.redirectUrl);
		expect(new URL(second.authorizationUrl).searchParams.get("client_id")).toBe(document);
		expect(server.requests).not.toContain("/register");
	});

	it("matching configured clients retain stored registration secrets during refresh", async () => {
		const work = entry();
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await credentials.importGrant(work, {
			...grant(),
			clientInformation: {
				client_id: "client",
				client_secret: "registration-secret",
				redirect_uris: ["http://localhost:19876/callback"],
				token_endpoint_auth_method: "client_secret_post",
			},
		});
		const server = authServer({
			authMethods: ["client_secret_basic", "client_secret_post"],
			token: async (params) => {
				expect(params.get("client_id")).toBe("client");
				expect(params.get("client_secret")).toBe("registration-secret");
				return Response.json({ access_token: "refreshed", token_type: "Bearer" });
			},
		});
		const provider = createMcpAuthProvider({
			serverUrl: endpoint,
			store: credentials.forServer(work),
			settings: () => ({ clientId: "client" }),
			onChallenge: () => {},
		});
		await provider.onUnauthorized?.({
			serverUrl: new URL(endpoint),
			response: new Response(null, { status: 401 }),
			token: "account-one",
			fetch: server.fetch,
		});
		expect(credentials.tokens(work)?.access_token).toBe("refreshed");
		expect(server.requests).not.toContain("/register");
	});

	it("reuses the complete registered callback and CIMD client without replacing registration", async () => {
		const probe = await OAuthCallbackServer.listen({ redirectHost: "localhost", path: "/oauth/exact%2Fpath" });
		const callback = probe.redirectUrl;
		await probe.close();
		const work: McpServerEntry = { name: "cimd", source: "test", config: { url: endpoint } };
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const saved: McpOAuthState = {
			...grant(),
			registrationType: "cimd",
			clientInformation: {
				client_id: "https://client.example/metadata.json",
				redirect_uris: [callback],
				token_endpoint_auth_method: "none",
			},
		};
		await credentials.importGrant(work, saved);
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const server = authServer();
		const started = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: {},
			fetch: server.fetch,
		});
		expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(callback);
		expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
			"https://client.example/metadata.json",
		);
		expect(server.requests).not.toContain("/register");
		await flow.complete(started.id, redirect(started));
		expect((await credentials.forServer(work).load())?.clientInformation).toEqual(saved.clientInformation);
		expect((await credentials.forServer(work).load())?.registrationType).toBe("cimd");
	});

	it("cancellation while grant completion waits for a refresh lock cannot commit a new account", async () => {
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const work = entry();
		await credentials.importGrant(work, grant());
		const refreshing = deferred();
		const release = deferred();
		const refreshServer = authServer({
			token: async () => {
				refreshing.resolve();
				await release.promise;
				return Response.json({ access_token: "rotated-original-account", token_type: "Bearer" });
			},
		});
		const provider = createMcpAuthProvider({
			serverUrl: endpoint,
			store: credentials.forServer(work),
			settings: () => ({}),
			onChallenge: () => {},
		});
		const refresh = provider.onUnauthorized?.({
			serverUrl: new URL(endpoint),
			response: new Response(null, { status: 401 }),
			token: "account-one",
			fetch: refreshServer.fetch,
		});
		await refreshing.promise;
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const exchanged = deferred();
		const signInServer = authServer({
			token: async () => {
				exchanged.resolve();
				return Response.json({ access_token: "new-account", token_type: "Bearer" });
			},
		});
		const started = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: {},
			fetch: signInServer.fetch,
		});
		const completion = flow.complete(started.id, redirect(started));
		completion.catch(() => undefined);
		await exchanged.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await flow.cancel(started.id);
		release.resolve();
		await refresh;
		await expect(completion).rejects.toThrow("cancelled");
		expect(credentials.tokens(work)?.access_token).toBe("rotated-original-account");
	});

	it("aborting one start closes its callback and detaches its caller signal without cancelling handed-back flows", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-aborted-begin-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const credentials = new McpOAuthCredentialStore(undefined, root);
		const work = entry();
		const flow = new McpSignInFlow();
		cleanups.push(() => flow.close());
		const handedBack = new AbortController();
		const first = await flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: { clientId: "client" },
			fetch: authServer().fetch,
			signal: handedBack.signal,
		});
		expect(getEventListeners(handedBack.signal, "abort")).toHaveLength(0);
		handedBack.abort();
		const probe = await OAuthCallbackServer.listen({ path: "/aborted" });
		const callback = probe.redirectUrl;
		const port = Number(new URL(callback).port);
		await probe.close();
		const entered = deferred();
		const caller = new AbortController();
		const fetch: McpFetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) throw new Error("Missing request cancellation");
				entered.resolve();
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		const beginning = flow.begin({
			entry: work,
			store: credentials.forServer(work),
			settings: { clientId: "client", callbackUrl: callback },
			fetch,
			signal: caller.signal,
		});
		beginning.catch(() => undefined);
		await entered.promise;
		caller.abort(new Error("Tool start aborted"));
		await expect(beginning).rejects.toThrow("Tool start aborted");
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
		expect(credentials.tokens(work)).toBeUndefined();
		expect(existsSync(join(root, "mcp-auth.json"))).toBe(false);
		const rebound = await OAuthCallbackServer.listen({ port, path: "/aborted" });
		await rebound.close();
		await flow.complete(first.id, redirect(first));
		expect(credentials.tokens(work)?.access_token).toBe("account-two");
	});

	it("closing a runtime during discovery prevents a pending sign-in from appearing afterward", async () => {
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const work = entry();
		const flow = new McpSignInFlow();
		const discovered = deferred();
		const release = deferred();
		const server = authServer();
		const fetch: McpFetch = async (input, init) => {
			discovered.resolve();
			await release.promise;
			return server.fetch(input, init);
		};
		const beginning = flow.begin({ entry: work, store: credentials.forServer(work), settings: {}, fetch });
		beginning.catch(() => undefined);
		await discovered.promise;
		await flow.close();
		release.resolve();
		await expect(beginning).rejects.toThrow("cancelled");
		expect(credentials.tokens(work)).toBeUndefined();
		await expect(
			flow.begin({ entry: work, store: credentials.forServer(work), settings: {}, fetch: server.fetch }),
		).rejects.toThrow("closed");
	});

	it("rejects issuer changes on refresh without discarding a working registration", async () => {
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const work = entry();
		await credentials.importGrant(work, { ...grant(), issuer: "https://old-auth.example" });
		const provider = createMcpAuthProvider({
			serverUrl: endpoint,
			store: credentials.forServer(work),
			settings: () => ({}),
			onChallenge: () => {},
		});
		const server = authServer();
		await expect(
			provider.onUnauthorized?.({
				serverUrl: new URL(endpoint),
				response: new Response(null, { status: 401 }),
				token: "account-one",
				fetch: server.fetch,
			}),
		).rejects.toThrow("issuer changed");
		expect(credentials.tokens(work)?.access_token).toBe("account-one");
		expect(server.requests).not.toContain("/token");
	});
});
