/**
 * Rewrite plain-HTTP model URLs whose hostname resolves to an interface on this
 * machine (for example `http://<host>.<tailnet>.ts.net:8000/v1`) to `127.0.0.1`
 * or `[::1]` when the same port is reachable on loopback, avoiding userspace
 * tunnel hairpinning during local SSE streaming without changing stored config.
 */

import { lookup } from "node:dns/promises";
import { createConnection, isIP } from "node:net";
import { networkInterfaces } from "node:os";

const CACHE_TTL_MS = 60_000;
const LOOPBACK_PROBE_TIMEOUT_MS = 150;

interface CachedEntry<T> {
	value: T;
	expiresAt: number;
}

const hostLocalFamilyCache = new Map<string, CachedEntry<4 | 6 | null>>();
const originLoopbackCache = new Map<string, CachedEntry<string>>();

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function stripZoneId(address: string): string {
	const zoneIndex = address.indexOf("%");
	return zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
}

function isLoopbackHostname(hostname: string): boolean {
	const bare = stripIpv6Brackets(hostname).toLowerCase();
	return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

function collectLocalInterfaceAddresses(): Set<string> {
	const addresses = new Set<string>();
	for (const entries of Object.values(networkInterfaces())) {
		if (!entries) continue;
		for (const entry of entries) {
			addresses.add(stripZoneId(entry.address).toLowerCase());
		}
	}
	return addresses;
}

async function resolveLocalAddressFamily(
	hostname: string,
	resolveHost: (host: string) => Promise<readonly { address: string; family: number }[]>,
	localAddresses: ReadonlySet<string>,
): Promise<4 | 6 | null> {
	const bare = stripIpv6Brackets(hostname).toLowerCase();
	const ipVersion = isIP(bare);
	if (ipVersion === 4 || ipVersion === 6) {
		return localAddresses.has(bare) ? ipVersion : null;
	}

	const now = Date.now();
	const cached = hostLocalFamilyCache.get(bare);
	if (cached && cached.expiresAt > now) return cached.value;

	let family: 4 | 6 | null = null;
	try {
		const records = await resolveHost(bare);
		for (const record of records) {
			if (!localAddresses.has(stripZoneId(record.address).toLowerCase())) continue;
			if (record.family === 4) {
				family = 4;
				break;
			}
			if (record.family === 6) family = 6;
		}
	} catch {
		return null;
	}

	hostLocalFamilyCache.set(bare, { value: family, expiresAt: now + CACHE_TTL_MS });
	return family;
}

function canConnectLoopback(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			resolve(ok);
		};
		const onAbort = (): void => finish(false);
		const socket = createConnection({ host, port });
		socket.setTimeout(LOOPBACK_PROBE_TIMEOUT_MS, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface LoopbackResolutionDeps {
	localAddresses?: ReadonlySet<string>;
	resolveHost?: (host: string) => Promise<readonly { address: string; family: number }[]>;
	probeLoopback?: (host: string, port: number, signal?: AbortSignal) => Promise<boolean>;
}

/** Clear cached DNS and loopback reachability entries (for deterministic tests). */
export function clearSameHostLoopbackCache(): void {
	hostLocalFamilyCache.clear();
	originLoopbackCache.clear();
}

/**
 * Return a loopback equivalent of `baseUrl` when `baseUrl` is a plain `http:` URL
 * pointing to one of this machine's own non-loopback network addresses and the
 * target port accepts loopback connections; otherwise return `baseUrl` unchanged.
 */
export async function resolveSameHostLoopbackBaseUrl(
	baseUrl: string,
	signal?: AbortSignal,
	deps?: LoopbackResolutionDeps,
): Promise<string> {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return baseUrl;
	}
	if (parsed.protocol !== "http:" || !parsed.hostname || isLoopbackHostname(parsed.hostname)) {
		return baseUrl;
	}

	const useDefaultDeps = deps === undefined;
	const now = Date.now();
	if (useDefaultDeps) {
		const cachedOrigin = originLoopbackCache.get(parsed.origin);
		if (cachedOrigin && cachedOrigin.expiresAt > now) {
			parsed.host = new URL(cachedOrigin.value).host;
			const rewritten = parsed.toString();
			return parsed.pathname === "/" && !parsed.search && !parsed.hash && !baseUrl.endsWith("/")
				? rewritten.slice(0, -1)
				: rewritten;
		}
	}

	const localAddresses = deps?.localAddresses ?? collectLocalInterfaceAddresses();
	const resolveHost = deps?.resolveHost ?? ((host: string) => lookup(host, { all: true }));
	const family = await resolveLocalAddressFamily(parsed.hostname, resolveHost, localAddresses);
	if (family === null) return baseUrl;

	const port = parsed.port ? Number(parsed.port) : 80;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return baseUrl;

	const probe = deps?.probeLoopback ?? canConnectLoopback;
	const candidates = family === 4 ? ["127.0.0.1"] : ["127.0.0.1", "::1"];
	for (const candidate of candidates) {
		if (!(await probe(candidate, port, signal))) continue;
		parsed.hostname = candidate === "::1" ? "[::1]" : candidate;
		if (useDefaultDeps) {
			originLoopbackCache.set(new URL(baseUrl).origin, {
				value: parsed.origin,
				expiresAt: Date.now() + CACHE_TTL_MS,
			});
		}
		const rewritten = parsed.toString();
		return parsed.pathname === "/" && !parsed.search && !parsed.hash && !baseUrl.endsWith("/")
			? rewritten.slice(0, -1)
			: rewritten;
	}

	return baseUrl;
}
