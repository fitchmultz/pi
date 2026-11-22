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
import { isCloudflareGoogleAiStudioUrl, resolveGoogleSimpleThinking, streamGoogle } from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// This adapter takes the shared options unchanged; the type stays exported from this path.
export type { GoogleOptions };

function getHeaderValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected) {
			const trimmed = value.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		}
	}
	return undefined;
}

/**
 * Resolve the SDK `apiKey` for `@google/genai`:
 * - Explicit `options.apiKey` or `x-goog-api-key` header takes precedence.
 * - For Cloudflare AI Gateway `/google-ai-studio` passthroughs (BYOK / Unified Billing) without a
 *   Google key, pass the `cf-aig-authorization` token directly as `apiKey` per Cloudflare's
 *   `@google/genai` guide.
 */
function resolveGoogleApiKey(
	model: Model<"google-generative-ai">,
	apiKey: string | undefined,
	optionsHeaders: ProviderHeaders | undefined,
): string | undefined {
	if (apiKey) return apiKey;
	const merged = providerHeadersToRecord(model.headers, optionsHeaders);
	const explicitHeaderKey = getHeaderValue(merged, "x-goog-api-key");
	if (explicitHeaderKey) return explicitHeaderKey;
	if (!isCloudflareGoogleAiStudioUrl(model.baseUrl)) return undefined;
	const gatewayAuth = getHeaderValue(merged, "cf-aig-authorization");
	if (!gatewayAuth) return undefined;
	const token = gatewayAuth.replace(/^Bearer\s+/i, "").trim();
	return token.length > 0 ? token : undefined;
}

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
		return createClient(model, apiKey, options?.headers, options?.identity, fetch);
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
	const budgetLevel = level === "xhigh" ? "high" : level;
	if (customBudgets?.[budgetLevel] !== undefined) {
		return customBudgets[budgetLevel]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<Exclude<ResolvedGoogleThinkingLevel, "xhigh">, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[budgetLevel];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<Exclude<ResolvedGoogleThinkingLevel, "xhigh">, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[budgetLevel];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<Exclude<ResolvedGoogleThinkingLevel, "xhigh">, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[budgetLevel];
	}

	return -1;
}
