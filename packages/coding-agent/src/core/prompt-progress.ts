export interface PromptProgress {
	total: number;
	cache: number;
	processed: number;
	timeMs: number;
}

/**
 * Extract llama.cpp / ds4-server `prompt_progress` metadata from a raw streaming
 * provider chunk (`{ prompt_progress: { total, cache, processed, time_ms } }`).
 */
export function extractPromptProgress(data: unknown): PromptProgress | undefined {
	if (typeof data !== "object" || data === null || !("prompt_progress" in data)) {
		return undefined;
	}
	const raw = (data as { prompt_progress?: unknown }).prompt_progress;
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const { total, cache, processed, time_ms } = raw as Record<string, unknown>;
	if (
		typeof total !== "number" ||
		!Number.isFinite(total) ||
		total <= 0 ||
		typeof cache !== "number" ||
		!Number.isFinite(cache) ||
		cache < 0 ||
		typeof processed !== "number" ||
		!Number.isFinite(processed) ||
		processed < 0 ||
		typeof time_ms !== "number" ||
		!Number.isFinite(time_ms) ||
		time_ms < 0
	) {
		return undefined;
	}
	const normalizedTotal = Math.floor(total);
	if (normalizedTotal <= 0) return undefined;
	const normalizedCache = Math.min(Math.floor(cache), normalizedTotal);
	const normalizedProcessed = Math.min(Math.max(Math.floor(processed), normalizedCache), normalizedTotal);
	return {
		total: normalizedTotal,
		cache: normalizedCache,
		processed: normalizedProcessed,
		timeMs: time_ms,
	};
}
