import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const neverAbortedSignal = new AbortController().signal;
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";
const nativeFetch = globalThis.fetch;

vi.mock("node:http", { spy: true });

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenResponse(scope = REQUIRED_SCOPE) {
	return {
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 3600,
		id_token: "id-token",
		scope,
	};
}

function stubTokenEndpoint(response: unknown, inspect?: (body: URLSearchParams) => void) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		expect(input instanceof Request ? input.url : String(input)).toBe(TOKEN_URL);
		inspect?.(new URLSearchParams(String(init?.body)));
		return jsonResponse(response);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function loginInteraction(options?: {
	callbackClientId?: string;
	onAuthorize?: (url: URL) => void;
}): ProviderAuthInteraction {
	let authorizeUrl: URL | undefined;
	return {
		signal: neverAbortedSignal,
		notify: (event) => {
			if (event.type !== "auth_url") return;
			authorizeUrl = new URL(event.url);
			options?.onAuthorize?.(authorizeUrl);
		},
		prompt: async (prompt) => {
			if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
			if (!authorizeUrl) throw new Error("Authorization URL was not emitted before the callback prompt");
			const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("code", "authorization-code");
			callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
			if (options?.callbackClientId) callback.searchParams.set("client_id", options.callbackClientId);
			return callback.toString();
		},
	};
}

function connectedCredential(): OAuthCredential {
	return {
		type: "oauth",
		access: "old-access",
		refresh: "old-refresh",
		expires: 0,
		clientId: "oaiapp_existing",
		scopes: REQUIRED_SCOPE.split(" "),
	};
}

describe("OpenAI ChatGPT OAuth", () => {
	afterEach(() => {
		for (const result of vi.mocked(createServer).mock.results) {
			if (result.type !== "return") continue;
			result.value.close();
			result.value.closeAllConnections();
		}
		vi.mocked(createServer).mockClear();
		vi.unstubAllGlobals();
	});

	it("registers a user-owned client and stores its issued ID and granted scopes", async () => {
		let authorizeUrl: URL | undefined;
		let exchangeBody: URLSearchParams | undefined;
		stubTokenEndpoint(tokenResponse(), (body) => {
			exchangeBody = body;
		});

		const credential = await openaiChatGPTOAuth.login(
			loginInteraction({
				callbackClientId: "oaiapp_issued",
				onAuthorize: (url) => {
					authorizeUrl = url;
				},
			}),
			{ getDeviceId: () => DEVICE_ID },
		);

		expect(authorizeUrl?.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(authorizeUrl?.searchParams.get("agent_name_hint")).toBe("Pi");
		expect(authorizeUrl?.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${DEVICE_ID}`);
		expect(authorizeUrl?.searchParams.get("scope")).toBe(REQUIRED_SCOPE);
		expect(authorizeUrl?.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
		expect(authorizeUrl?.searchParams.get("resource")).toBe("https://api.openai.com/v1");
		expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
		expect(exchangeBody?.get("client_id")).toBe("oaiapp_issued");
		expect(exchangeBody?.get("code")).toBe("authorization-code");
		expect(exchangeBody?.get("resource")).toBe("https://api.openai.com/v1");
		expect(exchangeBody?.get("code_verifier")).toBeTruthy();
		expect(credential).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			clientId: "oaiapp_issued",
			scopes: REQUIRED_SCOPE.split(" "),
		});
	});

	it.each(["success", "denial"] as const)(
		"ignores error callbacks without the login state before a valid %s callback",
		async (outcome) => {
			const fetchMock = stubTokenEndpoint(tokenResponse());
			const abort = new AbortController();
			let authorizationUrl: URL | undefined;
			const interaction = loginInteraction({
				onAuthorize: (url) => {
					authorizationUrl = url;
				},
			});
			interaction.signal = abort.signal;
			interaction.prompt = (prompt) =>
				new Promise<string>((_, reject) => {
					prompt.signal?.addEventListener("abort", () => reject(prompt.signal?.reason), { once: true });
				});
			const login = openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID });
			let settled = false;
			void login.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await vi.waitFor(() => expect(authorizationUrl).toBeDefined());
				const callback = new URL(authorizationUrl!.searchParams.get("redirect_uri")!);
				callback.searchParams.set("error", "access_denied");
				for (const state of [undefined, "unrelated-state"]) {
					if (state) callback.searchParams.set("state", state);
					const response = await nativeFetch(callback, { signal: AbortSignal.timeout(2000) });
					expect(response.status).toBe(400);
					expect(await response.text()).toContain("state");
					expect(settled).toBe(false);
					expect(fetchMock).not.toHaveBeenCalled();
				}
				callback.searchParams.set("state", authorizationUrl!.searchParams.get("state")!);
				if (outcome === "success") {
					callback.searchParams.delete("error");
					callback.searchParams.set("code", "callback-code");
					callback.searchParams.set("client_id", "oaiapp_callback");
				}
				const response = await nativeFetch(callback, { signal: AbortSignal.timeout(2000) });
				expect(response.status).toBe(outcome === "success" ? 200 : 400);
				await response.text();
				if (outcome === "success") {
					await expect(login).resolves.toMatchObject({ clientId: "oaiapp_callback", access: "access-token" });
					expect(fetchMock).toHaveBeenCalledOnce();
				} else {
					await expect(login).rejects.toThrow("ChatGPT authorization failed: access_denied");
					expect(fetchMock).not.toHaveBeenCalled();
				}
			} finally {
				abort.abort();
				await login.catch(() => undefined);
			}
		},
	);

	it.each(["notify", "prompt"] as const)("releases the listener when %s throws synchronously", async (source) => {
		const failure = new Error(`${source} setup failed`);
		const interaction = loginInteraction({ callbackClientId: "oaiapp_issued" });
		if (source === "notify")
			interaction.notify = (event) => {
				if (event.type === "auth_url") throw failure;
			};
		else
			interaction.prompt = () => {
				throw failure;
			};
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toBe(failure);

		const probe = createServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(1455, "127.0.0.1", resolve);
		});
		expect(probe.listening).toBe(true);
	});

	it("rejects registration without an issued client ID", async () => {
		const fetchMock = stubTokenEndpoint(tokenResponse());

		await expect(openaiChatGPTOAuth.login(loginInteraction(), { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
			"registration callback did not contain an issued client ID",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a token response that did not grant direct token use", async () => {
		stubTokenEndpoint(tokenResponse("openid profile email offline_access resource.invoke"));

		await expect(
			openaiChatGPTOAuth.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), {
				getDeviceId: () => DEVICE_ID,
			}),
		).rejects.toThrow("grant did not include chatgpt.tokens.use.direct");
	});

	it("requires a device ID before starting authorization", async () => {
		let authorizationStarted = false;
		const interaction = loginInteraction({
			onAuthorize: () => {
				authorizationStarted = true;
			},
		});

		await expect(openaiChatGPTOAuth.login(interaction)).rejects.toThrow("requires a device ID");
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => "not-a-uuid" })).rejects.toThrow(
			"requires a device ID",
		);
		expect(authorizationStarted).toBe(false);
	});

	it("requires refresh responses to rotate the refresh token", async () => {
		const { refresh_token: _refreshToken, ...responseWithoutRefresh } = tokenResponse();
		stubTokenEndpoint(responseWithoutRefresh);

		await expect(openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal)).rejects.toThrow(
			"token response has invalid refresh_token",
		);
	});

	it("refreshes with the credential's issued client ID and stores replacement scopes", async () => {
		let refreshBody: URLSearchParams | undefined;
		stubTokenEndpoint({ ...tokenResponse(), access_token: "new-access", refresh_token: "new-refresh" }, (body) => {
			refreshBody = body;
		});

		const before = Date.now();
		const credential = await openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal);

		// expires_in is 3600 seconds; the credential expires 3 minutes early so it is refreshed in time.
		expect(credential.expires).toBeGreaterThanOrEqual(before + (3600 - 180) * 1000);
		expect(credential.expires).toBeLessThanOrEqual(Date.now() + (3600 - 180) * 1000);

		expect(refreshBody?.get("grant_type")).toBe("refresh_token");
		expect(refreshBody?.get("client_id")).toBe("oaiapp_existing");
		expect(refreshBody?.get("refresh_token")).toBe("old-refresh");
		expect(refreshBody?.get("resource")).toBe("https://api.openai.com/v1");
		expect(refreshBody?.has("scope")).toBe(false);
		expect(credential).toMatchObject({
			access: "new-access",
			refresh: "new-refresh",
			clientId: "oaiapp_existing",
			scopes: REQUIRED_SCOPE.split(" "),
		});
	});
});
