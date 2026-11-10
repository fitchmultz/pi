import type { AnyModel } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";

const MOONSHOT_K3_FAMILY_IDS = ["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"];

// Canonical endpoints whose pi.dev catalog entries omit the Kimi K3 family's cache-write rate.
const KIMI_K3_ENDPOINTS: Record<string, { ids: readonly string[]; baseUrl: string }> = {
	"kimi-coding": {
		ids: ["k3", "k3-256k", "k3.1-pro", "k3.1-pro-highspeed"],
		baseUrl: "https://api.kimi.com/coding/v1",
	},
	moonshotai: { ids: MOONSHOT_K3_FAMILY_IDS, baseUrl: "https://api.moonshot.ai/v1" },
	"moonshotai-cn": { ids: MOONSHOT_K3_FAMILY_IDS, baseUrl: "https://api.moonshot.cn/v1" },
};

/**
 * Restore the five-minute cache-write rate of a Kimi K3-family entry from a published catalog
 * that lists it as zero. Kimi bills those writes at the model's input rate on both platforms
 * (https://platform.kimi.ai/docs/pricing/chat, https://platform.kimi.com/docs/pricing/chat).
 * Other models, custom endpoints and entries with a cache-write rate are returned unchanged.
 */
export function restoreKimiK3CacheWriteCost(model: AnyModel): AnyModel {
	const endpoint = KIMI_K3_ENDPOINTS[model.provider];
	if (
		!endpoint ||
		!isModelType(model, "chat") ||
		model.api !== "openai-completions" ||
		model.baseUrl !== endpoint.baseUrl ||
		!endpoint.ids.includes(model.id) ||
		// Published entries are unvalidated JSON; one without a cost is left alone.
		model.cost?.cacheWrite !== 0
	) {
		return model;
	}
	return { ...model, cost: { ...model.cost, cacheWrite: model.cost.input } };
}
