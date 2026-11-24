import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { createGoogleClient, resolveGoogleApiKey } from "./google-client.ts";
import type { GoogleOptions } from "./google-shared.ts";
import { getGoogleBudget, resolveGoogleSimpleThinking, streamGoogle } from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// This adapter takes the shared options unchanged; the type stays exported from this path.
export type { GoogleOptions };

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: GoogleOptions,
): AssistantMessageEventStream =>
	streamGoogle("google-generative-ai", model, context, options, (fetch) => {
		const apiKey = resolveGoogleApiKey(model, options?.apiKey, options?.headers);
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		return createGoogleClient(model, apiKey, options?.headers, options?.identity, fetch);
	});

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = resolveGoogleApiKey(model, options?.apiKey, options?.headers);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleOptions;
	return stream(model, context, {
		...base,
		thinking: resolveGoogleSimpleThinking(
			model,
			options?.reasoning,
			(level) => getGoogleBudget(model, level, options?.thinkingBudgets),
			options?.thinkingDisplay,
		),
	} satisfies GoogleOptions);
};
