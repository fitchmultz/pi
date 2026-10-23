import type { Api, Model } from "@earendil-works/pi-ai";

/** Model patterns that limit selection, such as the `enabledModels` setting. */
export interface ModelAllowlist {
	/** Configuration that supplied the patterns, for example `enabledModels`. */
	source: string;
	patterns: readonly string[];
	/** Models the patterns resolved to. */
	models: readonly Model<Api>[];
}

/** The configuration layer that excludes a model, or `unknown` when none can be identified. */
export type ModelUnavailableCause =
	| { kind: "models-json-hidden"; modelsPath: string | undefined }
	| { kind: "model-override"; detail: string }
	| { kind: "provider-unavailable"; detail: string }
	| { kind: "allowlist"; source: string; patterns: readonly string[] }
	| { kind: "unknown" };

export interface ModelUnavailability {
	provider: string;
	modelId: string;
	/** Listed in Pi's built-in model catalog. */
	inCatalog: boolean;
	/** Listed in the effective registry after models.json and extension layers. */
	inRegistry: boolean;
	cause: ModelUnavailableCause;
	/** Catalog presence, registry presence and cause, without the model reference. */
	explanation: string;
}

function describeCause(provider: string, modelId: string, cause: ModelUnavailableCause): string {
	switch (cause.kind) {
		case "models-json-hidden":
			return `models.json${cause.modelsPath ? ` (${cause.modelsPath})` : ""} sets providers[${JSON.stringify(provider)}].modelOverrides[${JSON.stringify(modelId)}].hidden to true`;
		case "model-override":
		case "provider-unavailable":
			return cause.detail;
		case "allowlist":
			return `${cause.source} excludes it (${cause.patterns.join(", ")})`;
		case "unknown":
			return "unknown; the responsible configuration layer could not be identified";
	}
}

export function createModelUnavailability(facts: Omit<ModelUnavailability, "explanation">): ModelUnavailability {
	const catalog = facts.inCatalog ? "present" : "absent";
	const registry = facts.inRegistry ? "present" : "absent";
	return {
		...facts,
		explanation: `built-in catalog: ${catalog}; effective registry: ${registry}; cause: ${describeCause(facts.provider, facts.modelId, facts.cause)}`,
	};
}
