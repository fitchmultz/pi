import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "20 min", timeoutMs: 1_200_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
const initialGlobalDispatcher = undici.getGlobalDispatcher();
let activeDispatcher: undici.Dispatcher | undefined;
let activeDispatcherSignature: string | undefined;
const MAX_SESSION_DISPATCHERS = 8;
const sessionFetches = new Map<string, { dispatcher: undici.Dispatcher; fetch: typeof globalThis.fetch }>();
const PI_TRANSPORT_FETCH_SYMBOL = Symbol.for("pi.transportFetch");

/** Returns true when `fetchFn` was created by `getSessionHttpFetch` (Pi's own transport wrapper, not a caller fetch). */
export function isSessionTransportFetch(fetchFn: unknown): boolean {
	return (
		typeof fetchFn === "function" &&
		Boolean((fetchFn as unknown as Record<symbol, unknown>)[PI_TRANSPORT_FETCH_SYMBOL])
	);
}

function resolveEffectiveProxies(httpProxy?: string): {
	httpProxy: string | undefined;
	httpsProxy: string | undefined;
} {
	const fallback = httpProxy?.trim() || undefined;
	// Match Undici's EnvHttpProxyAgent and pi-ai's getProxyEnv: lowercase env vars take precedence.
	const resolvedHttp = process.env.http_proxy ?? process.env.HTTP_PROXY ?? fallback;
	return {
		httpProxy: resolvedHttp,
		httpsProxy: process.env.https_proxy ?? process.env.HTTPS_PROXY ?? resolvedHttp,
	};
}

function getDispatcherSignature(timeoutMs: number, httpProxy?: string): string {
	const proxies = resolveEffectiveProxies(httpProxy);
	return JSON.stringify([
		timeoutMs,
		proxies.httpProxy ?? null,
		proxies.httpsProxy ?? null,
		process.env.NO_PROXY ?? null,
		process.env.no_proxy ?? null,
	]);
}

function createHttpDispatcher(timeoutMs: number, httpProxy?: string): undici.EnvHttpProxyAgent {
	const proxies = resolveEffectiveProxies(httpProxy);
	return withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: timeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: timeoutMs,
			...(proxies.httpProxy ? { httpProxy: proxies.httpProxy } : {}),
			...(proxies.httpsProxy ? { httpsProxy: proxies.httpsProxy } : {}),
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
}

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

const appliedProxyEnv: Partial<Record<"HTTP_PROXY" | "HTTPS_PROXY", string>> = {};

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim() || undefined;
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY"] as const) {
		const current = process.env[key];
		const owned = appliedProxyEnv[key] !== undefined && current === appliedProxyEnv[key];
		if (proxy) {
			if (current === undefined || owned) {
				process.env[key] = proxy;
				appliedProxyEnv[key] = proxy;
			} else {
				delete appliedProxyEnv[key];
			}
		} else {
			if (owned) {
				delete process.env[key];
			}
			delete appliedProxyEnv[key];
		}
	}
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const previousDispatcher = activeDispatcher;
	const dispatcher = createHttpDispatcher(normalizedTimeoutMs);
	undici.setGlobalDispatcher(dispatcher);
	activeDispatcher = dispatcher;
	activeDispatcherSignature = getDispatcherSignature(normalizedTimeoutMs);
	if (previousDispatcher && previousDispatcher !== dispatcher && typeof previousDispatcher.close === "function") {
		void Promise.resolve(previousDispatcher.close()).catch(() => {});
	}
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		globalThis.fetch === originalGlobalFetch ||
		(installedGlobalFetch !== undefined && globalThis.fetch === installedGlobalFetch);
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}

export interface HttpTransportSettings {
	httpIdleTimeoutMs: number;
	httpProxy?: string;
}

/**
 * Return a per-session `fetch` bound to an isolated Undici dispatcher matching the session's
 * `httpIdleTimeoutMs` and `httpProxy` settings without mutating process-wide globals.
 *
 * Returns `undefined` when the host replaced `globalThis.fetch` or the global Undici dispatcher,
 * when the CLI/RPC global dispatcher already matches, or when neither the process nor the session
 * overrides Node's default timeout/proxy.
 */
export function getSessionHttpFetch(settings: HttpTransportSettings): typeof globalThis.fetch | undefined {
	const fetchOverridden =
		globalThis.fetch !== originalGlobalFetch &&
		(installedGlobalFetch === undefined || globalThis.fetch !== installedGlobalFetch);
	if (fetchOverridden) {
		return undefined;
	}

	const currentGlobalDispatcher = undici.getGlobalDispatcher();
	const globalDispatcherOverridden =
		currentGlobalDispatcher !== initialGlobalDispatcher && currentGlobalDispatcher !== activeDispatcher;
	if (globalDispatcherOverridden) {
		return undefined;
	}

	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(settings.httpIdleTimeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(settings.httpIdleTimeoutMs)}`);
	}
	const proxy = settings.httpProxy?.trim() || undefined;
	const signature = getDispatcherSignature(normalizedTimeoutMs, proxy);

	if (
		activeDispatcher !== undefined &&
		currentGlobalDispatcher === activeDispatcher &&
		activeDispatcherSignature === signature
	) {
		return undefined;
	}
	if (activeDispatcher === undefined && normalizedTimeoutMs === DEFAULT_HTTP_IDLE_TIMEOUT_MS && proxy === undefined) {
		return undefined;
	}

	const cached = sessionFetches.get(signature);
	if (cached) {
		sessionFetches.delete(signature);
		sessionFetches.set(signature, cached);
		return cached.fetch;
	}

	const dispatcher = createHttpDispatcher(normalizedTimeoutMs, proxy);
	const sessionFetch = ((
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	) => {
		if (
			typeof globalThis.Request === "function" &&
			input instanceof globalThis.Request &&
			!(input instanceof undici.Request)
		) {
			const mergedInit: undici.RequestInit = {
				method: input.method,
				headers: Array.from(input.headers.entries()),
				body: input.body as undici.RequestInit["body"],
				signal: input.signal,
				...(input.body ? { duplex: "half" as const } : {}),
				...(init as undici.RequestInit),
				dispatcher,
			};
			return undici.fetch(input.url, mergedInit);
		}
		return undici.fetch(input as undici.RequestInfo, {
			...(init as undici.RequestInit),
			dispatcher,
		});
	}) as unknown as typeof globalThis.fetch;

	Object.defineProperty(sessionFetch, PI_TRANSPORT_FETCH_SYMBOL, { value: true });
	sessionFetches.set(signature, { dispatcher, fetch: sessionFetch });
	while (sessionFetches.size > MAX_SESSION_DISPATCHERS) {
		const oldest = sessionFetches.entries().next();
		if (oldest.done) break;
		const [oldestKey, oldestEntry] = oldest.value;
		sessionFetches.delete(oldestKey);
		if (typeof oldestEntry.dispatcher.close === "function") {
			void Promise.resolve(oldestEntry.dispatcher.close()).catch(() => {});
		}
	}
	return sessionFetch;
}
