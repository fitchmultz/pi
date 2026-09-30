import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { runMcpCommand } from "../../src/extensions/mcp/cli.ts";
import type { McpOAuthConfig, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";
import { type OAuthMcpServerOptions, startOAuthMcpServer } from "./mcp-oauth-server.ts";

describe("AgentSession MCP OAuth", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		browser: "follow" | "paste" | "manual",
		oauth?: McpOAuthConfig,
		lazy = false,
		serverOptions: OAuthMcpServerOptions = {},
	) {
		const server = await startOAuthMcpServer(serverOptions);
		cleanups.push(server.close);
		const backend = new InMemoryAuthStorageBackend();
		const credentials = new McpOAuthCredentialStore(backend);
		const entry: McpServerEntry = {
			name: "issues",
			config: {
				url: server.url,
				exposure: "direct",
				...(lazy ? {} : { connection: "eager" }),
				...(oauth ? { oauth } : {}),
			},
			source: "test",
		};
		const notifications: string[] = [];
		const opened: URL[] = [];
		const browserRequests: Promise<Response>[] = [];
		let redirectLocation: Promise<string> | undefined;
		const harness: Harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					credentials,
					openUrl: (url) => {
						opened.push(new URL(url));
						if (browser === "follow") {
							// The browser follows the authorization redirect to the loopback callback.
							const request = fetch(url);
							request.catch(() => undefined);
							browserRequests.push(request);
						} else if (browser === "paste") {
							// The browser cannot reach the callback; the user pastes the redirect URL.
							redirectLocation = fetch(url, { redirect: "manual" }).then(
								(response) => response.headers.get("location") ?? "",
							);
						}
					},
				}),
			],
		});
		cleanups.push(async () => {
			await Promise.all(browserRequests);
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		});
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message) => notifications.push(message),
				// The paste prompt waits until sign-in completes unless the user pastes the redirect URL.
				input: (_title, _placeholder, opts) =>
					browser === "paste"
						? Promise.resolve(redirectLocation)
						: new Promise((resolve) =>
								opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
							),
			}),
		});
		if (!lazy)
			await vi.waitFor(() =>
				expect(notifications).toContain("MCP servers need attention:\n  issues: needs sign-in\nRun /mcp to fix."),
			);
		return {
			harness,
			server,
			notifications,
			backend,
			opened,
			credentials,
			entry,
			redirectLocation: () => redirectLocation,
			waitForBrowser: () => Promise.all(browserRequests),
		};
	}

	async function modelCall(harness: Harness, name: string, args: Record<string, string>): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("use the native MCP tool");
		return getToolResult(harness, name);
	}

	async function callWhoami(harness: Harness): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__issues__whoami", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const before = harness.session.messages.length;
		await harness.session.prompt("who am i");
		const result = harness.session.messages
			.slice(before)
			.find((message): message is ToolResultMessage => message.role === "toolResult");
		if (!result) throw new Error("no tool result");
		return result;
	}

	it("signs in through the browser, refreshes expired tokens, and signs out", async () => {
		const { harness, server, notifications, backend, credentials, entry } = await setup("follow");

		await harness.session.prompt("/mcp");
		// Startup problems are reported once, pointing to /mcp.
		expect(notifications).toContain("MCP servers need attention:\n  issues: needs sign-in\nRun /mcp to fix.");
		expect(notifications.at(-1)).toBe("issues: needs sign-in, run /mcp login issues (direct)");

		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(server.log).toEqual(["401 none", "register", "token code"]);
		expect(backend.withLock((current) => ({ result: current }))).toContain('"access_token": "access-1"');

		expect(getMessageText({ content: (await callWhoami(harness)).content.slice(0, 1) })).toBe("token access-1");

		// An expired access token is refreshed without user interaction.
		server.expireAccessTokens();
		expect(getMessageText({ content: (await callWhoami(harness)).content.slice(0, 1) })).toBe("token access-2");
		expect(server.log.slice(-3)).toEqual(["401 access-1", "token refresh", "call access-2"]);

		// A token past its expiry is refreshed before the request, without a 401 round trip.
		const scoped = credentials.forServer(entry);
		await scoped.withMutationLock(async () => {
			const state = await scoped.load();
			if (!state) throw new Error("No signed-in grant");
			state.tokensExpireAt = Date.now() - 1_000;
			await scoped.save(state);
		});
		expect(getMessageText({ content: (await callWhoami(harness)).content.slice(0, 1) })).toBe("token access-3");
		expect(server.log.slice(-2)).toEqual(["token refresh", "call access-3"]);

		await harness.session.prompt("/mcp logout issues");
		expect(notifications.at(-1)).toBe('Signed out of MCP server "issues".');
		const result = await callWhoami(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Tool mcp__issues__whoami not found");
	});

	it("accepts a pasted redirect URL when the browser cannot reach the callback", async () => {
		const { harness, server, notifications } = await setup("paste");

		await harness.session.prompt("/mcp login");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(getMessageText({ content: (await callWhoami(harness)).content.slice(0, 1) })).toBe(`token access-1`);
		expect(server.log).toContain("token code");
	});

	async function freePort(): Promise<number> {
		return new Promise<number>((resolve) => {
			const probe = createServer().listen(0, "127.0.0.1", () => {
				const address = probe.address() as AddressInfo;
				probe.close(() => resolve(address.port));
			});
		});
	}

	it("uses the configured callback URL and scope", async () => {
		const callbackUrl = `http://localhost:${await freePort()}/callback`;
		const { harness, notifications, opened } = await setup("follow", { callbackUrl, scope: "issues:read" });

		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(opened[0].searchParams.get("redirect_uri")).toBe(callbackUrl);
		expect(opened[0].searchParams.get("scope")).toBe("issues:read");
		expect(getMessageText({ content: (await callWhoami(harness)).content.slice(0, 1) })).toBe("token access-1");
	});

	it("adds the listening port to a callback URL without one", async () => {
		const { harness, notifications, opened } = await setup("follow", { callbackUrl: "http://127.0.0.1/oauth/done" });
		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(opened[0].searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/done$/);

		const port = await freePort();
		const fixed = await setup("follow", { callbackUrl: "http://127.0.0.1/oauth/done", callbackPort: port });
		await fixed.harness.session.prompt("/mcp login issues");
		expect(fixed.opened[0].searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/oauth/done`);
	});

	it("uses credentials from pi mcp login on the next turn", async () => {
		const { harness, server, backend } = await setup("follow");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-login-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { issues: { url: server.url } } }));

		// The agent runs `pi mcp login issues` through bash; the user approves in the browser.
		const output: string[] = [];
		const exitCode = await runMcpCommand(["login", "issues"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(backend),
			openUrl: (url) => void fetch(url),
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		expect(exitCode).toBe(0);
		expect(output.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');

		// The session still waits for a sign-in, and reconnects when the next turn starts.
		expect(getMessageText({ content: (await callWhoami(harness)).content.slice(0, 1) })).toBe("token access-1");
	});

	it.each(["follow", "paste"] as const)(
		"supports model-led lazy sign-in with a %s browser and keeps completion results private",
		async (browser) => {
			const { harness, server, opened, credentials, entry, redirectLocation } = await setup(
				browser,
				undefined,
				true,
			);
			await harness.session.prompt("/mcp");
			expect(server.log).toEqual([]);
			harness.session.setActiveToolsByName(["mcp_auth", "mcp_discover"]);
			const started = await modelCall(harness, "mcp_auth", { action: "begin", server: "issues" });
			expect(started.isError).toBe(false);
			const pending = JSON.parse(getMessageText(started)) as { state: string; id: string; redirectUrl: string };
			expect(pending.state).toBe("pending");
			expect(opened).toHaveLength(1);
			expect(credentials.tokens(entry)).toBeUndefined();
			const redirectUrl = await redirectLocation();
			if (redirectUrl) {
				const wrongState = new URL(redirectUrl);
				wrongState.searchParams.set("state", "different-sign-in");
				const rejected = await modelCall(harness, "mcp_auth", {
					action: "complete",
					id: pending.id,
					redirectUrl: wrongState.href,
				});
				expect(rejected.isError).toBe(true);
				expect(getMessageText(rejected)).toContain("different sign-in");
			}
			const completed = await modelCall(harness, "mcp_auth", {
				action: "complete",
				id: pending.id,
				...(redirectUrl ? { redirectUrl } : {}),
			});
			expect(completed.isError).toBe(false);
			expect(JSON.parse(getMessageText(completed))).toEqual({
				state: "signed-in",
				server: "issues",
				id: pending.id,
			});
			expect(getMessageText(completed)).not.toMatch(/access-|refresh-|code=|state=/);
			expect(credentials.tokens(entry)?.access_token).toBe("access-1");
			expect(harness.session.getCallableToolNames()).not.toContain("mcp__issues__whoami");
			await modelCall(harness, "mcp_discover", { server: "issues" });
			expect(getMessageText({ content: (await callWhoami(harness)).content.slice(0, 1) })).toBe("token access-1");
			expect(opened).toHaveLength(1);
		},
	);

	it.each([401, 403] as const)(
		"keeps narrowed read consent usable and retains unresolved write guidance after a %s challenge",
		async (challengeStatus) => {
			const { harness, server, credentials, entry, opened, waitForBrowser } = await setup(
				"follow",
				undefined,
				true,
				{
					scopesSupported: ["read", "optional"],
					grantScope: "read",
					writeScope: "write",
					challengeStatus,
				},
			);
			harness.session.setActiveToolsByName(["mcp_auth", "mcp_discover"]);
			const first = await modelCall(harness, "mcp_auth", { action: "begin", server: "issues" });
			const { id } = JSON.parse(getMessageText(first)) as { id: string };
			expect(opened[0].searchParams.get("scope")).toBe("read optional");
			const completed = await modelCall(harness, "mcp_auth", { action: "complete", id });
			expect(completed.isError).toBe(false);
			expect(credentials.tokens(entry)?.scope).toBe("read");
			const epoch = credentials.catalogIdentity(entry);
			await modelCall(harness, "mcp_discover", { server: "issues" });
			expect((await callWhoami(harness)).isError).toBe(false);
			const denied = await modelCall(harness, "mcp__issues__write", {});
			expect(denied.isError).toBe(true);
			expect(server.log.filter((line) => line.startsWith("write denied"))).toHaveLength(1);
			expect(server.log).not.toContain("token refresh");
			expect(server.writes()).toBe(0);

			const stepUp = await modelCall(harness, "mcp_auth", { action: "begin", server: "issues" });
			const stepId = (JSON.parse(getMessageText(stepUp)) as { id: string }).id;
			expect(opened[1].searchParams.get("scope")?.split(" ")).toEqual(["read", "optional", "write"]);
			expect((await modelCall(harness, "mcp_auth", { action: "complete", id: stepId })).isError).toBe(false);
			expect(credentials.catalogIdentity(entry)).not.toBe(epoch);
			expect(credentials.tokens(entry)?.scope).toBe("read");
			expect(server.writes()).toBe(0);
			await modelCall(harness, "mcp_discover", { server: "issues" });
			server.expireAccessTokens();
			expect((await callWhoami(harness)).isError).toBe(false);
			expect(server.log.filter((line) => line === "token refresh")).toHaveLength(1);

			const retry = await modelCall(harness, "mcp_auth", { action: "begin", server: "issues" });
			expect(opened[2].searchParams.get("scope")?.split(" ")).toEqual(["read", "optional", "write"]);
			await waitForBrowser();
			await modelCall(harness, "mcp_auth", {
				action: "cancel",
				id: (JSON.parse(getMessageText(retry)) as { id: string }).id,
			});
			expect((await modelCall(harness, "mcp__issues__write", {})).isError).toBe(true);
			expect(server.log.filter((line) => line.startsWith("write denied"))).toHaveLength(2);
			expect(server.log.filter((line) => line === "token refresh")).toHaveLength(1);
			expect(server.writes()).toBe(0);
		},
	);

	it("lets the server authorize a broader scope grant without a client-side literal scope gate", async () => {
		const { harness, server, credentials, entry } = await setup("follow", undefined, true, {
			scopesSupported: ["files:read"],
			grantScope: "files:read",
			writeScope: "files:write",
			writeGrant: "files:all",
			callbackIssuer: "exact",
		});
		harness.session.setActiveToolsByName(["mcp_auth", "mcp_discover"]);
		for (const scope of ["files:read", "files:all"]) {
			server.setGrantScope(scope);
			const started = await modelCall(harness, "mcp_auth", { action: "begin", server: "issues" });
			const { id } = JSON.parse(getMessageText(started)) as { id: string };
			expect((await modelCall(harness, "mcp_auth", { action: "complete", id })).isError).toBe(false);
			expect(credentials.tokens(entry)?.scope).toBe(scope);
			await modelCall(harness, "mcp_discover", { server: "issues" });
			expect((await modelCall(harness, "mcp__issues__write", {})).isError).toBe(scope === "files:read");
		}
		expect(server.log.filter((line) => line.startsWith("write denied"))).toHaveLength(1);
		expect(server.writes()).toBe(1);
		expect(server.log).not.toContain("token refresh");
	});

	it.each(["trailing-slash", "empty"] as const)(
		"refuses a captured %s issuer before exchanging a code or replacing the existing grant",
		async (callbackIssuer) => {
			const { harness, server, credentials, entry } = await setup("follow", undefined, true, { callbackIssuer });
			await credentials.importGrant(entry, {
				serverUrl: server.url,
				issuer: new URL(server.url).origin,
				clientInformation: { client_id: "client-1" },
				tokens: { access_token: "existing-account", token_type: "Bearer", scope: "read" },
			});
			const epoch = credentials.catalogIdentity(entry);
			harness.session.setActiveToolsByName(["mcp_auth"]);
			const started = await modelCall(harness, "mcp_auth", { action: "begin", server: "issues" });
			const { id } = JSON.parse(getMessageText(started)) as { id: string };
			const refused = await modelCall(harness, "mcp_auth", { action: "complete", id });
			expect(refused.isError).toBe(true);
			expect(getMessageText(refused)).toContain("issuer");
			expect(server.log).not.toContain("token code");
			expect(credentials.catalogIdentity(entry)).toBe(epoch);
			expect(credentials.tokens(entry)?.access_token).toBe("existing-account");
		},
	);

	it("cancels a model sign-in without saving a grant or allowing completion afterward", async () => {
		const { harness, server, credentials, entry } = await setup("manual", undefined, true);
		harness.session.setActiveToolsByName(["mcp_auth"]);
		const started = await modelCall(harness, "mcp_auth", { action: "begin", server: "issues" });
		const { id } = JSON.parse(getMessageText(started)) as { id: string };
		const cancelled = await modelCall(harness, "mcp_auth", { action: "cancel", id });
		expect(JSON.parse(getMessageText(cancelled))).toEqual({ state: "cancelled", id });
		expect(credentials.tokens(entry)).toBeUndefined();
		expect(server.log).toEqual(["register"]);
		const completed = await modelCall(harness, "mcp_auth", { action: "complete", id });
		expect(completed.isError).toBe(true);
		expect(getMessageText(completed)).toContain("Unknown, expired, or withdrawn");
	});
});
