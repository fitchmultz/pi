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
	getOpenCodeSessionHeaders,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	type ImagesOptions,
	isModelType,
	type LoginOptions,
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
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	imageErrorResult,
} from "@earendil-works/pi-ai/utils/model-operations";
import { getAgentDir } from "../config.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import {
	createModelUnavailability,
	type ModelAllowlist,
	type ModelUnavailability,
	type ModelUnavailableCause,
} from "./model-unavailability.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderAuthFallback,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withPersonalizedCatalog, withRemoteCatalog } from "./remote-catalog-provider.ts";
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

interface ProviderRefresh extends PromiseWithResolvers<ModelsRefreshResult> {
	controller: AbortController;
}

interface ModelRefresh {
	seq: number;
	providers: Map<string, ProviderRefresh>;
}

type ModelAvailability = Awaited<ReturnType<MutableModels["getAvailability"]>>;

interface ModelRuntimeSnapshot {
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
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
	/** Feature detection for extensions that also run on hosts without credential isolation. */
	static readonly supportsIgnoreStoredCredentials = true;

	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly modelCredentials: CredentialStore;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	private readonly authFallbacks = new Map<string, { fallback: ProviderAuthFallback }>();
	/** Source windows before models.json overrides, and unmodified models behind capped views. */
	private readonly overriddenWindows = new WeakMap<Model<Api>, number>();
	private readonly uncappedModels = new WeakMap<Model<Api>, Model<Api>>();
	/** Virtual models by provider id, then model id. */
	private readonly virtualModels = new Map<string, Map<string, RegisteredVirtualModel>>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private modelNetworkEnabled: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	/** `snapshot.available` by provider, so scoped updates read only their own catalogs. */
	private availableByProvider = new Map<string, readonly Model<Api>[]>();
	private refreshSeq = 0;
	private configRefreshSeq = 0;
	private readonly providerRefreshes = new Map<string, ModelRefresh>();
	private availabilityReadSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private availabilityError: string | undefined;
	private authCheckErrors: ReadonlyMap<string, Error> = new Map();
	private readonly credentialOperations = new Map<string, Promise<unknown>>();

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
		this.modelCredentials = {
			read: (id, options) => {
				options?.signal?.throwIfAborted();
				return this.extensionProviders.get(id)?.ignoreStoredCredentials === true &&
					!credentials.hasRuntimeApiKey(id)
					? Promise.resolve(undefined)
					: credentials.read(id, options);
			},
			list: (options) => credentials.list(options),
			modify: (id, fn, options) => credentials.modify(id, fn, options),
			delete: (id, options) => credentials.delete(id, options),
		};
		this.models = createModels({ credentials: this.modelCredentials, modelsStore });
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
		const providers = builtinProviderCatalog.builtinProviders().map((provider) => {
			if (provider.id === "radius") return provider;
			// OpenRouter narrows the catalog to the models, limits and prices of the user's key.
			if (provider.id === "openrouter") {
				return withPersonalizedCatalog(
					provider,
					personalizeOpenRouterCatalog,
					options.catalogBaseUrl,
					builtinModelDataGeneratedAt,
				);
			}
			return withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt);
		});
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
		const fallback = this.authFallbacks.get(providerId)?.fallback;
		if (!this.config.getProvider(providerId) && !extension && !fallback) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.compositionErrors.delete(providerId);
			return base;
		}
		try {
			const provider = composeModelProvider(
				providerId,
				base,
				this.config,
				extension,
				fallback,
				(model, overridden) => {
					this.overriddenWindows.set(overridden, model.contextWindow);
				},
			);
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

	private updateModelSnapshot(providerIds?: readonly string[]): void {
		const current = providerIds && new Set(providerIds);
		this.snapshot = {
			...this.snapshot,
			// Changed catalogs are provisional until auth completes; retain siblings' credential filters.
			available: this.rebuildAvailable((id) => {
				if (current && !current.has(id)) return undefined;
				return this.snapshot.configuredProviders.has(id) ? [...this.models.getModels(id)] : [];
			}),
		};
	}

	/**
	 * Lists available models in provider order. `providerModels` returns a provider's new entries,
	 * or undefined to keep its previous ones. A full catalog read per provider made each refresh
	 * quadratic in the number of providers.
	 */
	private rebuildAvailable(providerModels: (providerId: string) => readonly Model<Api>[] | undefined): Model<Api>[] {
		const byProvider = new Map<string, readonly Model<Api>[]>();
		for (const { id } of this.models.getProviders()) {
			byProvider.set(id, providerModels(id) ?? this.availableByProvider.get(id) ?? []);
		}
		this.availableByProvider = byProvider;
		return [...byProvider.values()].flat();
	}

	private publishAvailability(
		{ available, auth, errors }: ModelAvailability,
		current: ReadonlySet<string>,
		stored: ReadonlySet<string>,
		complete = false,
	): void {
		const configuredProviders = new Set(complete ? [] : this.snapshot.configuredProviders);
		const storedProviders = new Set(complete ? stored : this.snapshot.storedProviders);
		const authByProvider = new Map(complete ? [] : this.snapshot.auth);
		const authErrors = new Map(complete ? [] : this.authCheckErrors);
		for (const id of current) {
			if (auth.get(id)) configuredProviders.add(id);
			else configuredProviders.delete(id);
			if (stored.has(id)) storedProviders.add(id);
			else storedProviders.delete(id);
			authByProvider.set(id, auth.get(id));
			const error = errors.get(id);
			if (error) authErrors.set(id, error);
			else authErrors.delete(id);
		}
		const availableById = new Map(
			available
				.filter((model) => current.has(model.provider))
				.map((model) => [`${model.provider}\0${model.id}`, model]),
		);
		this.snapshot = {
			available: this.rebuildAvailable((id) => {
				if (!current.has(id)) return complete ? [] : undefined;
				return this.models
					.getModels(id)
					.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []);
			}),
			configuredProviders,
			storedProviders,
			auth: authByProvider,
		};
		this.authCheckErrors = authErrors;
	}

	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providerSeqs = new Map(
			this.models.getProviders().map((provider) => [provider.id, this.providerAvailabilitySeq.get(provider.id)]),
		);
		const [availability, credentials] = await Promise.all([
			this.models.getAvailability({ signal }),
			this.credentials.list({ signal }),
		]);
		signal.throwIfAborted();
		if (seq !== this.availabilityReadSeq) return;
		const current = new Set(
			[...providerSeqs]
				.filter(([id, providerSeq]) => this.providerAvailabilitySeq.get(id) === providerSeq)
				.map(([id]) => id),
		);
		this.publishAvailability(
			availability,
			current,
			new Set(credentials.map((entry) => entry.providerId)),
			this.models.getProviders().every((provider) => current.has(provider.id)),
		);
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		// Read-only passes cannot supersede authoritative provider readiness.
		const seq = ++this.availabilityReadSeq;
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
	}

	private async refreshProviderAvailability(
		providerId: string,
		signal: AbortSignal,
		tolerateAuthFailure: boolean,
	): Promise<Error | undefined> {
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			// pi-ai's tolerant auth boundary is global-only. A single-provider read-only view
			// preserves that boundary without checking siblings or classifying store errors.
			const view = createModels({ credentials: this.modelCredentials });
			const provider = this.models.getProvider(providerId);
			if (provider) view.setProvider(provider);
			const [availability, credential] = await Promise.all([
				view.getAvailability({ signal }),
				// Isolated providers must not resolve ignored stored keys, which may run a secret-manager command.
				this.modelCredentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			const error = availability.errors.get(providerId);
			if (error && !tolerateAuthFailure) throw error;
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return undefined;
			this.publishAvailability(availability, new Set([providerId]), new Set(credential ? [providerId] : []));
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
			return error;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	/**
	 * Apply the policy after credential filtering, without changing provider catalogs or their
	 * persisted data. Each provider's original catalog is read once for a list.
	 */
	private capModels<TModel extends AnyModel>(models: readonly TModel[]): readonly TModel[] {
		if (!this.config.hasContextWindowCaps()) return models;
		const sources = new Map<string, Map<string, number>>();
		return models.map((entry) => {
			if (!isModelType(entry, "chat")) return entry;
			const model = this.uncappedModels.get(entry) ?? entry;
			const cap = this.config.getContextWindowCap(model.provider);
			if (cap === undefined || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
				return model as TModel;
			}
			let sourceWindows = sources.get(model.provider);
			if (!sourceWindows) {
				sourceWindows = new Map();
				const base = this.nativeExtensionProviders.get(model.provider) ?? this.builtins.get(model.provider);
				try {
					for (const source of base?.getModels() ?? []) sourceWindows.set(source.id, source.contextWindow);
					if (this.config.getProvider(model.provider)?.modelOverrides) {
						for (const source of this.models.getProvider(model.provider)?.getModels() ?? []) {
							const beforeOverride = this.overriddenWindows.get(source);
							if (beforeOverride !== undefined && Number.isFinite(beforeOverride) && beforeOverride >= 0) {
								const baseWindow = sourceWindows.get(source.id);
								sourceWindows.set(
									source.id,
									baseWindow !== undefined && Number.isFinite(baseWindow) && baseWindow >= 0
										? Math.min(baseWindow, beforeOverride)
										: beforeOverride,
								);
							}
						}
					}
				} catch {
					// A throwing provider is treated as an empty catalog by pi-ai.
				}
				sources.set(model.provider, sourceWindows);
			}
			const virtual = isVirtualModel(model);
			const providerConfig = this.config.getProvider(model.provider);
			const configured = virtual ? undefined : providerConfig?.models?.find((item) => item.id === model.id);
			const reportedWindow = virtual ? undefined : sourceWindows.get(model.id);
			if (reportedWindow === 0 || this.overriddenWindows.get(model) === 0) {
				const effective = { ...model, contextWindow: 0 };
				this.uncappedModels.set(effective, model);
				return effective as TModel;
			}
			const limits = [
				cap,
				model.contextWindow,
				this.overriddenWindows.get(model),
				reportedWindow,
				configured?.contextWindow,
				virtual ? providerConfig?.modelOverrides?.[model.id]?.contextWindow : undefined,
			].filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
			const contextWindow = Math.min(...limits);
			const effective = contextWindow === model.contextWindow ? model : { ...model, contextWindow };
			this.uncappedModels.set(effective, model);
			return effective as TModel;
		});
	}

	/** Apply current limits to a retained selection or request without replacing its other metadata. */
	applyContextWindowCap<TApi extends Api>(model: Model<TApi>): Model<TApi> {
		const source = (this.uncappedModels.get(model) ?? model) as Model<TApi>;
		if (this.config.getContextWindowCap(source.provider) === undefined) return source;
		const effective = this.capModels([source])[0];
		if (source.contextWindow <= 0) return effective;
		const current = this.models.getModel(source.provider, source.id);
		if (!current || !Number.isFinite(current.contextWindow) || current.contextWindow < 0) return effective;
		const currentWindow = this.capModels([current])[0].contextWindow;
		const contextWindow = Math.min(effective.contextWindow, currentWindow);
		if (contextWindow === effective.contextWindow) return effective;
		const result = { ...source, contextWindow };
		this.uncappedModels.set(result, source);
		return result;
	}

	getProviders(): readonly Provider[] {
		if (!this.config.hasContextWindowCaps()) return this.models.getProviders();
		return this.models.getProviders().map((provider) => this.getProvider(provider.id) ?? provider);
	}

	getProvider(providerId: string): Provider | undefined {
		const provider = this.models.getProvider(providerId);
		if (!provider || this.config.getContextWindowCap(providerId) === undefined) return provider;
		return {
			...provider,
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl,
			headers: provider.headers,
			auth: provider.auth,
			getModels: () => this.capModels(provider.getModels()),
			getAllModels: provider.getAllModels ? () => this.capModels(provider.getAllModels!()) : undefined,
			refreshModels: provider.refreshModels?.bind(provider),
			filterModels: provider.filterModels
				? (models, credential) =>
						this.capModels(
							provider.filterModels!(
								models.map((model) => this.uncappedModels.get(model) ?? model),
								credential,
							),
						)
				: undefined,
			filterAllModels: provider.filterAllModels
				? (models, credential) =>
						this.capModels(
							provider.filterAllModels!(
								models.map((model) =>
									isModelType(model, "chat") ? (this.uncappedModels.get(model) ?? model) : model,
								),
								credential,
							),
						)
				: undefined,
			stream: (model, context, options) => provider.stream(this.applyContextWindowCap(model), context, options),
			streamSimple: (model, context, options) =>
				provider.streamSimple(this.applyContextWindowCap(model), context, options),
			fetchDeferred: provider.fetchDeferred?.bind(provider),
			cancelDeferred: provider.cancelDeferred?.bind(provider),
			generateImages: provider.generateImages?.bind(provider),
			classify: provider.classify?.bind(provider),
		};
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.capModels(this.models.getModels(providerId));
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		const model = this.models.getModel(providerId, modelId);
		return model && this.capModels([model])[0];
	}

	/**
	 * Explain why `providerId/modelId` cannot be selected: whether Pi's built-in catalog and the
	 * effective registry list it, and the first identifiable layer that excludes it. Read-only.
	 */
	explainModelUnavailability(providerId: string, modelId: string, allowlist?: ModelAllowlist): ModelUnavailability {
		const builtin = builtinProviderCatalog.getBuiltinProviders().find((id) => id === providerId);
		const inRegistry = this.models.getModel(providerId, modelId) !== undefined;
		return createModelUnavailability({
			provider: providerId,
			modelId,
			inCatalog:
				builtin !== undefined && builtinProviderCatalog.getBuiltinModels(builtin).some((m) => m.id === modelId),
			inRegistry,
			cause: this.findUnavailableCause(providerId, modelId, inRegistry, allowlist),
		});
	}

	private findUnavailableCause(
		providerId: string,
		modelId: string,
		inRegistry: boolean,
		allowlist: ModelAllowlist | undefined,
	): ModelUnavailableCause {
		const quoted = JSON.stringify(providerId);
		if (!inRegistry) {
			if (!this.models.getProvider(providerId))
				return { kind: "provider-unavailable", detail: `provider ${quoted} is not registered` };
			// Composition order: base catalog, models.json models, extension models, OAuth modifyModels,
			// then models.json modelOverrides. A layer only explains the absence of a model it received.
			const listsModel = (models: readonly { id: string }[] | undefined) =>
				models?.some((m) => m.id === modelId) ?? false;
			const native = this.nativeExtensionProviders.get(providerId);
			const jsonModels = this.config.getProvider(providerId)?.models;
			if (
				native &&
				listsModel(this.builtins.get(providerId)?.getModels()) &&
				!listsModel(native.getModels()) &&
				!listsModel(jsonModels)
			)
				return {
					kind: "model-override",
					detail: `an extension provider replaced provider ${quoted} without this model`,
				};
			const supplied = listsModel((native ?? this.builtins.get(providerId))?.getModels()) || listsModel(jsonModels);
			const extension = this.extensionProviders.get(providerId);
			// refreshModels and credential-gated modifyModels change the list at runtime, so only a
			// static registration is evidence of what reached the later layers.
			const dynamic = extension?.refreshModels !== undefined || extension?.oauth?.modifyModels !== undefined;
			if (!dynamic && supplied && extension?.models && !listsModel(extension.models))
				return {
					kind: "model-override",
					detail: `an extension registration for provider ${quoted} replaced its models without this model`,
				};
			const reachesOverrides = !dynamic && (extension?.models ? listsModel(extension.models) : supplied);
			if (reachesOverrides && this.config.getProvider(providerId)?.modelOverrides?.[modelId]?.hidden === true)
				return { kind: "models-json-hidden", modelsPath: this.modelsPath };
			return { kind: "unknown" };
		}
		// A failed credential check keeps scope candidates, so it is reported after the allowlist.
		const authError = this.getAuthCheckError(providerId);
		if (!this.hasConfiguredAuth(providerId) && !authError)
			return { kind: "provider-unavailable", detail: `provider ${quoted} has no configured credentials` };
		const available = this.snapshot.available.some((m) => m.provider === providerId && m.id === modelId);
		if (!authError && !available)
			return {
				kind: "provider-unavailable",
				detail: `the credentials for provider ${quoted} do not include this model`,
			};
		if (allowlist && !allowlist.models.some((m) => m.provider === providerId && m.id === modelId))
			return { kind: "allowlist", source: allowlist.source, patterns: allowlist.patterns };
		if (!this.hasConfiguredAuth(providerId) && authError)
			return {
				kind: "provider-unavailable",
				detail: `credential check for provider ${quoted} failed: ${authError.message}`,
			};
		return { kind: "unknown" };
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		return this.capModels(this.models.getModelsOfType(type, providerId));
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		const model = this.models.getModelOfType(type, providerId, modelId);
		return model && this.capModels([model])[0];
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		return this.capModels(this.models.getAllModels(providerId));
	}

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.capModels(await this.models.getAvailableOfType(type, providerId, options));
	}

	async getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.capModels(await this.models.getAllAvailable(providerId, options));
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (providerId) {
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return this.capModels(available);
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
		return this.capModels(this.snapshot.available);
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.capModels(this.snapshot.available);
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		for (const [providerId, error] of this.authCheckErrors) errors.push(`Provider "${providerId}": ${error.message}`);
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

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuthCheckError(providerId: string): Error | undefined {
		return this.authCheckErrors.get(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides = {},
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
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			const result = await this.refresh({ allowNetwork: false, providers: [providerId], signal });
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
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
		const effective = (isModelType(model, "chat") ? this.applyContextWindowCap(model) : model) as TModel;
		const provider = this.models.getProvider(effective.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(effective, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
		const requestModel: TModel = resolution.auth.baseUrl
			? { ...effective, baseUrl: resolution.auth.baseUrl }
			: effective;
		const sessionId =
			"sessionId" in providerOptions && typeof providerOptions.sessionId === "string"
				? providerOptions.sessionId
				: undefined;
		let headers = mergeHeaders(
			mergeHeaders(getOpenCodeSessionHeaders(requestModel, sessionId), resolution.auth.headers),
			providerOptions.headers,
		);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
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
		return lazyStream(model, async () => {
			assertChatModel(model);
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsRequestTransforms) | undefined,
			);
			return prepared.provider.stream(prepared.model, transcript, prepared.options as ApiStreamOptions<TApi>);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	/**
	 * `onPrepared` is an internal observer for cache warming, called after auth/header
	 * preparation and before provider dispatch. Prepared options are not replay options:
	 * another request must resolve current credentials and headers again.
	 */
	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
		onPrepared?: (model: Model<Api>, options: SimpleStreamOptions) => void,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		if (isVirtualModel(model)) {
			// Requests outside the agent loop are routed here. Callers sized them before routing, so
			// cap the output budget to the routed model.
			return lazyStream(model, async () => {
				const route = await this.resolveModel(model, transcript.messages, {
					reason: "direct",
					thinkingLevel: options?.reasoning ?? "off",
					signal: options?.signal,
				});
				const { maxTokens: limit } = route.model;
				const maxTokens = options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
				const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
				// Caller credentials were resolved for the virtual model's provider. Another provider
				// resolves its own, so they are not sent to the wrong vendor.
				const { apiKey, headers, env, ...rest } = options ?? {};
				const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
				return this.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning }, onPrepared);
			});
		}
		return lazyStream(model, async () => {
			assertChatModel(model);
			const prepared = await this.prepareRequest(model, options);
			onPrepared?.(prepared.model, prepared.options);
			return prepared.provider.streamSimple(prepared.model, transcript, prepared.options as SimpleStreamOptions);
		});
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			assertChatModel(model);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
		});
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
			assertClassifierInputSupported(model, context);
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			return await prepared.provider.classify(prepared.model, context, prepared.options as ClassifierOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}

	login(
		providerId: string,
		type: AuthType,
		interaction: AuthInteraction,
		options?: LoginOptions,
	): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal }, options);
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

	/** Apply native saved launch policy even when an SDK host supplies this runtime. */
	setOffline(offline: boolean): void {
		this.modelNetworkEnabled = !offline;
	}

	get offline(): boolean {
		return !this.modelNetworkEnabled;
	}

	refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		return this.startRefresh(options, options.providers === undefined);
	}

	private startRefresh(options: ModelsRefreshOptions, tolerateAuthFailure: boolean): Promise<ModelsRefreshResult> {
		if (options.signal?.aborted) return Promise.resolve({ aborted: true, errors: new Map() });
		const refresh: ModelRefresh = { seq: ++this.refreshSeq, providers: new Map() };
		// Claim each provider before config I/O, including pi-ai publications already in flight.
		for (const id of new Set(
			options.providers ?? [...this.providerIds(), ...this.models.getProviders().map((p) => p.id)],
		)) {
			this.admitProviderRefresh(id, refresh);
		}
		return (async () => {
			let errors = new Map<string, Error>();
			try {
				const result = await this.runRefresh(options, refresh, tolerateAuthFailure);
				errors = new Map(result.errors);
				while (!options.signal?.aborted) {
					const owners = new Map([...refresh.providers.keys()].map((id) => [id, this.providerRefreshes.get(id)!]));
					const results = await raceWithAbortSignal(
						Promise.all(
							[...owners].map(async ([id, owner]) => [id, await owner.providers.get(id)!.promise] as const),
						),
						options.signal,
					);
					// Any provider can change while another is awaited; revalidate the whole scope.
					if ([...owners].some(([id, owner]) => this.providerRefreshes.get(id) !== owner)) continue;
					const resume = results.filter(([, next]) => next.aborted).map(([id]) => id);
					if (resume.length > 0) {
						// A cancelled successor cannot discard uncancelled registration or disposal.
						await this.startRefresh({ ...options, providers: resume }, tolerateAuthFailure);
						continue;
					}
					errors = new Map(result.errors);
					for (const [id, next] of results) {
						if (owners.get(id) !== refresh) errors.delete(id);
						const error = next.errors.get(id);
						if (error) errors.set(id, error);
					}
					return { aborted: false, errors };
				}
				return { aborted: true, errors };
			} catch (error) {
				for (const ready of refresh.providers.values()) {
					if (options.signal?.aborted) ready.resolve({ aborted: true, errors });
					else ready.reject(error);
				}
				if (!options.signal?.aborted) throw error;
				return { aborted: true, errors };
			}
		})();
	}

	private admitProviderRefresh(providerId: string, refresh: ModelRefresh): void {
		if (!refresh.providers.has(providerId)) {
			const ready = { ...Promise.withResolvers<ModelsRefreshResult>(), controller: new AbortController() };
			// Config failures reject the public operation even when no successor joins this entry.
			void ready.promise.catch(() => {});
			refresh.providers.set(providerId, ready);
		}
		if ((this.providerRefreshes.get(providerId)?.seq ?? 0) > refresh.seq) return;
		this.providerRefreshes.get(providerId)?.providers.get(providerId)?.controller.abort();
		this.providerRefreshes.set(providerId, refresh);
		this.providerAvailabilitySeq.set(providerId, (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1);
		const provider = this.models.getProvider(providerId);
		if (provider) this.models.setProvider(provider);
	}

	private async runRefresh(
		options: ModelsRefreshOptions,
		refresh: ModelRefresh,
		tolerateAuthFailure: boolean,
	): Promise<ModelsRefreshResult> {
		const config = await raceWithAbortSignal(ModelConfig.load(this.modelsPath), options.signal);
		// Config is global; an older load must never replace an already published newer snapshot.
		if (!options.signal?.aborted && refresh.seq > this.configRefreshSeq) {
			this.configRefreshSeq = refresh.seq;
			this.config = config;
			this.configureRadiusProviders();
		}
		if (!options.providers && !options.signal?.aborted) {
			// A full load can discover providers after admission without taking newer ownership.
			for (const id of this.providerIds()) {
				if (refresh.providers.has(id)) continue;
				this.admitProviderRefresh(id, refresh);
			}
		}
		const providers = [...refresh.providers.keys()].filter((id) => this.providerRefreshes.get(id) === refresh);
		if (!options.signal?.aborted) {
			for (const id of providers) this.recomposeProvider(id);
			this.updateModelSnapshot(providers);
		}
		const signal = operationSignal(options.signal);
		// Full-store metadata belongs to the full caller, never to a provider's readiness promise.
		const stored = options.providers
			? undefined
			: this.credentials.list({ signal }).then(
					(credentials) => ({ credentials }),
					(error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
				);
		const errors = new Map<string, Error>();
		await Promise.all(
			[...refresh.providers].map(async ([id, ready]) => {
				if (this.providerRefreshes.get(id) !== refresh || signal.aborted) {
					ready.resolve({ aborted: signal.aborted, errors: new Map() });
					return;
				}
				const providerSignal = AbortSignal.any([signal, ready.controller.signal]);
				const result = await this.models.refresh({
					...options,
					providers: [id],
					allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
					signal: providerSignal,
				});
				const providerErrors = new Map(result.errors);
				if (this.providerRefreshes.get(id) === refresh && !providerSignal.aborted) {
					this.updateModelSnapshot([id]);
					try {
						const error = await this.refreshProviderAvailability(id, providerSignal, tolerateAuthFailure);
						if (error) providerErrors.set(id, error);
					} catch (error) {
						if (!providerSignal.aborted)
							providerErrors.set(id, error instanceof Error ? error : new Error(String(error)));
					}
				}
				for (const [providerId, error] of providerErrors) errors.set(providerId, error);
				ready.resolve({ aborted: signal.aborted, errors: providerErrors });
			}),
		);
		const listed = stored && (await raceWithAbortSignal(stored, signal));
		if (listed && !signal.aborted) {
			const current = [...refresh.providers.keys()].filter((id) => this.providerRefreshes.get(id) === refresh);
			if ("error" in listed) {
				if (current.length > 0) {
					++this.availabilityErrorSeq;
					this.availabilityError = listed.error.message;
					for (const id of current) errors.set(id, listed.error);
				}
			} else {
				const storedProviders = new Set(this.snapshot.storedProviders);
				const listedProviders = new Set(listed.credentials.map((entry) => entry.providerId));
				for (const id of new Set([...storedProviders, ...listedProviders])) {
					if ((this.providerRefreshes.get(id)?.seq ?? 0) > refresh.seq) continue;
					if (listedProviders.has(id)) storedProviders.add(id);
					else storedProviders.delete(id);
				}
				this.snapshot = { ...this.snapshot, storedProviders };
			}
		}
		return { aborted: signal.aborted, errors };
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot([provider.id]);
		this.markProvisionallyConfigured(
			provider.id,
			configuredRequestAuthStatus(this.config.getProvider(provider.id), undefined),
			provider.auth.oauth && !provider.auth.apiKey ? "oauth" : "api_key",
		);
		void this.refresh({ allowNetwork: false });
	}

	/** One nonpersistent fallback per provider. Disposal never removes a later replacement. */
	registerProviderAuthFallback(providerId: string, fallback: ProviderAuthFallback): () => void {
		if (!providerId.trim() || typeof fallback.check !== "function" || typeof fallback.resolve !== "function") {
			throw new Error("Provider auth fallback requires a provider id, check and resolve.");
		}
		const registration = { fallback };
		this.authFallbacks.set(providerId, registration);
		this.recomposeProvider(providerId);
		void this.refresh({ allowNetwork: false });
		return () => {
			if (this.authFallbacks.get(providerId) !== registration) return;
			this.authFallbacks.delete(providerId);
			this.recomposeProvider(providerId);
			void this.refresh({ allowNetwork: false });
		};
	}

	/**
	 * Mark a newly registered provider as configured when it has a stored credential or a configured
	 * API key. Availability checks run asynchronously, and callers such as initial model selection
	 * read the snapshot before they finish. The next availability pass replaces this entry.
	 */
	private markProvisionallyConfigured(
		providerId: string,
		configuredStatus: AuthStatus | undefined,
		type: AuthType,
	): void {
		const hasStored =
			this.snapshot.storedProviders.has(providerId) &&
			this.extensionProviders.get(providerId)?.ignoreStoredCredentials !== true;
		if (!hasStored && !this.credentials.hasRuntimeApiKey(providerId) && !configuredStatus?.configured) return;
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const auth = new Map(this.snapshot.auth);
		// Never clobber a real check result.
		if (!auth.get(providerId)) auth.set(providerId, { type, source: "configured provider" });
		this.snapshot = { ...this.snapshot, auth, configuredProviders };
		this.updateModelSnapshot([providerId]);
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		if (effective.ignoreStoredCredentials === true) {
			// A saved credential's old check must not survive isolation or an in-flight refresh.
			this.providerAvailabilitySeq.set(providerId, (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1);
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const auth = new Map(this.snapshot.auth);
			configuredProviders.delete(providerId);
			auth.delete(providerId);
			this.snapshot = { ...this.snapshot, configuredProviders, auth };
		}
		this.recomposeProvider(providerId);
		this.updateModelSnapshot([providerId]);
		this.markProvisionallyConfigured(
			providerId,
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective),
			effective.oauth && !effective.apiKey ? "oauth" : "api_key",
		);
		void this.refresh({ allowNetwork: false });
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot([providerId]);
		void this.refresh({ allowNetwork: false });
	}

	/**
	 * Register a virtual model under `definition.provider`, which may also list physical models or
	 * several virtual models. Re-registering the same provider and id replaces the virtual model.
	 * Throws when the id belongs to a physical model of that provider.
	 */
	registerVirtualModel(definition: VirtualModelDefinition): void {
		const { provider: providerId, id } = definition;
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
		this.updateModelSnapshot([providerId]);
		void this.refresh({ allowNetwork: false });
	}

	unregisterVirtualModel(providerId: string, id: string): void {
		const models = this.virtualModels.get(providerId);
		if (!models?.delete(id)) return;
		if (models.size === 0) this.virtualModels.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot([providerId]);
		void this.refresh({ allowNetwork: false });
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
		const model = this.getModel(providerId, modelId);
		return model && !isVirtualModel(model) ? model : undefined;
	}
}
