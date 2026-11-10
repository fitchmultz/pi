import type { Api, Model } from "./types.ts";

/**
 * Whether a `providerSummary` request to this model returns a summary block (see
 * `StreamOptions.providerSummary`). True for the Anthropic Messages models whose thinking blocks are
 * bound to the conversation before them: the models pi sends per-message effort to.
 */
export function supportsProviderSummary(model: Model<Api>): boolean {
	return (
		model.api === "anthropic-messages" &&
		(model as Model<"anthropic-messages">).compat?.supportsMidConvoEffort === true
	);
}
