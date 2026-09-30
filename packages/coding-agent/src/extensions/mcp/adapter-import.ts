/** Explicit copy-only import. Never loaded as a fallback by discovery or authentication. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { parseClientInformation, parseOAuthTokens } from "@earendil-works/pi-mcp/oauth";
import { validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { copyMcpServerConfigs, type McpServerEntry, resolveMcpConfigWriteTarget } from "./config.ts";
import type { McpOAuthCredentialStore } from "./oauth-credentials.ts";

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected an MCP import object");
	return value as Record<string, unknown>;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Invalid MCP import JSON");
	}
}

function sameSource(path: string, destination: string): boolean {
	return (
		resolve(path) === resolve(destination) ||
		(existsSync(destination) && realpathSync(path) === realpathSync(destination))
	);
}

/** Convert references as text; importing never executes commands or resolves secrets. */
function reference(value: unknown): string {
	if (typeof value !== "string" || value.startsWith("!!"))
		throw new Error("Invalid or unsupported adapter secret expression");
	if (value.startsWith("!")) return value;
	return value.replace(
		/\$env:(\w+)|\{env:(\w+)\}/g,
		(_match, first: string | undefined, second: string | undefined) => `\${${first ?? second}}`,
	);
}

function stringMap(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	return Object.fromEntries(Object.entries(record(value)).map(([key, value]) => [key, reference(value)]));
}

function convertConfig(name: string, raw: Record<string, unknown>): McpServerEntry["config"] {
	if (
		[raw.command, raw.url, raw.socket].filter((value) => typeof value === "string" && value.length > 0).length !== 1
	) {
		throw new Error(`Adapter server must define exactly one transport (${name})`);
	}
	if (raw.auth !== undefined && raw.auth !== false && raw.auth !== "oauth" && raw.auth !== "bearer")
		throw new Error(`Invalid adapter auth mode (${name})`);
	// ponytail: convert native stdio/HTTP browser OAuth only; extend alongside native support for other adapter features.
	for (const key of ["socket", "protocolVersion", "includeTools", "excludeTools", "approveTools", "idleTimeout"]) {
		if (raw[key] !== undefined) throw new Error(`Adapter field ${key} is not supported by native MCP (${name})`);
	}
	if (raw.retryOnTransportFailure === true || raw.exposeResources === false)
		throw new Error(`Unsupported adapter transport/resource policy (${name})`);
	if (
		(raw.auth === false || raw.oauth === false) &&
		!Object.keys(record(raw.headers ?? {})).some((name) => name.toLowerCase() === "authorization")
	)
		throw new Error(`Explicit adapter OAuth disablement requires an Authorization header for native MCP (${name})`);
	const config: Record<string, unknown> = {};
	for (const key of ["command", "args", "cwd", "url", "description"]) {
		if (raw[key] !== undefined) config[key] = raw[key];
	}
	if (typeof raw.url === "string" && /\$\{|\$env:|\{env:/.test(raw.url))
		throw new Error(`Resolve the adapter endpoint before importing ${name}`);
	if (raw.env !== undefined) config.env = stringMap(raw.env);
	const headers = stringMap(raw.headers) ?? {};
	if (raw.bearerToken !== undefined) {
		const token = reference(raw.bearerToken);
		if (token.startsWith("!"))
			throw new Error(`Convert the bearer command to a complete Authorization header before importing ${name}`);
		headers.Authorization = `Bearer ${token}`;
	} else if (raw.bearerTokenEnv !== undefined) {
		if (typeof raw.bearerTokenEnv !== "string" || !/^\w+$/.test(raw.bearerTokenEnv))
			throw new Error("Invalid bearerTokenEnv");
		headers.Authorization = `Bearer \${${raw.bearerTokenEnv}}`;
	}
	if (Object.keys(headers).length) config.headers = headers;
	const hasAuthorization = Object.keys(headers).some((header) => header.toLowerCase() === "authorization");
	if ((raw.bearerToken !== undefined || raw.bearerTokenEnv !== undefined) && raw.auth !== "bearer")
		throw new Error(`Adapter bearer fields require auth: "bearer" (${name})`);
	if (raw.auth === "bearer" && !hasAuthorization) throw new Error(`Adapter bearer auth has no token/header (${name})`);
	if (raw.auth === "oauth" && raw.oauth !== false && hasAuthorization)
		throw new Error(`Native MCP cannot combine OAuth with an Authorization header (${name})`);
	if (raw.oauth !== undefined && raw.oauth !== false) {
		const oauth = record(raw.oauth);
		const allowed = new Set([
			"clientId",
			"clientSecret",
			"redirectUri",
			"callbackUrl",
			"callbackPort",
			"scope",
			"clientMetadataUrl",
			"grantType",
			"skipIssuerMetadataValidation",
		]);
		for (const key of Object.keys(oauth)) {
			if (!allowed.has(key)) throw new Error(`Unsupported adapter OAuth field ${key} (${name})`);
		}
		config.oauth = {
			...oauth,
			...(oauth.clientSecret === undefined ? {} : { clientSecret: reference(oauth.clientSecret) }),
			...(oauth.redirectUri === undefined ? {} : { callbackUrl: oauth.redirectUri }),
		};
		if (oauth.grantType !== undefined && oauth.grantType !== "authorization_code")
			throw new Error(`Unsupported adapter OAuth grant (${name})`);
		if (oauth.skipIssuerMetadataValidation !== undefined && oauth.skipIssuerMetadataValidation !== false)
			throw new Error(`Native import requires issuer validation (${name})`);
		delete record(config.oauth).redirectUri;
		delete record(config.oauth).grantType;
		delete record(config.oauth).skipIssuerMetadataValidation;
		if (record(config.oauth).clientMetadataUrl === false) delete record(config.oauth).clientMetadataUrl;
	}
	if (
		raw.lifecycle !== undefined &&
		!["lazy", "lazy-keep-alive", "keep-alive", "eager"].includes(String(raw.lifecycle))
	)
		throw new Error(`Invalid adapter lifecycle (${name})`);
	config.connection =
		raw.connection ?? (raw.lifecycle === "eager" || raw.lifecycle === "keep-alive" ? "eager" : "lazy");
	config.exposure = raw.exposure ?? "codemode-deferred";
	if (raw.toolExposure !== undefined) config.toolExposure = raw.toolExposure;
	if (raw.directTools === true) config.exposure = "direct";
	else if (Array.isArray(raw.directTools)) {
		if (!raw.directTools.every((tool) => typeof tool === "string")) throw new Error(`Invalid directTools (${name})`);
		config.toolExposure = {
			...record(config.toolExposure ?? {}),
			...Object.fromEntries(raw.directTools.map((tool) => [tool, "direct"])),
		};
	} else if (raw.directTools !== undefined && raw.directTools !== false)
		throw new Error(`Invalid directTools (${name})`);
	if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") throw new Error(`Invalid disabled (${name})`);
	if (raw.enabled !== undefined) config.enabled = raw.enabled;
	if (raw.disabled === true) config.enabled = false;
	if (raw.requestTimeoutMs !== undefined) {
		if (
			typeof raw.requestTimeoutMs !== "number" ||
			!Number.isFinite(raw.requestTimeoutMs) ||
			raw.requestTimeoutMs <= 0
		)
			throw new Error(`Invalid requestTimeoutMs (${name})`);
		config.timeout = raw.requestTimeoutMs / 1000;
	} else if (raw.timeout !== undefined) config.timeout = raw.timeout;
	const validated = validateMcpServerConfig(name, config);
	if (typeof validated === "string") throw new Error(validated);
	return validated;
}

/** Adapter sources merge partial overrides before conversion to native whole-entry overrides. */
function readConfigs(paths: string[], destination: string): McpServerEntry[] {
	const merged = new Map<string, Record<string, unknown>>();
	for (const path of paths) {
		const parsed = record(parseJson(readFileSync(path, "utf8")));
		if (parsed.imports !== undefined && (!Array.isArray(parsed.imports) || parsed.imports.length))
			throw new Error("Supply expanded adapter config sources; implicit host imports are not supported");
		if (parsed.settings !== undefined && Object.keys(record(parsed.settings)).length) {
			throw new Error("Adapter global settings must be translated explicitly before importing");
		}
		for (const [name, value] of Object.entries(record(parsed.mcpServers ?? parsed["mcp-servers"] ?? {}))) {
			const next = record(value);
			const base = { ...merged.get(name) };
			if (next.url !== undefined && next.url !== base.url) {
				for (const key of ["headers", "bearerToken", "bearerTokenEnv", "oauth"]) delete base[key];
			}
			if (
				(next.command !== undefined && next.command !== base.command) ||
				(next.args !== undefined && JSON.stringify(next.args) !== JSON.stringify(base.args ?? [])) ||
				(next.cwd !== undefined && next.cwd !== base.cwd)
			)
				delete base.env;
			merged.set(name, { ...base, ...next });
		}
	}
	return [...merged].map(([name, raw]) => ({
		name,
		config: convertConfig(name, raw),
		source: destination,
		writableSource: destination,
		scope: "global",
	}));
}

function optionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid adapter ${field}`);
	return value;
}

/** Validate profile URL/client/issuer before any credential is written. Missing scope/expiry stay missing. */
function convertAdapterGrant(entry: McpServerEntry, value: unknown): McpOAuthState {
	const raw = record(value);
	if (
		!("url" in entry.config) ||
		typeof raw.serverUrl !== "string" ||
		new URL(raw.serverUrl).href !== new URL(entry.config.url).href
	)
		throw new Error(`Adapter grant endpoint differs for ${entry.name}`);
	const tokens = record(raw.tokens);
	const client = record(raw.clientInfo);
	const issuer = tokens.issuer ?? client.issuer;
	if (typeof issuer !== "string" || !URL.canParse(issuer))
		throw new Error(`Adapter grant has no verified issuer (${entry.name})`);
	if (
		tokens.issuer !== undefined &&
		client.issuer !== undefined &&
		String(tokens.issuer).replace(/\/$/, "") !== String(client.issuer).replace(/\/$/, "")
	)
		throw new Error(`Adapter grant issuer bindings differ (${entry.name})`);
	if (entry.config.oauth?.clientId !== undefined && entry.config.oauth.clientId !== client.clientId)
		throw new Error(`Adapter grant client differs (${entry.name})`);
	if (client.configPreRegistered === true && entry.config.oauth?.clientId !== client.clientId)
		throw new Error(`Adapter config client is missing (${entry.name})`);
	if (client.registrationType !== undefined && client.registrationType !== "cimd")
		throw new Error("Unsupported adapter registration type");
	const information = parseClientInformation({
		client_id: client.clientId,
		client_secret: client.clientSecret,
		client_id_issued_at: optionalNumber(client.clientIdIssuedAt, "clientIdIssuedAt"),
		client_secret_expires_at: optionalNumber(client.clientSecretExpiresAt, "clientSecretExpiresAt"),
		redirect_uris: client.redirectUris,
	});
	const callback = entry.config.oauth?.callbackUrl ?? information.redirect_uris[0];
	if (!callback) throw new Error(`Supply the exact registered callbackUrl before importing ${entry.name}`);
	if (information.redirect_uris.length && !information.redirect_uris.includes(callback))
		throw new Error(`Adapter callback differs from registration (${entry.name})`);
	entry.config = { ...entry.config, oauth: { ...entry.config.oauth, callbackUrl: callback } };
	const valid = validateMcpServerConfig(entry.name, entry.config);
	if (typeof valid === "string") throw new Error(valid);
	const state: McpOAuthState = {
		serverUrl: new URL(raw.serverUrl).href,
		redirectUrl: callback,
		issuer,
		clientInformation: information,
		tokens: parseOAuthTokens({
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
			token_type: "Bearer",
			scope: tokens.scope,
		}),
		...(client.registrationType === "cimd" ? { registrationType: "cimd" } : {}),
	};
	const expiresAt = optionalNumber(tokens.expiresAt, "expiresAt");
	if (expiresAt !== undefined) {
		if (!Number.isFinite(expiresAt * 1000)) throw new Error("Invalid adapter expiresAt");
		state.tokensExpireAt = expiresAt * 1000;
	}
	return state;
}

/** Read-only macOS Keychain access; does not invoke adapter readers that migrate/delete old entries. */
function readKeychainGrant(name: string): unknown | undefined {
	if (process.platform !== "darwin") throw new Error("Use an exported credential JSON file outside macOS");
	const account = `sha256-${createHash("sha256").update(name).digest("hex")}`;
	const read = (account: string): string | undefined => {
		try {
			return execFileSync(
				"/usr/bin/security",
				["find-generic-password", "-s", "fitch-mcp-adapter.oauth", "-a", account, "-w"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
			).replace(/\r?\n$/, "");
		} catch (error) {
			if (typeof error === "object" && error !== null && "status" in error && error.status === 44) return undefined;
			throw new Error(`Could not read adapter Keychain grant for ${name}; unlock the Keychain and retry`);
		}
	};
	const payload = read(account);
	if (payload === undefined) return undefined;
	const value = record(parseJson(payload));
	if (value.__piMcpAdapterOAuthChunked !== 1) return value;
	if (
		!Number.isSafeInteger(value.chunkCount) ||
		Number(value.chunkCount) < 1 ||
		Number(value.chunkCount) > 10_000 ||
		typeof value.chunkDigest !== "string" ||
		!/^[a-f0-9]{16}$/.test(value.chunkDigest)
	)
		throw new Error("Invalid adapter Keychain chunk manifest");
	let joined = "";
	for (let index = 0; index < Number(value.chunkCount); index++) {
		const chunk = read(`${account}.chunk.${value.chunkDigest}.${index}`);
		if (chunk === undefined) throw new Error("Missing adapter Keychain chunk");
		joined += chunk;
	}
	if (createHash("sha256").update(joined).digest("hex").slice(0, 16) !== value.chunkDigest)
		throw new Error("Adapter Keychain chunk verification failed");
	return parseJson(joined);
}

export interface AdapterImportOptions {
	/** Ordered from lowest to highest precedence. Explicit paths only. */
	configPaths: string[];
	agentDir: string;
	/** Read-only shared config source; defaults to ~/.config/mcp/mcp.json. */
	sharedConfigPath?: string;
	credentials: McpOAuthCredentialStore;
	/** JSON object keyed by exact adapter profile names, containing AuthEntry objects. */
	credentialFile?: string;
	keychain?: boolean;
	/** All adapter users of the rotating grants must be stopped and stay stopped after copying. */
	adapterStopped?: boolean;
	dryRun?: boolean;
}

export async function importAdapter(
	options: AdapterImportOptions,
): Promise<{ servers: string[]; grants: string[]; dryRun: boolean }> {
	if (!options.configPaths.length) throw new Error("Specify at least one --config source");
	if (options.credentialFile && options.keychain)
		throw new Error("Choose exported JSON or Keychain credentials, not both");
	if ((options.credentialFile || options.keychain) && !options.adapterStopped)
		throw new Error(
			"Stop all adapter sessions and pass --adapter-stopped; copied rotating grants cannot be used independently",
		);
	const destination = join(options.agentDir, "mcp.json");
	const destinations = [destination, ...(options.credentials.path ? [options.credentials.path] : [])];
	for (const source of [...options.configPaths, ...(options.credentialFile ? [options.credentialFile] : [])]) {
		if (destinations.some((path) => sameSource(source, path))) {
			throw new Error("Import source and destination must differ");
		}
	}
	const target = resolveMcpConfigWriteTarget(destination, options.sharedConfigPath);
	const entries = readConfigs(options.configPaths, destination);
	const existing = existsSync(target) ? record(record(parseJson(readFileSync(target, "utf8"))).mcpServers ?? {}) : {};
	for (const entry of entries) {
		if (Object.hasOwn(existing, entry.name))
			throw new Error(`MCP server "${entry.name}" already exists in ${destination}`);
		if ("url" in entry.config && (await options.credentials.forServer(entry).load()))
			throw new Error(`Native credentials already exist for ${entry.name}`);
	}
	const exported = options.credentialFile ? record(parseJson(readFileSync(options.credentialFile, "utf8"))) : {};
	const grants = entries.flatMap((entry) => {
		const value = options.keychain
			? readKeychainGrant(entry.name)
			: Object.hasOwn(exported, entry.name)
				? exported[entry.name]
				: undefined;
		return value === undefined ? [] : [{ entry, state: convertAdapterGrant(entry, value) }];
	});
	if (!options.dryRun) {
		copyMcpServerConfigs(destination, entries, options.sharedConfigPath);
		for (const grant of grants) {
			try {
				await options.credentials.importGrant(grant.entry, grant.state);
			} catch {
				throw new Error(
					`Config was copied, but grant "${grant.entry.name}" could not be copied and verified. Adapter sources are unchanged; inspect native config/credentials before retrying.`,
				);
			}
		}
	}
	return {
		servers: entries.map((entry) => entry.name),
		grants: grants.map(({ entry }) => entry.name),
		dryRun: options.dryRun === true,
	};
}
