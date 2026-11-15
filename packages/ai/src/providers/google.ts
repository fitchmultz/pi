import { googleDecisionsApi } from "../api/google-decisions.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ClassifierModel } from "../types.ts";
import { GOOGLE_CLASSIFIER_MODELS, GOOGLE_MODELS } from "./google.models.ts";

export function googleProvider(): Provider<"google-generative-ai"> {
	return createProvider<"google-generative-ai">({
		id: "google",
		name: "Google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: { apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]) },
		models: [
			...Object.values(GOOGLE_MODELS),
			...Object.values<ClassifierModel<"google-decisions">>(GOOGLE_CLASSIFIER_MODELS),
		],
		api: googleGenerativeAIApi(),
		classifiers: {
			"google-decisions": googleDecisionsApi(),
		},
	});
}
