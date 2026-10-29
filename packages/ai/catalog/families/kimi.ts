// Moonshot Kimi models, shared by Moonshot, Kimi Coding, and gateways.

export { KIMI_K3_COST, KIMI_K3_OPENAI_COMPAT, KIMI_OPENAI_COMPAT } from "../../src/api/kimi.ts";

/**
 * Kimi K3 and its point releases (kimi-k3.1-pro, kimi-k3.1-pro-highspeed) share
 * K3's request format. https://api.moonshot.ai/v1/models reports effort levels
 * and dynamic tool loading for all of them.
 */
export function isKimiK3FamilyId(modelId: string): boolean {
	return /^kimi-k3(?:\.\d+)?(?:-|$)/.test(modelId);
}

export const KIMI_K3_MAX_TOKENS = 131072;
