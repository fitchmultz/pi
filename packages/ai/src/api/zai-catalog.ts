import type { AnyModel, OpenAICompletionsCompat, OpenAIResponsesCompat } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

export const ZAI_CODING_COMPLETIONS_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const ZAI_RESPONSES_BASE_URL = "https://api.z.ai/api/v1";
export const ZAI_CODING_CN_COMPLETIONS_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

const ZAI_MID_CONVO_SYSTEM_MODEL_PATTERN = /^glm-5\.[34](?:$|-)/i;

/**
 * Verified OpenAI Responses compat for Z.AI GLM-5.3+ on `https://api.z.ai/api/v1`:
 * developer role, cache-stable mid-conversation updates, strict JSON schemas,
 * and Lark grammar custom tools (`codemode`, `apply_patch`). Z.AI uses implicit
 * KV caching and does not support 24h long cache retention.
 */
export const ZAI_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsDeveloperRole: true,
	supportsMidConvoSystemMessages: true,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: true,
	supportsLongCacheRetention: false,
};

export function isZaiMidConvoSystemModel(modelId: string): boolean {
	return ZAI_MID_CONVO_SYSTEM_MODEL_PATTERN.test(modelId);
}

/**
 * Apply canonical Z.AI GLM-5.3+ catalog defaults during pinned hydration,
 * built-in provider load, and `pi.dev` remote catalog merges without overwriting
 * custom endpoints or explicit compat overrides.
 */
export function normalizeZaiModel(model: AnyModel): AnyModel {
	if (!isModelType(model, "chat")) return model;

	if (model.provider === "zai" && isZaiMidConvoSystemModel(model.id)) {
		if (model.api === "openai-responses" && model.baseUrl === ZAI_RESPONSES_BASE_URL) {
			return {
				...model,
				compat: {
					...ZAI_RESPONSES_COMPAT,
					...(model.compat as OpenAIResponsesCompat | undefined),
				},
			};
		}
		if (model.api === "openai-completions" && model.baseUrl === ZAI_CODING_COMPLETIONS_BASE_URL) {
			const incomingCompat = model.compat as OpenAICompletionsCompat | undefined;
			return {
				...model,
				api: "openai-responses",
				baseUrl: ZAI_RESPONSES_BASE_URL,
				compat: {
					...ZAI_RESPONSES_COMPAT,
					...(incomingCompat?.supportsMidConvoSystemMessages !== undefined
						? { supportsMidConvoSystemMessages: incomingCompat.supportsMidConvoSystemMessages }
						: {}),
					...(incomingCompat?.supportsStrictMode !== undefined
						? { supportsStrictMode: incomingCompat.supportsStrictMode }
						: {}),
				},
			};
		}
	}

	if (
		model.provider === "zai-coding-cn" &&
		model.api === "openai-completions" &&
		model.baseUrl === ZAI_CODING_CN_COMPLETIONS_BASE_URL &&
		isZaiMidConvoSystemModel(model.id)
	) {
		const incomingCompat = model.compat as OpenAICompletionsCompat | undefined;
		if (incomingCompat?.supportsMidConvoSystemMessages === undefined) {
			return {
				...model,
				compat: {
					...incomingCompat,
					supportsMidConvoSystemMessages: true,
				},
			};
		}
	}

	return model;
}
