import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import type { McpServerEntry } from "./config.ts";

interface StoredGrant {
	epoch: string;
	state?: McpOAuthState;
}
type StoredGrants = Record<string, StoredGrant>;
const queues = new Map<string, Promise<void>>();
const backendIds = new WeakMap<AuthStorageBackend, string>();
const mutation = new AsyncLocalStorage<{ identity: string; signal: AbortSignal; assertHeld(): void }>();

/** Raw configured identity only: this never resolves environment variables or !secret commands. */
function serverKey(entry: McpServerEntry): string {
	const config = entry.config;
	const endpoint = "url" in config ? new URL(config.url).href : [config.command, config.args, config.cwd];
	const oauth = "url" in config ? config.oauth : undefined;
	return createHash("sha256")
		.update(JSON.stringify([entry.name, endpoint, oauth?.clientId, oauth?.clientMetadataUrl, oauth?.clientSecret]))
		.digest("hex");
}

function parseGrants(content: string | undefined): StoredGrants {
	if (!content?.trim()) return {};
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("Invalid MCP credential store JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid MCP credential store");
	// URL-keyed credentials from older Pi versions are deliberately not an authentication fallback.
	return value as StoredGrants;
}

function durableState(state: McpOAuthState): McpOAuthState {
	const next = structuredClone(state);
	delete next.codeVerifier;
	delete next.oauthState;
	delete next.discovery;
	return next;
}

export interface McpOAuthServerStore extends McpOAuthStateStore {
	/** Refresh, grant completion, logout and import share this same identity lock. */
	withMutationLock<T>(fn: () => Promise<T>): Promise<T>;
	catalogIdentity(): string;
	/** Commit a completed grant only if the identity observed at begin still exists. */
	commitGrant(state: McpOAuthState, expectedIdentity: string, signal?: AbortSignal): Promise<void>;
}

/** Profile/endpoint/client-bound grants. Pending PKCE and state are never durable. */
export class McpOAuthCredentialStore {
	private readonly backend: AuthStorageBackend;
	private readonly lockDir: string | undefined;
	private readonly namespace: string;
	/** Default file destination, so explicit imports can refuse source aliases before writing. */
	readonly path: string | undefined;

	constructor(backend?: AuthStorageBackend, lockDir?: string) {
		this.path = backend ? undefined : join(lockDir ?? getAgentDir(), "mcp-auth.json");
		this.backend = backend ?? new FileAuthStorageBackend(this.path);
		this.lockDir = backend ? lockDir : (lockDir ?? getAgentDir());
		let id = backendIds.get(this.backend);
		if (!id) {
			id = randomUUID();
			backendIds.set(this.backend, id);
		}
		this.namespace = this.lockDir ? resolve(this.lockDir) : id;
	}

	/** Stable across refresh; changes on completed sign-in, import and logout. */
	catalogIdentity(entry: McpServerEntry): string {
		const key = serverKey(entry);
		return `${key}:${this.read()[key]?.epoch ?? "anonymous"}`;
	}

	forServer(entry: McpServerEntry): McpOAuthServerStore {
		entry = structuredClone(entry);
		if (!("url" in entry.config)) throw new Error("OAuth requires an HTTP MCP server");
		const key = serverKey(entry);
		const identity = `${this.namespace}:${key}`;
		return {
			load: () => {
				const state = this.read()[key]?.state;
				if (state) this.assertEndpoint(entry, state);
				return structuredClone(state);
			},
			save: async (state) => {
				const held = mutation.getStore();
				if (held?.identity !== identity) throw new Error("MCP credential mutation requires the identity lock");
				held.assertHeld();
				this.assertEndpoint(entry, state);
				await this.write((grants) => {
					const grant = grants[key];
					if (!grant?.state) throw new Error("MCP grant no longer exists");
					grant.state = durableState(state);
				});
			},
			withMutationLock: (fn) => this.withMutationLock(key, fn),
			catalogIdentity: () => this.catalogIdentity(entry),
			commitGrant: async (state, expectedIdentity, signal) => {
				await this.withMutationLock(key, async () => {
					signal?.throwIfAborted();
					this.assertEndpoint(entry, state);
					await this.write((grants) => {
						if (`${key}:${grants[key]?.epoch ?? "anonymous"}` !== expectedIdentity)
							throw new Error("MCP grant changed during sign-in");
						grants[key] = { epoch: randomUUID(), state: durableState(state) };
					}, signal);
				});
			},
		};
	}

	tokens(entry: McpServerEntry): McpOAuthState["tokens"] {
		const state = this.read()[serverKey(entry)]?.state;
		if (state) this.assertEndpoint(entry, state);
		return structuredClone(state?.tokens);
	}

	async remove(entry: McpServerEntry): Promise<boolean> {
		const key = serverKey(entry);
		return this.withMutationLock(key, async () => {
			let removed = false;
			await this.write((grants) => {
				removed = grants[key]?.state !== undefined;
				// Keep a tombstone so a pending sign-in cannot resurrect a logged-out grant.
				grants[key] = { epoch: randomUUID() };
			});
			return removed;
		});
	}

	/** Copy-only import: a tombstone may be reused, but an existing grant is never overwritten. */
	async importGrant(entry: McpServerEntry, state: McpOAuthState): Promise<void> {
		entry = structuredClone(entry);
		const key = serverKey(entry);
		await this.withMutationLock(key, async () => {
			this.assertEndpoint(entry, state);
			const next = durableState(state);
			await this.write((grants) => {
				if (grants[key]?.state) throw new Error(`Credentials already exist for MCP server "${entry.name}"`);
				grants[key] = { epoch: randomUUID(), state: next };
			});
			if (JSON.stringify(this.read()[key]?.state) !== JSON.stringify(next))
				throw new Error("MCP credential import verification failed");
		});
	}

	private assertEndpoint(entry: McpServerEntry, state: McpOAuthState): void {
		if (!("url" in entry.config) || state.serverUrl !== new URL(entry.config.url).href) {
			throw new Error("MCP credentials belong to a different endpoint");
		}
		if (
			entry.config.oauth?.clientId &&
			state.clientInformation &&
			entry.config.oauth.clientId !== state.clientInformation.client_id
		) {
			throw new Error("MCP credentials belong to a different client");
		}
	}

	private async withMutationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const identity = `${this.namespace}:${key}`;
		if (mutation.getStore()?.identity === identity) throw new Error("Nested MCP credential mutation");
		const previous = queues.get(identity) ?? Promise.resolve();
		let unlock = () => {};
		const queued = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		queues.set(identity, queued);
		await previous;
		let release: (() => Promise<void>) | undefined;
		let active = true;
		const controller = new AbortController();
		try {
			if (this.lockDir) {
				mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
				release = await lockfile.lock(join(this.lockDir, `mcp-auth-identity-${key}`), {
					realpath: false,
					stale: 20_000,
					retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
					onCompromised: (error) => {
						controller.abort(error);
					},
				});
			}
			return await mutation.run(
				{
					identity,
					signal: controller.signal,
					assertHeld: () => {
						controller.signal.throwIfAborted();
						if (!active) throw new Error("MCP credential identity lock was released");
					},
				},
				fn,
			);
		} finally {
			active = false;
			await release?.().catch(() => undefined);
			unlock();
			if (queues.get(identity) === queued) queues.delete(identity);
		}
	}

	private read(): StoredGrants {
		if (this.path) {
			try {
				// The backend publishes atomically. Synchronous cache reads must not block its async writer.
				return parseGrants(readFileSync(this.path, "utf8"));
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
				throw error;
			}
		}
		return this.backend.withLock((current) => ({ result: parseGrants(current) }));
	}

	private async write(update: (grants: StoredGrants) => void, signal?: AbortSignal): Promise<void> {
		const held = mutation.getStore();
		held?.assertHeld();
		await this.backend.withLockAsync(
			async (current) => {
				held?.assertHeld();
				const grants = parseGrants(current);
				update(grants);
				return { result: undefined, next: `${JSON.stringify(grants, null, 2)}\n` };
			},
			{ signal: held ? AbortSignal.any([held.signal, ...(signal ? [signal] : [])]) : signal },
		);
	}
}
