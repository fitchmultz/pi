import type { AnyModel, OpenAICompletionsCompat, ThinkingLevelMap } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

// Default five-minute cache writes: https://platform.kimi.ai/docs/pricing/chat
export const KIMI_K3_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 } as const;

// Kimi Chat Completions settings shared by Moonshot and Kimi Coding.
export const KIMI_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	thinkingFormat: "deepseek",
};
// K3-style models take reasoning_effort and need earlier reasoning sent back.
export const KIMI_K3_OPENAI_COMPAT: OpenAICompletionsCompat = {
	...KIMI_OPENAI_COMPAT,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "openai",
	supportsReasoningEffort: true,
};

// Highspeed reports neither effort levels nor dynamic tool loading and rejects
// tool-bearing system messages with a 400.
export const KIMI_CODING_K3_STYLE_MODEL_IDS = new Set(["k3", "k3-256k", "kimi-for-coding"]);

export function getKimiCodingMetadata(id: string, thinkingLevelMap?: ThinkingLevelMap) {
	const isK3Style = KIMI_CODING_K3_STYLE_MODEL_IDS.has(id);
	return {
		api: "openai-completions" as const,
		baseUrl: "https://api.kimi.com/coding/v1",
		compat: {
			...(isK3Style ? KIMI_K3_OPENAI_COMPAT : KIMI_OPENAI_COMPAT),
			supportsMidConvoSystemMessages: true,
			...(isK3Style ? { supportsMidConvoToolAdditions: true } : {}),
		},
		// Kimi Code reports every model as always-thinking.
		thinkingLevelMap: { ...thinkingLevelMap, off: null },
	};
}

// Canonical OpenAI-compatible endpoints whose published catalogs omit Kimi K3's 5m cache-write rate.
const KIMI_K3_CANONICAL_ENDPOINTS: Record<string, { id: string; baseUrl: string }> = {
	"kimi-coding": { id: "k3", baseUrl: "https://api.kimi.com/coding/v1" },
	moonshotai: { id: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1" },
	"moonshotai-cn": { id: "kimi-k3", baseUrl: "https://api.moonshot.cn/v1" },
};

/** Adapt canonical published entries that predate Kimi Coding's native protocol migration. */
export function normalizeKimiCodingModel(model: AnyModel): AnyModel {
	if (!isModelType(model, "chat")) {
		return model;
	}
	if (
		model.provider === "kimi-coding" &&
		model.api === "anthropic-messages" &&
		model.baseUrl === "https://api.kimi.com/coding"
	) {
		return {
			...model,
			...getKimiCodingMetadata(model.id, model.thinkingLevelMap),
			cost:
				model.id === "k3" && model.cost?.cacheWrite === 0
					? { ...model.cost, cacheWrite: KIMI_K3_COST.cacheWrite }
					: model.cost,
		};
	}
	const canonicalK3 = KIMI_K3_CANONICAL_ENDPOINTS[model.provider];
	if (
		canonicalK3 &&
		model.id === canonicalK3.id &&
		model.api === "openai-completions" &&
		model.baseUrl === canonicalK3.baseUrl &&
		model.cost?.cacheWrite === 0
	) {
		return {
			...model,
			cost: { ...model.cost, cacheWrite: KIMI_K3_COST.cacheWrite },
		};
	}
	return model;
}
