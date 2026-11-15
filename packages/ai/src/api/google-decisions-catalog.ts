import type { ClassifierModel } from "../types.ts";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Canonical `google/gemini-decision-1` catalog entry. */
export const GEMINI_DECISION_1_MODEL: ClassifierModel<"google-decisions"> = {
	type: "classifier",
	id: "gemini-decision-1",
	name: "Gemini Decision 1",
	api: "google-decisions",
	provider: "google",
	baseUrl: GOOGLE_BASE_URL,
	input: ["text", "image"],
	cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
};

/**
 * Keep `gemini-decision-1` in `google` catalogs hydrated from upstream snapshots that predate it.
 * Entries already present in the catalog win unchanged.
 */
export function withGoogleDecisionsModels<T extends { type?: unknown; id?: unknown }>(
	provider: string,
	entries: readonly T[],
): Array<T | (ClassifierModel<"google-decisions"> & { type: "classifier" })> {
	if (provider !== "google") return [...entries];
	if (entries.some((entry) => entry.type === "classifier" && entry.id === GEMINI_DECISION_1_MODEL.id)) {
		return [...entries];
	}
	return [...entries, { ...GEMINI_DECISION_1_MODEL }];
}
