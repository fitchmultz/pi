import type { Api, AssistantMessage, Model } from "../types.ts";

/**
 * The initial pending assistant message every streaming transport builds its output from:
 * model identity, an empty zeroed usage block, and a `pending` stop reason.
 */
export function createPendingAssistantMessage(api: Api, model: Pick<Model<Api>, "id" | "provider">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}
