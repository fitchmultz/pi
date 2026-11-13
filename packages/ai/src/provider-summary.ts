import { hasApi } from "./models.ts";
import type { Api, Model, ProviderSummary, SystemMessage, TranscriptContext, UserMessage } from "./types.ts";
import { getInitialSystemMessage, type TranscriptMessages } from "./utils/transcript.ts";

/**
 * Whether a `providerSummary` request to this model returns a summary block that later requests
 * can send (see `StreamOptions.providerSummary`). True for the Anthropic Messages models whose
 * thinking blocks are bound to the conversation before them (the models pi sends per-message
 * effort to), on routes that take system messages and tool changes inside the conversation. A
 * block is readable only below an unchanged leading system message and tool list; without those
 * two capabilities pi folds every later change into them.
 */
export function supportsProviderSummary(model: Model<Api>): boolean {
	if (!hasApi(model, "anthropic-messages")) return false;
	return (
		model.compat?.supportsMidConvoEffort === true &&
		model.compat.supportsMidConvoSystemMessages === true &&
		model.compat.supportsMidConvoToolChanges === true
	);
}

/** Whether `model` wrote the summary block. Only the provider, API and model that wrote a block can read it. */
export function wroteProviderSummary(model: Model<Api>, summary: ProviderSummary): boolean {
	return summary.provider === model.provider && summary.api === model.api && summary.model === model.id;
}

function buildStandIn(lead: SystemMessage, summary: ProviderSummary): UserMessage {
	const text = summary.block.content;
	return {
		role: "user",
		content:
			typeof text === "string" && text.length > 0
				? `Summary of the earlier conversation:\n\n${text}`
				: "The earlier conversation was summarized. Its summary is not available to this model.",
		timestamp: summary.timestamp ?? lead.timestamp,
	};
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
	return lead?.providerSummary ? buildStandIn(lead, lead.providerSummary) : undefined;
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
	if (!lead?.providerSummary || wroteProviderSummary(model, lead.providerSummary)) return context;
	const plainLead: SystemMessage = { ...lead };
	delete plainLead.providerSummary;
	const firstKept = context.messages.findIndex((message) => message.role !== "system");
	const index = firstKept < 0 ? context.messages.length : firstKept;
	return {
		...context,
		messages: [
			plainLead,
			...context.messages.slice(1, index),
			buildStandIn(lead, lead.providerSummary),
			...context.messages.slice(index),
		],
	};
}
