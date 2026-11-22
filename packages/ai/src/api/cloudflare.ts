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

/**
 * Direct OpenAI models that accept prefix-preserving Responses features (`OPENAI_TOOL_SEARCH_MODEL_IDS`,
 * `OPENAI_MID_CONVO_EFFORT_MODEL_IDS`, and `OPENAI_MID_CONVO_MODEL_IDS` in catalog/families/openai.ts).
 * Cloudflare's /openai route passes developer messages, `additional_tools`, tool search,
 * `prompt_cache_options`, and `configuration_update` through unchanged. The defaults live here rather
 * than only in the catalog because pi.dev overlays, published upstream without them,
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
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);
const OPENAI_MID_CONVO_EFFORT_MODEL_IDS = new Set([
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);
const OPENAI_MID_CONVO_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	...OPENAI_ADDITIONAL_TOOLS_MODEL_IDS,
]);

const OPENAI_TEMPERATURE_UNSUPPORTED_MODEL_IDS = new Set([
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);
const CLOUDFLARE_AI_GATEWAY_OPENAI_URL_PATTERN =
	/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+\/openai\/?$/;
const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL_PATTERN =
	/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+\/anthropic\/?$/;

/**
 * Claude passthrough parity with `catalog/families/anthropic.ts`. Kept in runtime code for the same
 * reason as the OpenAI lists above: published `pi.dev` catalog overlays can replace generated entries.
 */
const CLAUDE_DISABLED_THINKING_MODELS = new Set(["claude-opus-5", "claude-haiku-5-5", "claude-haiku-5.5"]);
const CLAUDE_TEMPERATURE_UNSUPPORTED_FRAGMENTS = [
	"opus-4-7",
	"opus-4.7",
	"opus-4-8",
	"opus-4.8",
	"opus-5",
	"opus.5",
	"sonnet-5",
	"sonnet.5",
	"haiku-5-5",
	"haiku-5.5",
	"fable-5-2",
	"fable-5.2",
	"mythos-5-2",
	"mythos-5.2",
];

function supportsCloudflareClaudeMidConvoSystemMessages(modelId: string): boolean {
	return (
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:fable|mythos)-5(?:[.-][12])?(?:-\d{8})?$/.test(modelId)
	);
}

function supportsCloudflareClaudeMidConvoEffort(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		/^claude-opus-(?:5|5[.-]5)(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5[.-][12](?:-\d{8})?$/.test(id)
	);
}

export function normalizeCloudflareModel<TModel extends AnyModel>(model: TModel): TModel {
	if (!isModelType(model, "chat") || model.provider !== "cloudflare-ai-gateway") return model;
	if (
		model.api === "openai-responses" &&
		CLOUDFLARE_AI_GATEWAY_OPENAI_URL_PATTERN.test(model.baseUrl) &&
		OPENAI_MID_CONVO_MODEL_IDS.has(model.id)
	) {
		const supportsToolFeatures = OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id);
		return {
			...model,
			compat: {
				supportsMidConvoSystemMessages: true,
				...(supportsToolFeatures
					? {
							supportsAdditionalTools: true,
							supportsToolSearch: true,
							supportsExplicitPromptCacheMode: true,
						}
					: {}),
				...(OPENAI_MID_CONVO_EFFORT_MODEL_IDS.has(model.id) ? { supportsMidConvoEffort: true } : {}),
				...(OPENAI_TEMPERATURE_UNSUPPORTED_MODEL_IDS.has(model.id) ? { supportsTemperature: false } : {}),
				...model.compat,
			},
		};
	}
	if (
		model.api !== "anthropic-messages" ||
		!supportsCloudflareClaudeMidConvoSystemMessages(model.id) ||
		!CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL_PATTERN.test(model.baseUrl)
	) {
		return model;
	}
	const midConvoEffort = supportsCloudflareClaudeMidConvoEffort(model.id);
	const lowerId = model.id.toLowerCase();
	const temperatureUnsupported = CLAUDE_TEMPERATURE_UNSUPPORTED_FRAGMENTS.some((fragment) =>
		lowerId.includes(fragment),
	);
	const disablesOff = midConvoEffort && !CLAUDE_DISABLED_THINKING_MODELS.has(lowerId.replace(/-\d{8}$/, ""));
	const compat = {
		supportsMidConvoSystemMessages: true,
		supportsMidConvoToolChanges: true,
		...(midConvoEffort ? { supportsMidConvoEffort: true } : {}),
		forceAdaptiveThinking: true,
		...(temperatureUnsupported ? { supportsTemperature: false } : {}),
		...model.compat,
	};
	return {
		...model,
		promptCache: model.promptCache ?? { short: 300, long: 3600 },
		compat,
		...(compat.supportsMidConvoEffort && disablesOff
			? { thinkingLevelMap: { ...model.thinkingLevelMap, off: null } }
			: {}),
	};
}

/**
 * OpenAI's Decisions classifiers as the gateway's `/openai` passthrough serves them: the same
 * entries at the gateway's base URL, since the gateway passes OpenAI usage through at OpenAI list prices.
 */
export function cloudflareGatewayDecisionsModels<T extends { type?: unknown; api?: unknown }>(
	openaiEntries: readonly T[],
): Array<T & { provider: "cloudflare-ai-gateway"; baseUrl: string }> {
	return openaiEntries
		.filter((entry) => entry.type === "classifier" && entry.api === "openai-decisions")
		.map((entry) => ({
			...entry,
			provider: "cloudflare-ai-gateway",
			baseUrl: CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
		}));
}

/**
 * Keep OpenAI's Decisions classifiers in `cloudflare-ai-gateway` catalogs hydrated from upstream
 * snapshots that predate them, derived from the snapshot's `openai` entries. Entries already present
 * in the catalog win unchanged.
 */
export function withCloudflareGatewayDecisionsModels<T extends { type?: unknown; id?: unknown; api?: unknown }>(
	provider: string,
	entries: readonly T[],
	openaiEntries: readonly T[],
): T[] {
	if (provider !== "cloudflare-ai-gateway") return [...entries];
	const present = new Set(entries.filter((entry) => entry.type === "classifier").map((entry) => entry.id));
	return [...entries, ...cloudflareGatewayDecisionsModels(openaiEntries).filter((entry) => !present.has(entry.id))];
}
