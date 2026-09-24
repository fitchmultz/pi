import type { Api, Model, OpenAIResponsesCompat, ProviderId } from "./types.ts";

export type ModelGroups = Record<string, Record<string, object>>;

type ModelId<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] &
	string;

type ModelApi<TGroups extends ModelGroups, TModelId extends ModelId<TGroups>> = {
	[TApi in keyof TGroups]: TModelId extends keyof TGroups[TApi] ? TApi : never;
}[keyof TGroups] &
	Api;

export type ModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TModelId in ModelId<TGroups>]: Model<ModelApi<TGroups, TModelId>> & {
		id: TModelId;
		provider: TProvider;
	};
};

/** Older and upstream catalogs can omit the fork's supported Astra lifecycle capabilities. */
export function withAstraLifecycleDefaults(model: Model<Api>): Model<Api> {
	if (
		model.id !== "gpt-6-astra" ||
		!(
			((model.provider === "openai" || model.provider === "cloudflare-ai-gateway") &&
				model.api === "openai-responses") ||
			(model.provider === "openai-codex" && model.api === "openai-codex-responses")
		)
	)
		return model;
	const compat = model.compat as OpenAIResponsesCompat | undefined;
	return {
		...model,
		compat: {
			...compat,
			supportsAsyncTools: compat?.supportsAsyncTools ?? true,
			supportsSteering: compat?.supportsSteering ?? true,
			supportsReasoningEffortUpdates: compat?.supportsReasoningEffortUpdates ?? true,
		},
	};
}

export function flattenModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ModelCatalog<TGroups, TProvider> {
	const catalog = Object.assign({}, ...Object.values(groups)) as Record<string, Model<Api>>;
	for (const [id, model] of Object.entries(catalog)) catalog[id] = withAstraLifecycleDefaults(model);
	return catalog as ModelCatalog<TGroups, TProvider>;
}
