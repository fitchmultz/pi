import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { normalizeZaiModel, ZAI_CODING_COMPLETIONS_BASE_URL } from "../api/zai-catalog.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { ZAI_MODELS } from "./zai.models.ts";

type ZaiApi = "openai-completions" | "openai-responses";

export function zaiProvider(): Provider<ZaiApi> {
	return createProvider<ZaiApi>({
		id: "zai",
		name: "Z.AI",
		baseUrl: ZAI_CODING_COMPLETIONS_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Z.AI API key", ["ZAI_API_KEY"]) },
		models: Object.values(ZAI_MODELS).map((model) => normalizeZaiModel(model) as Model<ZaiApi>),
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
