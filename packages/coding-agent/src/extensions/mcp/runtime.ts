/**
 * The part of the MCP integration that talks to servers: connections, transports, and OAuth
 * sign-in. It pulls in the MCP client, so index.ts loads it through runtime.lazy.ts only when a
 * server is configured.
 */

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	type AuthProvider,
	type CallToolResult,
	type GetPromptResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpAbortError,
	McpAuthRequiredError,
	McpClient,
	McpConnectionClosedError,
	McpError,
	McpHttpError,
	type McpRequestOptions,
	McpSessionExpiredError,
	McpTimeoutError,
	type Tool as McpTool,
	type McpTransport,
	type Prompt,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import { VERSION } from "../../config.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import {
	type McpServerCatalog,
	mcpCatalogIdentity,
	mcpConfigIdentity,
	mcpStdioIdentityEnvironment,
} from "./catalog.ts";
import type { McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
	mergeScopes,
} from "./oauth.ts";
import { isMcpAppResource, type McpResourceServer } from "./resources.ts";
import type { McpToolCaller, McpToolExpectation } from "./tools.ts";

export { McpServerLog } from "./log.ts";
export { McpOAuthCredentialStore, McpSignInCancelledError, McpSignInFlow, signInMcpServer } from "./oauth.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];
const LAZY_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `disconnected`: the connection dropped (for example the stdio server exited); the next call
 * reconnects.
 */
type ServerState = "idle" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Network failures and overloaded or restarting servers, which are worth another attempt. */
function isTransientError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	return error instanceof TypeError;
}

function signInRequiredMessage(name: string): string {
	return `MCP server "${name}" requires sign-in. Run /mcp to sign in.`;
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header. */
function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config)) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		stderr: "pipe",
	});
}

/** Servers that do not implement `resources/templates/list` have no templates. */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await list();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
	return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/**
 * Resources and templates at connect time, for the counts in `/mcp` and `pi mcp list`. A server
 * whose lists fail still connects: the resource tools list and read its resources on demand.
 */
async function fetchResources(
	client: McpClient,
): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }> {
	const [resources, resourceTemplates] = await Promise.all([
		client.listResources().catch(() => []),
		listTemplates(client).catch(() => []),
	]);
	return {
		resources: resources.filter((resource) => !isMcpAppResource(resource)),
		resourceTemplates: resourceTemplates.filter((template) => !isMcpAppResource(template)),
	};
}

/** One configured server. Reconnects lazily when a call finds the connection gone. */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	readonly entry: McpServerEntry;
	state: ServerState = "idle";
	error: string | undefined;
	tools: McpTool[] = [];
	/**
	 * Whether the server offers resources. The lists below are what it listed at the last connect or
	 * change, without MCP App resources.
	 */
	hasResources = false;
	resources: Resource[] = [];
	resourceTemplates: ResourceTemplate[] = [];
	prompts: Prompt[] = [];
	catalogKnown = false;
	/** Durable grant identity, stable through refresh. */
	credentialIdentity: string;
	/** Observable opening inputs, including opaque command configuration but not command output. */
	configIdentity: string;
	/** Resolved transport/account identity of the registered tool and prompt bindings. */
	bindingIdentity: string;
	/** Server instructions from `initialize`, describing its tools as a group. */
	instructions: string | undefined;
	/** Last OAuth challenge, retaining unresolved scope guidance through ordinary token expiry. */
	challenge: OAuthChallenge | undefined;
	/** Effective consent request in this runtime, including advertised scopes denied by consent. */
	requestedScope: string | undefined;
	private client: McpClient | undefined;
	private connectingClient: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private closed = false;
	private requests = 0;
	private idleTimer: NodeJS.Timeout | undefined;
	/** Stderr of the last stdio server that failed to connect. */
	private stderrTail: string | undefined;
	private readonly cwd: string;
	private readonly createTransport: McpTransportFactory;
	private readonly authProviders = new Set<McpAuthProvider>();
	private readonly credentials: McpOAuthCredentialStore;
	private readonly onTools: (connection: McpServerConnection) => void;
	private readonly onChange: ((connection: McpServerConnection) => void) | undefined;
	private readonly log: McpServerLog | undefined;

	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: McpOAuthCredentialStore;
		onTools: (connection: McpServerConnection) => void;
		/** Called when `state`, `error`, or `tools` change. */
		onChange?: (connection: McpServerConnection) => void;
		/** Receives the server's log messages (`notifications/message`). */
		log?: McpServerLog;
	}) {
		this.entry = options.entry;
		this.cwd = options.cwd;
		this.createTransport = options.createTransport;
		this.onTools = options.onTools;
		this.onChange = options.onChange;
		this.log = options.log;
		this.credentials = options.credentials;
		this.credentialIdentity = options.credentials.catalogIdentity(this.entry);
		this.configIdentity = mcpConfigIdentity(this.entry, this.cwd, this.credentialIdentity);
		this.bindingIdentity = mcpCatalogIdentity(this.entry, this.cwd, this.credentialIdentity) ?? randomUUID();
	}

	get name(): string {
		return this.entry.name;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** Server URL when the server authenticates with OAuth. */
	get oauthUrl(): string | undefined {
		return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
	}

	oauthSettings(): McpOAuthSettings {
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		if (!oauth) return {};
		return {
			clientId: oauth.clientId,
			clientMetadataUrl: oauth.clientMetadataUrl,
			clientSecret:
				oauth.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			callbackPort: oauth.callbackPort,
			callbackUrl: oauth.callbackUrl,
			scope: oauth.scope,
		};
	}

	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") {
			this.scheduleIdle();
			return Promise.resolve(this.client);
		}
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
			this.scheduleIdle();
		});
		return this.opening;
	}

	restoreCatalog(catalog: McpServerCatalog): void {
		this.tools = catalog.tools;
		this.hasResources = catalog.hasResources;
		this.resources = catalog.resources;
		this.resourceTemplates = catalog.resourceTemplates;
		this.prompts = catalog.prompts;
		this.instructions = catalog.instructions;
		this.catalogKnown = true;
		this.onTools(this);
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		options: McpRequestOptions,
		expected?: McpToolExpectation,
	): Promise<CallToolResult> {
		let dispatched = false;
		try {
			return await this.withClient((client) => {
				dispatched = false;
				// A reconnect after pipeline admission can replace the metadata or account.
				if (
					expected &&
					(!isDeepStrictEqual(
						this.tools.find((tool) => tool.name === name),
						expected.tool,
					) ||
						(expected.bindingIdentity !== undefined && expected.bindingIdentity !== this.bindingIdentity))
				) {
					throw new Error(
						`MCP tool "${this.name}/${name}" changed. Discover its current definition before calling it.`,
					);
				}
				options.signal?.throwIfAborted();
				dispatched = true;
				return client.callTool(name, args, options);
			});
		} catch (error) {
			if (
				dispatched &&
				(error instanceof McpAbortError ||
					error instanceof McpTimeoutError ||
					error instanceof McpConnectionClosedError ||
					isTransientError(error))
			) {
				throw new Error(
					`MCP tool "${this.name}/${name}" did not return a confirmed result: ${errorMessage(error)}. It may have run. Check the server's state before repeating it; pi did not retry the call.`,
					{ cause: error },
				);
			}
			throw error;
		}
	}

	getPrompt(
		name: string,
		args: Record<string, string>,
		options: McpRequestOptions,
		identity?: string,
	): Promise<GetPromptResult> {
		return this.withClient((client) => {
			if (identity !== undefined && identity !== this.bindingIdentity) {
				throw new Error(`MCP prompt "${this.name}/${name}" belongs to an old account.`);
			}
			if (!this.prompts.some((prompt) => prompt.name === name)) {
				throw new Error(`MCP prompt "${this.name}/${name}" is no longer offered.`);
			}
			return client.getPrompt(name, args, options);
		}, true);
	}

	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
		return this.withClient((client) => client.readResource(uri, options), true);
	}

	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult> {
		return this.withClient((client) => client.listResourcesPage(cursor, options), true);
	}

	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult> {
		return this.withClient(
			(client) =>
				withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
			true,
		);
	}

	allResources(options: McpRequestOptions): Promise<Resource[]> {
		return this.withClient(
			(client) => (client.serverCapabilities?.resources ? client.listResources(options) : Promise.resolve([])),
			true,
		);
	}

	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
		return this.withClient(
			(client) => (client.serverCapabilities?.resources ? listTemplates(client, options) : Promise.resolve([])),
			true,
		);
	}

	/**
	 * Run a request, reconnecting when needed. `readOnly` requests are retried once after a transient
	 * HTTP error; tool calls are not, since they may have run.
	 */
	private async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
		this.requests++;
		clearTimeout(this.idleTimer);
		try {
			for (let attempt = 1; ; attempt++) {
				const client = await this.getClient();
				try {
					const credentialIdentity = this.credentials.catalogIdentity(this.entry);
					const configIdentity = mcpConfigIdentity(this.entry, this.cwd, credentialIdentity);
					if (this.credentialIdentity !== credentialIdentity || configIdentity !== this.configIdentity) {
						throw new Error(`MCP server "${this.name}" changed accounts. Discover it again before calling it.`);
					}
					return await run(client);
				} catch (error) {
					if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
						await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[0]));
						continue;
					}
					if (error instanceof McpSessionExpiredError && attempt === 1) {
						// A 404 confirms this session did not run the request. Other calls on the old
						// client receive their own 404 rather than being interrupted by closing it.
						if (this.client === client) this.client = undefined;
						continue;
					}
					if (!this.needsSignIn(error)) throw error;
					await this.dropClient(client);
					this.markNeedsAuth();
					throw new Error(signInRequiredMessage(this.entry.name));
				}
			}
		} finally {
			this.requests--;
			this.scheduleIdle();
		}
	}

	private scheduleIdle(): void {
		clearTimeout(this.idleTimer);
		if (this.closed || this.requests > 0 || this.opening || !this.client || this.entry.config.connection === "eager")
			return;
		this.idleTimer = setTimeout(() => {
			if (this.requests > 0 || this.opening || !this.client || this.entry.config.connection === "eager") return;
			const client = this.client;
			this.client = undefined;
			this.state = "idle";
			this.changed();
			void client.close().catch(() => undefined);
		}, LAZY_IDLE_TIMEOUT_MS);
		this.idleTimer.unref();
	}

	/** Connect again with fresh credentials, for example after signing in. */
	async reconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		await this.getClient();
	}

	/** Disconnect after the stored credentials were removed. */
	async signOut(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		if (!this.closed) this.markNeedsAuth();
	}

	/** OAuth servers that still reject the request after a refresh need the user to sign in again. */
	private needsSignIn(error: unknown): boolean {
		return (
			error instanceof McpOAuthAuthorizationRequiredError ||
			(this.oauthUrl !== undefined && error instanceof McpAuthRequiredError)
		);
	}

	private markNeedsAuth(): void {
		this.state = "needs-auth";
		this.error = undefined;
		this.changed();
	}

	private changed(): void {
		this.onChange?.(this);
	}

	private async dropClient(client: McpClient): Promise<void> {
		if (this.client === client) this.client = undefined;
		await client.close().catch(() => undefined);
	}

	private async open(): Promise<McpClient> {
		this.state = "connecting";
		this.changed();
		const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
		for (let attempt = 0; ; attempt++) {
			this.stderrTail = undefined;
			try {
				return await this.connectOnce();
			} catch (error) {
				const delay = retries[attempt];
				if (this.closed || delay === undefined || !isTransientError(error)) {
					throw this.connectFailed(error);
				}
				await new Promise((resolve) => setTimeout(resolve, delay));
				if (this.closed) throw this.connectFailed(error);
			}
		}
	}

	private async connectOnce(): Promise<McpClient> {
		const credentialIdentity = this.credentials.catalogIdentity(this.entry);
		const configIdentity = mcpConfigIdentity(this.entry, this.cwd, credentialIdentity);
		const bindingIdentity = mcpCatalogIdentity(this.entry, this.cwd, credentialIdentity);
		const url = this.oauthUrl;
		// Each transport stays bound to its opening grant, including auth retries of prepared writes.
		const authProvider = url
			? createMcpAuthProvider({
					serverUrl: url,
					store: this.credentials.forServer(this.entry),
					settings: () => this.oauthSettings(),
					onChallenge: (challenge) => {
						this.challenge = this.challenge?.scope
							? { ...this.challenge, ...challenge, scope: mergeScopes(this.challenge.scope, challenge.scope) }
							: challenge;
					},
				})
			: undefined;
		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		this.connectingClient = client;
		if (authProvider) {
			this.authProviders.add(authProvider);
			client.onClose(() => {
				void authProvider.settled().then(() => this.authProviders.delete(authProvider));
			});
		}
		const log = this.log;
		if (log) client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
		let transport: McpTransport | undefined;
		try {
			transport = this.createTransport(this.entry, this.cwd, authProvider);
			// Native transports already resolved their used inputs. Never run a secret again for identity,
			// including an OAuth client secret that the connection did not need.
			const inputs =
				transport instanceof StreamableHttpTransport
					? {
							url: transport.url.href,
							headers: Object.fromEntries(
								Object.entries(transport.options.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
							),
						}
					: transport instanceof StdioTransport
						? {
								command: transport.options.command,
								args: transport.options.args,
								cwd: transport.options.cwd,
								env: mcpStdioIdentityEnvironment(transport.options.env, transport.options.inheritEnv !== false),
							}
						: undefined;
			// ponytail: opaque custom transports without native options revoke bindings on each reconnect.
			const liveBindingIdentity =
				bindingIdentity ??
				(inputs
					? createHash("sha256")
							.update(
								JSON.stringify({
									profile: this.name,
									cwd: this.cwd,
									credentialIdentity,
									transport: inputs,
								}),
							)
							.digest("hex")
					: randomUUID());
			await client.connect(transport);
			client.onNotification("notifications/tools/list_changed", () => {
				void this.refreshTools(client);
			});
			client.onNotification("notifications/resources/list_changed", () => {
				void this.refreshResources(client);
			});
			client.onNotification("notifications/prompts/list_changed", () => {
				void this.refreshPrompts(client);
			});
			const stdio = transport instanceof StdioTransport ? transport : undefined;
			client.onClose(() => this.handleClientClose(client, stdio));
			// Servers without the tools capability (prompts or resources only) do not answer tools/list.
			const hasResources = client.serverCapabilities?.resources !== undefined;
			const [tools, resources, prompts] = await Promise.all([
				client.serverCapabilities?.tools ? client.listTools() : [],
				hasResources ? fetchResources(client) : { resources: [], resourceTemplates: [] },
				client.serverCapabilities?.prompts ? client.listPrompts() : [],
			]);
			if (this.closed) throw new Error("shut down while connecting");
			if (
				credentialIdentity !== this.credentials.catalogIdentity(this.entry) ||
				configIdentity !== mcpConfigIdentity(this.entry, this.cwd, credentialIdentity)
			) {
				throw new Error("MCP account changed while connecting; discover the server again.");
			}
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.tools = tools;
			this.hasResources = hasResources;
			this.resources = resources.resources;
			this.resourceTemplates = resources.resourceTemplates;
			this.instructions = client.instructions?.trim() || undefined;
			this.prompts = prompts;
			this.catalogKnown = true;
			this.credentialIdentity = credentialIdentity;
			this.configIdentity = configIdentity;
			this.bindingIdentity = liveBindingIdentity;
			this.state = "connected";
			this.error = undefined;
			this.onTools(this);
			this.changed();
			return client;
		} catch (error) {
			await client.close().catch(() => undefined);
			if (transport instanceof StdioTransport) {
				this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
			}
			throw error;
		} finally {
			if (this.connectingClient === client) this.connectingClient = undefined;
		}
	}

	private connectFailed(error: unknown): Error {
		if (this.needsSignIn(error) && !this.closed) {
			this.markNeedsAuth();
			return new Error(signInRequiredMessage(this.entry.name));
		}
		this.state = this.closed ? "closed" : "failed";
		this.error = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
		this.changed();
		return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
	}

	/** The transport dropped. The next call reconnects; until then the status shows why. */
	private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.state = "disconnected";
		const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
		this.error = stderr ? `Connection closed\n${stderr}` : "Connection closed";
		this.changed();
	}

	private async refreshTools(client: McpClient): Promise<void> {
		this.requests++;
		clearTimeout(this.idleTimer);
		try {
			const tools = await client.listTools();
			if (this.client !== client || this.closed) return;
			this.tools = tools;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		} finally {
			this.requests--;
			this.scheduleIdle();
		}
		this.changed();
	}

	private async refreshResources(client: McpClient): Promise<void> {
		this.requests++;
		clearTimeout(this.idleTimer);
		try {
			const { resources, resourceTemplates } = await fetchResources(client);
			if (this.client !== client || this.closed) return;
			this.resources = resources;
			this.resourceTemplates = resourceTemplates;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh resources: ${errorMessage(error)}`;
		} finally {
			this.requests--;
			this.scheduleIdle();
		}
		this.changed();
	}

	private async refreshPrompts(client: McpClient): Promise<void> {
		this.requests++;
		clearTimeout(this.idleTimer);
		try {
			const prompts = await client.listPrompts();
			if (this.client !== client || this.closed) return;
			this.prompts = prompts;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh prompts: ${errorMessage(error)}`;
		} finally {
			this.requests--;
			this.scheduleIdle();
		}
		this.changed();
	}

	async close(): Promise<void> {
		this.closed = true;
		clearTimeout(this.idleTimer);
		this.state = "closed";
		this.changed();
		const client = this.client;
		this.client = undefined;
		await client?.close().catch(() => undefined);
		await this.connectingClient?.close().catch(() => undefined);
		await this.opening?.catch(() => undefined);
		// A refresh the server already answered may have rotated the refresh token; exiting before the
		// new tokens are saved would lose the grant.
		await Promise.all([...this.authProviders].map((provider) => provider.settled()));
		this.authProviders.clear();
	}
}
