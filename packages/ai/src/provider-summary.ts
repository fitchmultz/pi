import type { Api, Model, ProviderSummary, SystemMessage, TranscriptContext, UserMessage } from "./types.ts";
import { getInitialSystemMessage, type TranscriptMessages } from "./utils/transcript.ts";

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

/** Whether `model` wrote the summary block. Only the provider, API and model that wrote a block can read it. */
export function wroteProviderSummary(model: Model<Api>, summary: ProviderSummary): boolean {
	return summary.provider === model.provider && summary.api === model.api && summary.model === model.id;
}

/**
 * The user message that stands in for the summary block of `messages` in a request that cannot send
 * it: the summary the provider wrote, as far as the block shows it. Undefined without a block.
 *
 * A block is readable only by the model that wrote it, below the leading system message it was
 * written under.
 */
export function getProviderSummaryStandIn(messages: TranscriptMessages): UserMessage | undefined {
	const lead = getInitialSystemMessage(messages);
	if (!lead?.providerSummary) return undefined;
	const text = lead.providerSummary.block.content;
	return {
		role: "user",
		content:
			typeof text === "string" && text.length > 0
				? `Summary of the earlier conversation:\n\n${text}`
				: "The earlier conversation was summarized. Its summary is not available to this model.",
		timestamp: lead.timestamp,
	};
}

/**
 * Make a transcript whose leading system message carries a summary block sendable to `model`.
 *
 * The model that wrote the block gets the transcript as it is. For every other model the transcript
 * would start with the first kept assistant message, which most APIs reject, so the stand-in user
 * message is put before that message.
 */
export function resolveProviderSummary(model: Model<Api>, context: TranscriptContext): TranscriptContext {
	const lead = getInitialSystemMessage(context.messages);
	const standIn = getProviderSummaryStandIn(context.messages);
	if (!lead?.providerSummary || !standIn || wroteProviderSummary(model, lead.providerSummary)) return context;
	const plainLead: SystemMessage = { ...lead };
	delete plainLead.providerSummary;
	const firstKept = context.messages.findIndex((message) => message.role !== "system");
	const index = firstKept < 0 ? context.messages.length : firstKept;
	return {
		...context,
		messages: [plainLead, ...context.messages.slice(1, index), standIn, ...context.messages.slice(index)],
	};
}
