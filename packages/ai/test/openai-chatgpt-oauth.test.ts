import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const neverAbortedSignal = new AbortController().signal;
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";
const nativeFetch = globalThis.fetch;

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

	it("ignores unrelated error callbacks before accepting the matching authorization", async () => {
		stubTokenEndpoint(tokenResponse());
		const interaction = loginInteraction({ callbackClientId: "oaiapp_issued" });
		const prompt = interaction.prompt;
		interaction.prompt = async (options) => {
			const correct = await prompt(options);
			const stray = new URL(correct);
			stray.search = "error=access_denied&state=unrelated";
			expect((await nativeFetch(stray)).status).toBe(400);
			expect((await nativeFetch(correct)).status).toBe(200);
			return correct;
		};
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID })).resolves.toMatchObject({
			clientId: "oaiapp_issued",
		});
	});

	it("fails before exposing authorization when the callback port is occupied", async () => {
		const server = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(1455, "127.0.0.1", resolve);
			});
			const interaction = loginInteraction({ callbackClientId: "oaiapp_issued" });
			const notify = vi.spyOn(interaction, "notify");
			const prompt = vi.spyOn(interaction, "prompt");
			const fetch = stubTokenEndpoint(tokenResponse());
			await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
				"Port 1455 is in use",
			);
			expect(notify).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			server.close();
		}
	});

	it.each(["notify", "prompt"] as const)("closes the listener when %s throws", async (method) => {
		const interaction = loginInteraction();
		interaction[method] = () => {
			throw new Error("UI failed");
		};
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
			"UI failed",
		);
		const server = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(1455, "127.0.0.1", resolve);
			});
		} finally {
			server.close();
		}
	});

	it("cancels a login when manual input ignores its signal", async () => {
		const controller = new AbortController();
		const interaction = loginInteraction();
		interaction.signal = controller.signal;
		interaction.prompt = () => {
			controller.abort();
			return new Promise(() => {});
		};
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
			"Login cancelled",
		);
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
