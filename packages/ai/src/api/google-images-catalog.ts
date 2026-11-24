import type { ImageModel } from "../types.ts";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Canonical Gemini Nano Banana image-generation models on the `google` provider (`google-images`
 * API over `POST /v1beta/models/{model}:generateContent`). Verified against live `/v1beta/models`
 * and Google AI Studio documentation.
 */
export const GOOGLE_IMAGE_CATALOG_MODELS: readonly ImageModel<"google-images">[] = [
	{
		type: "image",
		id: "gemini-nano-banana-2.1",
		name: "Nano Banana 2.1",
		api: "google-images",
		provider: "google",
		baseUrl: GOOGLE_BASE_URL,
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
	},
	{
		type: "image",
		id: "gemini-3.1-flash-image",
		name: "Nano Banana 2",
		api: "google-images",
		provider: "google",
		baseUrl: GOOGLE_BASE_URL,
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
	},
	{
		type: "image",
		id: "gemini-3.1-flash-lite-image",
		name: "Nano Banana 2 Lite",
		api: "google-images",
		provider: "google",
		baseUrl: GOOGLE_BASE_URL,
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 0.25, output: 1.5, cacheRead: 0, cacheWrite: 0 },
	},
	{
		type: "image",
		id: "gemini-3-pro-image",
		name: "Nano Banana Pro",
		api: "google-images",
		provider: "google",
		baseUrl: GOOGLE_BASE_URL,
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
	},
	{
		type: "image",
		id: "gemini-2.5-flash-image",
		name: "Nano Banana",
		api: "google-images",
		provider: "google",
		baseUrl: GOOGLE_BASE_URL,
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.083333 },
	},
];

/**
 * Keep native Gemini Nano Banana image models in `google` catalogs hydrated from upstream
 * snapshots that predate `google-images`. Entries already present in the catalog win unchanged.
 */
export function withGoogleImageModels<T extends { type?: unknown; id?: unknown }>(
	provider: string,
	entries: readonly T[],
): Array<T | ImageModel<"google-images">> {
	if (provider !== "google") return [...entries];
	const existingIds = new Set(
		entries.filter((entry) => entry.type === "image" && typeof entry.id === "string").map((entry) => entry.id),
	);
	const additions = GOOGLE_IMAGE_CATALOG_MODELS.filter((model) => !existingIds.has(model.id)).map((model) => ({
		...model,
	}));
	return [...entries, ...additions];
}
