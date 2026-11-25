import { googleDecisionsApi } from "../api/google-decisions.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { googleImagesApi } from "../api/google-images.lazy.ts";
import { googleInteractionsApi } from "../api/google-interactions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ClassifierModel, ImageModel } from "../types.ts";
import { GOOGLE_CLASSIFIER_MODELS, GOOGLE_IMAGE_MODELS, GOOGLE_MODELS } from "./google.models.ts";

type GoogleChatApi = "google-generative-ai" | "google-interactions";

export function googleProvider(): Provider<GoogleChatApi> {
	return createProvider<GoogleChatApi>({
		id: "google",
		name: "Google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: { apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]) },
		models: [
			...Object.values(GOOGLE_MODELS),
			...Object.values<ImageModel<"google-images">>(GOOGLE_IMAGE_MODELS),
			...Object.values<ClassifierModel<"google-decisions">>(GOOGLE_CLASSIFIER_MODELS),
		],
		api: {
			"google-generative-ai": googleGenerativeAIApi(),
			"google-interactions": googleInteractionsApi(),
		},
		images: {
			"google-images": googleImagesApi(),
		},
		classifiers: {
			"google-decisions": googleDecisionsApi(),
		},
	});
}
