/** Native MCP authentication. Connections refresh grants; only explicit sign-in creates consent. */
import { randomUUID } from "node:crypto";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	MemoryOAuthStateStore,
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthChallenge,
	parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";
import { APP_NAME } from "../../config.ts";
import type { McpServerEntry } from "./config.ts";
import type { McpOAuthServerStore } from "./oauth-credentials.ts";

export { McpOAuthCredentialStore, type McpOAuthServerStore } from "./oauth-credentials.ts";

export interface McpOAuthSettings {
	clientId?: string;
	/** Already resolved, only when authentication actually needs it. */
	clientSecret?: string;
	clientMetadataUrl?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
}

function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return merged.length ? merged.join(" ") : undefined;
}

function registeredRedirects(state: McpOAuthState | undefined): string[] {
	const client = state?.clientInformation;
	return [
		...new Set([
			...(state?.redirectUrl ? [state.redirectUrl] : []),
			...(client && "redirect_uris" in client ? client.redirect_uris : []),
		]),
	];
}

function createProvider(
	serverUrl: string,
	store: MemoryOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: APP_NAME },
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		clientMetadataUrl: settings.clientMetadataUrl,
		store,
		onRedirect,
	});
}

export interface McpAuthProvider extends AuthProvider {
	settled(): Promise<void>;
}

/** Rotating refresh tokens are serialized with sign-in completion, logout and import. */
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: () => McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	const { serverUrl, store } = options;
	let refreshing: Promise<void> | undefined;
	const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		refreshing ??= store
			.withMutationLock(async () => {
				const state = await store.load();
				if (state?.tokens?.access_token !== staleToken) return;
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const settings = options.settings();
				if (!state.clientInformation && !settings.clientId) throw new McpOAuthAuthorizationRequiredError();
				const local = new MemoryOAuthStateStore();
				const next = { ...state };
				delete next.discovery;
				local.save(next);
				const provider = createProvider(
					serverUrl,
					local,
					settings,
					settings.callbackUrl ?? registeredRedirects(state)[0] ?? "http://127.0.0.1/callback",
					() => {
						throw new McpOAuthAuthorizationRequiredError();
					},
				);
				const result = await authorizeMcp(provider, {
					serverUrl,
					resourceMetadataUrl: challenge?.resourceMetadataUrl,
					scope: mergeScopes(settings.scope, challenge?.scope),
					fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
				});
				if (result !== "AUTHORIZED") throw new McpOAuthAuthorizationRequiredError();
				await store.save(local.load()!);
			})
			.finally(() => {
				refreshing = undefined;
			});
		return refreshing;
	};
	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = await store.load();
			const token = state?.tokens?.access_token;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - 30_000 <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			await refresh(token).catch(() => undefined);
			return (await store.load())?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await refreshing?.catch(() => undefined);
		},
	};
}

export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}

interface PendingSignIn {
	store: McpOAuthServerStore;
	expectedIdentity: string;
	local: MemoryOAuthStateStore;
	provider: McpOAuthProvider;
	callback: OAuthCallbackServer;
	redirectUrl: string;
	state: string;
	controller: AbortController;
	result: Promise<OAuthCallback>;
	submit: (result: OAuthCallback) => void;
	flow: { serverUrl: string; scope?: string; resourceMetadataUrl?: URL; fetch: McpFetch };
	timer: ReturnType<typeof setTimeout>;
	completing?: Promise<void>;
}

export interface McpSignInStart {
	id: string;
	authorizationUrl: string;
	redirectUrl: string;
}

/** One session's private browser flows. Never share this instance across independent SDK clients. */
export class McpSignInFlow {
	private readonly pending = new Map<string, PendingSignIn>();
	private readonly starting = new Set<AbortController>();
	private closed = false;

	has(id: string): boolean {
		return this.pending.has(id);
	}

	async begin(options: {
		entry: McpServerEntry;
		store: McpOAuthServerStore;
		settings: McpOAuthSettings;
		challenge?: OAuthChallenge;
		fetch?: McpFetch;
		timeoutMs?: number;
		/** Cancels this start only; detached once the pending browser flow is handed back. */
		signal?: AbortSignal;
	}): Promise<McpSignInStart> {
		const signal = options.signal;
		signal?.throwIfAborted();
		if (this.closed) throw new Error("MCP sign-in runtime is closed");
		if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
			throw new Error("MCP sign-in timeout must be positive");
		if (!("url" in options.entry.config)) throw new Error("OAuth requires an HTTP MCP server");
		const serverUrl = new URL(options.entry.config.url).href;
		const expectedIdentity = options.store.catalogIdentity();
		const stored = await options.store.load();
		const settings = options.settings;
		const registrations = registeredRedirects(stored);
		const configured = settings.callbackUrl;
		const registered = configured && registrations.includes(configured) ? configured : registrations[0];
		const raw = configured ?? registered ?? "http://127.0.0.1/callback";
		const url = new URL(raw);
		if (
			url.protocol !== "http:" ||
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error("OAuth callback must be an HTTP loopback URL without credentials, query or fragment");
		}
		// A persisted registration fixes the complete redirect, not just its port.
		const explicitPort = /^http:\/\/(?:\[[^\]]+\]|[^/?#:]+):(\d+)(?:[/?#]|$)/i.exec(raw)?.[1];
		const fixedRedirect = explicitPort !== undefined || raw === registered;
		const port = explicitPort ? Number(explicitPort) : raw === registered ? 80 : settings.callbackPort;
		if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
			throw new Error("Invalid OAuth callback port");
		if (settings.callbackPort !== undefined && port !== undefined && settings.callbackPort !== port)
			throw new Error("OAuth callback ports differ");
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const controller = new AbortController();
		if (this.closed) throw new Error("MCP sign-in runtime is closed");
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		this.starting.add(controller);
		let callback: OAuthCallbackServer | undefined;
		try {
			controller.signal.throwIfAborted();
			callback = await OAuthCallbackServer.listen({
				host: host === "localhost" ? "127.0.0.1" : host,
				redirectHost: host,
				port,
				path: url.pathname,
				timeoutMs: options.timeoutMs,
				renderPage: (page: OAuthCallbackPage) =>
					page.ok
						? oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
						: oauthErrorHtml(page.message, page.details),
			});
			controller.signal.throwIfAborted();
			const redirectUrl = fixedRedirect ? raw : callback.redirectUrl;
			if (registered && !settings.clientId && !registrations.includes(redirectUrl))
				throw new Error("OAuth redirect differs from the registered callback");
			const local = new MemoryOAuthStateStore();
			if (stored) {
				const next = { ...stored, redirectUrl };
				delete next.tokens;
				delete next.tokensExpireAt;
				delete next.oauthState;
				delete next.codeVerifier;
				delete next.discovery;
				local.save(next);
			} else local.save({ serverUrl, redirectUrl });
			let authorizationUrl: URL | undefined;
			const provider = createProvider(serverUrl, local, settings, redirectUrl, (url) => {
				authorizationUrl = url;
			});
			const flow = {
				serverUrl,
				scope: mergeScopes(settings.scope, options.challenge?.scope),
				resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
				fetch: (input: Parameters<McpFetch>[0], init: Parameters<McpFetch>[1]) =>
					(options.fetch ?? globalThis.fetch)(input, {
						...init,
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
					}),
			};
			await authorizeMcp(provider, { ...flow, skipRefresh: true });
			controller.signal.throwIfAborted();
			if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");
			const state = await provider.state();
			let submit = (_result: OAuthCallback) => {};
			const manual = new Promise<OAuthCallback>((resolve) => {
				submit = resolve;
			});
			const result = Promise.race([callback.waitForCallback(state), manual]);
			result.catch(() => undefined);
			const id = randomUUID();
			const timer = setTimeout(() => {
				void this.cancel(id);
			}, options.timeoutMs ?? 300_000);
			this.pending.set(id, {
				store: options.store,
				expectedIdentity,
				local,
				provider,
				callback,
				redirectUrl,
				state,
				controller,
				result,
				submit,
				flow,
				timer,
			});
			return { id, authorizationUrl: authorizationUrl.href, redirectUrl };
		} catch (error) {
			controller.abort();
			await callback?.close();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.starting.delete(controller);
		}
	}

	/** Supply the full pasted redirect URL, or wait for the loopback browser callback. */
	async complete(id: string, redirectUrl?: string): Promise<void> {
		const pending = this.pending.get(id);
		if (!pending) throw new Error("Unknown or expired MCP sign-in");
		if (redirectUrl !== undefined) {
			const url = new URL(redirectUrl.trim());
			const expected = new URL(pending.redirectUrl);
			if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash)
				throw new Error("Redirect URL does not match the registered callback");
			if (url.searchParams.get("state") !== pending.state)
				throw new Error("The redirect URL belongs to a different sign-in");
			if (url.searchParams.has("error")) throw new Error("OAuth authorization was denied");
			const code = url.searchParams.get("code");
			if (!code) throw new Error("The redirect URL does not contain an authorization code");
			pending.submit({ code, state: pending.state, iss: url.searchParams.get("iss") ?? undefined });
		}
		pending.completing ??= (async () => {
			try {
				const response = await pending.result;
				pending.controller.signal.throwIfAborted();
				const discovery = pending.local.load()?.discovery;
				const issuer = discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl;
				const required =
					discovery?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true;
				if (
					(required && !response.iss) ||
					(response.iss && response.iss.replace(/\/$/, "") !== issuer?.replace(/\/$/, ""))
				)
					throw new Error("OAuth callback issuer does not match discovery");
				await authorizeMcp(pending.provider, { ...pending.flow, authorizationCode: response.code });
				pending.controller.signal.throwIfAborted();
				await pending.store.commitGrant(pending.local.load()!, pending.expectedIdentity, pending.controller.signal);
			} finally {
				await this.cancel(id);
			}
		})();
		return pending.completing;
	}

	async cancel(id: string): Promise<void> {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.controller.abort(new McpSignInCancelledError());
		await pending.callback.close();
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const controller of this.starting) controller.abort(new McpSignInCancelledError());
		await Promise.all([...this.pending.keys()].map((id) => this.cancel(id)));
	}
}

export interface McpSignInPrompt {
	showAuthorizationUrl(url: URL): void;
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

/** UI and CLI use the same runtime-local primitives as the model authentication tool. */
export async function signInMcpServer(options: {
	entry: McpServerEntry;
	store: McpOAuthServerStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
	/** Share with this runtime's model/browser sign-ins. CLI may omit it and own a flow. */
	flow?: McpSignInFlow;
}): Promise<void> {
	const flow = options.flow ?? new McpSignInFlow();
	const controller = new AbortController();
	let id: string | undefined;
	try {
		const started = await flow.begin(options);
		id = started.id;
		options.prompt.showAuthorizationUrl(new URL(started.authorizationUrl));
		const completion = flow.complete(started.id);
		const input = options.prompt.promptForRedirectUrl(controller.signal).then(async (url) => {
			if (!url?.trim()) throw new McpSignInCancelledError();
			await flow.complete(started.id, url);
		});
		await Promise.race([completion, input]);
	} finally {
		controller.abort();
		if (id) await flow.cancel(id);
		if (!options.flow) await flow.close();
	}
}
