import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { normalizeCloudflareModel } from "../api/cloudflare.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ClassifierModel } from "../types.ts";
import {
	CLOUDFLARE_AI_GATEWAY_CLASSIFIER_MODELS,
	CLOUDFLARE_AI_GATEWAY_MODELS,
} from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareClassifier, cloudflareStreams } from "./cloudflare-stream.ts";

type CloudflareAIGatewayApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export function cloudflareAIGatewayProvider(): Provider<CloudflareAIGatewayApi> {
	// The api map is pinned to all three APIs: models.dev's gateway catalog drops and
	// restores `workers-ai/*` (openai-completions) entries over time, and inference from
	// `models` alone would otherwise reject the openai-completions entry whenever the
	// generated catalog happens to contain none.
	return createProvider<CloudflareAIGatewayApi>({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: [
			...Object.values(CLOUDFLARE_AI_GATEWAY_MODELS).map((model) => normalizeCloudflareModel(model)),
			...Object.values<ClassifierModel<"openai-decisions">>(CLOUDFLARE_AI_GATEWAY_CLASSIFIER_MODELS),
		],
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-completions": cloudflareStreams(openAICompletionsApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
		classifiers: {
			"openai-decisions": cloudflareClassifier(openAIDecisionsApi()),
		},
	});
}
