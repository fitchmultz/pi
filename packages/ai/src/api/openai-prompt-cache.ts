export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * OpenAI GPT-6 models that accept `configuration_update` input items to change reasoning effort
 * without mutating the request prefix (`reasoning.effort`). Shared by the OpenAI and Codex
 * catalogs, Cloudflare AI Gateway `/openai` passthrough normalization, and the Codex runtime
 * fallback for upstream `pi.dev` catalog overlays.
 */
export const OPENAI_MID_CONVO_EFFORT_MODEL_IDS: ReadonlySet<string> = new Set([
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
