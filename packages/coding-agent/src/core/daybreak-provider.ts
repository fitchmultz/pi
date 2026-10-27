import {
	type AnyModel,
	type Api,
	type AssistantMessage,
	isModelType,
	lazyStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelsJsonModelOverride } from "./model-config.ts";
import { applyModelOverride } from "./provider-composer.ts";

export const DAYBREAK_BLUE_MODEL = "daybreak-blue-luna";
const LUNA_MODEL = "gpt-6-luna";
const OPENAI_URL = "https://api.openai.com/v1";

function isNativeOpenAI(model: Model<Api>): boolean {
	return (
		model.provider === "openai" &&
		model.api === "openai-responses" &&
		(model.baseUrl === OPENAI_URL || model.baseUrl === `${OPENAI_URL}/`)
	);
}

export function isNativeDaybreakModel(model: AnyModel): boolean {
	return isModelType(model, "chat") && model.id === DAYBREAK_BLUE_MODEL && isNativeOpenAI(model);
}

function isNativeLuna(model: Model<Api>): boolean {
	return model.id === LUNA_MODEL && isNativeOpenAI(model);
}

function addAlias(
	models: readonly AnyModel[],
	enabled: boolean,
	override: ModelsJsonModelOverride | undefined,
): AnyModel[] {
	const base = models.filter((model) => !isModelType(model, "chat") || model.id !== DAYBREAK_BLUE_MODEL);
	const luna = enabled ? base.find((model) => isModelType(model, "chat") && isNativeLuna(model)) : undefined;
	if (!luna || !isModelType(luna, "chat")) return base;
	const alias = { ...luna, id: DAYBREAK_BLUE_MODEL, name: "Daybreak Blue (GPT-6 Luna)" };
	return [...base, override ? applyModelOverride(alias, override) : alias];
}

/** The alias shares Luna's per-model configuration, including its request headers. */
export function daybreakConfigurationModel<T extends AnyModel>(model: T): T {
	return model.provider === "openai" && isModelType(model, "chat") && model.id === DAYBREAK_BLUE_MODEL
		? { ...model, id: LUNA_MODEL }
		: model;
}

function daybreakPayload(options: StreamOptions | undefined): NonNullable<StreamOptions["onPayload"]> {
	return async (payload, model) => {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			throw new Error("Daybreak Blue requires an OpenAI Responses payload.");
		}
		const request = payload as Record<string, unknown>;
		const programs = request.access_programs;
		const updated = {
			...request,
			model: LUNA_MODEL,
			access_programs: {
				...(programs && typeof programs === "object" && !Array.isArray(programs) ? programs : {}),
				cyber: "daybreak_blue",
			},
		};
		const result = await options?.onPayload?.(updated, model);
		return result === undefined ? updated : result;
	};
}

/** Public summary helpers without a session stream still need the native alias transport. */
export function completeDaybreakSummary(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> | undefined {
	if (model.provider !== "openai" || model.id !== DAYBREAK_BLUE_MODEL) return undefined;
	return lazyStream(model, async () => {
		if (!isNativeOpenAI(model)) throw new Error("Daybreak Blue requires the native OpenAI Responses endpoint.");
		const canonical = { ...model, baseUrl: OPENAI_URL };
		const apiKey = options.apiKey?.trim() ? options.apiKey : getEnvApiKey("openai", options.env);
		return openAIResponsesApi().streamSimple(canonical, context, {
			...options,
			apiKey,
			onPayload: daybreakPayload(options),
		});
	}).result();
}

/** Add the local alias after provider catalogs and configuration have been composed. */
export function withDaybreakBlue(
	provider: Provider,
	enabled: boolean,
	override: ModelsJsonModelOverride | undefined,
): Provider {
	const getModels = () =>
		addAlias(provider.getModels(), enabled, override).filter((model) => isModelType(model, "chat"));
	const requireNativeRoute = (model: Model<Api>) => {
		if (!enabled || !isNativeOpenAI(model) || !provider.getModels().some(isNativeLuna)) {
			throw new Error(
				"Daybreak Blue requires the native OpenAI Responses endpoint and an available GPT-6 Luna model.",
			);
		}
	};
	return {
		...provider,
		getModels,
		getAllModels: () => addAlias(provider.getAllModels?.() ?? provider.getModels(), enabled, override),
		filterModels: (models, credential) => {
			const base = models.filter((model) => model.id !== DAYBREAK_BLUE_MODEL);
			return addAlias(provider.filterModels?.(base, credential) ?? base, enabled, override).filter((model) =>
				isModelType(model, "chat"),
			);
		},
		filterAllModels: (models, credential) => {
			const base = models.filter((model) => !isModelType(model, "chat") || model.id !== DAYBREAK_BLUE_MODEL);
			const available = provider.filterAllModels
				? provider.filterAllModels(base, credential)
				: provider.filterModels
					? (() => {
							const chat = base.filter((model) => isModelType(model, "chat"));
							const ids = new Set(provider.filterModels!(chat, credential).map((model) => model.id));
							return base.filter((model) => !isModelType(model, "chat") || ids.has(model.id));
						})()
					: base;
			return addAlias(available, enabled, override);
		},
		stream: (model, context, options) => {
			if (model.id !== DAYBREAK_BLUE_MODEL) return provider.stream(model, context, options);
			return lazyStream(model, async () => {
				requireNativeRoute(model);
				const aliasOptions = { ...options, onPayload: daybreakPayload(options) } as typeof options;
				return provider.stream({ ...model, baseUrl: OPENAI_URL }, context, aliasOptions);
			});
		},
		streamSimple: (model, context, options) => {
			if (model.id !== DAYBREAK_BLUE_MODEL) return provider.streamSimple(model, context, options);
			return lazyStream(model, async () => {
				requireNativeRoute(model);
				return provider.streamSimple({ ...model, baseUrl: OPENAI_URL }, context, {
					...options,
					onPayload: daybreakPayload(options),
				});
			});
		},
	};
}
