import type { AnthropicMessagesCompat, Api, Model } from "../types.ts";

/**
 * Anthropic server-side fallback targets allowed per primary model.
 * Kept in a leaf module without runtime dependencies so catalog generation and runtime
 * normalizers share one source of truth.
 */
export const ANTHROPIC_ALLOWED_FALLBACK_MODELS: Readonly<Record<string, readonly string[]>> = {
	"claude-fable-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-fable-5-2": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5": ["claude-opus-4-8"],
};

/**
 * Maximum images per request accepted by Anthropic Messages endpoints:
 * 100 for 200k-context models, 600 for 1M-context models.
 */
export function anthropicMaxImagesPerRequest(contextWindow: number): number {
	return contextWindow === 200000 ? 100 : 600;
}

/**
 * Populate `compat.allowedFallbackModels` for Anthropic Messages models in a provider catalog
 * from `ANTHROPIC_ALLOWED_FALLBACK_MODELS` and that provider's own fallback model pricing.
 */
export function applyAnthropicAllowedFallbackModels(
	models: readonly Model<Api>[],
	supportsMidConvoEffort: (modelId: string) => boolean,
): void {
	const modelsById = new Map<string, Model<"anthropic-messages">>();
	for (const model of models) {
		if (model.api === "anthropic-messages") {
			modelsById.set(model.id, model as Model<"anthropic-messages">);
		}
	}
	for (const [modelId, fallbackModelIds] of Object.entries(ANTHROPIC_ALLOWED_FALLBACK_MODELS)) {
		const model = modelsById.get(modelId);
		if (!model) continue;
		const compat = model.compat as AnthropicMessagesCompat | undefined;
		const compatibleFallbackModelIds = compat?.supportsMidConvoEffort
			? fallbackModelIds.filter(supportsMidConvoEffort)
			: fallbackModelIds;
		const allowedFallbackModels = compatibleFallbackModelIds.flatMap((fallbackModelId) => {
			const fallbackModel = modelsById.get(fallbackModelId);
			return fallbackModel
				? [{ provider: fallbackModel.provider, model: fallbackModel.id, cost: { ...fallbackModel.cost } }]
				: [];
		});
		if (allowedFallbackModels.length > 0) {
			model.compat = { ...compat, allowedFallbackModels };
		}
	}
}
