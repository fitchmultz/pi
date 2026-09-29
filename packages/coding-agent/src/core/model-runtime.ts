import { dirname, join } from "node:path";
import {
	type AnyModel,
	type Api,
	type ApiStreamOptions,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierOptions,
	type ClassifierResult,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	clampThinkingLevel,
	createModels,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	getModelType,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	type ImagesOptions,
	isModelType,
	lazyStream,
	type Message,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelThinkingLevel,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	normalizeContext,
	type Provider,
	type ProviderHeaders,
	type ProviderRequestOptions,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import {
	assertChatModel,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	imageErrorResult,
} from "@earendil-works/pi-ai/utils/model-operations";
import { getAgentDir } from "../config.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { AuthStorage as DefaultAuthStorage, FileAuthStorageBackend } from "./auth-storage.ts";
import { CheckpointActivity } from "./checkpoint.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";
import {
	createVirtualModel,
	findLatestResponse,
	isVirtualModel,
	type ModelRoute,
	type ModelRouteReason,
	type VirtualModelDefinition,
	withVirtualModels,
} from "./virtual-models.ts";

interface RegisteredVirtualModel {
	model: Model<Api>;
	route: VirtualModelDefinition["route"];
}

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	allAvailable: readonly AnyModel[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
	authErrors: ReadonlyMap<string, Error>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}

export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	static readonly supportsIgnoreStoredCredentials = true;
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** Virtual models by provider id, then model id. */
	private readonly virtualModels = new Map<string, Map<string, RegisteredVirtualModel>>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		allAvailable: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
		authErrors: new Map(),
	};
	private registrationRefreshPending = false;
	private availabilityRefreshSeq = 0;
	private availabilityRefresh: { seq: number; promise: Promise<void>; cancelled: boolean } | undefined;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private availabilityError: string | undefined;
	private readonly credentialOperations = new Map<string, Promise<unknown>>();
	private readonly checkpointActivity = new CheckpointActivity();
	private readonly checkpointPersistenceErrors = new Map<string, unknown>();

	private persistForCheckpoint<T>(
		key: string,
		write: () => Promise<T>,
		signal?: AbortSignal,
		isPersistenceFailure: (error: unknown) => boolean = () => true,
	): Promise<T> {
		return this.checkpointActivity.run(async () => {
			try {
				const result = await write();
				this.checkpointPersistenceErrors.delete(key);
				return result;
			} catch (error) {
				if (!signal?.aborted && isPersistenceFailure(error)) this.checkpointPersistenceErrors.set(key, error);
				throw error;
			}
		});
	}

	/** Join catalog/auth operations and their underlying storage, including cancelled callers' unlock tails. */
	async flushForCheckpoint(options?: { requireSuccessfulPersistence?: boolean }): Promise<void> {
		await this.checkpointActivity.flush();
		await FileAuthStorageBackend.checkpointActivity.flush();
		if (options?.requireSuccessfulPersistence && this.checkpointPersistenceErrors.size)
			throw new Error(
				`Native persistence failed: ${[...this.checkpointPersistenceErrors].map(([key, error]) => `${key}: ${error instanceof Error ? error.message : String(error)}`).join("; ")}`,
			);
	}

	/** New native model/auth work invalidates the receipt before it starts. */
	holdForCheckpoint(invalidate: () => void): () => void {
		const release = this.checkpointActivity.hold(invalidate);
		try {
			const releaseStorage = FileAuthStorageBackend.checkpointActivity.hold(invalidate);
			return () => {
				releaseStorage();
				release();
			};
		} catch (error) {
			release();
			throw error;
		}
	}

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		// Track the actual stores as well as public operations: cancellation can return before
		// a provider/store continuation releases its file lock. Keep native auth unchanged.
		this.models = createModels({
			credentials: {
				read: (id, options) =>
					this.checkpointActivity.run(async () => {
						options?.signal?.throwIfAborted();
						if (
							this.extensionProviders.get(id)?.ignoreStoredCredentials === true &&
							!credentials.hasRuntimeApiKey(id)
						) {
							return undefined;
						}
						return credentials.read(id, options);
					}),
				list: (options) => this.checkpointActivity.run(() => credentials.list(options)),
				modify: (id, fn, options) => {
					let callbackFailure: { error: unknown } | undefined;
					return this.persistForCheckpoint(
						`credentials:${id}`,
						() =>
							credentials.modify(
								id,
								async (current) => {
									try {
										return await fn(current);
									} catch (error) {
										// OAuth refresh runs inside modify, before any credential is adopted or written.
										callbackFailure = { error };
										throw error;
									}
								},
								options,
							),
						options?.signal,
						(error) => !callbackFailure || error !== callbackFailure.error,
					);
				},
				delete: (id, options) =>
					this.persistForCheckpoint(`credentials:${id}`, () => credentials.delete(id, options), options?.signal),
			},
			modelsStore: {
				read: (id, options) => this.checkpointActivity.run(() => modelsStore.read(id, options)),
				write: (id, entry, options) =>
					this.persistForCheckpoint(`catalog:${id}`, () => modelsStore.write(id, entry, options), options?.signal),
				delete: (id, options) =>
					this.persistForCheckpoint(`catalog:${id}`, () => modelsStore.delete(id, options), options?.signal),
			},
		});
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.id === "radius"
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			process.env.PI_OFFLINE === undefined,
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller =
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		const signal = controller
			? options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			: options.signal;
		try {
			if (options.refreshOnCreate !== false) {
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	private configureRadiusProviders(): void {
		this.builtins.clear();
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
			...this.virtualModels.keys(),
		]);
	}

	/** Returns the provider without virtual models, or undefined when only virtual models define it. */
	private recomposeProvider(providerId: string): Provider | undefined {
		const provider = this.composeProvider(providerId);
		const virtualModels = [...(this.virtualModels.get(providerId)?.values() ?? [])].map((entry) => entry.model);
		if (virtualModels.length > 0) this.models.setProvider(withVirtualModels(providerId, provider, virtualModels));
		else if (provider) this.models.setProvider(provider);
		else this.models.deleteProvider(providerId);
		return provider;
	}

	/** The provider without virtual models, or undefined when nothing defines it. */
	private composeProvider(providerId: string): Provider | undefined {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.compositionErrors.delete(providerId);
			return base;
		}
		try {
			const provider = composeModelProvider(providerId, base, this.config, extension);
			this.compositionErrors.delete(providerId);
			return provider;
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			return base;
		}
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
			allAvailable: this.models
				.getAllModels()
				.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(
		seq: number,
		errorSeq: number,
		signal: AbortSignal,
		onAuthResult?: AuthOperationOptions["onAuthResult"],
	): Promise<void> {
		const auth = new Map<string, AuthCheck | undefined>();
		const authErrors = new Map<string, Error>();
		// The models collection observes only registered providers. Keep credentials for
		// unknown providers visible too, and fail the whole pass if storage cannot be listed.
		const storedProviders = new Set((await this.credentials.list({ signal })).map((entry) => entry.providerId));
		const available = await this.models.getAllAvailable(undefined, {
			signal,
			onAuthResult: (id, observation) => {
				auth.set(id, observation.auth);
				if (observation.error) authErrors.set(id, observation.error);
				if (observation.stored) storedProviders.add(id);
				onAuthResult?.(id, observation);
			},
		});
		signal.throwIfAborted();
		if (seq !== this.availabilityRefreshSeq) return;
		const configuredProviders = new Set([...auth].filter(([, check]) => check !== undefined).map(([id]) => id));
		this.snapshot = {
			all: [...this.models.getModels()],
			available: available.filter((model) => isModelType(model, "chat")),
			allAvailable: available,
			configuredProviders,
			storedProviders,
			auth,
			authErrors,
		};
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	private async queueAvailabilityRefresh(
		signal?: AbortSignal,
		onAuthResult?: AuthOperationOptions["onAuthResult"],
	): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		const pass: { seq: number; promise: Promise<void>; cancelled: boolean } = {
			seq,
			cancelled: false,
			promise: this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal, onAuthResult).catch((error) => {
				// Capture at rejection; a later deadline cannot change a real failure into cancellation.
				pass.cancelled = effectiveSignal.aborted;
				if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}),
		};
		let refresh = pass;
		let failure: { error: unknown } | undefined;
		this.availabilityRefresh = pass;
		// Registration refreshes can overlap the startup barrier. If a newer pass
		// supersedes this one, its snapshot must land before this caller continues.
		for (;;) {
			try {
				await raceWithAbortSignal(refresh.promise, effectiveSignal);
			} catch (error) {
				effectiveSignal.throwIfAborted();
				// A superseded failure cannot end the barrier before the current pass publishes.
				if (this.availabilityRefresh !== refresh) {
					if (!refresh.cancelled) failure ??= { error };
					refresh = this.availabilityRefresh;
					continue;
				}
				if (!refresh.cancelled) throw error;
				// The current pass's caller cancelled before publication. Recheck under
				// this caller's signal without reclassifying an earlier real failure.
				await this.queueAvailabilityRefresh(effectiveSignal, onAuthResult);
				if (failure) throw failure.error;
				return;
			}
			if (this.availabilityRefresh === refresh) {
				// Scoped observations invalidate a full pass without replacing its waiter.
				// A discarded pass is not a complete snapshot, even if the scoped caller aborted.
				if (refresh.seq !== this.availabilityRefreshSeq)
					await this.queueAvailabilityRefresh(effectiveSignal, onAuthResult);
				// Preserve this caller's real failure, but only after the current snapshot barrier.
				if (failure) throw failure.error;
				return;
			}
			refresh = this.availabilityRefresh;
		}
	}

	private async refreshProviderAvailability(
		providerId: string,
		signal: AbortSignal,
		onAuthResult?: AuthOperationOptions["onAuthResult"],
	): Promise<readonly AnyModel[]> {
		// Invalidate older full observations before this provider-scoped check can publish.
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			let auth: AuthCheck | undefined;
			let authError: Error | undefined;
			let stored = false;
			const available = await this.models.getAllAvailable(providerId, {
				signal,
				onAuthResult: (_id, observation) => {
					auth = observation.auth;
					authError = observation.error;
					stored = observation.stored;
					onAuthResult?.(_id, observation);
				},
			});
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) {
				if (authError) throw authError;
				return available;
			}
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			const authErrors = new Map(this.snapshot.authErrors);
			if (authError) authErrors.set(providerId, authError);
			else authErrors.delete(providerId);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (stored) storedProviders.add(providerId);
			else storedProviders.delete(providerId);
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[...this.snapshot.allAvailable.filter((model) => model.provider !== providerId), ...available].map(
					(model) => [`${model.provider}\0${getModelType(model)}\0${model.id}`, model],
				),
			);
			this.snapshot = {
				all,
				available: all.filter((model) => availableById.has(`${model.provider}\0chat\0${model.id}`)),
				allAvailable: this.models
					.getAllModels()
					.flatMap((model) => availableById.get(`${model.provider}\0${getModelType(model)}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
				authErrors,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
			// Credential mutation callers still learn that their committed change failed
			// local verification, but no stale successful auth survives that failure.
			if (authError) throw authError;
			return available;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted &&
				this.snapshot.authErrors.get(providerId) !== error
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		return this.models.getModelsOfType(type, providerId);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.models.getModelOfType(type, providerId, modelId);
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		return this.models.getAllModels(providerId);
	}

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return (await this.getAllAvailable(providerId, options)).filter((model) => isModelType(model, type));
	}

	async getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		if (providerId) {
			return this.checkpointActivity.run(() =>
				this.refreshProviderAvailability(providerId, operationSignal(options?.signal), options?.onAuthResult),
			);
		}
		await this.checkpointActivity.run(() => this.queueAvailabilityRefresh(options?.signal, options?.onAuthResult));
		return this.snapshot.allAvailable;
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const available = await this.getAllAvailable(providerId, options);
		return providerId ? available.filter((model) => isModelType(model, "chat")) : this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		for (const [providerId, error] of this.snapshot.authErrors) {
			errors.push(`Provider "${providerId}" availability: ${error.message}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	/** Failed observation, distinct from a successful unconfigured check. Does not resolve credentials. */
	getAuthCheckError(providerId: string): Error | undefined {
		return this.snapshot.authErrors.get(providerId);
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		return this.checkpointActivity.run(() => this.resolveAuth(providerOrModel, overrides));
	}

	private async resolveAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides,
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return this.checkpointActivity.run(task);
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return this.checkpointActivity.run(() => raceWithAbortSignal(started, signal).then(() => operation));
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			this.recomposeProvider(providerId);
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			const result = await this.models.refresh({ allowNetwork: false, providers: [providerId], signal });
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			this.updateModelSnapshot();
			await this.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(
				providerId,
				"setRuntimeApiKey",
				{ type: "api_key", key: apiKey },
				signal,
			);
		});
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.credentials.list(options);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.snapshot.authErrors.has(providerId)) return { configured: false };
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (
			this.snapshot.storedProviders.has(providerId) &&
			this.extensionProviders.get(providerId)?.ignoreStoredCredentials !== true
		) {
			return { configured: true, source: "stored" };
		}
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	private async prepareRequest<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(
		model: TModel,
		options: TOptions | undefined,
	): Promise<{
		provider: Provider;
		model: TModel;
		options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	}> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		const requestModel: TModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
		return {
			provider,
			model: requestModel,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>,
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(
			model,
			async () => {
				assertChatModel(model);
				const prepared = await this.prepareRequest(
					model,
					options as (StreamOptions & ModelsRequestTransforms) | undefined,
				);
				return prepared.provider.stream(prepared.model, transcript, prepared.options as ApiStreamOptions<TApi>);
			},
			options?.signal,
		);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		if (isVirtualModel(model)) {
			// Requests outside the agent loop are routed here. Callers sized them before routing, so
			// cap the output budget to the routed model.
			return lazyStream(
				model,
				async () => {
					const route = await this.resolveModel(model, transcript.messages, {
						reason: "direct",
						thinkingLevel: options?.reasoning ?? "off",
						signal: options?.signal,
					});
					const { maxTokens: limit } = route.model;
					const maxTokens =
						options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
					const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
					// Caller credentials were resolved for the virtual model's provider. Another provider
					// resolves its own, so they are not sent to the wrong vendor.
					const { apiKey, headers, env, ...rest } = options ?? {};
					const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
					return this.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning });
				},
				options?.signal,
			);
		}
		return lazyStream(
			model,
			async () => {
				assertChatModel(model);
				const prepared = await this.prepareRequest(model, options);
				return prepared.provider.streamSimple(prepared.model, transcript, prepared.options as SimpleStreamOptions);
			},
			options?.signal,
		);
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(
			model,
			async () => {
				assertChatModel(model);
				const prepared = await this.prepareRequest(model, options);
				if (!prepared.provider.fetchDeferred) {
					throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
				}
				return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
			},
			options?.signal,
		);
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		assertChatModel(model);
		const prepared = await this.prepareRequest(model, options);
		if (!prepared.provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.generateImages) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			return await prepared.provider.generateImages(prepared.model, context, prepared.options as ImagesOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			return await prepared.provider.classify(prepared.model, context, prepared.options as ClassifierOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}

	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal });
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		// An explicit full refresh (notably the services startup barrier) covers queued registrations.
		if (!options.providers) this.registrationRefreshPending = false;
		return this.checkpointActivity.run(() => this.refreshCatalogs(options));
	}

	private queueRegistrationRefresh(): void {
		if (this.registrationRefreshPending) return;
		this.registrationRefreshPending = true;
		void this.checkpointActivity.run(async () => {
			// Composition is synchronous; only the redundant catalog/auth work is coalesced.
			// Reserve checkpoint activity now, before yielding to the rest of the factory batch.
			await Promise.resolve();
			if (this.registrationRefreshPending) await this.refresh({ allowNetwork: false });
		});
	}

	private async refreshCatalogs(options: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		if (options.providers) {
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else {
			this.rebuildProviders();
		}
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		const result = await this.models.refresh(refreshOptions);
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted) {
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch {
				// Availability errors are recorded by the latest pass; refreshed models remain usable.
			}
		}
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	private invalidateProviderAvailability(providerId: string): void {
		++this.availabilityRefreshSeq;
		this.providerAvailabilitySeq.set(providerId, (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1);
		const authErrors = new Map(this.snapshot.authErrors);
		authErrors.delete(providerId);
		this.snapshot = { ...this.snapshot, authErrors };
	}

	registerNativeProvider(provider: Provider): void {
		this.checkpointActivity.invalidate();
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.invalidateProviderAvailability(provider.id);
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		this.queueRegistrationRefresh();
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		this.checkpointActivity.invalidate();
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.invalidateProviderAvailability(providerId);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// Provisional entry until the async refresh lands; never clobber a real check result.
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
				allAvailable: this.models.getAllModels().filter((model) => configuredProviders.has(model.provider)),
			};
		}
		this.queueRegistrationRefresh();
	}

	unregisterProvider(providerId: string): void {
		this.checkpointActivity.invalidate();
		this.invalidateProviderAvailability(providerId);
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.queueRegistrationRefresh();
	}

	/**
	 * Register a virtual model under `definition.provider`, which may also list physical models or
	 * several virtual models. Re-registering the same provider and id replaces the virtual model.
	 * Throws when the id belongs to a physical model of that provider.
	 */
	registerVirtualModel(definition: VirtualModelDefinition): void {
		this.checkpointActivity.invalidate();
		const { provider: providerId, id } = definition;
		this.invalidateProviderAvailability(providerId);
		if (!providerId.trim() || !id.trim()) throw new Error("Virtual model provider and id must not be empty.");
		const existing = this.models.getModel(providerId, id);
		if (existing && !isVirtualModel(existing)) {
			throw new Error(`Virtual model ${providerId}/${id} conflicts with a physical model.`);
		}
		const models = this.virtualModels.get(providerId) ?? new Map<string, RegisteredVirtualModel>();
		models.set(id, { model: createVirtualModel(definition), route: (request) => definition.route(request) });
		this.virtualModels.set(providerId, models);
		if (!this.recomposeProvider(providerId) && !this.snapshot.configuredProviders.has(providerId)) {
			// A provider of only virtual models needs no credentials. Mark it configured now: session
			// restore checks auth before the refresh below lands.
			const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "virtual" });
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			this.snapshot = { ...this.snapshot, auth, configuredProviders };
		}
		this.updateModelSnapshot();
		this.queueRegistrationRefresh();
	}

	unregisterVirtualModel(providerId: string, id: string): void {
		this.checkpointActivity.invalidate();
		this.invalidateProviderAvailability(providerId);
		const models = this.virtualModels.get(providerId);
		if (!models?.delete(id)) return;
		if (models.size === 0) this.virtualModels.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		this.queueRegistrationRefresh();
	}

	/**
	 * Ask a virtual model's router for the model and thinking level of one request. The router must
	 * return a physical catalog model whose provider has credentials; the thinking level is clamped
	 * to that model. Throws when routing fails.
	 *
	 * `previous` reports the latest successful response in `messages`. A retry passes the failed
	 * response as `options.failed`; `messages` no longer contains it. `options.state` is the router
	 * state stored by the caller, which also stores the returned state.
	 */
	async resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: {
			reason: ModelRouteReason;
			thinkingLevel: ModelThinkingLevel;
			signal?: AbortSignal;
			failed?: AssistantMessage;
			state?: unknown;
		},
	): Promise<ModelRoute> {
		const name = `Virtual model ${model.provider}/${model.id}`;
		const virtual = this.virtualModels.get(model.provider)?.get(model.id);
		if (!virtual) throw new Error(`${name} is not registered.`);
		const { failed, ...request } = options;
		const latest = findLatestResponse(messages);
		const previousModel = latest && this.getPhysicalModel(latest.provider, latest.model);
		// A failed routing attempt names the virtual model; there is no physical request to report.
		const failedModel = failed && this.getPhysicalModel(failed.provider, failed.model);
		const route = await virtual.route({
			...request,
			model,
			previous: previousModel && { model: previousModel, thinkingLevel: latest?.thinkingLevel },
			failed: failedModel && failed && { model: failedModel, thinkingLevel: failed.thinkingLevel, message: failed },
			messages,
		});
		const target = this.getPhysicalModel(route.model.provider, route.model.id);
		const routed = `${name} routed to ${route.model.provider}/${route.model.id}`;
		if (!target) throw new Error(`${routed}, which is not a physical model.`);
		if (!this.hasConfiguredAuth(target.provider)) throw new Error(`${routed}, which has no credentials.`);
		return { model: target, thinkingLevel: clampThinkingLevel(target, route.thinkingLevel), state: route.state };
	}

	/** A catalog chat model that is not virtual. */
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined {
		const model = this.models.getModel(providerId, modelId);
		return model && !isVirtualModel(model) ? model : undefined;
	}
}
