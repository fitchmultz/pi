import type { AnyModel } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

/** Workers AI direct endpoint. */
export const CLOUDFLARE_WORKERS_AI_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";

/** Workers AI REST endpoint root; model runs are posted to `run`. */
export const CLOUDFLARE_WORKERS_AI_REST_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai";

/** AI Gateway Unified API. https://developers.cloudflare.com/ai-gateway/usage/unified-api/ */
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat";

/** AI Gateway → OpenAI passthrough. Used until /compat supports /v1/responses. */
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai";

/** AI Gateway → Anthropic passthrough. */
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";

/** /anthropic forwards the ID unchanged; Anthropic accepts hyphenated Claude versions. */
export function normalizeCloudflareModelId(provider: string, api: string, id: string): string {
	return provider === "cloudflare-ai-gateway" && api === "anthropic-messages" && id.startsWith("claude-")
		? id.replaceAll(".", "-")
		: id;
}

/**
 * Direct OpenAI models that accept `additional_tools` items, and those that accept developer messages
 * mid-conversation (`OPENAI_TOOL_SEARCH_MODEL_IDS` and `OPENAI_MID_CONVO_MODEL_IDS` in
 * catalog/families/openai.ts). Cloudflare's /openai route passes both through unchanged. The defaults
 * live here rather than only in the catalog because pi.dev overlays, published upstream without them,
 * replace generated entries. A parity test keeps these lists in sync.
 */
const OPENAI_ADDITIONAL_TOOLS_MODEL_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
]);
const OPENAI_MID_CONVO_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	...OPENAI_ADDITIONAL_TOOLS_MODEL_IDS,
]);

export function normalizeCloudflareModel<TModel extends AnyModel>(model: TModel): TModel {
	const id = normalizeCloudflareModelId(model.provider, model.api, model.id);
	const normalized = id === model.id ? model : { ...model, id };
	if (!isModelType(normalized, "chat") || normalized.provider !== "cloudflare-ai-gateway") return normalized;
	if (
		normalized.api === "openai-responses" &&
		normalized.baseUrl === CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL &&
		OPENAI_MID_CONVO_MODEL_IDS.has(normalized.id)
	) {
		return {
			...normalized,
			compat: {
				supportsMidConvoSystemMessages: true,
				...(OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(normalized.id) ? { supportsAdditionalTools: true } : {}),
				...normalized.compat,
			},
		};
	}
	if (
		normalized.api !== "anthropic-messages" ||
		normalized.id !== "claude-opus-5-5" ||
		normalized.baseUrl !== CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL
	) {
		return normalized;
	}
	const compat = {
		supportsMidConvoSystemMessages: true,
		supportsMidConvoToolChanges: true,
		supportsMidConvoEffort: true,
		forceAdaptiveThinking: true,
		...normalized.compat,
	};
	return {
		...normalized,
		promptCache: normalized.promptCache ?? { short: 300, long: 3600 },
		compat,
		...(compat.supportsMidConvoEffort ? { thinkingLevelMap: { ...normalized.thinkingLevelMap, off: null } } : {}),
	};
}
