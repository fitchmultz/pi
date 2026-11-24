import type { AnyModel, ModelPromptCache } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

const CANONICAL_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const LEGACY_GOOGLE_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const GEMINI_4_MODEL_ID_PATTERN = /^gemini-4(?:-|$)/i;

/**
 * Gemini Developer API inline request payload limit (100 MiB).
 * Raised from 20 MB on 2026-01-08: https://aistudio.google.com/docs/changelog
 */
export const GOOGLE_MAX_REQUEST_BYTES = 100 * 1024 * 1024;

/**
 * Conservative floor (seconds) for Gemini 4's implicit prefix cache sliding TTL (~3–5 min).
 * Verified live on gemini-4-neon: a 1-token warm replay at 160s kept 100% of the cached prefix alive past 320s.
 */
export const GEMINI_4_PROMPT_CACHE: Readonly<ModelPromptCache> = { short: 180 };

/** Whether `modelId` identifies a Gemini 4 model (e.g. `gemini-4-neon`, `gemini-4-carbon`). */
export function isGemini4ModelId(modelId: string): boolean {
	return GEMINI_4_MODEL_ID_PATTERN.test(modelId);
}

/**
 * Gemini 4 Carbon and Argon support 65,536 output tokens on streaming requests,
 * matching Google Vertex; models.dev lists the 32,768 non-streaming REST cap.
 */
export const GOOGLE_STREAMING_MAX_OUTPUT_OVERRIDES: Readonly<Record<string, number>> = {
	"gemini-4-carbon": 65536,
	"gemini-4-argon": 65536,
};

/**
 * Apply canonical Gemini Developer API catalog corrections during pinned hydration
 * and pi.dev catalog overlay merges without overwriting custom endpoints or limits.
 */
export function normalizeGoogleModel(model: AnyModel): AnyModel {
	if (
		model.provider !== "google" ||
		!isModelType(model, "chat") ||
		model.api !== "google-generative-ai" ||
		model.baseUrl !== CANONICAL_GOOGLE_BASE_URL
	) {
		return model;
	}

	const streamingMaxTokens = GOOGLE_STREAMING_MAX_OUTPUT_OVERRIDES[model.id];
	const nextMaxTokens =
		streamingMaxTokens !== undefined && model.maxTokens === 32768 ? streamingMaxTokens : model.maxTokens;
	const currentMaxRequestBytes = model.inputLimits?.maxRequestBytes;
	const nextInputLimits =
		currentMaxRequestBytes === LEGACY_GOOGLE_MAX_REQUEST_BYTES
			? { ...model.inputLimits, maxRequestBytes: GOOGLE_MAX_REQUEST_BYTES }
			: model.inputLimits;
	const nextPromptCache =
		isGemini4ModelId(model.id) && model.promptCache === undefined ? { ...GEMINI_4_PROMPT_CACHE } : model.promptCache;

	if (
		nextMaxTokens === model.maxTokens &&
		nextInputLimits === model.inputLimits &&
		nextPromptCache === model.promptCache
	) {
		return model;
	}
	return {
		...model,
		maxTokens: nextMaxTokens,
		...(nextInputLimits ? { inputLimits: nextInputLimits } : {}),
		...(nextPromptCache !== undefined ? { promptCache: nextPromptCache } : {}),
	};
}
