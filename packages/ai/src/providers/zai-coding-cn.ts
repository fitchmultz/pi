import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { normalizeZaiModel, ZAI_CODING_CN_COMPLETIONS_BASE_URL } from "../api/zai-catalog.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { ZAI_CODING_CN_MODELS } from "./zai-coding-cn.models.ts";

export function zaiCodingCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai-coding-cn",
		name: "Z.AI Coding CN",
		baseUrl: ZAI_CODING_CN_COMPLETIONS_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Z.AI Coding CN API key", ["ZAI_CODING_CN_API_KEY"]) },
		models: Object.values(ZAI_CODING_CN_MODELS).map(
			(model) => normalizeZaiModel(model) as Model<"openai-completions">,
		),
		api: openAICompletionsApi(),
	});
}
