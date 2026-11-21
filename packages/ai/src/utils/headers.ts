import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

export function providerHeadersToRecord(
	...headerSources: (ProviderHeaders | undefined)[]
): Record<string, string> | undefined {
	const merged = new Map<string, [string, string]>();
	for (const source of headerSources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			const normalizedName = name.toLowerCase();
			merged.delete(normalizedName);
			if (value !== null) merged.set(normalizedName, [name, value]);
		}
	}
	return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}

const CREDENTIAL_HEADERS = new Set(["authorization", "cf-aig-authorization"]);

/**
 * Whether `headers` carry a request credential that stands in for an API key: a non-empty
 * `authorization`, or `cf-aig-authorization` for Cloudflare AI Gateway. Names match case-insensitively.
 */
export function hasCredentialHeader(headers: ProviderHeaders | undefined): boolean {
	return Object.entries(headers ?? {}).some(
		([name, value]) => CREDENTIAL_HEADERS.has(name.toLowerCase()) && value !== null && value.trim().length > 0,
	);
}
