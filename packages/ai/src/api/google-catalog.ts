import type { AnyModel, ModelPromptCache } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

const CANONICAL_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const LEGACY_GOOGLE_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const GEMINI_4_MODEL_ID_PATTERN = /^gemini-4(?:-|$)/i;

/** Select the canonical Developer API for a Google chat catalog entry. */
export function googleChatApi(modelId: string): "google-generative-ai" | "google-interactions" {
	return modelId === "gemini-4-neon" ? "google-interactions" : "google-generative-ai";
}

/**
 * Gemini Developer API inline request payload limit (100 MiB).
 * Raised from 20 MB on 2026-01-08: https://aistudio.google.com/docs/changelog
 */
export const GOOGLE_MAX_REQUEST_BYTES = 100 * 1024 * 1024;

/**
 * Warming budget in seconds for Gemini 4's implicit prefix cache, not a provider guarantee.
 * On Cloudflare AI Gateway, Neon hit on four 60s replays but missed on the first 90s replay.
 */
export const GEMINI_4_PROMPT_CACHE: Readonly<ModelPromptCache> = { short: 75 };

/** Whether `modelId` identifies a Gemini 4 model (e.g. `gemini-4-neon`, `gemini-4-carbon`). */
export function isGemini4ModelId(modelId: string): boolean {
	return GEMINI_4_MODEL_ID_PATTERN.test(modelId);
}

/** Read the Gemini version from an ID, including IDs with a host or vendor prefix (#12321). */
export function getGeminiVersion(modelId: string): { major: number; minor: number } | undefined {
	const match = modelId.toLowerCase().match(/gemini(?:-live)?-(\d+)(?:\.(\d+))?/);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1], 10),
		minor: match[2] ? Number.parseInt(match[2], 10) : 0,
	};
}

/** Whether the model ID identifies Gemini 4 or later, including prefixed and minor-version IDs. */
export function isGemini4OrLaterModelId(modelId: string): boolean {
	return (getGeminiVersion(modelId)?.major ?? 0) >= 4;
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
		(model.api !== "google-generative-ai" && model.api !== "google-interactions") ||
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
	const api = model.api === "google-generative-ai" ? googleChatApi(model.id) : model.api;

	if (
		api === model.api &&
		nextMaxTokens === model.maxTokens &&
		nextInputLimits === model.inputLimits &&
		nextPromptCache === model.promptCache
	) {
		return model;
	}
	return {
		...model,
		api,
		maxTokens: nextMaxTokens,
		...(nextInputLimits ? { inputLimits: nextInputLimits } : {}),
		...(nextPromptCache !== undefined ? { promptCache: nextPromptCache } : {}),
	};
}
