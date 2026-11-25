import type { GoogleGenAIRequestOptions, Interactions } from "@google/genai";
import { calculateCost, clampThinkingLevel, hasApi } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	Model,
	ProviderRequestOptions,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Tool,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage, resolveTranscript } from "../utils/transcript.ts";
import { createGoogleClient, createGoogleFetch, resolveGoogleApiKey, retryGoogleRequest } from "./google-client.ts";
import {
	type GoogleInteractionsReplay,
	InteractionSteps,
	projectSteps,
	replayMetadata,
} from "./google-interactions-steps.ts";
import {
	applyGoogleServiceTierPricing,
	isGoogleStrictToolRejectionError,
	needsGoogleNeonStopSequence,
	resolveGoogleThinkingLevel,
	rewriteConstAsEnum,
	supportsGoogleStrictToolSampling,
	supportsGoogleTemperature,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { createStrictToolLimitSessionTracker, planStrictTools } from "./strict-tool-limits.ts";

export type { GoogleInteractionsReplay } from "./google-interactions-steps.ts";

type InteractionModel = Model<"google-interactions">;
type Request = Interactions.InteractionCreateParams.CreateModelInteractionParams;
type Lifecycle = Interactions.InteractionCompletedEvent["interaction"];

// Each foreground segment reaches 65,536 tokens before it can request continuation.
// https://aistudio.google.com/docs/long-decode bounds the whole decode at 1,048,576 tokens minus input.
const MAX_FOREGROUND_HOPS = 1_048_576 / 65_536;

/** Google Interactions options. Use `store: false` to opt out of Google-side history. */
export interface GoogleInteractionsOptions extends StreamOptions {
	store?: boolean;
	background?: boolean;
	toolChoice?: "auto" | "none" | "any";
	thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
	thinkingSummaries?: "auto" | "none";
	serviceTier?: "standard" | "flex" | "priority";
}

export const stream: StreamFunction<"google-interactions", GoogleInteractionsOptions> = (model, context, options) =>
	runStream(model, options?.signal, async (events, output) => {
		const request = createInteractionClient(model, options);
		const transcript = resolveTranscript(context, true);
		const steps = projectSteps(model, transcript);
		const initial = getInitialSystemMessage(transcript.messages);
		const tools = getCurrentTools(transcript.messages);
		const strict = prepareTools(model, tools, options);
		const original: Request = {
			model: model.id,
			input: steps,
			system_instruction: initial ? sanitizeSurrogates(getSystemMessageText(initial)) : "",
			tools: strict.tools,
			generation_config: {
				max_output_tokens: options?.maxTokens ?? model.maxTokens,
				...(supportsGoogleTemperature(model) ? { temperature: options?.temperature } : {}),
				thinking_level: options?.thinkingLevel,
				thinking_summaries: options?.thinkingSummaries,
				tool_choice: strict.choice,
				...(needsGoogleNeonStopSequence(model) ? { stop_sequences: ["\nuser\n"] } : {}),
			},
			service_tier: options?.serviceTier ?? "standard",
			store: options?.store,
			background: options?.background ?? false,
			stream: !options?.background,
		};
		const replacement = await options?.onPayload?.(original, model);
		const payload = { ...((replacement ?? original) as Request) };
		// Pi owns history and hop selection, even when a payload hook changes request settings.
		delete payload.previous_interaction_id;
		delete payload.continuation_token;
		if (options?.cacheWarm) {
			payload.store = false;
			payload.background = false;
			payload.generation_config = { ...payload.generation_config, max_output_tokens: 1 };
			if (payload.service_tier === "priority") payload.service_tier = "standard";
		}
		if (payload.background && payload.store === false) {
			throw new Error(
				"Google Interactions background execution requires store: true; remove store: false or disable background execution.",
			);
		}
		payload.store ??= true;

		// If an extension rewrote the input in a different format we cannot prove it is the
		// projected conversation; issue the payload without using or replacing a stored prefix.
		const canTrack =
			payload.store &&
			!options?.disableContinuation &&
			!options?.cacheWarm &&
			options?.sessionId !== undefined &&
			(payload.input === steps || JSON.stringify(payload.input) === JSON.stringify(steps));
		const sessionId = canTrack ? options?.sessionId : undefined;
		const owner = sessionId !== undefined ? await request.threadOwner() : undefined;
		const key = owner === undefined ? undefined : JSON.stringify([sessionId, owner]);
		const entry = key === undefined ? undefined : threadState.get(key);
		const delta = entry && owner !== undefined ? await getDelta(entry, payload, steps, owner) : undefined;
		let previousId = delta && entry ? entry.id : undefined;
		let preferred =
			strict.hasPreferred &&
			payload.tools === strict.tools &&
			payload.generation_config?.tool_choice === "validated";

		async function open<T>(send: (params: Request) => Promise<T>): Promise<T> {
			for (;;) {
				try {
					return await send(
						previousId ? { ...payload, input: delta, previous_interaction_id: previousId } : payload,
					);
				} catch (error) {
					if (previousId && isRejectedPreviousId(error)) {
						if (key !== undefined && threadState.get(key) === entry) threadState.delete(key);
						previousId = undefined;
						continue;
					}
					if (!preferred || !isGoogleStrictToolRejectionError(error)) throw error;
					preferred = false;
					strictToolSessions.markExceeded(options?.sessionId);
					const fallback = prepareTools(model, tools, options, true);
					payload.tools = fallback.tools;
					payload.generation_config = { ...payload.generation_config, tool_choice: fallback.choice };
				}
			}
		}

		if (payload.background) {
			const interaction = await open((params) =>
				request.send((client, opts) => client.interactions.create({ ...params, stream: false }, opts)),
			);
			output.responseId = interaction.id;
			output.responseModel = interaction.model;
			output.rawStopReason = interaction.status;
			if (!isBackgroundPending(interaction.status) && stopReason(interaction.status) === "error") {
				if (interaction.usage) {
					output.usage = buildUsage(model, interaction.usage, interaction.service_tier ?? request.serviceTier());
				}
				throw new Error(interaction.errors?.[0]?.message ?? `Google Interactions: ${interaction.status}`);
			}
			output.stopReason = "deferred";
			output.deferred = { id: interaction.id, provider: model.provider, api: model.api, modelId: model.id };
			return;
		}

		// SDK continuation opens later hops from inside its SSE iterator, outside
		// Pi's shared rate-limit retry policy. Open each hop through request.send.
		const sendHop = (params: Request) =>
			request.send((client, opts) =>
				client.interactions.create({ ...params, stream: true, automatic_continuation: false }, opts),
			);
		let source = await open(sendHop);
		const nativeSteps: GoogleInteractionsReplay["steps"] = [];
		const seenTokens = new Set<string>();
		let hopBaseUsage: Usage | undefined;
		for (let hop = 1; ; hop++) {
			const hopSteps = new InteractionSteps(events, output);
			let interaction: Lifecycle | undefined;
			let usage: Interactions.Usage | undefined;
			let status: string | undefined;
			let token: string | undefined;
			let id: string | undefined;
			let tier: string | undefined;
			for await (const event of source) {
				const previousUsage = usage;
				const previousTier = tier;
				await options?.onProviderStreamEvent?.(event, model);
				switch (event.event_type) {
					case "interaction.created":
					case "interaction.completed":
						interaction = event.interaction;
						id = interaction.id;
						output.responseId = id;
						output.responseModel = interaction.model ?? output.responseModel;
						status = interaction.status;
						token = interaction.continuation_token ?? token;
						tier = interaction.service_tier ?? tier;
						usage = interaction.usage ?? usage;
						break;
					case "interaction.status_update":
						id = event.interaction_id;
						status = event.status;
						token = event.continuation_token ?? token;
						usage = event.usage ?? usage;
						break;
					case "step.start":
						hopSteps.start(event.index, structuredClone(event.step));
						break;
					case "step.delta":
						hopSteps.delta(event.index, event.delta);
						usage = event.metadata?.total_usage ?? usage;
						break;
					case "step.stop":
						hopSteps.stop(event.index);
						usage = event.usage ?? usage;
						break;
					case "error":
						output.rawStopReason = event.error?.code;
						throw new Error(event.error?.message ?? "Google Interactions stream returned an error");
				}
				if (usage && (usage !== previousUsage || tier !== previousTier)) {
					output.usage = buildUsage(model, usage, tier ?? request.serviceTier(), hopBaseUsage);
				}
				options?.signal?.throwIfAborted();
			}
			options?.signal?.throwIfAborted();
			const reason = stopReason(status);
			output.rawStopReason = status;
			if (reason === "error")
				throw new Error(`Google Interactions stream ended with status: ${status ?? "missing"}`);
			nativeSteps.push(...hopSteps.finish(interaction?.steps));
			if (
				status !== "requires_continuation" ||
				!id ||
				!token ||
				seenTokens.has(token) ||
				hop >= MAX_FOREGROUND_HOPS ||
				options?.disableContinuation ||
				options?.cacheWarm
			) {
				output.stopReason = reason;
				output.responseId = id;
				output.googleInteractionsReplay = replayMetadata(output, nativeSteps);
				if (
					key !== undefined &&
					sessionId !== undefined &&
					owner !== undefined &&
					id &&
					status !== "requires_continuation"
				) {
					const prefix = steps.concat(nativeSteps);
					const prefixHash = await hashPrefix(payload, prefix, owner);
					setThreadEntry(key, { sessionId, id, prefixCount: prefix.length, prefixHash });
				}
				return;
			}
			seenTokens.add(token);
			if (usage) hopBaseUsage = output.usage;
			const { input, ...settings } = payload;
			source = await sendHop(
				payload.store
					? { ...settings, continuation_token: token, previous_interaction_id: id }
					: { ...settings, input, continuation_token: token },
			);
		}
	});

export const streamSimple: StreamFunction<"google-interactions", SimpleStreamOptions> = (model, context, options) => {
	const level = clampThinkingLevel(model, options?.reasoning ?? "off");
	return stream(model, context, {
		...buildBaseOptions(model, context, options),
		background: Boolean(options?.deferred),
		toolChoice: options?.toolChoice,
		thinkingLevel: level === "off" ? undefined : resolveGoogleThinkingLevel(model, level),
		thinkingSummaries: options?.thinkingDisplay === "omitted" ? "none" : level === "off" ? undefined : "auto",
	});
};

export function fetchDeferred(
	model: Model<Api>,
	handle: DeferredHandle,
	options?: DeferredFetchOptions,
): AssistantMessageEventStream {
	return runStream(model, options?.signal, async (events, output) => {
		checkHandle(model, handle);
		const request = createInteractionClient(model, options);
		// The GET response can include the originally submitted steps. Filter those below.
		const interaction = await request.send((client, opts) => client.interactions.get(handle.id, {}, opts));
		output.responseId = interaction.id;
		output.responseModel = interaction.model;
		output.rawStopReason = interaction.status;
		if (isBackgroundPending(interaction.status)) {
			output.stopReason = "deferred";
			output.deferred = handle;
			return;
		}
		if (interaction.usage) {
			output.usage = buildUsage(model, interaction.usage, interaction.service_tier ?? request.serviceTier());
		}
		const reason = stopReason(interaction.status);
		if (reason === "error")
			throw new Error(interaction.errors?.[0]?.message ?? `Google Interactions: ${interaction.status}`);
		const steps = new InteractionSteps(events, output);
		output.googleInteractionsReplay = replayMetadata(output, steps.finish(interaction.steps));
		output.stopReason = reason;
	});
}

export async function cancelDeferred(
	model: Model<Api>,
	handle: DeferredHandle,
	options?: DeferredCancelOptions,
): Promise<void> {
	checkHandle(model, handle);
	const request = createInteractionClient(model, options);
	await request.send((client, opts) => client.interactions.cancel(handle.id, {}, opts));
}

function checkHandle(model: Model<Api>, handle: DeferredHandle): asserts model is InteractionModel {
	if (
		!hasApi(model, "google-interactions") ||
		handle.api !== model.api ||
		handle.provider !== model.provider ||
		handle.modelId !== model.id
	) {
		throw new Error("Deferred Google Interactions handle does not match the model");
	}
}

function runStream(
	model: Model<Api>,
	signal: AbortSignal | undefined,
	run: (events: AssistantMessageEventStream, output: AssistantMessage) => Promise<void>,
): AssistantMessageEventStream {
	const events = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
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
	void (async () => {
		try {
			events.push({ type: "start", partial: output });
			await run(events, output);
			signal?.throwIfAborted();
			const reason = output.stopReason;
			if (reason === "pending" || reason === "aborted" || reason === "error")
				throw new Error("Google Interactions did not finish");
			events.push({ type: "done", reason, message: output });
		} catch (error) {
			output.stopReason = signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			events.push({ type: "error", reason: output.stopReason, error: output });
		}
	})();
	return events;
}

function createInteractionClient(model: InteractionModel, options?: ProviderRequestOptions<Model<Api>>) {
	const apiKey = resolveGoogleApiKey(model, options?.apiKey, options?.headers);
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	let failedHeaders: Headers | undefined;
	let tier: string | undefined;
	const googleFetch = createGoogleFetch("Google Interactions", model, options, (headers) => {
		failedHeaders = headers;
	});
	const client = createGoogleClient(model, apiKey, options?.headers, options?.identity, async (input, init) => {
		const response = await googleFetch(input, init);
		tier = response.headers.get("x-gemini-service-tier") ?? undefined;
		return response;
	});
	// SDK retries are off: Pi's shared retry policy handles captured headers and provider limits.
	const sdkOptions: GoogleGenAIRequestOptions = { signal: options?.signal, retries: { strategy: "none" } };
	return {
		send: <T>(request: (sdk: typeof client, opts: GoogleGenAIRequestOptions) => Promise<T>) =>
			retryGoogleRequest(
				() => request(client, sdkOptions),
				model,
				{
					signal: options?.signal,
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
				},
				() => failedHeaders,
			),
		serviceTier: () => tier,
		threadOwner: async () => {
			const headers = new Headers(providerHeadersToRecord(model.headers, options?.headers));
			const credentials = await hashJson([
				apiKey,
				headers.get("x-goog-api-key"),
				headers.get("cf-aig-authorization"),
				headers.get("authorization"),
			]);
			return JSON.stringify([model.provider, model.baseUrl, credentials, model.id]);
		},
	};
}

const strictToolSessions = createStrictToolLimitSessionTracker();

function prepareTools(model: InteractionModel, tools: Tool[], options?: GoogleInteractionsOptions, relaxed = false) {
	const choice = options?.toolChoice;
	const plan = planStrictTools(tools, {
		supportsStrictMode: supportsGoogleStrictToolSampling(model) && choice !== "none",
		disablePreferred: relaxed || strictToolSessions.hasExceeded(options?.sessionId),
		applyClaudeLimits: false,
	});
	let usesStrict = false;
	const declarations = tools.map((tool): Interactions.Function => {
		const schema = plan.admit(tool);
		usesStrict ||= schema !== undefined;
		return {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: rewriteConstAsEnum(schema ?? tool.parameters),
		};
	});
	return {
		tools: declarations.length > 0 ? declarations : undefined,
		choice: declarations.length > 0 ? (usesStrict && choice !== "any" ? "validated" : (choice ?? "auto")) : undefined,
		hasPreferred: plan.hasPreferredStrictTools,
	};
}

function isBackgroundPending(status: string): boolean {
	return status === "queued" || status === "in_progress";
}

function stopReason(status: string | undefined) {
	switch (status) {
		case "requires_action":
			return "toolUse";
		case "completed":
			return "stop";
		case "incomplete":
		case "requires_continuation":
			return "length";
		default:
			return "error";
	}
}

function buildUsage(
	model: InteractionModel,
	usage: Interactions.Usage,
	tier: string | undefined,
	hopBaseUsage?: Usage,
): Usage {
	const cacheRead = usage.total_cached_tokens ?? 0;
	const prompt = usage.initial_input_tokens ?? usage.total_input_tokens ?? 0;
	const toolInput = usage.total_tool_use_tokens ?? 0;
	const reasoning = usage.total_thought_tokens ?? 0;
	const completion = (usage.total_output_tokens ?? 0) + reasoning;
	const hop: Usage = {
		input: Math.max(0, prompt - cacheRead),
		output: completion,
		cacheRead,
		cacheWrite: 0,
		reasoning,
		totalTokens: usage.total_tokens ?? prompt + toolInput + completion,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, { ...hop, input: Math.max(0, (usage.total_input_tokens ?? prompt) - cacheRead) + toolInput });
	applyGoogleServiceTierPricing(model, hop, tier?.toLowerCase());
	if (!hopBaseUsage) return hop;
	// Continuation bills for prefilling history again, but does not add it to context again.
	return {
		...hopBaseUsage,
		output: hopBaseUsage.output + completion,
		reasoning: (hopBaseUsage.reasoning ?? 0) + reasoning,
		totalTokens: hopBaseUsage.totalTokens + toolInput + completion,
		cost: {
			input: hopBaseUsage.cost.input + hop.cost.input,
			output: hopBaseUsage.cost.output + hop.cost.output,
			cacheRead: hopBaseUsage.cost.cacheRead + hop.cost.cacheRead,
			cacheWrite: hopBaseUsage.cost.cacheWrite + hop.cost.cacheWrite,
			total: hopBaseUsage.cost.total + hop.cost.total,
		},
	};
}

interface ThreadEntry {
	sessionId: string;
	id: string;
	prefixCount: number;
	prefixHash: string;
}

// ~2 MB process-wide fallback (~220 B/entry), matching Anthropic's thread cap; session cleanup normally frees entries.
const MAX_THREAD_STATE_ENTRIES = 10_000;
const threadState = new Map<string, ThreadEntry>();

registerSessionResourceCleanup((sessionId) => {
	if (sessionId === undefined) threadState.clear();
	else for (const [key, entry] of threadState) if (entry.sessionId === sessionId) threadState.delete(key);
});

function setThreadEntry(key: string, entry: ThreadEntry): void {
	threadState.delete(key);
	threadState.set(key, entry);
	if (threadState.size > MAX_THREAD_STATE_ENTRIES) {
		const oldest = threadState.keys().next().value;
		if (oldest !== undefined) threadState.delete(oldest);
	}
}

async function getDelta(
	entry: ThreadEntry,
	payload: Request,
	steps: Interactions.Step[],
	owner: string,
): Promise<Interactions.Step[] | undefined> {
	if (steps.length <= entry.prefixCount) return undefined;
	const delta = steps.slice(entry.prefixCount);
	let hasUserInput = false;
	for (const step of delta) {
		if (step.type === "user_input") hasUserInput = true;
		else if (step.type !== "function_result" || hasUserInput) return undefined;
	}
	return (await hashPrefix(payload, steps.slice(0, entry.prefixCount), owner)) === entry.prefixHash
		? delta
		: undefined;
}

function hashPrefix(payload: Request, steps: Interactions.Step[], owner: string): Promise<string> {
	return hashJson([owner, payload.model, payload.system_instruction, steps]);
}

async function hashJson(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRejectedPreviousId(error: unknown): boolean {
	return normalizeProviderError(error).status === 404;
}
