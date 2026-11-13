import { GoogleGenAI, type HttpOptions } from "@google/genai";
import type {
	FetchFunction,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	ThinkingBudgets,
	TranscriptContext,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import type { GoogleOptions, ResolvedGoogleThinkingLevel } from "./google-shared.ts";
import { resolveGoogleSimpleThinking, streamGoogle } from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// This adapter takes the shared options unchanged; the type stays exported from this path.
export type { GoogleOptions };

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: GoogleOptions,
): AssistantMessageEventStream =>
	streamGoogle("google-generative-ai", model, context, options, () => {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		return createClient(model, apiKey, options?.headers, options?.identity, options?.fetch);
	});

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleOptions;
	return stream(model, context, {
		...base,
		thinking: resolveGoogleSimpleThinking(model, options?.reasoning, (level) =>
			getGoogleBudget(model, level, options?.thinkingBudgets),
		),
	} satisfies GoogleOptions);
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	fetch?: FetchFunction,
): GoogleGenAI {
	// Always pass fetch: without one, @google/genai adds a per-request dispatcher that disables
	// undici's header and body timeouts, bypassing the idle timeouts of the global dispatcher.
	const httpOptions: HttpOptions = { fetch: fetch ?? globalThis.fetch };
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	const headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders);
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({ apiKey, httpOptions });
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[level] !== undefined) {
		return customBudgets[level]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	return -1;
}
