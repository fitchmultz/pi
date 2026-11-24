import type { AnyModel } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

/**
 * GPT-6 models that reject `reasoning.effort: "none"`, so `off` thinking is unavailable and
 * `temperature` is unsupported on OpenAI Responses endpoints.
 *
 * Kept in a leaf module without runtime dependencies so catalog pin refresh can import it before
 * workspace dependencies are installed.
 */
export const GPT_6_NO_NONE_EFFORT_MODEL_IDS: ReadonlySet<string> = new Set([
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);

/**
 * Default OpenAI prompt-cache lifetimes (30m short, 12h long) and Responses request-image limits.
 * Owned here so catalog generation, hydration, and `pi.dev` remote overlays share one source of truth.
 */
export const OPENAI_EXPLICIT_PROMPT_CACHE_TTL = { short: 1800, long: 43200 } as const;
export const OPENAI_RESPONSES_INPUT_LIMITS = {
	maxRequestBytes: 512 * 1024 * 1024,
	images: { maxPerRequest: 1500 },
} as const;

export function normalizeOpenAIModel<TModel extends AnyModel>(model: TModel): TModel {
	if (!isModelType(model, "chat")) return model;
	const isDirectOpenAI = model.provider === "openai" && model.api === "openai-responses";
	const isCodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (!isDirectOpenAI && !isCodex) return model;

	const needsPromptCache = isDirectOpenAI && model.cost.cacheWrite > 0 && model.promptCache === undefined;
	const supportsImages = model.input.includes("image");
	const needsBytes = supportsImages && model.inputLimits?.maxRequestBytes === undefined;
	const needsImages = supportsImages && model.inputLimits?.images?.maxPerRequest === undefined;
	if (!needsPromptCache && !needsBytes && !needsImages) return model;
	return {
		...model,
		...(needsPromptCache ? { promptCache: { ...OPENAI_EXPLICIT_PROMPT_CACHE_TTL } } : {}),
		...(needsBytes || needsImages
			? {
					inputLimits: {
						...model.inputLimits,
						...(needsBytes ? { maxRequestBytes: OPENAI_RESPONSES_INPUT_LIMITS.maxRequestBytes } : {}),
						...(needsImages
							? {
									images: {
										...model.inputLimits?.images,
										maxPerRequest: OPENAI_RESPONSES_INPUT_LIMITS.images.maxPerRequest,
									},
								}
							: {}),
					},
				}
			: {}),
	};
}
