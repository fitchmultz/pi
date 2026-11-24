import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { CacheRetention, OpenAIResponsesCompat, ProviderEnv, ProviderHeaders } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
export function resolveOpenAICacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

export function getOpenAIPromptCacheRetention(
	compat: Pick<Required<OpenAIResponsesCompat>, "supportsLongCacheRetention" | "supportsExplicitPromptCacheMode">,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

export function getOpenAIPromptCacheOptions(
	compat: Pick<Required<OpenAIResponsesCompat>, "supportsLongCacheRetention" | "supportsExplicitPromptCacheMode">,
	cacheRetention: CacheRetention,
): ResponseCreateParamsStreaming["prompt_cache_options"] {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "12h" };
	return undefined;
}

export function applyOpenAISessionAffinityHeaders(
	headers: ProviderHeaders,
	sessionId: string | undefined,
	sessionAffinityFormat: NonNullable<OpenAIResponsesCompat["sessionAffinityFormat"]>,
): void {
	if (!sessionId) return;
	if (sessionAffinityFormat === "openrouter") {
		headers["x-session-id"] = sessionId;
		return;
	}
	if (sessionAffinityFormat === "openai") {
		headers["session-id"] = sessionId;
	}
	headers["x-client-request-id"] = sessionId;
}
