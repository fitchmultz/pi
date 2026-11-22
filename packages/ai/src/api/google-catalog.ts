import type { AnyModel } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

const CANONICAL_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const LEGACY_GOOGLE_MAX_REQUEST_BYTES = 20 * 1024 * 1024;

/**
 * Gemini Developer API inline request payload limit (100 MiB).
 * Raised from 20 MB on 2026-01-08: https://aistudio.google.com/docs/changelog
 */
export const GOOGLE_MAX_REQUEST_BYTES = 100 * 1024 * 1024;

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

	if (nextMaxTokens === model.maxTokens && nextInputLimits === model.inputLimits) {
		return model;
	}
	return {
		...model,
		maxTokens: nextMaxTokens,
		...(nextInputLimits ? { inputLimits: nextInputLimits } : {}),
	};
}
