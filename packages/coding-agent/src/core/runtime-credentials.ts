import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { StoredCommandInvalidation } from "./auth-storage.ts";

type CommandCacheableCredentialStore = CredentialStore & {
	invalidateCachedCredential?: (
		provider: string,
		options?: AuthOperationOptions,
	) => Promise<StoredCommandInvalidation>;
};

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CommandCacheableCredentialStore;
	private readonly overrides = new Map<string, string>();
	/** Modifications not yet written or failed, for example an OAuth refresh. */
	private readonly pendingModifications = new Set<Promise<void>>();

	constructor(store: CommandCacheableCredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	async invalidateCachedCredential(
		providerId: string,
		options?: AuthOperationOptions,
	): Promise<StoredCommandInvalidation> {
		options?.signal?.throwIfAborted();
		if (this.overrides.has(providerId)) return { hasStored: true, invalidated: false };
		if (this.store.invalidateCachedCredential) {
			return this.store.invalidateCachedCredential(providerId, options);
		}
		const entries = await this.store.list(options);
		options?.signal?.throwIfAborted();
		return { hasStored: entries.some((entry) => entry.providerId === providerId), invalidated: false };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const modification = this.store.modify(providerId, fn, options);
		const pending = modification.then(
			() => undefined,
			() => undefined,
		);
		this.pendingModifications.add(pending);
		void pending.finally(() => this.pendingModifications.delete(pending));
		return modification;
	}

	/**
	 * Resolves when every modification started so far is written or failed. An OAuth refresh may
	 * already have spent the single-use refresh token, so exiting before its result is written would
	 * leave only the spent token in auth.json.
	 */
	async settled(): Promise<void> {
		await Promise.all(this.pendingModifications);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
